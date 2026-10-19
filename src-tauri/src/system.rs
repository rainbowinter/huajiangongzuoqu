//! 交给 Windows 资源管理器自己的两个动作：**打开方式**与**属性**。
//!
//! 这两件事没有跨平台的一致做法，也不值得自己画一套：
//!
//! - 「打开方式」弹的是系统的「你要如何打开这个文件？」对话框（`openas` 动词）；
//! - 「属性」弹的是资源管理器原生属性页（`properties` 动词 + `SEE_MASK_INVOKEIDLIST`，
//!   这样文件类型注册的扩展属性页也会出现）。
//!
//! 路径仍然只允许工作区里的项目 —— 这是从目录树的右键菜单发起的动作。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::services::notes::{default_store, AppError};
use crate::services::workspace;

fn err(code: &str, message: impl Into<String>) -> AppError {
    AppError {
        code: code.to_string(),
        message: message.into(),
        details: BTreeMap::new(),
    }
}

fn authorize(raw: &str) -> Result<PathBuf, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::ensure_inside(
        &workspace::roots_from_config(&config.workspace_folders),
        Path::new(raw.trim()),
    )
}

#[cfg(target_os = "windows")]
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn shell_open_with(path: &Path) -> Result<(), AppError> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation: Vec<u16> = "openas\0".encode_utf16().collect();
    let file = wide(path.as_os_str());
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecute 的约定：返回值 <= 32 表示失败。
    if result as isize <= 32 {
        return Err(err(
            "systemOpenWithFailed",
            format!("无法打开「打开方式」对话框（错误码 {}）", result as isize),
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn shell_show_properties(path: &Path) -> Result<(), AppError> {
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb: Vec<u16> = "properties\0".encode_utf16().collect();
    let file = wide(path.as_os_str());

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_INVOKEIDLIST;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.nShow = SW_SHOWNORMAL;

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        return Err(err("systemPropertiesFailed", "无法打开文件属性"));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn shell_open_with(_path: &Path) -> Result<(), AppError> {
    Err(err(
        "systemUnsupported",
        "当前平台暂不支持「打开方式」",
    ))
}

#[cfg(not(target_os = "windows"))]
fn shell_show_properties(_path: &Path) -> Result<(), AppError> {
    Err(err("systemUnsupported", "当前平台暂不支持「属性」"))
}

/// 用系统的「打开方式」对话框打开工作区里的一个文件。
#[tauri::command]
pub fn system_open_with(path: String) -> Result<(), AppError> {
    shell_open_with(&authorize(&path)?)
}

/// 用资源管理器原生的属性页显示工作区里的一个文件 / 文件夹。
#[tauri::command]
pub fn system_show_properties(path: String) -> Result<(), AppError> {
    shell_show_properties(&authorize(&path)?)
}
