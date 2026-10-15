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
use super::sync;
use super::{assets, errors::app_error, scan_plugins};
use crate::services::notes::AppError;
use serde_json::{Map, Value};
use std::sync::{Mutex, MutexGuard};
// `AppHandle::asset_protocol_scope` 来自这个 trait，不导入的话方法根本不可见。
use tauri::Manager;

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

/// 列出插件目录下某个子目录里可读的文本资源文件名（不递归，空串表示插件根目录）。
#[tauri::command]
pub fn plugins_list_assets(name: String, relative_dir: String) -> Result<Vec<String>, AppError> {
    assets::list_assets(&PluginPaths::resolve()?, &name, &relative_dir)
}

/// 列出插件字体目录里的字体文件，顺带把该目录登记进 asset 协议的放行范围。
///
/// 两条边界值得写下来：
///
/// * 返回值里带**绝对路径**，但它只到得了主世界 —— 方法表的 `fonts.register` 用它生成
///   asset URL，回给插件的只有字体族名。插件始终不知道自己的目录在哪。
/// * 放行的目录由**插件名**推导（`assets::fonts_dir` 内部走 `safe_join_dir`），插件传什么
///   `relative_dir` 都改不了被放行的是哪个目录，越界与符号链接也被 canonicalize 挡掉。
#[tauri::command]
pub fn plugins_list_fonts(
    app: tauri::AppHandle,
    name: String,
    relative_dir: String,
) -> Result<Vec<assets::FontAsset>, AppError> {
    let paths = PluginPaths::resolve()?;
    let dir = assets::fonts_dir(&paths, &name, &relative_dir)?;
    let fonts = assets::list_fonts(&paths, &name, &relative_dir)?;

    // 目录为空就不登记：没有文件要加载，没必要往 scope 里塞一条。
    // 递归放行的是**该插件自己的**字体目录，够不到别的插件，也够不到数据目录之外。
    if !fonts.is_empty() {
        let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    }

    Ok(fonts)
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

// ------------------------------------------------------------------ 版本校正

/// 取走启动时那次版本校正的报告。
///
/// 校正跑在 `.setup` 里，那时前端还没起来，事件发出去没人接，所以改成「先存后取」。
/// **取过即清空** —— 返回 `null` 表示这次启动没更新任何东西，前端据此保持安静。
///
/// 之所以做成命令而不是启动时主动推：多窗口场景下每个 WebView 都会调它，但只有第一个
/// 能拿到报告，正好只提示一次。
#[tauri::command]
pub fn plugins_sync_report() -> Option<sync::SyncReport> {
    sync::take_report()
}
