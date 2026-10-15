//! 内置插件的版本校正。
//!
//! 要解决的问题：插件代码装在 `<data_dir>/plugins/<名字>/`，是**上一次安装时**从安装包
//! 里拷进去的。应用升级后那份副本不会跟着变 —— 于是新宿主配着老插件，轻则少几个功能，
//! 重则插件直接跑不起来（清单里的 `apiVersion` 与宿主对不上就会被判为不合法）。这个模块
//! 在每次启动时比对版本，把落后的副本更新掉。
//!
//! 三条不能破的规矩：
//!
//! 1. **只更新已装的，绝不替用户新增。** 数据目录里没有的插件整个跳过 —— 自动装上一堆
//!    插件会突然改变开箱界面（工具栏、侧栏、面板一起冒出来），那是另一个决定，不该混在
//!    「修版本」里顺手做掉。
//! 2. **只碰随应用分发的代码文件。** 见 `code_files`：`css-modifier/styles/` 是专门留给
//!    用户放样式表的，`font-pack/fonts/` 是给用户丢字体的 —— 整个目录同步一遍就会把用户
//!    的东西删干净。
//! 3. **用户改过的文件一律不动。** 判断依据是上次写下去时记的哈希（`plugins-state.json`
//!    里每个条目的 `installedFiles`）：对得上才敢覆盖，对不上就跳过。只有在**压根没有历史
//!    记录**时才退而求其次 —— 先把原件备份进 `plugin-data/<名字>/.backup/` 再覆盖。

use super::manifest::{read_manifest_file, PluginManifestFile};
use super::paths::{is_plain_relative, validate_plugin_name, PluginPaths};
use super::state::{self, PluginStateEntry};
use crate::services::notes::AppError;
use crate::updater::sha256_hex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 随应用分发的插件目录名。`tauri.conf.json` 的 `bundle.resources` 把它拷到可执行文件
/// 旁边（Windows 上 `resource_dir()` 返回的就是 exe 所在目录），所以这里只需要一个目录名。
pub const BUNDLED_DIR_NAME: &str = "example-plugins-v2";

const MANIFEST_FILE: &str = "plugin.json";

macro_rules! sync_log {
    ($($arg:tt)*) => {{
        if cfg!(debug_assertions) {
            eprintln!("[plugins:sync] {}", format!($($arg)*));
        }
    }};
}

/// 启动时那次校正的结果。给前端用来决定要不要提示用户。
///
/// 三张表都按**插件名**列，而不是文件：用户关心的是「哪几个插件被更新了」，
/// 文件级细节只进日志。
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// 被覆盖过文件的插件。
    pub updated: Vec<String>,
    /// 因为本地有改动而被跳过的插件。
    pub skipped: Vec<String>,
    /// 本地改动无法判断、把原件备份走了的插件。
    pub backed_up: Vec<String>,
    /// 状态文件本身在这次启动里被升级过（v1 → v2）。
    pub migrated: bool,
}

impl SyncReport {
    /// 什么事都没发生 —— 前端据此保持安静，一个字都不弹。
    pub fn is_empty(&self) -> bool {
        self.updated.is_empty() && self.skipped.is_empty() && self.backed_up.is_empty() && !self.migrated
    }
}

/// 待取的校正报告。
///
/// 校正跑在 `.setup` 里，那时前端还没起来，事件发出去没人接；所以改成**先存后取**：
/// 前端启动时问一次（`plugins_sync_report`），取过即清空 —— 一个进程里只该提示一次。
static PENDING_REPORT: Mutex<Option<SyncReport>> = Mutex::new(None);

fn store_report(report: SyncReport) {
    if report.is_empty() {
        // 没更新任何东西就是常态，不留报告，前端也就不会白问一趟。
        return;
    }
    let mut slot = PENDING_REPORT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *slot = Some(report);
}

/// 取出并清空待取报告。没有就返回 `None`。
pub fn take_report() -> Option<SyncReport> {
    PENDING_REPORT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

/// 内置插件目录的绝对路径（可执行文件旁边）。
pub fn bundled_root(resource_dir: &Path) -> PathBuf {
    resource_dir.join(BUNDLED_DIR_NAME)
}

/// 启动时跑一次校正，把结果存进待取报告。
///
/// 任何失败都只记日志、不往上抛：版本校正是**尽力而为**的附带动作，绝不该因为它挡住
/// 应用启动 —— 插件起不来是小事，打不开笔记是大事。
pub fn sync_at_startup(resource_dir: &Path) {
    let paths = match PluginPaths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            sync_log!("解析数据目录失败，跳过版本校正：{}", error.code);
            return;
        }
    };

    let report = sync_bundled_plugins(&paths, &bundled_root(resource_dir));
    if !report.is_empty() {
        sync_log!(
            "校正完成 更新={:?} 跳过={:?} 已备份={:?} 状态迁移={}",
            report.updated,
            report.skipped,
            report.backed_up,
            report.migrated
        );
    }
    store_report(report);
}

/// 比对内置源与已装副本，更新落后的那些。`bundled_root` 是内置插件目录。
pub fn sync_bundled_plugins(paths: &PluginPaths, bundled_root: &Path) -> SyncReport {
    let mut report = SyncReport::default();

    if !bundled_root.is_dir() {
        // 开发时没走打包流程、或安装包漏带了资源 —— 不是错误，只是没得校正。
        sync_log!("内置插件目录不存在，跳过：{}", bundled_root.display());
        return report;
    }
    if let Err(error) = paths.ensure_dirs() {
        sync_log!("创建插件目录失败，跳过：{}", error.code);
        return report;
    }

    // 顺带把状态文件升级掉：低版本文件在这里被读到就会就地迁移并写回。
    let (mut state, migrated) = state::load_with_migration(&paths.state_path, &paths.data_dir);
    report.migrated = migrated;

    let entries = match fs::read_dir(bundled_root) {
        Ok(entries) => entries,
        Err(error) => {
            sync_log!("读取内置目录失败，跳过：{error}");
            return report;
        }
    };

    let mut state_dirty = false;

    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let bundled_dir = entry.path();

        // 内置目录是我们自己的东西，但仍然照规矩校验：名字会一路变成磁盘路径。
        if validate_plugin_name(&name).is_err() {
            sync_log!("跳过非法插件名：{name:?}");
            continue;
        }

        let installed_dir = paths.root.join(&name);
        if !installed_dir.is_dir() {
            // 规矩 1：只更新已装的。这里是**唯一**决定不播种的地方。
            continue;
        }

        let mut plugin_entry = state.entry(&name);
        if sync_one(&bundled_dir, &installed_dir, &name, paths, &mut plugin_entry, &mut report) {
            state.plugins.insert(name, plugin_entry);
            state_dirty = true;
        }
    }

    if state_dirty {
        if let Err(error) = state::save(&paths.state_path, &state) {
            // 写不进去只影响下次判断（会重跑一遍「无法判断」的分支），不影响这次已经
            // 落地的文件，所以只记日志。
            sync_log!("写回插件状态失败：{}", error.code);
        }
    }

    report
}

/// 一个文件在这次校正里的去向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileOutcome {
    /// 什么都没动。
    Untouched,
    /// 文件没动，但状态里补记了哈希。
    Recorded,
    /// 覆盖了文件（并记下新哈希）。
    Updated,
    /// 用户改过，跳过。
    Skipped,
    /// 没有历史记录、无法判断，先把原件备份走再覆盖。
    BackedUp,
}

impl FileOutcome {
    /// 是否需要把状态写回磁盘。
    fn touched_state(self) -> bool {
        matches!(self, Self::Recorded | Self::Updated | Self::BackedUp)
    }
}

/// 校正单个插件，返回状态条目是否需要写回。
fn sync_one(
    bundled_dir: &Path,
    installed_dir: &Path,
    name: &str,
    paths: &PluginPaths,
    entry: &mut PluginStateEntry,
    report: &mut SyncReport,
) -> bool {
    let bundled_manifest = match read_manifest_file(bundled_dir) {
        Ok(manifest) => manifest,
        Err(error) => {
            sync_log!("跳过 {name}：内置清单读不出来（{}）", error.code);
            return false;
        }
    };

    // 装的那份读不出来（坏文件、或用户正在手改）时判成「不更新」：没必要的东西不动。
    // 一个坏掉的插件不会因为这里顺手重写而变好，但一个正在被编辑的插件可能会被写坏。
    let installed_version = read_manifest_file(installed_dir).ok().map(|it| it.version);

    let updatable = match installed_version.as_deref() {
        Some(version) => version_is_newer(&bundled_manifest.version, version),
        None => false,
    };

    let mut state_dirty = false;

    for relative in code_files(&bundled_manifest) {
        if !is_plain_relative(&relative) {
            // 清单里的 `main` 是自由字符串。虽然这份清单是我们自己写的，仍然照规矩挡一道
            // —— 它马上要变成磁盘路径。
            sync_log!("跳过 {name}/{relative}：清单里的路径不合法");
            continue;
        }

        let source = bundled_dir.join(&relative);
        if !source.is_file() {
            // 清单点名了但文件不在（打包漏了）。不是错误，跳过即可。
            continue;
        }
        let target = installed_dir.join(&relative);

        let outcome = if updatable {
            update_file(&source, &target, &relative, name, paths, entry, &installed_version)
        } else {
            verify_file(&source, &target, &relative, name, entry)
        };

        if outcome.touched_state() {
            state_dirty = true;
        }
        match outcome {
            FileOutcome::Updated => push_once(&mut report.updated, name),
            FileOutcome::Skipped => push_once(&mut report.skipped, name),
            FileOutcome::BackedUp => {
                push_once(&mut report.updated, name);
                push_once(&mut report.backed_up, name);
            }
            FileOutcome::Untouched | FileOutcome::Recorded => {}
        }
    }

    state_dirty
}

/// 内置版本更新时，决定一个文件该不该被覆盖。
fn update_file(
    source: &Path,
    target: &Path,
    relative: &str,
    name: &str,
    paths: &PluginPaths,
    entry: &mut PluginStateEntry,
    installed_version: &Option<String>,
) -> FileOutcome {
    let Some(bundled_hash) = hash_of(source) else {
        sync_log!("读不到内置文件 {name}/{relative}，跳过");
        return FileOutcome::Untouched;
    };

    if !target.is_file() {
        // 内置这一版新增的文件。没有东西可覆盖，直接落地。
        return match write_file(source, target) {
            Ok(()) => {
                remember(entry, relative, bundled_hash);
                FileOutcome::Updated
            }
            Err(error) => {
                sync_log!("写入 {name}/{relative} 失败：{error}");
                FileOutcome::Untouched
            }
        };
    }

    let current = hash_of(target);
    match entry.installed_files.get(relative) {
        // 记过账、且内容自那时起没被动过 —— 可以放心覆盖。
        Some(recorded) if current.as_deref() == Some(recorded.as_str()) => {
            match write_file(source, target) {
                Ok(()) => {
                    remember(entry, relative, bundled_hash);
                    FileOutcome::Updated
                }
                Err(error) => {
                    sync_log!("写入 {name}/{relative} 失败：{error}");
                    FileOutcome::Untouched
                }
            }
        }
        // 记过账、但内容对不上 —— **用户改过，一个字都不动**。
        Some(_) => {
            sync_log!("保留 {name}/{relative}：本地有改动");
            FileOutcome::Skipped
        }
        // 没有历史记录（这一版之前装的插件都是这样）。判断不了，于是把原件留一份
        // 再覆盖：用户真改过的话，东西还在 `.backup/` 里。
        None => {
            if back_up(target, name, relative, installed_version, paths).is_err() {
                // 备份不成功就不覆盖 —— 没有安全网的时候宁可不更新。
                sync_log!("备份 {name}/{relative} 失败，改为跳过");
                return FileOutcome::Skipped;
            }
            match write_file(source, target) {
                Ok(()) => {
                    remember(entry, relative, bundled_hash);
                    FileOutcome::BackedUp
                }
                Err(error) => {
                    sync_log!("写入 {name}/{relative} 失败：{error}");
                    FileOutcome::Untouched
                }
            }
        }
    }
}

/// 内置版本不更新时，只做一件事：**核对并记下哈希**，一个字节都不改。
///
/// 记的是**内置文件**的哈希，不是磁盘上那份的 —— 这个区别是本模块的关键。记内置的那份
/// 意味着「这个文件的原始形态长这样」，于是下次真升级时：
///
/// * 磁盘上那份哈希仍等于原样 → 用户没动过 → 覆盖；
/// * 对不上 → 用户改过 → 跳过；
/// * 磁盘上那份**当时就与内置的不一致**（用户手改过、或来自另一个同版本号的构建）→
///   我们无从判断它该不该算「原样」，于是**不记账**，留给下次走「备份后覆盖」那条路。
///
/// 反过来说，绝对不能拿磁盘上那份的哈希去记账：那等于把用户改过的内容封成「原样」，
/// 下次升级就会心安理得地把它覆盖掉。
fn verify_file(
    source: &Path,
    target: &Path,
    relative: &str,
    name: &str,
    entry: &mut PluginStateEntry,
) -> FileOutcome {
    if entry.installed_files.contains_key(relative) || !target.is_file() {
        return FileOutcome::Untouched;
    }

    let (Some(bundled_hash), Some(current)) = (hash_of(source), hash_of(target)) else {
        return FileOutcome::Untouched;
    };

    if bundled_hash != current {
        sync_log!("{name}/{relative} 与内置的不一致，不记账（下次升级会备份后覆盖）");
        return FileOutcome::Untouched;
    }

    remember(entry, relative, bundled_hash);
    FileOutcome::Recorded
}

/// 一个插件里属于「随应用分发的代码」的文件（相对路径）。
///
/// **只认清单点名的两个**：`plugin.json` 与 `main`。绝不整个目录同步 ——
/// `css-modifier/styles/` 是专门给用户放样式表的、`font-pack/fonts/` 是给用户丢字体的，
/// 一次「顺手全同步」就能把用户的东西删干净。
///
/// 副作用：如果某一版把入口文件改了名（`index.js` → `main.js`），旧的那个会留在原地。
/// 不删是刻意的 —— 我们只写清单点名的文件，删文件这种事不该由版本校正来做。旧入口
/// 因为清单已经不指向它，也不会被加载。
fn code_files(manifest: &PluginManifestFile) -> Vec<String> {
    let mut files = vec![MANIFEST_FILE.to_string()];
    let main = manifest.main.trim();
    if !main.is_empty() && main != MANIFEST_FILE {
        files.push(main.to_string());
    }
    files
}

fn remember(entry: &mut PluginStateEntry, relative: &str, hash: String) {
    entry.installed_files.insert(relative.to_string(), hash);
}

fn push_once(list: &mut Vec<String>, name: &str) {
    if !list.iter().any(|existing| existing == name) {
        list.push(name.to_string());
    }
}

fn hash_of(path: &Path) -> Option<String> {
    sha256_hex(path).ok()
}

fn write_file(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    // 清单里的 `main` 可以是嵌套路径，父目录得先有。
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, target)?;
    Ok(())
}

/// 把要被覆盖的原件另存一份，放在**插件数据目录**而不是插件代码目录里。
///
/// 放数据目录有两个好处：不会因为下一步的覆盖而消失，也不会出现在插件的资源清单里
/// （`assets` 只认几个扩展名）。
fn back_up(
    target: &Path,
    name: &str,
    relative: &str,
    installed_version: &Option<String>,
    paths: &PluginPaths,
) -> Result<(), AppError> {
    let label = safe_version_label(installed_version.as_deref().unwrap_or_default());
    let destination = paths
        .data_dir_for(name)?
        .join(".backup")
        .join(label)
        .join(relative);

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(target, &destination)?;
    sync_log!("已备份 {name}/{relative} → {}", destination.display());
    Ok(())
}

/// 把版本号变成安全的目录名。
///
/// 版本号是清单里的自由字符串（`manifest.rs` 里就是 `String`），直接当路径用的话
/// 一个 `../../x` 就能把备份写到数据目录外面去。
fn safe_version_label(version: &str) -> String {
    let cleaned: String = version
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed
    }
}

/// 把版本号拆成数字段。拆不出来（含非数字、为空）就返回 `None`。
fn version_segments(raw: &str) -> Option<Vec<u64>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 预发布与构建后缀不参与比较：`1.1.0-beta.2` 与 `1.1.0` 当作同一版。
    // 宁可判成相同也不能判成更新 —— 见 `version_is_newer`。
    let core = trimmed.split(['-', '+']).next().unwrap_or(trimmed);
    let mut segments = Vec::new();
    for part in core.split('.') {
        if part.is_empty() {
            return None;
        }
        segments.push(part.parse::<u64>().ok()?);
    }
    Some(segments)
}

/// 内置版本是否比已装的**更新**。
///
/// 只有两边的版本号都拆得出数字段时才可能为 `true`；**拆不出来一律返回 `false`**。
/// 这一点是刻意的：版本号在清单里是自由字符串（` "" `、`1.0-beta`、`v2` 都合法），
/// 一旦把「比不了」当成「该更新」，一个写歪的版本号就能把用户的插件冲掉。宁可不动。
pub fn version_is_newer(bundled: &str, installed: &str) -> bool {
    let (Some(a), Some(b)) = (version_segments(bundled), version_segments(installed)) else {
        return false;
    };

    // 补齐到等长再逐位比：`1.0` 与 `1.0.0` 是同一版。
    let len = a.len().max(b.len());
    for index in 0..len {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ------------------------------------------------------------ 版本比较

    #[test]
    fn compares_dotted_versions_numerically() {
        assert!(version_is_newer("1.1.0", "1.0.0"));
        assert!(version_is_newer("2.0.0", "1.9.9"));
        // 按数字比，不是按字符串：`1.10.0` 比 `1.9.0` 新。
        assert!(version_is_newer("1.10.0", "1.9.0"));
        assert!(!version_is_newer("1.9.0", "1.10.0"));
        assert!(!version_is_newer("1.0.0", "1.0.0"));
        assert!(!version_is_newer("1.0.0", "1.0.1"));
    }

    #[test]
    fn treats_padding_and_suffixes_as_equal() {
        assert!(!version_is_newer("1.0", "1.0.0"), "缺省段补 0，视为同一版");
        assert!(!version_is_newer("1.0.0", "1.0"));
        assert!(
            !version_is_newer("1.1.0", "1.1.0-beta.2"),
            "预发布后缀不参与比较，且绝不能因此判成更新"
        );
        assert!(!version_is_newer("1.1.0+build.7", "1.1.0"));
    }

    #[test]
    fn refuses_to_compare_unparseable_versions() {
        // 这一组是防线本身：比不了就当「不更新」。反过来写的话，一个写歪的版本号
        // 就能把用户改过的插件冲掉。
        for (bundled, installed) in [
            ("", "1.0.0"),
            ("1.0.0", ""),
            ("", ""),
            ("v2", "1.0.0"),
            ("1.0.0-beta", "not-a-version"),
            ("1..0", "1.0.0"),
            ("1.0.", "1.0.0"),
        ] {
            assert!(
                !version_is_newer(bundled, installed),
                "{bundled:?} vs {installed:?} 拆不出数字段，必须判为不更新"
            );
        }
    }

    #[test]
    fn version_label_is_safe_as_a_directory_name() {
        assert_eq!(safe_version_label("1.0.0"), "1.0.0");
        assert_eq!(safe_version_label("  1.0.0  "), "1.0.0");
        assert_eq!(safe_version_label(""), "unknown");
        assert_eq!(safe_version_label("..."), "unknown");
        assert_eq!(safe_version_label("../../etc"), "_.._etc");
        assert_eq!(safe_version_label("1.0/a\\b"), "1.0_a_b");
        assert!(
            !safe_version_label("../../etc").contains('/'),
            "版本号是自由字符串，绝不能当路径用"
        );
    }

    #[test]
    fn code_files_covers_manifest_and_entry_only() {
        let manifest = manifest_with("index.js");
        assert_eq!(code_files(&manifest), vec!["plugin.json", "index.js"]);

        // 入口就是清单本身时不要出现两次。
        let mut weird = manifest_with("plugin.json");
        weird.main = "plugin.json".to_string();
        assert_eq!(code_files(&weird), vec!["plugin.json"]);

        // 没有 main 也不能慌。
        let mut empty = manifest_with("index.js");
        empty.main = String::new();
        assert_eq!(code_files(&empty), vec!["plugin.json"]);
    }

    // ------------------------------------------------------------ 目录搭建

    fn manifest_with(main: &str) -> PluginManifestFile {
        PluginManifestFile {
            name: "demo".to_string(),
            version: String::new(),
            main: main.to_string(),
            description: String::new(),
            api_version: 2,
            author: None,
            homepage: None,
            permissions: Vec::new(),
            contributes: None,
        }
    }

    struct Fixture {
        root: PathBuf,
        paths: PluginPaths,
        bundled: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let mut root = std::env::temp_dir();
            root.push(format!("floral-plugin-sync-{tag}-{}", uuid::Uuid::new_v4()));
            let data_dir = root.join("notes");
            let paths = PluginPaths::from_data_dir(&data_dir);
            paths.ensure_dirs().expect("ensure dirs");
            let bundled = root.join("bundled");
            fs::create_dir_all(&bundled).expect("create bundled root");
            Self { root, paths, bundled }
        }

        /// 在内置源里放一个插件。
        fn bundle(&self, name: &str, version: &str, entry_body: &str) {
            write_plugin(&self.bundled, name, version, entry_body);
        }

        /// 在数据目录里放一个「已装」的插件。
        fn install(&self, name: &str, version: &str, entry_body: &str) {
            write_plugin(&self.paths.root, name, version, entry_body);
        }

        fn sync(&self) -> SyncReport {
            sync_bundled_plugins(&self.paths, &self.bundled)
        }

        fn load_state(&self) -> state::PluginStateFile {
            state::load(&self.paths.state_path, &self.paths.data_dir)
        }

        fn installed(&self, name: &str, file: &str) -> String {
            fs::read_to_string(self.paths.root.join(name).join(file)).expect("read installed file")
        }

        fn bundled_file(&self, name: &str, file: &str) -> String {
            fs::read_to_string(self.bundled.join(name).join(file)).expect("read bundled file")
        }

        /// 改写已装的那份，模拟用户手改。
        fn user_edit(&self, name: &str, file: &str, body: &str) {
            fs::write(self.paths.root.join(name).join(file), body).expect("write user edit");
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).ok();
        }
    }

    fn write_plugin(root: &Path, name: &str, version: &str, entry_body: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).expect("create plugin dir");
        let manifest = format!(
            r#"{{ "name": "{name}", "version": "{version}", "main": "index.js", "apiVersion": 2 }}"#
        );
        fs::write(dir.join(MANIFEST_FILE), manifest).expect("write manifest");
        fs::write(dir.join("index.js"), entry_body).expect("write entry");
    }

    fn add_user_file(fixture: &Fixture, name: &str, relative: &str, body: &str) {
        let path = fixture.paths.root.join(name).join(relative);
        fs::create_dir_all(path.parent().unwrap()).expect("create parent");
        let mut file = fs::File::create(path).expect("create file");
        file.write_all(body.as_bytes()).expect("write file");
    }

    // ------------------------------------------------------------ 校正行为

    #[test]
    fn does_not_install_plugins_the_user_does_not_have() {
        let fixture = Fixture::new("no-seed");
        fixture.bundle("line-numbers", "1.0.0", "// bundled");

        let report = fixture.sync();

        assert!(
            !fixture.paths.root.join("line-numbers").exists(),
            "规矩 1：只更新已装的，绝不替用户新增"
        );
        assert!(report.is_empty(), "什么都没做就不该有报告");
    }

    #[test]
    fn missing_bundled_dir_is_not_an_error() {
        let fixture = Fixture::new("no-resources");
        fixture.install("line-numbers", "1.0.0", "// installed");

        let mut missing = std::env::temp_dir();
        missing.push(format!("floral-absent-{}", uuid::Uuid::new_v4()));
        let report = sync_bundled_plugins(&fixture.paths, &missing);

        assert!(report.is_empty());
        assert_eq!(fixture.installed("line-numbers", "index.js"), "// installed");
    }

    #[test]
    fn same_version_only_records_hashes() {
        let fixture = Fixture::new("same-version");
        fixture.bundle("line-numbers", "1.0.0", "// code");
        fixture.install("line-numbers", "1.0.0", "// code");

        let report = fixture.sync();

        assert_eq!(fixture.installed("line-numbers", "index.js"), "// code", "一个字节都不该改");
        assert!(report.updated.is_empty());

        // 两个树里的内容按构造就是同一份字节，所以「记内置的哈希」与「记磁盘上那份的
        // 哈希」在这里取值相同，这条断言分不出来 —— 分得出来的是「内容不一致时**不**
        // 记账」，另有一条测试专管（`file_modified_at_equal_version_is_never_blessed_as_pristine`）。
        // 这里先钉住「版本相同时要顺手把哈希记下来」。
        let entry = fixture.load_state().entry("line-numbers");
        let expected =
            sha256_hex(&fixture.paths.root.join("line-numbers").join("index.js")).unwrap();
        assert_eq!(
            entry.installed_files.get("index.js"),
            Some(&expected),
            "版本相同时要顺手把哈希记下来，下次升级才有判断依据"
        );
        assert!(
            entry.installed_files.contains_key(MANIFEST_FILE),
            "清单文件也要记账"
        );
    }

    #[test]
    fn newer_version_overwrites_pristine_files() {
        let fixture = Fixture::new("update");
        fixture.bundle("line-numbers", "1.1.0", "// new code");
        fixture.install("line-numbers", "1.0.0", "// old code");

        let report = fixture.sync();

        assert_eq!(fixture.installed("line-numbers", "index.js"), "// new code");
        assert_eq!(fixture.installed("line-numbers", MANIFEST_FILE), fixture.bundled_file("line-numbers", MANIFEST_FILE));
        assert_eq!(report.updated, vec!["line-numbers".to_string()]);
        assert!(report.skipped.is_empty());
    }

    /// 这条是整个模块存在的理由：升级要发生，但用户改过的那一行必须留着。
    #[test]
    fn update_skips_the_file_the_user_touched_and_keeps_the_rest() {
        let fixture = Fixture::new("keep-edits");
        // 先同版本同步一次，把哈希记上（模拟「装过、也同步过」的正常状态）。
        fixture.bundle("line-numbers", "1.0.0", "// code");
        fixture.install("line-numbers", "1.0.0", "// code");
        fixture.sync();

        // 用户改了入口脚本；内置这一版也升级了。
        fixture.user_edit("line-numbers", "index.js", "// 用户自己改的");
        fixture.bundle("line-numbers", "1.1.0", "// new code");

        let report = fixture.sync();

        assert_eq!(
            fixture.installed("line-numbers", "index.js"),
            "// 用户自己改的",
            "用户改过的文件一个字都不能动"
        );
        assert_eq!(
            fixture.installed("line-numbers", MANIFEST_FILE),
            fixture.bundled_file("line-numbers", MANIFEST_FILE),
            "同一个插件里没被动过的文件照样要更新"
        );
        assert_eq!(report.skipped, vec!["line-numbers".to_string()]);
        assert_eq!(report.updated, vec!["line-numbers".to_string()]);
    }

    #[test]
    fn file_modified_at_equal_version_is_never_blessed_as_pristine() {
        let fixture = Fixture::new("no-bless");
        fixture.bundle("line-numbers", "1.0.0", "// code");
        fixture.install("line-numbers", "1.0.0", "// 用户改的");

        fixture.sync();

        assert!(
            fixture
                .load_state()
                .entry("line-numbers")
                .installed_files
                .get("index.js")
                .is_none(),
            "内容与内置的不一致时不记账 —— 否则下次升级会把用户改的当成原样覆盖掉"
        );
    }

    #[test]
    fn unknown_provenance_is_backed_up_then_overwritten() {
        let fixture = Fixture::new("backup");
        // 装的是老版本、且这次之前从没同步过 —— 没有哈希可依，是唯一判断不了的情况。
        fixture.bundle("line-numbers", "1.1.0", "// new code");
        fixture.install("line-numbers", "1.0.0", "// old code");

        let report = fixture.sync();

        assert_eq!(fixture.installed("line-numbers", "index.js"), "// new code");
        assert_eq!(report.backed_up, vec!["line-numbers".to_string()]);

        let backup = fixture
            .paths
            .data_root
            .join("line-numbers")
            .join(".backup")
            .join("1.0.0")
            .join("index.js");
        assert_eq!(
            fs::read_to_string(&backup).expect("备份应存在"),
            "// old code",
            "判断不了的旧版本必须留一份原件"
        );
    }

    #[test]
    fn backs_up_into_plugin_data_not_plugin_code() {
        let fixture = Fixture::new("backup-location");
        fixture.bundle("line-numbers", "1.1.0", "// new code");
        fixture.install("line-numbers", "1.0.0", "// old code");

        fixture.sync();

        let inside_plugin = fixture.paths.root.join("line-numbers").join(".backup");
        assert!(
            !inside_plugin.exists(),
            "备份不能放进插件代码目录 —— 那里会随下次整体覆盖一起没了"
        );
    }

    #[test]
    fn never_touches_files_that_are_not_part_of_the_bundle() {
        let fixture = Fixture::new("user-files");
        fixture.bundle("css-modifier", "1.1.0", "// new code");
        fixture.install("css-modifier", "1.0.0", "// old code");

        // css-modifier 的 styles/ 是**专门给用户放样式表**的目录，font-pack 的 fonts/ 同理。
        add_user_file(&fixture, "css-modifier", "styles/my-theme.css", "body { color: red }");
        add_user_file(&fixture, "font-pack", "fonts/notes.txt", "用户的字体说明");

        fixture.sync();

        assert_eq!(
            fs::read_to_string(fixture.paths.root.join("css-modifier/styles/my-theme.css")).unwrap(),
            "body { color: red }",
            "规矩 2：用户自己放进去的文件一个都不能动"
        );
        assert_eq!(
            fixture.installed("css-modifier", "index.js"),
            "// new code",
            "同一个插件的代码文件照常更新"
        );
    }

    #[test]
    fn skips_plugins_whose_installed_manifest_is_unreadable() {
        let fixture = Fixture::new("broken-installed");
        fixture.bundle("line-numbers", "1.1.0", "// new code");
        fixture.install("line-numbers", "1.0.0", "// old code");
        // 装的那份清单坏了 —— 版本无从比较。
        fs::write(
            fixture.paths.root.join("line-numbers").join(MANIFEST_FILE),
            "{ 这不是 json",
        )
        .unwrap();

        let report = fixture.sync();

        assert!(
            report.is_empty(),
            "读不出已装版本时不能猜「它更旧」，那等于借机重写一个正在手改的插件"
        );
        assert_eq!(fixture.installed("line-numbers", "index.js"), "// old code");
    }

    #[test]
    fn migrates_state_file_as_part_of_the_same_pass() {
        let fixture = Fixture::new("migrate");
        fixture.install("demo", "1.0.0", "// code");
        fs::write(
            &fixture.paths.state_path,
            format!(
                r#"{{ "version": 1, "dataDir": "{}", "plugins": {{ "demo": {{ "enabled": false }} }} }}"#,
                fixture.paths.data_dir.display().to_string().replace('\\', "\\\\")
            ),
        )
        .unwrap();

        let report = fixture.sync();

        assert!(report.migrated, "启动时的校正要顺手把状态文件升级掉");
        assert!(
            !fixture.load_state().entry("demo").enabled,
            "升级不该动用户的启停设置"
        );
    }

    #[test]
    fn report_is_empty_when_nothing_happened() {
        let fixture = Fixture::new("quiet");
        fixture.bundle("line-numbers", "1.0.0", "// code");
        fixture.install("line-numbers", "1.0.0", "// code");

        // 第一次同步会记账（状态变了），但**报告**不该因此非空 ——
        // 前端只该在真更新了东西时才出声。
        let report = fixture.sync();
        assert!(report.is_empty(), "只记账不算「更新了插件」");
    }

    // ------------------------------------------------------------ 报告

    #[test]
    fn store_report_keeps_only_meaningful_results() {
        // 全局静态跨测试共享，用 take 清干净，避免互相干扰。
        let _ = take_report();

        store_report(SyncReport::default());
        assert!(take_report().is_none(), "空报告不该留下来让前端白问一趟");

        store_report(SyncReport {
            updated: vec!["line-numbers".to_string()],
            ..SyncReport::default()
        });
        let taken = take_report().expect("有内容就该留报告");
        assert_eq!(taken.updated, vec!["line-numbers".to_string()]);
        assert!(take_report().is_none(), "取过即清空 —— 一个进程只提示一次");
    }

    #[test]
    fn bundled_root_sits_next_to_the_executable() {
        let root = bundled_root(Path::new("X:/app"));
        assert_eq!(root, PathBuf::from("X:/app").join(BUNDLED_DIR_NAME));
    }
}
