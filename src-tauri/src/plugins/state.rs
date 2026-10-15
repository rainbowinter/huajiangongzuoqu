//! 插件启停状态与权限授予的持久化（`<data_dir>/plugins-state.json`）。
//!
//! 权限授予用 `Option<Vec<String>>` 表达三态，这点是刻意的：
//!
//! * `None` —— 该插件从未被用户配置过。语义是「按清单声明自动授予」。
//! * `Some(list)` —— 用户显式配置过（可能是授予，也可能是撤销后的子集）。
//!
//! 有了这个区分，`plugins_list` 就可以保持**只读**：不需要为了记录"首次自动授予"
//! 而反写磁盘。

use super::errors::{app_error, with_detail};
use crate::json_io::write_json_atomic;
use crate::services::notes::AppError;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 状态文件的当前格式版本。
///
/// * 1 —— 初版：每个插件只有 `enabled` 与 `grantedPermissions`。
/// * 2 —— 每个插件增加 `installedFiles`：随应用分发的那些文件在被写下去时的哈希，
///   供版本校正判断「这个文件用户动过没有」。
/// * 3 —— 每个插件增加 `origin`：这个插件是随应用分发的，还是从插件市场装的。
///   内置版本校正靠它避开市场插件（见 [`PluginOrigin`]）。
///
/// 这个字段**一直就在文件里，却从来没人读过**。现在补上迁移：`load` 读到低版本会就地
/// 升级并写回。2 → 3 不需要搬数据（老文件里的插件当然都是随应用分发的，缺省即
/// `Bundled`），但壳子得先立着 —— 将来真要改字段含义时，低版本文件才会被自动送进
/// `migrate`。
const STATE_VERSION: u32 = 3;

/// 文件里没有 `version` 字段时的取值。
///
/// 取当前版本而不是 1：这个字段从初版起就是无条件写出的，所以**应用自己写的文件一定
/// 带着它**；缺字段只可能是手写或外部生成的，当成新文件处理是安全的（1 → 2 无数据要搬）。
fn default_state_version() -> u32 {
    STATE_VERSION
}

fn default_enabled() -> bool {
    // 新放进插件目录的插件默认是启用的，否则用户会以为没生效。
    true
}

/// 插件是打哪来的。
///
/// **存在的唯一理由是划清管辖范围**：内置版本校正（`sync`）负责把随应用分发的那几个
/// 插件刷到最新，但它对市场插件**无权过问** —— 一个市场装的 `outline 3.0` 会被内置的
/// `outline 2.1` 当成「版本更低」或「版本更高」乱来，而两者根本不是一套东西。
///
/// 缺省是 `Bundled`：老状态文件里没有这个字段，而那些插件确实都是随应用分发或用户自己
/// 放进去的。宁可把它们当成内置的（最多是被校正一次，还会先备份），也不能反过来 ——
/// 反过来等于宣布「所有老插件都归市场管」，那才是真的乱。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginOrigin {
    #[default]
    Bundled,
    Market,
}

impl PluginOrigin {
    fn is_bundled(&self) -> bool {
        matches!(self, Self::Bundled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateEntry {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub granted_permissions: Option<Vec<String>>,
    /// 随应用分发的插件文件 → 上次写下去时的 SHA-256。
    ///
    /// 版本校正靠它判断「这个文件用户改过没有」：**只有哈希对得上才敢覆盖**。
    /// 键是插件目录下的相对路径（`plugin.json`、`index.js`…）。
    ///
    /// 空表是常态：这一版之前根本没有这个字段，老用户的每个插件都是空的，此时按
    /// 「无法判断」处理（见 `sync`）。空表不写进文件，免得状态文件被一堆 `{}` 撑肿。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub installed_files: BTreeMap<String, String>,
    /// 打哪来的。缺省 `Bundled`（见 [`PluginOrigin`]）。
    ///
    /// `Bundled` 不写进文件：绝大多数插件都是这一类，写了只是把状态文件撑肿。
    #[serde(default, skip_serializing_if = "PluginOrigin::is_bundled")]
    pub origin: PluginOrigin,
}

impl Default for PluginStateEntry {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            granted_permissions: None,
            installed_files: BTreeMap::new(),
            origin: PluginOrigin::Bundled,
        }
    }
}

impl PluginStateEntry {
    /// 结合清单声明的权限，算出实际生效的授予集合。
    ///
    /// * 从未配置过（`None`）→ 全量自动授予清单里声明的权限。
    /// * 已配置过 → 取「已授予 ∩ 清单声明」，这样插件升级后不再声明的权限会自动失效。
    pub fn effective_permissions(&self, declared: &[String]) -> Vec<String> {
        match &self.granted_permissions {
            None => declared.to_vec(),
            Some(granted) => declared
                .iter()
                .filter(|permission| granted.contains(permission))
                .cloned()
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateFile {
    #[serde(default = "default_state_version")]
    pub version: u32,
    /// 这份状态属于哪个数据目录。数据目录迁移后旧状态不再适用，会被重置。
    #[serde(default)]
    pub data_dir: String,
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginStateEntry>,
}

impl Default for PluginStateFile {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            data_dir: String::new(),
            plugins: BTreeMap::new(),
        }
    }
}

impl PluginStateFile {
    pub fn entry(&self, name: &str) -> PluginStateEntry {
        self.plugins.get(name).cloned().unwrap_or_default()
    }
}

/// 把状态文件升到 [`STATE_VERSION`]，返回是否真的动过。
///
/// 迁移**逐级进行**，不要写成直接跳到最新版：将来加到 4 时，一个从 1 升上来的文件仍然
/// 要依次跑过 1→2、2→3、3→4 三步，跳过去会漏掉中间那步的数据搬动。现在逐级加分支即可。
///
/// 目前两步都不需要搬数据：新增的 `installedFiles` 是一张空表、新增的 `origin` 缺省就是
/// `Bundled`，老文件靠 `#[serde(default)]` 照样读得出来，这里只把版本号推上去。
fn migrate(state: &mut PluginStateFile) -> bool {
    if state.version >= STATE_VERSION {
        return false;
    }
    state.version = STATE_VERSION;
    true
}

/// 读取状态文件，**并在发现低版本时就地升级**（升级结果会写回磁盘）。
///
/// 第二项返回值表示这次是否真的升级过 —— 启动时的版本校正要拿它去告诉用户
/// 「顺手把状态文件也升了」。
pub fn load_with_migration(path: &Path, data_dir: &Path) -> (PluginStateFile, bool) {
    let mut state = read(path, data_dir);
    let migrated = migrate(&mut state);
    if migrated {
        // 升级失败不是致命问题：文件照样读得出来，只是版本号留在旧值，下次启动再试。
        let _ = save(path, &state);
    }
    (state, migrated)
}

/// 读取状态文件。文件缺失、为空、损坏，或属于另一个数据目录时，返回一个干净的状态。
pub fn load(path: &Path, data_dir: &Path) -> PluginStateFile {
    load_with_migration(path, data_dir).0
}

/// 状态文件的纯读取，不带任何写盘副作用。损坏的文件先另存现场再重新开始，不静默丢弃。
fn read(path: &Path, data_dir: &Path) -> PluginStateFile {
    let expected = data_dir.display().to_string();

    if !path.is_file() {
        return PluginStateFile {
            data_dir: expected,
            ..PluginStateFile::default()
        };
    }

    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => {
            return PluginStateFile {
                data_dir: expected,
                ..PluginStateFile::default()
            }
        }
    };

    match serde_json::from_str::<PluginStateFile>(&raw) {
        // 数据目录变了：插件的启停与授权不再适用于新目录，重置但保留文件不删。
        Ok(state) if !state.data_dir.is_empty() && state.data_dir != expected => PluginStateFile {
            data_dir: expected,
            ..PluginStateFile::default()
        },
        Ok(mut state) => {
            state.data_dir = expected;
            state
        }
        Err(_) => {
            let stamp = Utc::now().format("%Y%m%d%H%M%S");
            let backup = path.with_extension(format!("corrupt-{stamp}.json"));
            let _ = fs::rename(path, &backup);
            PluginStateFile {
                data_dir: expected,
                ..PluginStateFile::default()
            }
        }
    }
}

pub fn save(path: &Path, state: &PluginStateFile) -> Result<(), AppError> {
    write_json_atomic(path, state)
}

/// 校验插件名确实是插件目录下的一个条目，避免给不存在的插件写状态。
pub fn ensure_known(paths: &super::paths::PluginPaths, name: &str) -> Result<PathBuf, AppError> {
    super::paths::plugin_dir(paths, name)
}

pub fn set_enabled(
    paths: &super::paths::PluginPaths,
    name: &str,
    enabled: bool,
) -> Result<PluginStateFile, AppError> {
    ensure_known(paths, name)?;

    let mut state = load(&paths.state_path, state_dir(paths)?);
    state.plugins.entry(name.to_string()).or_default().enabled = enabled;
    save(&paths.state_path, &state)?;
    Ok(state)
}

/// 设置已授予权限。允许集合必须是清单声明权限的子集，防止越权写入。
pub fn set_granted_permissions(
    paths: &super::paths::PluginPaths,
    name: &str,
    declared: &[String],
    granted: Vec<String>,
) -> Result<PluginStateFile, AppError> {
    ensure_known(paths, name)?;

    for permission in &granted {
        if !declared.contains(permission) {
            return Err(with_detail(
                app_error(
                    "pluginPermissionNotDeclared",
                    format!("插件 {name} 未在清单中声明权限 {permission}"),
                ),
                "permission",
                permission.clone(),
            ));
        }
    }

    let mut state = load(&paths.state_path, state_dir(paths)?);
    let entry = state.plugins.entry(name.to_string()).or_default();
    entry.granted_permissions = Some(granted);
    save(&paths.state_path, &state)?;
    Ok(state)
}

fn state_dir(paths: &super::paths::PluginPaths) -> Result<&Path, AppError> {
    paths
        .state_path
        .parent()
        .ok_or_else(|| app_error("pluginStatePathInvalid", "插件状态路径不合法"))
}

/// 记下一笔「从插件市场装的」。
///
/// **一次读、一次写**：来源与授权必须同时落地。拆成两次读改写会出现「来源记了、权限没记」
/// 的中间态，而那个状态下 `grantedPermissions` 是 `None` —— 语义是「按清单声明全量授予」，
/// 插件之后偷偷加一个权限就立刻生效，用户当初确认的那份清单形同虚设。
///
/// ⚠️ 所以这里**一定要写 `Some(...)`**，永远不留 `None`。这是「装之前列清楚、我确认」
/// 这条承诺能在代码里成立的前提。
pub fn record_market_install(
    paths: &super::paths::PluginPaths,
    name: &str,
    granted: Vec<String>,
) -> Result<PluginStateFile, AppError> {
    super::paths::validate_plugin_name(name)?;

    let mut state = load(&paths.state_path, state_dir(paths)?);
    let entry = state.plugins.entry(name.to_string()).or_default();
    entry.origin = PluginOrigin::Market;
    entry.granted_permissions = Some(granted);
    // 市场插件不参与内置校正，`installedFiles` 那套哈希对它没有意义。
    entry.installed_files.clear();
    // 覆盖安装（更新/降级）时**不动** `enabled`：用户停用它是个决定，不该被一次更新抹掉。
    save(&paths.state_path, &state)?;
    Ok(state)
}

/// 卸载时把这个插件的状态条目整个删掉。
///
/// 删掉而不是留个空壳，是因为留下的 `grantedPermissions` 会在**下次装同一个名字**时被
/// 直接沿用 —— 那等于绕过了「装之前我确认」这一步。
pub fn record_uninstall(
    paths: &super::paths::PluginPaths,
    name: &str,
) -> Result<PluginStateFile, AppError> {
    let mut state = load(&paths.state_path, state_dir(paths)?);
    state.plugins.remove(name);
    save(&paths.state_path, &state)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state(tag: &str) -> (PathBuf, PathBuf) {
        let mut dir = std::env::temp_dir();
        dir.push(format!("floral-plugin-state-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let data_dir = dir.join("notes");
        fs::create_dir_all(&data_dir).expect("create data dir");
        let path = data_dir.join("plugins-state.json");
        (path, data_dir)
    }

    fn declared() -> Vec<String> {
        vec!["editor:read".to_string(), "ui:panel".to_string()]
    }

    #[test]
    fn missing_file_yields_enabled_default() {
        let (path, data_dir) = temp_state("missing");
        let state = load(&path, &data_dir);

        let entry = state.entry("demo");
        assert!(entry.enabled, "新插件应默认启用");
        assert!(
            entry.granted_permissions.is_none(),
            "从未配置过时应是 None，才能保持 plugins_list 只读"
        );

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }

    #[test]
    fn unconfigured_entry_auto_grants_declared_permissions() {
        let entry = PluginStateEntry::default();
        assert_eq!(
            entry.effective_permissions(&declared()),
            declared(),
            "从未配置过的插件应按清单声明自动授予"
        );
    }

    #[test]
    fn explicit_grant_is_intersected_with_declared() {
        let entry = PluginStateEntry {
            enabled: true,
            granted_permissions: Some(vec![
                "editor:read".to_string(),
                "ui:panel".to_string(),
                "notes:write".to_string(), // 清单里没有，应被剔除
            ]),
            ..PluginStateEntry::default()
        };

        assert_eq!(
            entry.effective_permissions(&declared()),
            vec!["editor:read".to_string(), "ui:panel".to_string()],
            "插件升级后不再声明的权限应自动失效"
        );
    }

    #[test]
    fn revoked_permissions_stay_revoked() {
        let entry = PluginStateEntry {
            enabled: true,
            granted_permissions: Some(vec!["editor:read".to_string()]),
            ..PluginStateEntry::default()
        };

        assert_eq!(
            entry.effective_permissions(&declared()),
            vec!["editor:read".to_string()]
        );
    }

    #[test]
    fn save_then_load_roundtrips() {
        let (path, data_dir) = temp_state("roundtrip");

        let mut state = PluginStateFile {
            data_dir: data_dir.display().to_string(),
            ..PluginStateFile::default()
        };
        state.plugins.insert(
            "demo".to_string(),
            PluginStateEntry {
                enabled: false,
                granted_permissions: Some(vec!["editor:read".to_string()]),
                ..PluginStateEntry::default()
            },
        );
        save(&path, &state).unwrap();

        let loaded = load(&path, &data_dir);
        let entry = loaded.entry("demo");
        assert!(!entry.enabled);
        assert_eq!(
            entry.granted_permissions,
            Some(vec!["editor:read".to_string()])
        );

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }

    #[test]
    fn state_from_another_data_dir_is_reset() {
        let (path, data_dir) = temp_state("migrated");

        let mut state = PluginStateFile {
            data_dir: "X:/other/place".to_string(),
            ..PluginStateFile::default()
        };
        state.plugins.insert(
            "demo".to_string(),
            PluginStateEntry {
                enabled: false,
                granted_permissions: Some(vec![]),
                ..PluginStateEntry::default()
            },
        );
        save(&path, &state).unwrap();

        let loaded = load(&path, &data_dir);
        assert!(
            loaded.entry("demo").enabled,
            "数据目录迁移后旧状态不再适用，应回到默认启用"
        );
        assert_eq!(loaded.data_dir, data_dir.display().to_string());

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }

    #[test]
    fn corrupt_state_file_is_quarantined() {
        let (path, data_dir) = temp_state("corrupt");
        fs::write(&path, "not json at all").unwrap();

        let state = load(&path, &data_dir);
        assert!(state.entry("demo").enabled);

        let kept = fs::read_dir(&data_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains("corrupt"));
        assert!(kept, "损坏的状态文件应被另存现场");

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }

    // ------------------------------------------------------------ 版本迁移

    /// 手写一份 v1 格式的状态文件（那时没有 `installedFiles`）。
    fn write_v1_state(path: &Path, data_dir: &Path) {
        let raw = format!(
            r#"{{
                "version": 1,
                "dataDir": "{}",
                "plugins": {{
                    "demo": {{ "enabled": false, "grantedPermissions": ["editor:read"] }}
                }}
            }}"#,
            data_dir.display().to_string().replace('\\', "\\\\")
        );
        fs::write(path, raw).unwrap();
    }

    #[test]
    fn migrates_v1_state_and_keeps_user_settings() {
        let (path, data_dir) = temp_state("migrate-v1");
        write_v1_state(&path, &data_dir);

        let (state, migrated) = load_with_migration(&path, &data_dir);

        assert!(migrated, "读到 v1 应报告升级过");
        assert_eq!(state.version, STATE_VERSION);

        // 升级的**全部意义**就在这里：启停与授权是用户设置的，必须原样留着。
        let entry = state.entry("demo");
        assert!(!entry.enabled, "升级不该把停用的插件重新启用");
        assert_eq!(
            entry.granted_permissions,
            Some(vec!["editor:read".to_string()]),
            "升级不该动用户配过的授权"
        );
        assert!(
            entry.installed_files.is_empty(),
            "老文件没有哈希记录，升级后应是空表（按「无法判断」处理）"
        );

        // 版本号要真的落盘，否则每次启动都会重跑一遍迁移。
        let (again, migrated_again) = load_with_migration(&path, &data_dir);
        assert!(!migrated_again, "第二次读不该再报升级");
        assert_eq!(again.version, STATE_VERSION);

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }

    #[test]
    fn current_version_file_is_not_migrated() {
        let (path, data_dir) = temp_state("no-migrate");
        save(
            &path,
            &PluginStateFile {
                data_dir: data_dir.display().to_string(),
                ..PluginStateFile::default()
            },
        )
        .unwrap();

        let (_, migrated) = load_with_migration(&path, &data_dir);
        assert!(!migrated, "新版本的文件不该被当作待升级");

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }

    #[test]
    fn installed_file_hashes_roundtrip() {
        let (path, data_dir) = temp_state("hashes");

        let mut state = PluginStateFile {
            data_dir: data_dir.display().to_string(),
            ..PluginStateFile::default()
        };
        state
            .plugins
            .entry("demo".to_string())
            .or_default()
            .installed_files
            .insert("index.js".to_string(), "abc123".to_string());
        save(&path, &state).unwrap();

        let loaded = load(&path, &data_dir);
        assert_eq!(
            loaded.entry("demo").installed_files.get("index.js"),
            Some(&"abc123".to_string()),
            "哈希必须能跨进程存活 —— 版本校正全靠它判断文件有没有被改过"
        );

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }

    #[test]
    fn empty_hash_table_is_not_serialized() {
        let (path, data_dir) = temp_state("compact");

        let mut state = PluginStateFile {
            data_dir: data_dir.display().to_string(),
            ..PluginStateFile::default()
        };
        state.plugins.insert("demo".to_string(), PluginStateEntry::default());
        save(&path, &state).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("installedFiles"),
            "空哈希表不该写进文件，否则状态文件会被一堆空对象撑肿：{raw}"
        );
        assert!(
            !raw.contains("origin"),
            "随应用分发是绝大多数情况，不该写进文件：{raw}"
        );

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }

    // ------------------------------------------------------------ 市场装的插件

    fn market_paths(tag: &str) -> (super::super::paths::PluginPaths, PathBuf) {
        let mut root = std::env::temp_dir();
        root.push(format!("floral-plugin-state-{tag}-{}", uuid::Uuid::new_v4()));
        let data_dir = root.join("notes");
        let paths = super::super::paths::PluginPaths::from_data_dir(&data_dir);
        paths.ensure_dirs().expect("ensure dirs");
        (paths, root)
    }

    #[test]
    fn market_install_records_origin_and_never_leaves_grants_unset() {
        let (paths, root) = market_paths("market");
        let granted = vec!["editor:read".to_string(), "ui:panel".to_string()];

        let state = record_market_install(&paths, "demo", granted.clone()).unwrap();
        let entry = state.entry("demo");

        assert_eq!(entry.origin, PluginOrigin::Market);
        assert_eq!(
            entry.granted_permissions,
            Some(granted.clone()),
            "必须写 Some(...)：None 的语义是「按清单全量自动授予」，那样插件之后偷偷加一个\
             权限就立刻生效，用户确认过的清单形同虚设"
        );

        // 用户没确认过的权限，即便插件后来声明了也不生效。
        let declared = vec![
            "editor:read".to_string(),
            "ui:panel".to_string(),
            "workspace:read".to_string(),
        ];
        assert_eq!(
            entry.effective_permissions(&declared),
            granted,
            "没确认过的新权限不该生效"
        );

        // 落盘之后还要读得回来。
        let reloaded = load(&paths.state_path, &paths.data_dir);
        assert_eq!(reloaded.entry("demo").origin, PluginOrigin::Market);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn market_reinstall_keeps_the_enabled_flag() {
        let (paths, root) = market_paths("reinstall");
        record_market_install(&paths, "demo", vec![]).unwrap();

        // 用户停用了它。
        let mut state = load(&paths.state_path, &paths.data_dir);
        state.plugins.entry("demo".to_string()).or_default().enabled = false;
        save(&paths.state_path, &state).unwrap();

        // 之后有一次覆盖安装（更新或降级）。
        record_market_install(&paths, "demo", vec!["editor:read".to_string()]).unwrap();

        assert!(
            !load(&paths.state_path, &paths.data_dir).entry("demo").enabled,
            "用户停用是个决定，不该被一次更新抹掉"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn uninstall_forgets_the_entry_entirely() {
        let (paths, root) = market_paths("uninstall");
        record_market_install(&paths, "demo", vec!["editor:read".to_string()]).unwrap();

        record_uninstall(&paths, "demo").unwrap();

        let state = load(&paths.state_path, &paths.data_dir);
        assert!(
            !state.plugins.contains_key("demo"),
            "留下的授权会在下次装同一个名字时被沿用 —— 那等于绕过了「装之前我确认」"
        );
        // 条目没了之后，重新装进来自然是「从未配置过」的状态。
        assert_eq!(state.entry("demo").origin, PluginOrigin::Bundled);

        fs::remove_dir_all(root).ok();
    }

    /// 手写一份 v2 格式的状态文件（那时没有 `origin`）。
    fn write_v2_state(path: &Path, data_dir: &Path) {
        let raw = format!(
            r#"{{
                "version": 2,
                "dataDir": "{}",
                "plugins": {{
                    "demo": {{
                        "enabled": false,
                        "grantedPermissions": ["editor:read"],
                        "installedFiles": {{ "index.js": "abc" }}
                    }}
                }}
            }}"#,
            data_dir.display().to_string().replace('\\', "\\\\")
        );
        fs::write(path, raw).unwrap();
    }

    #[test]
    fn migrates_v2_state_and_defaults_origin_to_bundled() {
        let (path, data_dir) = temp_state("migrate-v2");
        write_v2_state(&path, &data_dir);

        let (state, migrated) = load_with_migration(&path, &data_dir);
        assert!(migrated, "读到 v2 应报告升级过");
        assert_eq!(state.version, STATE_VERSION);

        let entry = state.entry("demo");
        assert_eq!(
            entry.origin,
            PluginOrigin::Bundled,
            "老插件都是随应用分发或用户自己放进去的 —— 缺省必须是 Bundled，否则内置校正就\
             再也不管它们了"
        );
        assert!(!entry.enabled, "升级不该把停用的插件重新启用");
        assert_eq!(
            entry.granted_permissions,
            Some(vec!["editor:read".to_string()])
        );
        assert_eq!(entry.installed_files.get("index.js"), Some(&"abc".to_string()));

        fs::remove_dir_all(data_dir.parent().unwrap()).ok();
    }
}
