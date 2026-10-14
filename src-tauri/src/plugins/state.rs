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

const STATE_VERSION: u32 = 1;

fn default_state_version() -> u32 {
    STATE_VERSION
}

fn default_enabled() -> bool {
    // 新放进插件目录的插件默认是启用的，否则用户会以为没生效。
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateEntry {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub granted_permissions: Option<Vec<String>>,
}

impl Default for PluginStateEntry {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            granted_permissions: None,
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

/// 读取状态文件。文件缺失、为空、损坏，或属于另一个数据目录时，返回一个干净的状态。
///
/// 与其他持久化模块一致：损坏的文件先另存现场再重新开始，不静默丢弃。
pub fn load(path: &Path, data_dir: &Path) -> PluginStateFile {
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

    let data_dir = paths
        .state_path
        .parent()
        .ok_or_else(|| app_error("pluginStatePathInvalid", "插件状态路径不合法"))?;

    let mut state = load(&paths.state_path, data_dir);
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

    let data_dir = paths
        .state_path
        .parent()
        .ok_or_else(|| app_error("pluginStatePathInvalid", "插件状态路径不合法"))?;

    let mut state = load(&paths.state_path, data_dir);
    let entry = state.plugins.entry(name.to_string()).or_default();
    entry.granted_permissions = Some(granted);
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
}
