//! 插件相关的 `#[tauri::command]` 薄封装。
//!
//! 旧命令名（`plugins_list` / `plugins_read` / `plugins_dir_path` /
//! `plugins_open_dir`）全部保留，因此前端的 v1 读取路径零改动；其余为新增。
//!
//! `plugins-state.json` 是全局单文件，多个 WebView 窗口可能同时切换同一个插件
//! 的启停，这里用一把进程内互斥锁把读-改-写串行化（跨进程场景不存在：花笺只有
//! 一个 Tauri 主进程）。

use super::manifest::{read_manifest_file, PluginManifest};
use super::paths::{plugin_dir, safe_join_file, PluginPaths};
use super::state;
use super::store;
use super::{assets, errors::app_error, scan_plugins};
use crate::services::notes::AppError;
use serde_json::{Map, Value};
use std::sync::{Mutex, MutexGuard};

static STATE_FILE_LOCK: Mutex<()> = Mutex::new(());

/// 中毒的锁直接恢复使用：状态文件始终是"先写临时文件再改名"，不会处于半写状态，
/// 因此持锁线程 panic 不会留下不一致的数据。
fn lock_state_file() -> MutexGuard<'static, ()> {
    STATE_FILE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn record_for(paths: &PluginPaths, name: &str) -> Result<PluginManifest, AppError> {
    scan_plugins(paths)?
        .into_iter()
        .find(|plugin| plugin.name == name)
        .ok_or_else(|| super::errors::plugin_not_found(name))
}

#[tauri::command]
pub fn plugins_list() -> Result<Vec<PluginManifest>, AppError> {
    scan_plugins(&PluginPaths::resolve()?)
}

/// 读取插件的入口脚本。
///
/// 这是原实现存在路径穿越漏洞的位置：旧代码直接 `plugins_root()?.join(&name)`
/// 并把不可信的 `manifest.main` 再 join 一次。现在两段都走 `safe_join_file`。
#[tauri::command]
pub fn plugins_read(name: String) -> Result<String, AppError> {
    let paths = PluginPaths::resolve()?;
    let dir = plugin_dir(&paths, &name)?;
    let manifest = read_manifest_file(&dir)?;
    let entry = safe_join_file(&dir, &manifest.main)?;
    Ok(std::fs::read_to_string(&entry)?)
}

#[tauri::command]
pub fn plugins_read_asset(name: String, relative_path: String) -> Result<String, AppError> {
    assets::read_asset(&PluginPaths::resolve()?, &name, &relative_path)
}

#[tauri::command]
pub fn plugins_dir_path() -> Result<String, AppError> {
    let paths = PluginPaths::resolve()?;
    paths.ensure_dirs()?;
    Ok(paths.root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugins_open_dir() -> Result<(), AppError> {
    let paths = PluginPaths::resolve()?;
    paths.ensure_dirs()?;

    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(&paths.root).spawn().map_err(|error| {
        super::errors::with_detail(
            app_error("plugins", format!("打开文件夹失败: {error}")),
            "path",
            paths.root.display().to_string(),
        )
    })?;
    Ok(())
}

#[tauri::command]
pub fn plugins_set_enabled(name: String, enabled: bool) -> Result<PluginManifest, AppError> {
    let paths = PluginPaths::resolve()?;
    let _guard = lock_state_file();

    state::set_enabled(&paths, &name, enabled)?;
    record_for(&paths, &name)
}

/// 更新已授予权限。`granted` 必须是清单声明权限的子集。
#[tauri::command]
pub fn plugins_set_permissions(
    name: String,
    granted: Vec<String>,
) -> Result<PluginManifest, AppError> {
    let paths = PluginPaths::resolve()?;
    let dir = plugin_dir(&paths, &name)?;
    let manifest = read_manifest_file(&dir)?;

    let _guard = lock_state_file();
    state::set_granted_permissions(&paths, &name, &manifest.permissions, granted)?;
    record_for(&paths, &name)
}

// ------------------------------------------------------------------ 键值存储

#[tauri::command]
pub fn plugins_storage_get(name: String, key: String) -> Result<Option<Value>, AppError> {
    store::get_value(&PluginPaths::resolve()?, &name, &key)
}

#[tauri::command]
pub fn plugins_storage_set(name: String, key: String, value: Value) -> Result<(), AppError> {
    store::set_value(&PluginPaths::resolve()?, &name, &key, value)
}

#[tauri::command]
pub fn plugins_storage_delete(name: String, key: String) -> Result<(), AppError> {
    store::delete_value(&PluginPaths::resolve()?, &name, &key)
}

#[tauri::command]
pub fn plugins_storage_keys(name: String) -> Result<Vec<String>, AppError> {
    store::list_keys(&PluginPaths::resolve()?, &name)
}

#[tauri::command]
pub fn plugins_storage_clear(name: String) -> Result<(), AppError> {
    store::clear_values(&PluginPaths::resolve()?, &name)
}

// -------------------------------------------------------------------- 设置值

#[tauri::command]
pub fn plugins_settings_get(name: String) -> Result<Map<String, Value>, AppError> {
    store::get_settings(&PluginPaths::resolve()?, &name)
}

#[tauri::command]
pub fn plugins_settings_set(
    name: String,
    values: Map<String, Value>,
) -> Result<Map<String, Value>, AppError> {
    store::set_settings(&PluginPaths::resolve()?, &name, values)
}
