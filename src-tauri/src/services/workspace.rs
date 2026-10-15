//! 工作文件夹：用户显式添加、可以浏览与编辑的任意目录。
//!
//! 与「插件目录」「笔记数据目录」的关键区别在于**授权来源**：这两者是应用自己管理的，
//! 而工作文件夹是用户在界面上亲手选定的。因此这里的每个入口都必须先确认目标确实落在
//! 某个已添加的文件夹之内 —— 判据不是「路径看起来正常」，而是 `canonicalize()` 之后的
//! 前缀匹配。这样符号链接逃逸、`..` 绕过都会一并被挡住，因为校验用的是磁盘上的真实
//! 路径，而不是字符串。
//!
//! 列目录**不递归**：目录树是懒加载的，展开某一层时才列那一层。递归扫描碰到
//! `node_modules` 这类目录会直接把界面卡死。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use super::notes::AppError;

/// 单次列目录的条目上限。超出时截断，并通过 `truncated` 如实告知调用方，
/// 而不是静默丢条目让用户以为文件夹里就这么多东西。
const MAX_ENTRIES: usize = 2000;

/// 可读写文本文件的体积上限，与插件资源保持一致。
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// 生成首行预览时最多读多少字节。只为了卡片上那一行文字，没必要整篇读进来。
const MAX_PREVIEW_BYTES: u64 = 64 * 1024;

/// 单次列目录里最多给多少个文件生成预览。
///
/// 预览要为每个文件读一次盘。列目录本身是廉价操作，但如果一个目录里有几千个小文件，
/// 无上限地读会把「展开一次目录」变成几千次 IO。超过这个数就不再生成预览 —— 卡片上
/// 少一行文字，比界面卡住强。
const MAX_PREVIEWS_PER_LISTING: usize = 200;

/// 预览文字的长度上限。
const MAX_PREVIEW_CHARS: usize = 120;

/// 「移动到…」的目标列表最多扫多少个目录项。
const MAX_SUBDIR_SCAN: usize = 500;

/// 「移动到…」的最大下钻层数。
const MAX_SUBDIR_DEPTH: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    /// 绝对路径。前端把它原样传回 `workspace_read_file` 等命令。
    pub path: String,
    pub is_dir: bool,
    /// 字节数；目录为 `None`。
    pub size: Option<u64>,
    /// RFC3339 时间戳；取不到为 `None`。
    pub modified_at: Option<String>,
    /// 小写扩展名（不含点）。无扩展名或非 UTF-8 时为 `None`。
    pub extension: Option<String>,
    /// 首个非空行的预览，供卡片中间那行显示。取不到（二进制、过大、非 UTF-8）为 `None`。
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListing {
    pub entries: Vec<WorkspaceEntry>,
    pub truncated: bool,
}

/// 回传给前端的路径表示。
///
/// `canonicalize()` 在 Windows 上返回的是 **verbatim 路径**（`\\?\E:\...`）。它在我们
/// 自己的命令里没问题，但传给 Tauri 的 asset 协议就对不上了：scope 是按普通路径登记的，
/// `convertFileSrc` 生成的 URL 也按普通路径编码 —— 于是图片显示不出来。
///
/// 所以对外一律还原成普通形式。**这不削弱校验**：每次入站调用都会重新 `canonicalize()`，
/// 前缀匹配用的始终是磁盘上的真实路径。
pub fn to_frontend_path(path: &Path) -> String {
    let text = path.to_string_lossy();

    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_string();
    }

    text.to_string()
}

fn err(code: &str, message: impl Into<String>) -> AppError {
    AppError {
        code: code.to_string(),
        message: message.into(),
        details: BTreeMap::new(),
    }
}

/// 把用户选定的目录规范化为可用于前缀校验的根。
///
/// 只在「添加文件夹」与「每次读取配置」时调用：它要求目录存在。已被删除的文件夹
/// 会在 `roots_from_config` 里被静默跳过，而不是让整个列表功能报错。
pub fn normalize_root(path: &str) -> Result<PathBuf, AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(err("workspacePathEmpty", "文件夹路径为空"));
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err(err("workspacePathNotAbsolute", "需要绝对路径"));
    }

    let canonical = candidate
        .canonicalize()
        .map_err(|_| err("workspacePathMissing", "文件夹不存在或无法访问"))?;
    if !canonical.is_dir() {
        return Err(err("workspacePathNotDir", "目标不是文件夹"));
    }

    Ok(canonical)
}

/// 从配置里的路径列表取出仍然有效的根。
///
/// 刻意只收 `&[String]` 而不是 `&AppConfig`：这里只关心这一个字段，收窄参数既让调用方
/// 不必把整个配置传进来，也让单测不必构造一整个 `AppConfig`。
///
/// 已被删除或无法访问的文件夹会被**跳过**，而不是让整个列表功能报错——用户临时拔掉
/// 一个移动硬盘，不该导致侧栏整个打不开。
pub fn roots_from_config(folders: &[String]) -> Vec<PathBuf> {
    folders
        .iter()
        .filter_map(|raw| normalize_root(raw).ok())
        .collect()
}

/// 确认 `target` 存在且落在某个已授权的根之内，返回其规范化路径。
///
/// ⚠️ `roots` **必须已经是规范化路径**（即来自 `roots_from_config` / `normalize_root`）。
/// 这里拿 `canonicalize()` 之后的目标去比前缀，如果根本身没规范化，两边形态不同就会被
/// 误判成"越界"——在 Windows 上尤其容易踩到，因为 `%TEMP%` 这类路径的短名（8.3）与长名
/// 是不同的字符串。
fn ensure_inside(roots: &[PathBuf], target: &Path) -> Result<PathBuf, AppError> {
    debug_assert!(
        roots.iter().all(|root| root.is_absolute()),
        "roots 必须是规范化后的绝对路径"
    );

    let canonical = target
        .canonicalize()
        .map_err(|_| err("workspacePathMissing", "路径不存在或无法访问"))?;

    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(err(
            "workspacePathOutside",
            "路径不在任何已添加的工作文件夹内",
        ));
    }

    Ok(canonical)
}

/// 解析一个**可能尚不存在**的目标文件路径（写新文件时用）。
///
/// 直接 `canonicalize()` 一个新文件会失败，所以校验落在父目录上；再确认最后一段是
/// 普通文件名，避免 `..` 之类被当成文件名写进磁盘。目标**已存在**时改走
/// `ensure_inside`，因为那个文件本身可能就是指向外部的符号链接。
fn resolve_target(roots: &[PathBuf], raw: &str) -> Result<PathBuf, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(err("workspacePathEmpty", "路径为空"));
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(err("workspacePathNotAbsolute", "需要绝对路径"));
    }
    if !matches!(path.components().last(), Some(Component::Normal(_))) {
        return Err(err("workspacePathInvalid", "路径包含非法片段"));
    }
    if path.exists() {
        return ensure_inside(roots, &path);
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| err("workspacePathInvalid", "路径缺少文件名"))?;
    let parent = path
        .parent()
        .ok_or_else(|| err("workspacePathInvalid", "路径缺少父目录"))?;
    let parent = ensure_inside(roots, parent)?;

    Ok(parent.join(file_name))
}

fn modified_at(metadata: &std::fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
}

/// 取文件首个非空行作为预览。
///
/// 用 `read_to_string` 而不是逐字节读：非 UTF-8 会直接失败，这正是我们想要的判据 ——
/// 二进制文件不该在卡片上显示乱码。体积上限在这里再挡一次，避免为一行文字读大文件。
fn preview_of(path: &Path, metadata: &std::fs::Metadata) -> Option<String> {
    if metadata.len() > MAX_PREVIEW_BYTES {
        return None;
    }

    let text = std::fs::read_to_string(path).ok()?;
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;

    Some(if line.chars().count() > MAX_PREVIEW_CHARS {
        line.chars().take(MAX_PREVIEW_CHARS).collect::<String>()
    } else {
        line.to_string()
    })
}

/// 列出**一层**目录。目录在前，同类按名字排序（大小写不敏感）。
pub fn list_dir(roots: &[PathBuf], raw: &str) -> Result<WorkspaceListing, AppError> {
    let dir = ensure_inside(roots, Path::new(raw.trim()))?;
    if !dir.is_dir() {
        return Err(err("workspaceNotDir", "目标不是文件夹"));
    }

    let read = std::fs::read_dir(&dir).map_err(|_| err("workspaceDirUnreadable", "文件夹无法读取"))?;

    let mut entries: Vec<WorkspaceEntry> = Vec::new();
    let mut truncated = false;
    let mut previews = 0usize;

    for item in read.flatten() {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }

        let path = item.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        // 单个条目读元数据失败（权限不足、文件刚被删）不应让整次列举失败。
        let Ok(metadata) = item.metadata() else {
            continue;
        };

        let is_dir = metadata.is_dir();
        let extension = if is_dir {
            None
        } else {
            path.extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase())
        };

        let preview = if is_dir || previews >= MAX_PREVIEWS_PER_LISTING {
            None
        } else {
            previews += 1;
            preview_of(&path, &metadata)
        };

        entries.push(WorkspaceEntry {
            name: name.to_string(),
            path: to_frontend_path(&path),
            is_dir,
            size: if is_dir { None } else { Some(metadata.len()) },
            modified_at: modified_at(&metadata),
            extension,
            preview,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(WorkspaceListing { entries, truncated })
}

/// 读一个文本文件。只接受 UTF-8，二进制文件会明确报错而不是给出乱码。
pub fn read_text_file(roots: &[PathBuf], raw: &str) -> Result<String, AppError> {
    let path = ensure_inside(roots, Path::new(raw.trim()))?;

    let metadata = std::fs::metadata(&path).map_err(|_| err("workspacePathMissing", "文件不存在"))?;
    if !metadata.is_file() {
        return Err(err("workspaceNotFile", "目标不是文件"));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(err("workspaceFileTooLarge", "文件过大，暂不支持打开"));
    }

    std::fs::read_to_string(&path).map_err(|_| err("workspaceFileNotText", "文件不是有效的 UTF-8 文本"))
}

/// 单个二进制文件的上限。
///
/// 比文本那条（4MB）宽得多：PDF 动辄几十兆。但它仍然是个**上限** —— 这条路径会把整份
/// 文件读进内存再经 IPC 递出去，不设限的话一个几百兆的文件就能把两侧都拖垮。
/// 流式传输留待以后。
const MAX_BINARY_BYTES: u64 = 64 * 1024 * 1024;

/// 读一个二进制文件，原样返回字节。
///
/// 与 [`read_text_file`] 的区别只在「不要求是 UTF-8」—— 路径校验、越界拒绝、大小上限
/// 这些规矩完全一样，所以 PDF 走这条不会比文本文件拿到更大的权限。
pub fn read_binary_file(roots: &[PathBuf], raw: &str) -> Result<Vec<u8>, AppError> {
    let path = ensure_inside(roots, Path::new(raw.trim()))?;

    let metadata = std::fs::metadata(&path).map_err(|_| err("workspacePathMissing", "文件不存在"))?;
    if !metadata.is_file() {
        return Err(err("workspaceNotFile", "目标不是文件"));
    }
    if metadata.len() > MAX_BINARY_BYTES {
        return Err(err("workspaceFileTooLarge", "文件过大，暂不支持打开"));
    }

    std::fs::read(&path).map_err(|_| err("workspaceReadFailed", "读取文件失败"))
}

/// 写回一个文本文件；目标不存在时创建。
pub fn write_text_file(roots: &[PathBuf], raw: &str, content: &str) -> Result<(), AppError> {
    let path = resolve_target(roots, raw)?;

    std::fs::write(&path, content).map_err(|error| AppError {
        code: "workspaceWriteFailed".into(),
        message: format!("写入失败：{error}"),
        details: BTreeMap::new(),
    })
}

/// 删除一个文件。
///
/// **只允许文件**。删目录要先回答一串问题（要不要递归、要不要进回收站、删错了怎么办），
/// 这些没有明确答案之前，直接拒绝比猜用户的意图安全 —— 而删一个文件是明确的。
pub fn delete_file(roots: &[PathBuf], raw: &str) -> Result<(), AppError> {
    let path = ensure_inside(roots, Path::new(raw.trim()))?;

    if !path.is_file() {
        return Err(err("workspaceDeleteNotFile", "只能删除文件"));
    }

    std::fs::remove_file(&path).map_err(|error| AppError {
        code: "workspaceDeleteFailed".into(),
        message: format!("删除失败：{error}"),
        details: BTreeMap::new(),
    })
}

/// 把文件或目录移动到另一个目录下，返回移动后的新路径。
///
/// 三处防护：目标必须是已授权的目录；不能把目录移进它自己（否则会把整棵子树弄丢）；
/// 目标位置已有同名项时直接报错，而不是覆盖 —— 覆盖是不可逆的，让用户自己改名。
pub fn move_entry(roots: &[PathBuf], raw: &str, target_dir: &str) -> Result<String, AppError> {
    let source = ensure_inside(roots, Path::new(raw.trim()))?;
    let target = ensure_inside(roots, Path::new(target_dir.trim()))?;

    if !target.is_dir() {
        return Err(err("workspaceNotDir", "目标不是文件夹"));
    }
    if source.is_dir() && target.starts_with(&source) {
        return Err(err(
            "workspaceMoveIntoItself",
            "不能把文件夹移动到它自己里面",
        ));
    }

    let name = source
        .file_name()
        .ok_or_else(|| err("workspacePathInvalid", "路径缺少名称"))?;
    let destination = target.join(name);

    if destination == source {
        return Ok(to_frontend_path(&source));
    }
    if destination.exists() {
        return Err(err("workspaceMoveConflict", "目标位置已有同名文件"));
    }

    std::fs::rename(&source, &destination).map_err(|error| AppError {
        code: "workspaceMoveFailed".into(),
        message: format!("移动失败：{error}"),
        details: BTreeMap::new(),
    })?;

    Ok(to_frontend_path(&destination))
}

/// 列出根目录下的所有子目录（递归、有上限），供「移动到…」选择目标。
///
/// 跳过名字以 `.` 开头的目录：`.git`、`.venv` 这类几乎不可能是用户想放文件的地方，
/// 列出来只会把菜单撑满。
pub fn list_subdirs(roots: &[PathBuf], raw: &str) -> Result<Vec<String>, AppError> {
    let root = ensure_inside(roots, Path::new(raw.trim()))?;

    fn walk(dir: &Path, out: &mut Vec<String>, budget: &mut usize, depth: usize) {
        if *budget == 0 || depth > MAX_SUBDIR_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };

        for item in entries.flatten() {
            if *budget == 0 {
                return;
            }
            *budget -= 1;

            let path = item.path();
            if !path.is_dir() {
                continue;
            }
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
            if name.starts_with('.') {
                continue;
            }

            out.push(to_frontend_path(&path));
            walk(&path, out, budget, depth + 1);
        }
    }

    let mut dirs = Vec::new();
    let mut budget = MAX_SUBDIR_SCAN;
    walk(&root, &mut dirs, &mut budget, 0);
    dirs.sort();
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "floral-workspace-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn as_strings(folders: &[&Path]) -> Vec<String> {
        folders
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect()
    }

    /// 生产里 roots 来自 `roots_from_config`（会 canonicalize）。单测走同一条路，
    /// 否则拿未规范化的短路径去比前缀会误判成越界。
    fn roots_of(folders: &[&Path]) -> Vec<PathBuf> {
        roots_from_config(&as_strings(folders))
    }

    #[test]
    fn reads_binary_bytes_verbatim() {
        let root = temp_dir("bytes");
        // 非 UTF-8 的字节序列：文本那条路径会明确拒绝，字节这条路必须原样带回来。
        let payload: Vec<u8> = vec![0x25, 0x50, 0x44, 0x46, 0x00, 0xFF, 0xFE, 0x80];
        fs::write(root.join("sample.pdf"), &payload).unwrap();

        let bytes = read_binary_file(&roots_of(&[&root]), &root.join("sample.pdf").to_string_lossy())
            .expect("应当读得到");

        assert_eq!(bytes, payload);
    }

    #[test]
    fn refuses_binary_reads_outside_the_roots() {
        let root = temp_dir("bytes-outside");
        let outside = temp_dir("elsewhere");
        let target = outside.join("secret.bin");
        fs::write(&target, b"not yours").unwrap();

        let error = read_binary_file(&roots_of(&[&root]), &target.to_string_lossy())
            .expect_err("工作区之外的文件不该读得到");

        assert_eq!(error.code, "workspacePathOutside");
    }

    #[test]
    fn refuses_binary_reads_over_the_size_limit() {
        let root = temp_dir("bytes-huge");
        let target = root.join("huge.bin");
        fs::write(&target, b"x").unwrap();
        // 不真写 64MB：把文件长度"说大"再靠 metadata 判断才是生产逻辑，这里直接造一个
        // 稀疏文件即可（Windows 上 set_len 同样有效且不占空间）。
        let file = fs::OpenOptions::new().write(true).open(&target).unwrap();
        file.set_len(MAX_BINARY_BYTES + 1).unwrap();
        drop(file);

        let error = read_binary_file(&roots_of(&[&root]), &target.to_string_lossy())
            .expect_err("超过上限应当被拒");

        assert_eq!(error.code, "workspaceFileTooLarge");
    }

    #[test]
    fn lists_directories_first_then_names_case_insensitively() {
        let root = temp_dir("list");
        fs::create_dir_all(root.join("zeta")).unwrap();
        fs::write(root.join("Beta.txt"), b"x").unwrap();
        fs::write(root.join("alpha.md"), b"y").unwrap();

        let listing = list_dir(&roots_of(&[&root]), &root.to_string_lossy()).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();

        assert_eq!(names, vec!["zeta", "alpha.md", "Beta.txt"]);
        assert!(!listing.truncated);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_extension_and_size_for_files_only() {
        let root = temp_dir("meta");
        fs::write(root.join("script.PY"), b"print(1)").unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();

        let listing = list_dir(&roots_of(&[&root]), &root.to_string_lossy()).unwrap();
        let file = listing.entries.iter().find(|e| e.name == "script.PY").unwrap();
        let dir = listing.entries.iter().find(|e| e.name == "nested").unwrap();

        assert_eq!(file.extension.as_deref(), Some("py"), "扩展名应统一成小写");
        assert_eq!(file.size, Some(8));
        assert!(dir.is_dir);
        assert_eq!(dir.size, None);
        assert_eq!(dir.extension, None);

        fs::remove_dir_all(&root).ok();
    }

    /// 单测里要把绝对路径还原成末段名字，方便断言。
    fn name_of(path: &str) -> String {
        Path::new(path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string()
    }

    #[test]
    fn deletes_files_but_refuses_directories() {
        let root = temp_dir("delete");
        let file = root.join("a.md");
        fs::write(&file, b"x").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();

        let roots = roots_of(&[&root]);
        delete_file(&roots, &file.to_string_lossy()).unwrap();
        assert!(!file.exists());

        let error = delete_file(&roots, &root.join("sub").to_string_lossy()).unwrap_err();
        assert_eq!(error.code, "workspaceDeleteNotFile");
        assert!(root.join("sub").exists(), "目录不该被删掉");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn moves_files_between_directories() {
        let root = temp_dir("move");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        let file = root.join("a").join("note.md");
        fs::write(&file, b"hi").unwrap();

        let moved = move_entry(
            &roots_of(&[&root]),
            &file.to_string_lossy(),
            &root.join("b").to_string_lossy(),
        )
        .unwrap();

        assert!(!file.exists(), "源文件应已移走");
        assert_eq!(fs::read_to_string(&moved).unwrap(), "hi");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn move_refuses_overwrite_and_self_nesting() {
        let root = temp_dir("move-guard");
        let inner = root.join("a").join("inner");
        fs::create_dir_all(&inner).unwrap();
        fs::write(root.join("a").join("x.md"), b"1").unwrap();
        fs::write(inner.join("x.md"), b"2").unwrap();

        let roots = roots_of(&[&root]);

        let conflict = move_entry(
            &roots,
            &root.join("a").join("x.md").to_string_lossy(),
            &inner.to_string_lossy(),
        )
        .unwrap_err();
        assert_eq!(conflict.code, "workspaceMoveConflict");
        assert_eq!(
            fs::read_to_string(inner.join("x.md")).unwrap(),
            "2",
            "同名文件不该被覆盖"
        );

        let self_nesting = move_entry(
            &roots,
            &root.join("a").to_string_lossy(),
            &inner.to_string_lossy(),
        )
        .unwrap_err();
        assert_eq!(self_nesting.code, "workspaceMoveIntoItself");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn lists_subdirs_recursively_and_skips_hidden() {
        let root = temp_dir("subdirs");
        fs::create_dir_all(root.join("src").join("deep")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("file.md"), b"x").unwrap();

        let names: Vec<String> = list_subdirs(&roots_of(&[&root]), &root.to_string_lossy())
            .unwrap()
            .iter()
            .map(|path| name_of(path))
            .collect();

        assert_eq!(names.len(), 2, "只该有 src 与 deep：隐藏目录与文件都不算");
        assert!(names.contains(&"src".to_string()));
        assert!(names.contains(&"deep".to_string()));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn previews_first_non_empty_line() {
        let root = temp_dir("preview");
        fs::write(root.join("a.md"), "\n\n# 标题\n正文".as_bytes()).unwrap();
        fs::write(root.join("empty.md"), b"").unwrap();
        fs::write(root.join("binary.md"), [0xff, 0xfe, 0xfd]).unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();

        let listing = list_dir(&roots_of(&[&root]), &root.to_string_lossy()).unwrap();
        let find = |name: &str| listing.entries.iter().find(|entry| entry.name == name).unwrap();

        assert_eq!(find("a.md").preview.as_deref(), Some("# 标题"));
        assert_eq!(find("empty.md").preview, None, "空文件没有预览");
        assert_eq!(find("binary.md").preview, None, "二进制文件不该给出乱码预览");
        assert_eq!(find("sub").preview, None, "目录没有预览");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_paths_outside_authorized_roots() {
        let root = temp_dir("outside-root");
        let outsider = temp_dir("outside-other");
        fs::write(outsider.join("secret.txt"), b"nope").unwrap();

        let roots = roots_of(&[&root]);

        assert!(read_text_file(&roots, &outsider.join("secret.txt").to_string_lossy()).is_err());
        assert!(list_dir(&roots, &outsider.to_string_lossy()).is_err());
        assert!(write_text_file(&roots, &outsider.join("new.txt").to_string_lossy(), "x").is_err());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outsider).ok();
    }

    #[test]
    fn rejects_traversal_out_of_the_root() {
        let parent = temp_dir("traversal-parent");
        let root = parent.join("inside");
        fs::create_dir_all(&root).unwrap();
        fs::write(parent.join("elsewhere.txt"), b"x").unwrap();

        let roots = roots_of(&[&root]);

        // 读：`..` 指到根外面
        let escaping_read = root.join("..").join("elsewhere.txt");
        let error = read_text_file(&roots, &escaping_read.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, "workspacePathOutside");

        // 写：目标不存在，校验落在被 `..` 推出的父目录上，同样应被拒
        let escaping_write = root.join("..").join("planted.txt");
        let error = write_text_file(&roots, &escaping_write.to_string_lossy(), "x").unwrap_err();
        assert_eq!(error.code, "workspacePathOutside");
        assert!(!parent.join("planted.txt").exists(), "越界写入不应真的落盘");

        fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn reads_and_writes_inside_the_root() {
        let root = temp_dir("rw");
        let roots = roots_of(&[&root]);
        let target = root.join("note.md");

        write_text_file(&roots, &target.to_string_lossy(), "你好").unwrap();
        assert_eq!(read_text_file(&roots, &target.to_string_lossy()).unwrap(), "你好");

        // 覆盖写
        write_text_file(&roots, &target.to_string_lossy(), "改过了").unwrap();
        assert_eq!(read_text_file(&roots, &target.to_string_lossy()).unwrap(), "改过了");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_non_utf8_files() {
        let root = temp_dir("binary");
        let roots = roots_of(&[&root]);
        let target = root.join("image.png");
        fs::write(&target, [0xff, 0xfe, 0xfd]).unwrap();

        let error = read_text_file(&roots, &target.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, "workspaceFileNotText");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn normalize_root_rejects_files_and_missing_paths() {
        let root = temp_dir("normalize");
        let file = root.join("a.txt");
        fs::write(&file, b"x").unwrap();

        assert!(normalize_root(&file.to_string_lossy()).is_err(), "文件不是合法的根");
        assert!(normalize_root("").is_err());
        assert!(normalize_root("relative/path").is_err());
        assert!(
            normalize_root(&root.join("does-not-exist").to_string_lossy()).is_err()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn roots_from_config_skips_deleted_folders() {
        let root = temp_dir("stale");
        let missing = temp_dir("stale-gone");
        fs::remove_dir_all(&missing).ok();

        let roots = roots_from_config(&as_strings(&[&root, &missing]));

        assert_eq!(roots.len(), 1, "已删除的文件夹应被跳过而不是让列举失败");
        assert_eq!(roots[0], root.canonicalize().unwrap());

        fs::remove_dir_all(&root).ok();
    }
}
