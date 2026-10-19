//! 把文件放进**系统剪贴板**（Windows 的 `CF_HDROP`），并附带一份路径文本。
//!
//! ## 为什么要自己写
//!
//! Tauri 的 clipboard-manager 插件只有文本 / HTML / 图片，没有「文件列表」。而在
//! Windows 上「复制一个文件」这件事本身就是 `CF_HDROP` —— 资源管理器、Word、微信
//! 都认它。没有这一层，用户从花笺里复制图片，粘到资源管理器只会得到一串路径。
//!
//! ## 为什么同时放文本
//!
//! 用户要的是「粘到别处是原文件，粘回花笺是一串地址」。`CF_HDROP` 让前者成立；
//! `CF_UNICODETEXT` 让后者成立（编辑器的粘贴处理会把它变成 `![](路径)`）。
//!
//! ⚠️ 写入顺序不能反：clipboard-win 的 `Unicode` setter 会先 `EmptyClipboard()`，
//! 而 `FileList` setter 刻意不清空。先文本后文件列表，两种格式才会同时留在剪贴板里。

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

/// 校验并规范化要复制的路径。
///
/// 只允许落在「已添加的工作文件夹」或数据目录里的路径 —— 与工作区的读写命令同一道闸。
/// 笔记里的 `images/…` 落在数据目录里，工作区里的文件落在工作区根里，两类都覆盖到了。
/// **文件夹也允许**：`CF_HDROP` 本来就支持目录。
pub fn filter_authorized_paths(
    paths: &[String],
    roots: &[PathBuf],
    data_dir: &Path,
) -> Result<Vec<PathBuf>, AppError> {
    if paths.is_empty() {
        return Err(err("clipboardEmpty", "没有要复制的文件"));
    }

    // 数据目录本身可能还没被创建（全新安装），此时不做 canonicalize，退化成原路径比较。
    let data_dir = data_dir
        .canonicalize()
        .unwrap_or_else(|_| data_dir.to_path_buf());

    let mut result = Vec::with_capacity(paths.len());
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(err("clipboardPathEmpty", "文件路径为空"));
        }

        let path = PathBuf::from(trimmed);
        if !path.is_absolute() {
            return Err(err("clipboardPathNotAbsolute", "需要绝对路径"));
        }

        let canonical = path.canonicalize().map_err(|_| {
            err(
                "clipboardPathMissing",
                format!("文件不存在或无法访问：{trimmed}"),
            )
        })?;

        let inside_data = canonical.starts_with(&data_dir);
        let inside_workspace = roots.iter().any(|root| canonical.starts_with(root));
        if !inside_data && !inside_workspace {
            return Err(err(
                "clipboardPathOutside",
                format!("路径不在任何已添加的工作文件夹内：{trimmed}"),
            ));
        }

        result.push(canonical);
    }

    Ok(result)
}

#[cfg(target_os = "windows")]
fn open_clipboard() -> Result<clipboard_win::Clipboard, AppError> {
    use clipboard_win::Clipboard;
    use std::time::Duration;

    // 剪贴板可能正被别的程序占着。new_attempts 内部是 Sleep(0) 空转，这里自己加一点
    // 间隔，避免和正在写剪贴板的程序硬碰硬。
    let mut last_error = None;
    for _ in 0..10 {
        match Clipboard::new() {
            Ok(clipboard) => return Ok(clipboard),
            Err(error) => {
                last_error = Some(error.to_string());
                std::thread::sleep(Duration::from_millis(30));
            }
        }
    }

    Err(err(
        "clipboardBusy",
        format!(
            "剪贴板正被其他程序占用，请稍后再试（{}）",
            last_error.unwrap_or_default()
        ),
    ))
}

#[cfg(target_os = "windows")]
fn write_file_list(paths: &[PathBuf]) -> Result<(), AppError> {
    use clipboard_win::{formats, Setter};

    let text = paths
        .iter()
        .map(|path| workspace::to_frontend_path(path))
        .collect::<Vec<_>>()
        .join("\n");
    let as_strings = paths
        .iter()
        .map(|path| workspace::to_frontend_path(path))
        .collect::<Vec<_>>();

    let _clipboard = open_clipboard()?;

    // 顺序见文件头：先 Unicode（会清空），再 FileList（不清空）。
    formats::Unicode
        .write_clipboard(&text)
        .map_err(|error| err("clipboardWriteFailed", format!("写入剪贴板失败：{error}")))?;
    formats::FileList
        .write_clipboard(&as_strings)
        .map_err(|error| err("clipboardWriteFailed", format!("写入文件列表失败：{error}")))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn read_file_list() -> Result<Vec<String>, AppError> {
    use clipboard_win::{formats, Getter};

    let _clipboard = open_clipboard()?;

    let mut paths: Vec<PathBuf> = Vec::new();
    if formats::FileList
        .read_clipboard(&mut paths)
        .map_err(|error| err("clipboardReadFailed", format!("读取剪贴板失败：{error}")))?
        > 0
    {
        return Ok(paths
            .iter()
            .map(|path| workspace::to_frontend_path(path))
            .collect());
    }

    // 有些程序只放了文本路径（我们自己写剪贴板时会两种都放，这里只是兜底）。
    let mut text = String::new();
    formats::Unicode
        .read_clipboard(&mut text)
        .map_err(|error| err("clipboardReadFailed", format!("读取剪贴板失败：{error}")))?;
    Ok(text
        .lines()
        .map(|line| line.trim().trim_matches('"'))
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.exists())
        .map(|path| workspace::to_frontend_path(&path))
        .collect())
}

#[cfg(not(target_os = "windows"))]
fn write_file_list(_paths: &[PathBuf]) -> Result<(), AppError> {
    Err(err(
        "clipboardUnsupported",
        "当前平台暂不支持把文件放进剪贴板",
    ))
}

/// 把一组文件 / 文件夹放进系统剪贴板（Windows：`CF_HDROP` + 路径文本）。
#[tauri::command]
pub fn clipboard_copy_files(paths: Vec<String>) -> Result<(), AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    let roots = workspace::roots_from_config(&config.workspace_folders);
    let authorized = filter_authorized_paths(&paths, &roots, store.data_dir())?;
    write_file_list(&authorized)
}

/// 读系统剪贴板里的文件列表（`CF_HDROP`），没有时退回文本路径。
///
/// 只返回路径字符串，不做授权 —— 这是「粘贴」的输入，来源本来就可能是工作区之外
/// （从资源管理器复制的文件）。真正写盘时由 `workspace_copy_entries` 校验目标目录。
#[tauri::command]
pub fn clipboard_read_files() -> Result<Vec<String>, AppError> {
    #[cfg(target_os = "windows")]
    {
        read_file_list()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(err(
            "clipboardUnsupported",
            "当前平台暂不支持读取剪贴板里的文件",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "floral-clipboard-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn canonical(path: &Path) -> PathBuf {
        path.canonicalize().expect("canonicalize")
    }

    #[test]
    fn accepts_files_inside_a_workspace_root() {
        let root = temp_dir("root");
        let file = root.join("note.md");
        std::fs::write(&file, "x").unwrap();
        let data_dir = temp_dir("data");

        let result = filter_authorized_paths(
            &[file.to_string_lossy().to_string()],
            &[canonical(&root)],
            &data_dir,
        )
        .expect("inside root");
        assert_eq!(result, vec![canonical(&file)]);

        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data_dir).ok();
    }

    #[test]
    fn accepts_files_inside_the_data_dir() {
        let data_dir = temp_dir("data-only");
        let file = data_dir.join("images").join("a.png");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "x").unwrap();

        let result = filter_authorized_paths(
            &[file.to_string_lossy().to_string()],
            &[],
            &data_dir,
        )
        .expect("inside data dir");
        assert_eq!(result, vec![canonical(&file)]);

        std::fs::remove_dir_all(data_dir).ok();
    }

    #[test]
    fn accepts_directories() {
        let root = temp_dir("dir-root");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let data_dir = temp_dir("dir-data");

        let result = filter_authorized_paths(
            &[sub.to_string_lossy().to_string()],
            &[canonical(&root)],
            &data_dir,
        )
        .expect("directory is allowed");
        assert_eq!(result, vec![canonical(&sub)]);

        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data_dir).ok();
    }

    #[test]
    fn rejects_paths_outside_authorized_roots() {
        let root = temp_dir("root-deny");
        let outside = temp_dir("outside");
        let file = outside.join("secret.txt");
        std::fs::write(&file, "x").unwrap();
        let data_dir = temp_dir("data-deny");

        let error = filter_authorized_paths(
            &[file.to_string_lossy().to_string()],
            &[canonical(&root)],
            &data_dir,
        )
        .expect_err("outside must be rejected");
        assert_eq!(error.code, "clipboardPathOutside");

        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(outside).ok();
        std::fs::remove_dir_all(data_dir).ok();
    }

    #[test]
    fn rejects_missing_paths() {
        let root = temp_dir("root-missing");
        let data_dir = temp_dir("data-missing");
        let missing = root.join("nope.md");

        let error = filter_authorized_paths(
            &[missing.to_string_lossy().to_string()],
            &[canonical(&root)],
            &data_dir,
        )
        .expect_err("missing must be rejected");
        assert_eq!(error.code, "clipboardPathMissing");

        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data_dir).ok();
    }
}
