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

/// 被替换掉的本地插件存在 `plugin-data/<名字>/` 下的哪个子目录里。
const REPLACED_DIR: &str = ".replaced";

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
    /// 本地已有同名插件（且不是市场装的）时，是否允许**替换**它。
    ///
    /// 缺省 `false`：调用方必须显式说要替换 —— 参数传错不该毁掉用户自己写的东西。
    /// 允许替换时，被顶掉的那份会**搬到备份目录**（不是删掉），卸载时会装回去。
    pub replace_local: bool,
}

/// 装完之后要告诉用户的事。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub name: String,
    pub version: String,
    /// zip 里声明、但这次**没有授权**的权限。非空说明清单与插件对不上，要显式提示。
    pub extra_permissions: Vec<String>,
    /// 被这次安装替掉的旧版本（首次安装为 `None`）。替换本地插件时，这里是**本地那个**版本号。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced_version: Option<String>,
    /// 替换掉的那份本地插件备份在哪儿（只有替换本地插件时才非空）。
    ///
    /// 给界面显示用：用户得知道东西没丢，以及去哪儿找。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOutcome {
    pub name: String,
    /// 连插件数据一起删了没有。
    pub data_removed: bool,
    /// 卸载时**装回来**的那个本地版本（这个插件当初替换掉过同名的本地插件）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_version: Option<String>,
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
        local_backup_path: staged
            .local_backup
            .map(|path| path.display().to_string()),
    })
}

/// 下载之前能做的全部检查，外加两件要**在替换前**定下来的事：被顶掉的是哪一版、
/// 以及它该不该被备份下来。
struct Prepared {
    target: PathBuf,
    replaced_version: Option<String>,
    expected_hash: String,
    /// 要不要把被顶掉的那份本地插件**留起来**（而不是当垃圾清掉）。
    back_up_local: bool,
}

fn precheck(paths: &PluginPaths, request: &InstallRequest) -> Result<Prepared, AppError> {
    validate_plugin_name(&request.name)?;
    check_approved_permissions(&request.approved_permissions)?;

    // 便宜的判断放在下载之前：地址不合法、校验值不像 sha256，就别浪费一次网络请求。
    if !catalog::url_is_allowed(&request.url) {
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

    // 规矩 2：不**悄悄**覆盖本地已有的同名插件。
    //
    // 两种情况：
    // * 那个也是市场装的 → 更新/降级，正常覆盖，旧的那份当垃圾清掉；
    // * 那个是随应用分发的、或者用户自己写的 → 只有调用方**显式**说了要替换才动，
    //   而且被顶掉的那份要**备份下来**（见 `swap_into_place`）。没有这道确认，
    //   一次误发的安装就能端掉用户自己写的东西。
    let mut back_up_local = false;
    if target.exists() {
        if installed_from_market(paths, &request.name, &target) {
            // 市场版之间的替换，不需要额外确认。
        } else if request.replace_local {
            back_up_local = true;
        } else {
            return Err(with_detail(
                app_error(
                    "marketPluginShadowsLocal",
                    format!(
                        "本地已经有一个叫 {} 的插件，它不是在市场装的。\
                         要替换它需要在界面上显式确认（会把原版备份下来）。",
                        request.name
                    ),
                ),
                "name",
                request.name.clone(),
            ));
        }
    }

    let replaced_version = read_manifest_file(&target)
        .ok()
        .map(|manifest| manifest.version)
        .filter(|version| !version.is_empty());

    Ok(Prepared {
        target,
        replaced_version,
        expected_hash,
        back_up_local,
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
    /// 被替换掉的本地插件备份到了哪儿（只有替换本地插件时才非空）。
    local_backup: Option<PathBuf>,
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
    let local_backup = swap_into_place(
        paths,
        &request.name,
        work,
        &prepared.target,
        prepared.back_up_local,
    )?;

    Ok(StagedOutcome {
        extra_permissions,
        local_backup,
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

/// 把工作目录换成正式的插件目录，返回被替换掉的**本地**插件的备份路径。
///
/// Windows 上 `rename` 到**已存在**的目标会失败，所以顺序只能是「旧的先搬走，新的再搬进
/// 来」。中间那一步失败就把旧目录搬回去 —— 宁可保持原样，也不能让用户既没旧的也没新的。
///
/// 旧的那份搬去两个地方之一，取决于 `back_up_local`：
///
/// * `false`（市场版之间的替换）→ 工作区里的 `trash/`，下次安装时一起清掉；
/// * `true`（顶掉了本地/内置插件）→ `plugin-data/<名字>/.replaced/<时间戳>/`，**留着**，
///   卸载时会装回去。放数据目录而不是工作区：工作区每次安装都会被清空，
///   那等于把用户原来那份插件删了。
fn swap_into_place(
    paths: &PluginPaths,
    name: &str,
    work: &Path,
    target: &Path,
    back_up_local: bool,
) -> Result<Option<PathBuf>, AppError> {
    let stamp = || Utc::now().format("%Y%m%d%H%M%S%.3f").to_string();

    let mut displaced: Option<PathBuf> = None;
    if target.exists() {
        let parked = if back_up_local {
            let dir = replaced_root(paths, name);
            fs::create_dir_all(&dir)?;
            dir.join(stamp())
        } else {
            let trash = paths.trash_dir();
            fs::create_dir_all(&trash)?;
            trash.join(format!("{name}-{}", stamp()))
        };

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

    match displaced {
        // 备份下来的那份**留着**，卸载时要装回去。
        Some(parked) if back_up_local => {
            market_log!("原版本已备份到 {:?}", parked);
            Ok(Some(parked))
        }
        // 市场版之间的替换：旧的那份已经用不上了。删不掉不是错误，下次安装时一起清。
        Some(parked) => {
            if fs::remove_dir_all(&parked).is_err() {
                market_log!("旧版本残留在 {:?}，下次安装时清理", parked);
            }
            Ok(None)
        }
        None => Ok(None),
    }
}

/// 被替换掉的本地插件存哪儿：`plugin-data/<名字>/.replaced/`。
///
/// 放在**插件数据目录**而不是插件代码目录，理由与 `sync` 的备份一致：它不会出现在插件的
/// 资源清单里，也不会被人当成插件目录扫到。
fn replaced_root(paths: &PluginPaths, name: &str) -> PathBuf {
    paths.data_root.join(name).join(REPLACED_DIR)
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
/// * 这个插件当初**替换掉过**本地的同名插件时，卸载会把它**装回去**（那是安装时备份下来的，
///   见 `swap_into_place`）。这是「替换」这个动作的反向操作 —— 没有它，被顶掉的内置插件就
///   再也回不来了（内置校正只更新已装的，从不播种）。
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

    // 还原**必须排在删数据之前**：备份就住在 `plugin-data/<名字>/` 下面，
    // 而 `delete_data` 会把那个目录整个删掉。
    let restored_version = restore_replaced(paths, name)?;

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
        restored_version,
    })
}

/// 把当初被市场版替换掉的本地插件装回 `plugins/<名字>`，返回它的版本号。
///
/// 备份目录名是时间戳，所以**字典序就是时间序**，取最后一个即最新那份。
///
/// 三种情况下什么都不做（都返回 `Ok(None)`）：没有备份、目标目录竟然还在（不该发生，
/// 宁可不动也不能盖东西）、备份目录读不了。
fn restore_replaced(paths: &PluginPaths, name: &str) -> Result<Option<String>, AppError> {
    let backup_root = replaced_root(paths, name);
    if !backup_root.is_dir() {
        return Ok(None);
    }

    let mut backups: Vec<PathBuf> = fs::read_dir(&backup_root)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    backups.sort();

    let Some(latest) = backups.pop() else {
        return Ok(None);
    };

    let target = paths.root.join(name);
    if target.exists() {
        market_log!("{name} 的目标目录还在，跳过还原（备份留在 {:?}）", latest);
        return Ok(None);
    }

    let version = read_manifest_file(&latest)
        .ok()
        .map(|manifest| manifest.version)
        .filter(|version| !version.is_empty());

    fs::rename(&latest, &target)?;
    market_log!("已把 {name} 的本地版本还原到 {:?}", target);

    // 备份用掉了，把这个目录清掉。剩下的要么是空壳、要么是被更晚一次替换顶掉的旧备份
    // （正常流程下不会出现）。删不掉不是错误：留着也不影响什么。
    if let Err(error) = fs::remove_dir_all(&backup_root) {
        market_log!("清理备份目录 {:?} 失败：{}", backup_root, error);
    }

    Ok(version)
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
            local_backup_path: staged.local_backup.map(|path| path.display().to_string()),
        })
    }

    fn request(name: &str, version: &str, bytes: &[u8], approved: &[&str]) -> InstallRequest {
        InstallRequest {
            name: name.to_string(),
            version: version.to_string(),
            url: "https://example.com/a.zip".to_string(),
            sha256: sha256_of(bytes),
            approved_permissions: approved.iter().map(|item| item.to_string()).collect(),
            // 默认**不**替换本地同名插件：绝大多数用例该走那条安全路径，
            // 要替换的用例自己把它改成 true。
            replace_local: false,
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
                // 没有显式同意替换 —— 这正是要被拦下的那一种。
                replace_local: false,
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
    fn replacing_a_local_plugin_backs_it_up_and_uninstall_puts_it_back() {
        let (paths, root) = temp_paths("replace-local");

        // 用户自己写的一个 demo（状态里从来没有它 → origin 是缺省的 Bundled）。
        let local = paths.root.join("demo");
        fs::create_dir_all(&local).unwrap();
        fs::write(
            local.join("plugin.json"),
            r#"{ "name": "demo", "version": "9.0.0", "main": "index.js", "apiVersion": 2 }"#,
        )
        .unwrap();
        fs::write(local.join("index.js"), "// 我自己的版本").unwrap();

        // 用户在确认框里点了「替换安装」。
        let bytes = plugin_zip("demo", MANIFEST, &[("index.js", "// 市场版")]);
        let mut req = request("demo", "1.0.0", &bytes, &[]);
        req.replace_local = true;

        let outcome = install_from_bytes(&paths, &req, &bytes).expect("显式同意之后应当装成");

        assert_eq!(
            outcome.replaced_version.as_deref(),
            Some("9.0.0"),
            "要告诉用户被顶掉的是哪一版"
        );
        let backup = outcome.local_backup_path.expect("原版应当被备份下来");
        assert!(
            Path::new(&backup).join("index.js").is_file(),
            "备份里要有原版的代码：{backup}"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&backup).join("index.js")).unwrap(),
            "// 我自己的版本",
            "备份是**原样搬走**，不是删掉"
        );
        assert_eq!(
            fs::read_to_string(paths.root.join("demo").join("index.js")).unwrap(),
            "// 市场版"
        );
        assert_eq!(
            state::load(&paths.state_path, &paths.data_dir)
                .entry("demo")
                .origin,
            PluginOrigin::Market
        );

        // 卸载 → 原来那份装回来。
        let removed = uninstall(&paths, "demo", false).unwrap();
        assert_eq!(removed.restored_version.as_deref(), Some("9.0.0"));
        assert_eq!(
            fs::read_to_string(paths.root.join("demo").join("index.js")).unwrap(),
            "// 我自己的版本",
            "卸载是「替换」的反向操作 —— 没有它，被顶掉的内置插件就再也回不来了"
        );
        assert_eq!(
            state::load(&paths.state_path, &paths.data_dir)
                .entry("demo")
                .origin,
            PluginOrigin::Bundled,
            "装回来的那份重新归内置校正管"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_failed_replace_leaves_the_local_plugin_untouched() {
        let (paths, root) = temp_paths("replace-fail");

        let local = paths.root.join("demo");
        fs::create_dir_all(&local).unwrap();
        fs::write(
            local.join("plugin.json"),
            r#"{ "name": "demo", "version": "9.0.0", "main": "index.js", "apiVersion": 2 }"#,
        )
        .unwrap();
        fs::write(local.join("index.js"), "// 我自己的版本").unwrap();

        // 包里写着 main=index.js，却没有这个文件 → 在**换目录之前**就失败。
        let bad = plugin_zip(
            "demo",
            r#"{ "name": "demo", "version": "1.0.0", "main": "index.js", "apiVersion": 2 }"#,
            &[("other.js", "// 市场版")],
        );
        let mut req = request("demo", "1.0.0", &bad, &[]);
        req.replace_local = true;

        assert!(install_from_bytes(&paths, &req, &bad).is_err());

        assert_eq!(
            fs::read_to_string(local.join("index.js")).unwrap(),
            "// 我自己的版本",
            "失败之后用户的东西一个字都不能动"
        );
        assert!(
            !replaced_root(&paths, "demo").exists(),
            "没走到替换那一步就不该留下备份目录"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn restore_never_clobbers_whatever_is_already_there() {
        let (paths, root) = temp_paths("restore-guard");

        // 造一份备份，同时目标目录**还在**（不该发生的组合，但必须不闯祸）。
        let backup = replaced_root(&paths, "demo").join("20260101000000.000");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("index.js"), "// 备份里的").unwrap();

        let target = paths.root.join("demo");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("index.js"), "// 现在装着的").unwrap();

        assert_eq!(restore_replaced(&paths, "demo").unwrap(), None);
        assert_eq!(
            fs::read_to_string(target.join("index.js")).unwrap(),
            "// 现在装着的",
            "宁可什么都不做，也不能盖掉现有的东西"
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

    // ------------------------------------------------------------ 端到端（真下一个包）

    /// 走完整条路：真发 HTTP 请求 → 边下边算 sha256 → 解压 → 复核 → 落盘 → 记状态。
    ///
    /// 这是唯一一处把「下载」也跑起来的地方 —— 其余用例都假设包已经在本地了。
    #[test]
    fn installs_a_plugin_downloaded_over_http() {
        use super::super::testkit::TestServer;

        let (paths, root) = temp_paths("http");
        let bytes = plugin_zip("demo", MANIFEST, &[("index.js", "// 从市场装来的")]);
        let server = TestServer::start(vec![("/demo-1.0.0.zip".to_string(), bytes.clone())]);

        let outcome = install(
            &paths,
            &InstallRequest {
                name: "demo".to_string(),
                version: "1.0.0".to_string(),
                url: format!("{}/demo-1.0.0.zip", server.base),
                sha256: sha256_of(&bytes),
                approved_permissions: vec!["editor:read".to_string()],
                replace_local: false,
            },
        )
        .expect("应当装成功");

        assert_eq!(outcome.version, "1.0.0");
        assert_eq!(
            server.hits(),
            vec!["/demo-1.0.0.zip"],
            "下载必须真的发出去过"
        );
        assert_eq!(
            fs::read_to_string(paths.root.join("demo").join("index.js")).unwrap(),
            "// 从市场装来的",
            "文件要真的落到插件目录里"
        );

        // 状态文件里必须是 Some([...])，绝不能是 None（None = 按清单全量自动授予）。
        let entry = state::load(&paths.state_path, &paths.data_dir).entry("demo");
        assert_eq!(entry.origin, PluginOrigin::Market);
        assert_eq!(
            entry.granted_permissions,
            Some(vec!["editor:read".to_string()])
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_download_that_fails_its_checksum_never_reaches_the_plugin_directory() {
        use super::super::testkit::TestServer;

        let (paths, root) = temp_paths("http-bad-hash");
        let served = plugin_zip("demo", MANIFEST, &[("index.js", "// 服务器给的东西")]);
        let server = TestServer::start(vec![("/demo-1.0.0.zip".to_string(), served)]);

        let error = install(
            &paths,
            &InstallRequest {
                name: "demo".to_string(),
                version: "1.0.0".to_string(),
                url: format!("{}/demo-1.0.0.zip", server.base),
                // 清单里写的是另一份内容的哈希。
                sha256: sha256_of(b"not the served content at all"),
                approved_permissions: vec![],
                replace_local: false,
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "marketChecksumMismatch");
        assert!(!server.hits().is_empty(), "请求确实发出去过，是内容对不上");
        assert!(
            !paths.root.join("demo").exists(),
            "校验不过的东西一个字节都不许进插件目录"
        );
        assert!(
            !state::load(&paths.state_path, &paths.data_dir)
                .plugins
                .contains_key("demo"),
            "更不该在状态里留下一笔"
        );

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
