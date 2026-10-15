//! 从市场装一个插件、卸一个插件。
//!
//! ## 装一次的完整链路
//!
//! ```text
//! 下载（边下边算 sha256，超上限就中断）
//!   → sha256 与清单对不上？停在这里，一个字节都没落进插件目录
//!   → 解压到 plugin-install/<uuid>/（逐条校验见 archive.rs）
//!   → 复核 zip 里那份 plugin.json：apiVersion 必须是 2、入口必须真的存在
//!   → 写一本「出身证明」.market.json
//!   → 换目录：旧的先 rename 进 trash/，新的再 rename 成 plugins/<name>；失败就搬回来
//!   → 记状态：origin=market + grantedPermissions=Some(用户确认过的那份)
//! ```
//!
//! ## 三条不能松的地方
//!
//! 1. **权限只授予用户确认过的那份**。zip 里声明的权限比清单多时，多出来的那几个
//!    **不生效**（在结果里如实报给用户）。写 `None` 或者照单全收，都等于把「装之前我
//!    确认」这一步作废。
//! 2. **不覆盖本地已有的同名插件**（除非那个也是市场装的）。用户手写的、或随应用分发的，
//!    被一次安装悄悄换掉是灾难 —— 而且内置插件被换成市场版之后，卸载就再也回不来了
//!    （内置校正只更新已装的，从不播种）。
//! 3. **失败不留半个插件**。所有校验都在写进 `plugins/` 之前做完；真到换目录那一步失败，
//!    旧目录会被搬回来。
//!
//! ## 进程内串行
//!
//! 每次安装都会先清一遍工作区。两个安装并发跑的话，后一个的清理会把前一个正在解压的
//! 目录删掉 —— 所以这里用一把进程内的锁把安装与卸载串起来（应用本身是单实例的）。

use super::super::errors::{app_error, with_detail};
use super::super::manifest::{read_manifest_file, CURRENT_API_VERSION};
use super::super::paths::{is_supported_entry, safe_join_file, validate_plugin_name, PluginPaths};
use super::super::state::{self, PluginOrigin};
use super::super::store;
use super::archive;
use super::catalog;
use crate::services::notes::AppError;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// 下载上限。插件包正常只有几 MB，给足余量但绝不允许无限增长。
const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const USER_AGENT: &str = "floral-notepaper-plugin-market";

/// 用户确认的权限列表的上限。清单是被签名的，但状态文件的体积仍不该由远端说了算。
const MAX_APPROVED_PERMISSIONS: usize = 64;
const MAX_PERMISSION_CHARS: usize = 64;

/// 出身证明的文件名。放在插件目录里，跟着目录走。
pub const MARKER_FILE: &str = ".market.json";

/// 安装/卸载的进程内串行锁。见模块注释最后一段。
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // 上一次因为 panic 而中毒不该让安装永久失效 —— 被保护的是文件系统操作，
    // 没有「数据被写坏一半」的共享状态需要担心。
    INSTALL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 安装过程中的日志。与 `sync.rs` 的 `sync_log!` 同一个形状（开发构建里打到 stderr，
/// 由 Vite 转发出来），前缀不同是为了分清是哪个子系统在说话。
macro_rules! market_log {
    ($($arg:tt)*) => {{
        if cfg!(debug_assertions) {
            eprintln!("[plugins:market] {}", format!($($arg)*));
        }
    }};
}

/// 一次安装请求。字段来自清单里选中的那一版，外加用户确认过的权限。
#[derive(Debug, Clone)]
pub struct InstallRequest {
    pub name: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    /// **用户在确认框里看到并同意的**那一份（来自清单）。
    pub approved_permissions: Vec<String>,
}

/// 装完之后要告诉用户的事。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub name: String,
    pub version: String,
    /// zip 里声明、但这次**没有授权**的权限。非空说明清单与插件对不上，要显式提示。
    pub extra_permissions: Vec<String>,
    /// 被这次安装替掉的旧版本（首次安装为 `None`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOutcome {
    pub name: String,
    /// 连插件数据一起删了没有。
    pub data_removed: bool,
}

/// 插件目录里的出身证明。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketMarker {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub installed_at: String,
}

/// 读一本出身证明。没有或者读不出来都返回 `None`。
///
/// 存在的意义：状态文件被删掉/搬走之后，插件目录自己仍然记得它是市场装的 ——
/// 内置校正（`sync`）据此继续避开它，卸载也据此认得它。
pub fn read_marker(dir: &Path) -> Option<MarketMarker> {
    let raw = fs::read_to_string(dir.join(MARKER_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn is_market_installed(dir: &Path, name: &str) -> bool {
    read_marker(dir).is_some_and(|marker| marker.name == name)
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

pub fn install(paths: &PluginPaths, request: &InstallRequest) -> Result<InstallOutcome, AppError> {
    let _guard = lock();

    let prepared = precheck(paths, request)?;

    // 工作区先清一遍：上一次失败留下的东西没有用了。**必须在拿到锁之后做。**
    reset_workspace(paths)?;

    let work = paths.staging_root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&work)?;
    // 从这里开始，任何提前返回都要把工作目录带走 —— Drop 里做，连 panic 也盖得到。
    let _cleanup = WorkspaceGuard { dir: work.clone() };

    let zip_path = paths
        .staging_root
        .join(format!("{}.zip", uuid::Uuid::new_v4()));
    let downloaded = download_to_file(
        &request.url,
        &zip_path,
        MAX_DOWNLOAD_BYTES,
        &prepared.expected_hash,
    );
    if downloaded.is_err() {
        let _ = fs::remove_file(&zip_path);
    }
    downloaded?;

    let outcome = finish_staging(paths, request, &zip_path, &work, &prepared);
    let _ = fs::remove_file(&zip_path);
    let staged = outcome?;

    state::record_market_install(paths, &request.name, request.approved_permissions.clone())?;

    Ok(InstallOutcome {
        name: request.name.clone(),
        version: request.version.clone(),
        extra_permissions: staged.extra_permissions,
        replaced_version: prepared.replaced_version,
    })
}

/// 下载之前能做的全部检查，外加一件要**在替换前**记下来的事：被顶掉的是哪一版。
struct Prepared {
    target: PathBuf,
    replaced_version: Option<String>,
    expected_hash: String,
}

fn precheck(paths: &PluginPaths, request: &InstallRequest) -> Result<Prepared, AppError> {
    validate_plugin_name(&request.name)?;
    check_approved_permissions(&request.approved_permissions)?;

    // 便宜的判断放在下载之前：地址不合法、校验值不像 sha256，就别浪费一次网络请求。
    if !catalog::release_url_is_allowed(&request.url) {
        return Err(app_error(
            "marketReleaseUrlInvalid",
            format!("下载地址不合法：{}", request.url),
        ));
    }
    let Some(expected_hash) = catalog::normalize_sha256(&request.sha256) else {
        return Err(app_error(
            "marketReleaseSha256Invalid",
            format!("校验值不是合法的 sha256：{}", request.sha256),
        ));
    };

    paths.ensure_dirs()?;
    let target = paths.root.join(&request.name);

    // 规矩 2：不覆盖本地已有的同名插件。市场版把内置/手写版顶掉之后，卸载就再也回不来了
    // （内置校正只更新已装的，从不播种）。
    if target.exists() && !installed_from_market(paths, &request.name, &target) {
        return Err(with_detail(
            app_error(
                "marketPluginShadowsLocal",
                format!(
                    "本地已经有一个叫 {} 的插件，它不是在市场装的 —— 请先手动删掉 plugins/{} 再装",
                    request.name, request.name
                ),
            ),
            "name",
            request.name.clone(),
        ));
    }

    let replaced_version = read_manifest_file(&target)
        .ok()
        .map(|manifest| manifest.version)
        .filter(|version| !version.is_empty());

    Ok(Prepared {
        target,
        replaced_version,
        expected_hash,
    })
}

/// 「这个插件是市场装的吗」——**唯一的一份判据**。
///
/// 两处证据看一处就够，但两个都看更稳：状态文件里那条记录是界面与卸载的依据（用户可以
/// 删掉状态文件、可以搬数据目录），而插件目录里那份出身证明跟着目录走。
///
/// 内置版本校正（`sync`）也调这个函数。两边各写一份的话，迟早会出现「一边认为该管、
/// 另一边认为不该管」——那种不一致正是内置校正去覆盖市场插件的成因。
pub fn is_market_origin(state: &state::PluginStateFile, name: &str, dir: &Path) -> bool {
    state.entry(name).origin == PluginOrigin::Market || is_market_installed(dir, name)
}

fn installed_from_market(paths: &PluginPaths, name: &str, dir: &Path) -> bool {
    is_market_origin(
        &state::load(&paths.state_path, &paths.data_dir),
        name,
        dir,
    )
}

struct StagedOutcome {
    extra_permissions: Vec<String>,
}

/// 包已经下好之后的全部工作：解压 → 复核 → 换目录。
///
/// 写进 `plugins/` 之前的所有校验都在这里完成 —— 任何一步失败，正式目录都不会被碰过。
fn finish_staging(
    paths: &PluginPaths,
    request: &InstallRequest,
    zip_path: &Path,
    work: &Path,
    prepared: &Prepared,
) -> Result<StagedOutcome, AppError> {
    // 解压到工作目录。archive 那边把每一条路径都校验过（zip-slip、符号链接、大小上限…）。
    let unpack_result = archive::unpack(fs::File::open(zip_path)?, &request.name, work);
    // 压缩包本身没用了，无论解压成不成都先删掉 —— 别让它跟着目录被 rename 进 plugins/。
    let _ = fs::remove_file(zip_path);
    unpack_result?;

    // 复核 zip 里那份 plugin.json。**清单可能过期，压缩包里的才是权威。**
    let manifest = read_manifest_file(work).map_err(|error| {
        with_detail(
            app_error(
                "marketInstallManifestInvalid",
                format!("装进来的插件清单读不出来：{}", error.message),
            ),
            "name",
            request.name.clone(),
        )
    })?;

    if manifest.api_version < 2 {
        // 清单里筛过一遍了，这里是复核。两处都挡，是因为清单可能过期。
        return Err(app_error(
            "marketInstallApiNoSandbox",
            format!(
                "压缩包里的插件是旧格式（apiVersion {}），跑在主线程里没有沙箱隔离，不能安装",
                manifest.api_version
            ),
        ));
    }
    if manifest.api_version > CURRENT_API_VERSION {
        return Err(app_error(
            "marketInstallApiTooNew",
            format!(
                "压缩包里的插件要求 apiVersion {}，当前应用只支持到 {CURRENT_API_VERSION}",
                manifest.api_version
            ),
        ));
    }
    if !is_supported_entry(&manifest.main) {
        return Err(with_detail(
            app_error(
                "marketInstallEntryInvalid",
                format!("插件入口不是 JavaScript：{}", manifest.main),
            ),
            "name",
            request.name.clone(),
        ));
    }
    // 入口必须真的存在（这条同时挡住了清单里写歪的 `main`）。
    safe_join_file(work, &manifest.main).map_err(|error| {
        with_detail(
            app_error(
                "marketInstallEntryMissing",
                format!("插件入口文件不在包里：{}（{}）", manifest.main, error.message),
            ),
            "name",
            request.name.clone(),
        )
    })?;

    // 只授予用户确认过的那几个。多出来的如实报上去，**不静默生效**。
    let extra_permissions: Vec<String> = manifest
        .permissions
        .iter()
        .filter(|permission| !request.approved_permissions.contains(permission))
        .cloned()
        .collect();

    write_marker(work, request, &prepared.expected_hash)?;
    swap_into_place(paths, &request.name, work, &prepared.target)?;

    Ok(StagedOutcome {
        extra_permissions,
    })
}

fn write_marker(work: &Path, request: &InstallRequest, sha256: &str) -> Result<(), AppError> {
    let marker = MarketMarker {
        name: request.name.clone(),
        version: request.version.clone(),
        sha256: sha256.to_string(),
        installed_at: Utc::now().to_rfc3339(),
    };
    let json = serde_json::to_string_pretty(&marker)
        .map_err(|error| app_error("marketMarkerFailed", format!("写出身证明失败：{error}")))?;
    fs::write(work.join(MARKER_FILE), json)?;
    Ok(())
}

/// 把工作目录换成正式的插件目录。
///
/// Windows 上 `rename` 到**已存在**的目标会失败，所以顺序只能是「旧的先搬走，新的再搬进
/// 来」。中间那一步失败就把旧目录搬回去 —— 宁可保持原样，也不能让用户既没旧的也没新的。
fn swap_into_place(
    paths: &PluginPaths,
    name: &str,
    work: &Path,
    target: &Path,
) -> Result<(), AppError> {
    let trash = paths.trash_dir();
    fs::create_dir_all(&trash)?;

    let mut displaced: Option<PathBuf> = None;
    if target.exists() {
        let stamp = Utc::now().format("%Y%m%d%H%M%S%.3f");
        let parked = trash.join(format!("{name}-{stamp}"));
        fs::rename(target, &parked).map_err(|error| {
            with_detail(
                app_error(
                    "marketInstallReplaceFailed",
                    format!("旧版本的目录搬不动（可能有文件被占用）：{error}"),
                ),
                "name",
                name.to_string(),
            )
        })?;
        displaced = Some(parked);
    }

    if let Err(error) = fs::rename(work, target) {
        // 回滚：把旧目录搬回原位。
        if let Some(parked) = &displaced {
            if let Err(rollback) = fs::rename(parked, target) {
                return Err(app_error(
                    "marketInstallRollbackFailed",
                    format!(
                        "新版本落位失败（{error}），旧版本也没能搬回去（{rollback}）—— \
                         旧版本在 {}",
                        parked.display()
                    ),
                ));
            }
        }
        return Err(with_detail(
            app_error(
                "marketInstallFailed",
                format!("插件目录落位失败：{error}"),
            ),
            "name",
            name.to_string(),
        ));
    }

    // 旧版本已经用不上了。删不掉不是错误：留在 trash 里，下次安装时一起清。
    if let Some(parked) = displaced {
        if fs::remove_dir_all(&parked).is_err() {
            market_log!("旧版本残留在 {:?}，下次安装时清理", parked);
        }
    }

    Ok(())
}

/// 清空工作区与 trash。**调用方必须持有安装锁**：并发时后一个会把前一个正在解压的目录删掉。
fn reset_workspace(paths: &PluginPaths) -> Result<(), AppError> {
    let staging = paths.staging_root.clone();
    if !staging.is_dir() {
        fs::create_dir_all(&staging)?;
        return Ok(());
    }

    // 删不掉的条目留着（可能被杀毒软件占着），下次再试。
    for entry in fs::read_dir(&staging)?.flatten() {
        let path = entry.path();
        let result = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(error) = result {
            market_log!("清理工作区残留失败 {:?}：{}", path, error);
        }
    }

    Ok(())
}

/// 提前返回时把工作目录带走。
struct WorkspaceGuard {
    dir: PathBuf,
}

impl Drop for WorkspaceGuard {
    fn drop(&mut self) {
        // 落位成功后这个目录已经改名搬走了，`remove_dir_all` 自然失败 —— 忽略即可。
        let _ = fs::remove_dir_all(&self.dir);
    }
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/// 下载到文件，**边下边算 sha256**，并与清单里的值核对。
///
/// 三重上限：`Content-Length`（可以先看一眼）、实际写出的字节数、以及 sha256 ——
/// 前面两个防的是把磁盘写爆，最后那个才是完整性。**校验不过的东西一步都不往下走**。
///
/// 重定向是允许的（GitHub 的发布资产会跳到另一个域名），sha256 校验让这件事不影响安全。
fn download_to_file(
    url: &str,
    target: &Path,
    limit: u64,
    expected_hash: &str,
) -> Result<u64, AppError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| app_error("marketClientFailed", format!("创建网络客户端失败：{error}")))?;

    let mut response = client
        .get(url)
        .send()
        .map_err(|error| with_detail(
            app_error("marketDownloadFailed", format!("下载失败：{error}")),
            "url",
            url.to_string(),
        ))?;

    let status = response.status();
    if !status.is_success() {
        return Err(with_detail(
            app_error(
                "marketDownloadFailed",
                format!("下载失败：HTTP {status}"),
            ),
            "status",
            status.as_u16().to_string(),
        ));
    }
    if let Some(length) = response.content_length() {
        if length > limit {
            return Err(too_large(length, limit));
        }
    }

    let mut file = fs::File::create(target)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;

    loop {
        let read = response.read(&mut buffer).map_err(|error| {
            app_error("marketDownloadFailed", format!("下载中断：{error}"))
        })?;
        if read == 0 {
            break;
        }
        written += read as u64;
        if written > limit {
            // 头里的 `Content-Length` 可能没有，也可能撒谎 —— 这里才是真正管用的那道。
            return Err(too_large(written, limit));
        }
        digest.update(&buffer[..read]);
        file.write_all(&buffer[..read])?;
    }
    file.flush()?;
    drop(file);

    let actual = to_hex(&digest.finalize());
    if actual != expected_hash {
        return Err(with_detail(
            app_error(
                "marketChecksumMismatch",
                format!("下载下来的文件与清单里的校验值不符（期望 {expected_hash}，实际 {actual}）"),
            ),
            "expected",
            expected_hash.to_string(),
        ));
    }

    Ok(written)
}

fn too_large(size: u64, limit: u64) -> AppError {
    app_error(
        "marketDownloadTooLarge",
        format!("插件包过大（{size} 字节，上限 {limit}）"),
    )
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn check_approved_permissions(approved: &[String]) -> Result<(), AppError> {
    if approved.len() > MAX_APPROVED_PERMISSIONS {
        return Err(app_error(
            "marketPermissionListTooLong",
            format!("确认的权限条目太多（{} 条）", approved.len()),
        ));
    }
    for permission in approved {
        if permission.is_empty() || permission.chars().count() > MAX_PERMISSION_CHARS {
            return Err(app_error(
                "marketPermissionInvalid",
                "权限名不合法".to_string(),
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 卸载
// ---------------------------------------------------------------------------

/// 卸掉一个市场装的插件。
///
/// * **只卸市场装的**：不看清楚就删，一条误发的命令就能端掉用户手写或随应用分发的插件。
/// * `delete_data` 由用户决定（界面上会问）。代码与数据本来就是分开的，默认留着，
///   重装能恢复设置；要删也走现成的 `store::remove_plugin_data`。
pub fn uninstall(
    paths: &PluginPaths,
    name: &str,
    delete_data: bool,
) -> Result<UninstallOutcome, AppError> {
    let _guard = lock();

    validate_plugin_name(name)?;
    let target = paths.root.join(name);

    if !installed_from_market(paths, name, &target) {
        return Err(with_detail(
            app_error(
                "marketUninstallNotMarket",
                format!("{name} 不是在插件市场装的，这里不负责删它（请手动处理 plugins/{name}）"),
            ),
            "name",
            name.to_string(),
        ));
    }

    if target.is_dir() {
        // 先搬进 trash 再删：留下的是一个「一半在 plugins/、一半不在」的糟糕状态的话，
        // 用户会以为插件坏了，而实际上卸载没做完。
        let trash = paths.trash_dir();
        fs::create_dir_all(&trash)?;
        let stamp = Utc::now().format("%Y%m%d%H%M%S%.3f");
        let parked = trash.join(format!("{name}-{stamp}"));
        fs::rename(&target, &parked)?;
        if let Err(error) = fs::remove_dir_all(&parked) {
            market_log!("卸载后清理 {:?} 失败：{}", parked, error);
        }
    }

    // 条目整个删掉，别留一份授权给下次安装白白沿用。
    state::record_uninstall(paths, name)?;

    let mut data_removed = false;
    if delete_data {
        store::remove_plugin_data(paths, name)?;
        data_removed = true;
    }

    Ok(UninstallOutcome {
        name: name.to_string(),
        data_removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_paths(tag: &str) -> (PluginPaths, PathBuf) {
        let mut root = std::env::temp_dir();
        root.push(format!("floral-market-install-{tag}-{}", uuid::Uuid::new_v4()));
        let paths = PluginPaths::from_data_dir(&root);
        paths.ensure_dirs().expect("ensure dirs");
        (paths, root)
    }

    /// 打一个符合约定的插件包。
    fn plugin_zip(name: &str, manifest: &str, files: &[(&str, &str)]) -> Vec<u8> {
        use zip::write::SimpleFileOptions;

        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file(format!("{name}/plugin.json"), options).unwrap();
            writer.write_all(manifest.as_bytes()).unwrap();
            for (relative, content) in files {
                writer
                    .start_file(format!("{name}/{relative}"), options)
                    .unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    fn sha256_of(bytes: &[u8]) -> String {
        let mut digest = Sha256::new();
        digest.update(bytes);
        to_hex(&digest.finalize())
    }

    /// 把一包字节当作「已经下好了」走完剩下的路。
    ///
    /// 走的**就是** `install` 的那几段代码（`precheck` → `finish_staging`，
    /// 外加落状态），只有下载那一步换成了本地写入 —— 端到端里再用本地 HTTP 服务补上
    /// 下载这一段。这样测试断言的落盘行为与线上是同一段代码，不会各写一份慢慢漂移。
    fn install_from_bytes(
        paths: &PluginPaths,
        request: &InstallRequest,
        zip_bytes: &[u8],
    ) -> Result<InstallOutcome, AppError> {
        let prepared = precheck(paths, request)?;

        let work = paths.staging_root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&work)?;
        let _cleanup = WorkspaceGuard { dir: work.clone() };

        let zip_path = paths.staging_root.join(format!("{}.zip", uuid::Uuid::new_v4()));
        fs::write(&zip_path, zip_bytes)?;

        let staged = finish_staging(paths, request, &zip_path, &work, &prepared);
        let _ = fs::remove_file(&zip_path);
        let staged = staged?;

        state::record_market_install(paths, &request.name, request.approved_permissions.clone())?;

        Ok(InstallOutcome {
            name: request.name.clone(),
            version: request.version.clone(),
            extra_permissions: staged.extra_permissions,
            replaced_version: prepared.replaced_version,
        })
    }

    fn request(name: &str, version: &str, bytes: &[u8], approved: &[&str]) -> InstallRequest {
        InstallRequest {
            name: name.to_string(),
            version: version.to_string(),
            url: "https://example.com/a.zip".to_string(),
            sha256: sha256_of(bytes),
            approved_permissions: approved.iter().map(|item| item.to_string()).collect(),
        }
    }

    const MANIFEST: &str = r#"{ "name": "demo", "version": "1.0.0", "main": "index.js",
        "apiVersion": 2, "permissions": ["editor:read", "ui:panel"] }"#;

    #[test]
    fn installs_a_plugin_and_records_it_as_market() {
        let (paths, root) = temp_paths("ok");
        let bytes = plugin_zip("demo", MANIFEST, &[("index.js", "// plugin")]);
        let req = request("demo", "1.0.0", &bytes, &["editor:read", "ui:panel"]);

        let outcome = install_from_bytes(&paths, &req, &bytes).expect("应当装成功");

        assert_eq!(outcome.name, "demo");
        assert_eq!(outcome.replaced_version, None);
        assert!(outcome.extra_permissions.is_empty());

        let installed = paths.root.join("demo");
        assert!(installed.join("plugin.json").is_file());
        assert!(installed.join("index.js").is_file());
        assert!(
            installed.join(MARKER_FILE).is_file(),
            "出身证明要跟着目录走 —— 状态文件丢了也能认出这是市场装的"
        );
        assert!(is_market_installed(&installed, "demo"));

        let entry = state::load(&paths.state_path, &paths.data_dir).entry("demo");
        assert_eq!(entry.origin, PluginOrigin::Market);
        assert_eq!(
            entry.granted_permissions,
            Some(vec!["editor:read".to_string(), "ui:panel".to_string()]),
            "授予的必须正好是用户确认过的那份"
        );

        assert!(
            fs::read_dir(&paths.staging_root)
                .unwrap()
                .flatten()
                .all(|entry| entry.file_name() != "demo"),
            "工作区里不该留下东西"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn extra_permissions_are_reported_but_not_granted() {
        // 清单里只写了 editor:read，插件实际还想要 ui:panel 与 workspace:read。
        let (paths, root) = temp_paths("extra");
        let bytes = plugin_zip("demo", MANIFEST, &[("index.js", "// plugin")]);
        let req = request("demo", "1.0.0", &bytes, &["editor:read"]);

        let outcome = install_from_bytes(&paths, &req, &bytes).expect("照装，但不能授权");

        assert_eq!(
            outcome.extra_permissions,
            vec!["ui:panel".to_string()],
            "多出来的要如实报给用户"
        );

        let entry = state::load(&paths.state_path, &paths.data_dir).entry("demo");
        let declared: Vec<String> = vec!["editor:read".to_string(), "ui:panel".to_string()];
        assert_eq!(
            entry.effective_permissions(&declared),
            vec!["editor:read".to_string()],
            "没确认过的权限一律不生效"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn refuses_to_overwrite_a_locally_installed_plugin() {
        let (paths, root) = temp_paths("shadow");

        // 本地已经有一个手写的 demo（状态里从来没有它，于是 origin 是缺省的 Bundled）。
        let existing = paths.root.join("demo");
        fs::create_dir_all(&existing).unwrap();
        fs::write(
            existing.join("plugin.json"),
            r#"{ "name": "demo", "version": "9.0.0", "main": "index.js", "apiVersion": 2 }"#,
        )
        .unwrap();
        fs::write(existing.join("index.js"), "// 手写的，别动我").unwrap();

        assert!(
            !installed_from_market(&paths, "demo", &existing),
            "手写的插件不该被当成市场装的"
        );

        // 真走一遍 `install`：这一步应该在**下载之前**就被拦下。地址是假的，能证明它没发请求。
        let error = install(
            &paths,
            &InstallRequest {
                name: "demo".to_string(),
                version: "1.0.0".to_string(),
                url: "http://127.0.0.1:1/should-not-be-requested.zip".to_string(),
                sha256: "a".repeat(64),
                approved_permissions: vec![],
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "marketPluginShadowsLocal");
        assert_eq!(
            fs::read_to_string(existing.join("index.js")).unwrap(),
            "// 手写的，别动我",
            "用户的东西一个字都不能动"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_market_install_can_be_replaced() {
        let (paths, root) = temp_paths("upgrade");
        let first = plugin_zip("demo", MANIFEST, &[("index.js", "// v1")]);
        install_from_bytes(&paths, &request("demo", "1.0.0", &first, &[]), &first).unwrap();

        let second = plugin_zip(
            "demo",
            r#"{ "name": "demo", "version": "1.1.0", "main": "index.js", "apiVersion": 2 }"#,
            &[("index.js", "// v2")],
        );
        let outcome = install_from_bytes(&paths, &request("demo", "1.1.0", &second, &[]), &second)
            .expect("市场装的可以覆盖");

        assert_eq!(outcome.replaced_version.as_deref(), Some("1.0.0"));
        assert_eq!(
            fs::read_to_string(paths.root.join("demo").join("index.js")).unwrap(),
            "// v2"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_packages_that_do_not_match_the_rules() {
        let (paths, root) = temp_paths("rules");

        // v1：没有沙箱，不能装。
        let v1 = plugin_zip(
            "demo",
            r#"{ "name": "demo", "version": "1.0.0", "main": "index.js" }"#,
            &[("index.js", "// plugin")],
        );
        assert_eq!(
            install_from_bytes(&paths, &request("demo", "1.0.0", &v1, &[]), &v1)
                .unwrap_err()
                .code,
            "marketInstallApiNoSandbox"
        );

        // 入口不是 JS。
        let ts = plugin_zip(
            "demo",
            r#"{ "name": "demo", "version": "1.0.0", "main": "index.ts", "apiVersion": 2 }"#,
            &[("index.ts", "// plugin")],
        );
        assert_eq!(
            install_from_bytes(&paths, &request("demo", "1.0.0", &ts, &[]), &ts)
                .unwrap_err()
                .code,
            "marketInstallEntryInvalid"
        );

        // 入口写着 index.js，包里却没有 —— 装上去也跑不起来，早点拦。
        let missing = plugin_zip(
            "demo",
            r#"{ "name": "demo", "version": "1.0.0", "main": "index.js", "apiVersion": 2 }"#,
            &[("other.js", "// plugin")],
        );
        assert_eq!(
            install_from_bytes(&paths, &request("demo", "1.0.0", &missing, &[]), &missing)
                .unwrap_err()
                .code,
            "marketInstallEntryMissing"
        );

        assert!(
            !paths.root.join("demo").exists(),
            "被拒绝的安装不该在 plugins/ 里留下任何东西"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn failed_install_leaves_the_previous_version_untouched() {
        let (paths, root) = temp_paths("rollback");
        let good = plugin_zip("demo", MANIFEST, &[("index.js", "// v1 好用的")]);
        install_from_bytes(&paths, &request("demo", "1.0.0", &good, &[]), &good).unwrap();

        // 拿一个坏包去覆盖：校验发生在换目录之前，所以旧版本必须原封不动。
        let bad = plugin_zip(
            "demo",
            r#"{ "name": "demo", "version": "2.0.0", "main": "index.js" }"#,
            &[("index.js", "// v2")],
        );
        assert!(install_from_bytes(&paths, &request("demo", "2.0.0", &bad, &[]), &bad).is_err());

        assert_eq!(
            fs::read_to_string(paths.root.join("demo").join("index.js")).unwrap(),
            "// v1 好用的",
            "失败之后旧的必须还在"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn uninstall_removes_the_plugin_and_optionally_its_data() {
        let (paths, root) = temp_paths("remove");
        let bytes = plugin_zip("demo", MANIFEST, &[("index.js", "// plugin")]);
        install_from_bytes(&paths, &request("demo", "1.0.0", &bytes, &[]), &bytes).unwrap();

        // 造一点插件数据（settings.json）出来。
        let data_file = paths.data_dir_for("demo").unwrap().join("kv.json");
        fs::write(&data_file, "{}").unwrap();

        // 先试「保留数据」。
        let outcome = uninstall(&paths, "demo", false).unwrap();
        assert!(!outcome.data_removed);
        assert!(!paths.root.join("demo").exists(), "代码要删掉");
        assert!(data_file.is_file(), "用户选了保留数据");
        assert!(
            !state::load(&paths.state_path, &paths.data_dir)
                .plugins
                .contains_key("demo"),
            "状态条目要清干净"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn uninstall_deletes_data_when_asked() {
        let (paths, root) = temp_paths("remove-data");
        let bytes = plugin_zip("demo", MANIFEST, &[("index.js", "// plugin")]);
        install_from_bytes(&paths, &request("demo", "1.0.0", &bytes, &[]), &bytes).unwrap();
        let data_dir = paths.data_dir_for("demo").unwrap();
        fs::write(data_dir.join("kv.json"), "{}").unwrap();

        let outcome = uninstall(&paths, "demo", true).unwrap();

        assert!(outcome.data_removed);
        assert!(!data_dir.exists(), "用户选了连数据一起删");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn uninstall_refuses_plugins_that_are_not_from_the_market() {
        let (paths, root) = temp_paths("remove-local");
        let existing = paths.root.join("handwritten");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("index.js"), "// 手写的").unwrap();

        let error = uninstall(&paths, "handwritten", true).unwrap_err();

        assert_eq!(error.code, "marketUninstallNotMarket");
        assert!(existing.is_dir(), "一条误发的命令不能端掉用户自己写的插件");

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn marker_survives_a_lost_state_file() {
        let (paths, root) = temp_paths("marker");
        let bytes = plugin_zip("demo", MANIFEST, &[("index.js", "// plugin")]);
        install_from_bytes(&paths, &request("demo", "1.0.0", &bytes, &[]), &bytes).unwrap();

        // 状态文件没了（用户搬了数据目录、或删了它）。
        fs::remove_file(&paths.state_path).unwrap();

        let dir = paths.root.join("demo");
        assert!(
            is_market_installed(&dir, "demo"),
            "目录自带的那份出身份证才是最后一道保险"
        );
        assert_eq!(read_marker(&dir).unwrap().version, "1.0.0");
        // 卸载照样认得它。
        assert!(uninstall(&paths, "demo", false).is_ok());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn workspace_is_reset_between_attempts() {
        let (paths, root) = temp_paths("workspace");

        // 假装上一次安装留下了垃圾。
        let stale = paths.staging_root.join("leftover");
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("x"), "x").unwrap();
        let stale_zip = paths.staging_root.join("leftover.zip");
        fs::write(&stale_zip, "x").unwrap();

        reset_workspace(&paths).unwrap();

        assert!(!stale.exists());
        assert!(!stale_zip.exists());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_absurd_permission_lists() {
        let too_many: Vec<String> = (0..MAX_APPROVED_PERMISSIONS + 1)
            .map(|index| format!("p{index}"))
            .collect();
        assert_eq!(
            check_approved_permissions(&too_many).unwrap_err().code,
            "marketPermissionListTooLong"
        );

        assert_eq!(
            check_approved_permissions(&["x".repeat(MAX_PERMISSION_CHARS + 1)]).unwrap_err().code,
            "marketPermissionInvalid"
        );
        assert_eq!(
            check_approved_permissions(&[String::new()]).unwrap_err().code,
            "marketPermissionInvalid"
        );
        assert!(check_approved_permissions(&["editor:read".to_string()]).is_ok());
    }
}
