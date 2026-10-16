//! 工作区缓存目录 `__floral-notepaper__`：插件把**与某个文件相关**的数据放在文件旁边。
//!
//! ## 为什么放在用户的文件夹里
//!
//! 批注这类数据的归属就是那个文件：把文件拷走、发给人，批注得跟着走。放在应用数据目录
//! 里的话，换台机器、或者把文件夹同步到网盘，数据就断了。代价是会在用户的目录里多出一个
//! 文件夹 —— 所以配套三条规矩：**界面上不显示、扫描时跳过、移除工作文件夹时问一句要不要
//! 一起删掉**（用户定的）。
//!
//! ## 布局
//!
//! ```text
//! <工作区根>/__floral-notepaper__/<插件名>/<文件在工作区里的相对路径>.json
//! ```
//!
//! 例：`<工作区>/论文/第一章.pdf` 上 `pdf-annotations` 的数据 →
//! `<工作区>/__floral-notepaper__/pdf-annotations/论文/第一章.pdf.json`。
//!
//! * 一个工作区**只有一个**缓存根（用户选的）—— 清理时一把删干净，不必挨个目录找。
//! * 键里带**相对路径**而不是光文件名：不同子目录下的同名文件才不会互相覆盖。
//! * 每份数据后面挂 `.json`：内容本来就是 JSON，让它在资源管理器里也不至于是个无名文件。
//!
//! 文件**不在任何工作区里**时（「打开文件」进来的那种），退回用**文件自己所在的目录**
//! 当根 —— 用户的原话是「直接存在那个文件夹里面」。
//!
//! ## 边界
//!
//! 与插件自己的目录一样，这里的路径全部来自**不可信输入**（插件名由插件自己报）：
//! 插件名只允许一段普通名字，相对路径逐段校验，落盘之前再确认最终路径仍在缓存根之内。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::notes::AppError;
// 路径校验**只有一份**：插件目录那边（`plugins/paths.rs`）已经为「相对路径不许有 `..`、
// 不许绝对路径」写过一遍并且有测试盯着。这里要挡的是同一类输入，抄一份出来只会让两条
// 规则慢慢分家 —— 而分家的那一天就是漏洞。
use crate::plugins::paths::is_plain_relative;

/// 缓存目录的名字。
///
/// ⚠️ **两处硬编码必须一致**：这里，以及 `workspace::list_dir` 里那条跳过规则。
/// 界面上看不到它是靠着后者的，改名字时别忘了那一边。
pub const CACHE_DIR_NAME: &str = "__floral-notepaper__";

/// 单份数据的序列化长度上限。与插件 KV（`plugins/store.rs`）同一个量级 ——
/// 一份批注 JSON 远不到这个数，但别让一个写疯了的插件把用户的磁盘塞满。
pub const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;

/// `workspace_cache_info` 的返回值：给「移除工作文件夹」那个确认框显示用。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    /// 缓存根存在与否。不存在时后面两个都是 0。
    pub exists: bool,
    pub files: u64,
    pub bytes: u64,
}

fn err(code: &str, message: impl Into<String>) -> AppError {
    AppError {
        code: code.to_string(),
        message: message.into(),
        details: std::collections::BTreeMap::new(),
    }
}

/// 缓存根：`<工作区文件夹>/__floral-notepaper__`。
pub fn cache_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(CACHE_DIR_NAME)
}

/// 这个文件该用哪个工作区根。
///
/// 落在某个已授权的工作文件夹里就用**那个文件夹**；否则用**文件自己所在的目录**。
/// 两者都不成立（路径拿不到父目录）时报错 —— 宁可失败，也不要在磁盘上瞎猜一个位置。
pub fn root_for(roots: &[PathBuf], file: &Path) -> Result<PathBuf, AppError> {
    let canonical = file
        .canonicalize()
        .map_err(|_| err("workspaceCachePathMissing", "文件不存在或无法访问"))?;

    if let Some(root) = roots
        .iter()
        .filter(|root| canonical.starts_with(root))
        // 嵌套的工作文件夹（比如把 `a` 和 `a/b` 都加进来）取**最长**的那个：
        // 缓存应该落在最接近文件的那一级，否则同一个文件会因为加过哪个文件夹而换个位置。
        .max_by_key(|root| root.components().count())
    {
        return Ok(root.clone());
    }

    canonical
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| err("workspaceCachePathMissing", "拿不到文件所在的目录"))
}

/// 算出某份数据的落点。**纯函数**，路径校验都在这里 —— 单测盯的就是它。
///
/// `file` 必须是 `root` 之内的绝对路径；`plugin` 是一段普通名字（插件名）。
pub fn entry_path(root: &Path, file: &Path, plugin: &str) -> Result<PathBuf, AppError> {
    if !is_plain_relative(plugin) || plugin.contains(['/', '\\']) {
        return Err(err("workspaceCachePluginInvalid", "插件名不合法"));
    }

    let relative = file
        .strip_prefix(root)
        .map_err(|_| err("workspaceCachePathOutside", "文件不在缓存根之内"))?;

    let relative_text = relative
        .to_str()
        .ok_or_else(|| err("workspaceCachePathInvalid", "路径不是有效的 UTF-8"))?
        .replace('\\', "/");

    // `strip_prefix` 之后每一段本来就该是普通名字，这里再核一遍：文件名的来源不可控
    // （用户可以在磁盘上造出任何名字），而下一步就是拼出真实路径去写盘。
    if !is_plain_relative(&relative_text) {
        return Err(err("workspaceCachePathInvalid", "路径里含有非法片段"));
    }

    Ok(cache_root(root)
        .join(plugin)
        .join(format!("{relative_text}.json")))
}

/// 定位某份数据的落点：先规范化文件路径，再算根、再算缓存文件。
///
/// ⚠️ 规范化这一步不能省：`entry_path` 要 `strip_prefix`，而**根是规范化的、文件不是**
/// 时前缀就对不上（包含 `..`、短名、符号链接的路径都会踩到）。两条路径必须是同一种形态。
fn locate(roots: &[PathBuf], file: &Path, plugin: &str) -> Result<PathBuf, AppError> {
    let canonical = file
        .canonicalize()
        .map_err(|_| err("workspaceCachePathMissing", "文件不存在或无法访问"))?;
    let root = root_for(roots, &canonical)?;
    entry_path(&root, &canonical, plugin)
}

/// 读一份数据；没有（或内容是坏的）返回 `None`。
///
/// 坏内容当作「没有」而不是报错：缓存坏掉不该让插件打不开文件，让它当作没写过、重新存
/// 一遍即可。
pub fn read(roots: &[PathBuf], file: &Path, plugin: &str) -> Result<Option<serde_json::Value>, AppError> {
    let path = locate(roots, file, plugin)?;
    if !path.is_file() {
        return Ok(None);
    }

    let text = std::fs::read_to_string(&path)
        .map_err(|_| err("workspaceCacheUnreadable", "缓存文件读不了"))?;
    Ok(serde_json::from_str(&text).ok())
}

/// 写一份数据。整份重写、原子落盘。
pub fn write(
    roots: &[PathBuf],
    file: &Path,
    plugin: &str,
    value: &serde_json::Value,
) -> Result<(), AppError> {
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|_| err("workspaceCacheUnserializable", "这份数据没法序列化"))?;
    if serialized.len() > MAX_VALUE_BYTES {
        return Err(err(
            "workspaceCacheValueTooLarge",
            format!("这份数据有 {} 字节，超过上限", serialized.len()),
        ));
    }

    let path = locate(roots, file, plugin)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| err("workspaceCacheUnwritable", "缓存目录建不出来（可能是只读位置）"))?;
    }
    crate::json_io::write_json_atomic(&path, value)
        .map_err(|_| err("workspaceCacheUnwritable", "缓存写不进去（可能是只读位置）"))
}

/// 删掉某份数据。文件本来就不在时返回 `false`（**不是**错误：删一个不存在的东西是达成目的）。
pub fn remove(roots: &[PathBuf], file: &Path, plugin: &str) -> Result<bool, AppError> {
    let path = locate(roots, file, plugin)?;
    if !path.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(&path).map_err(|_| err("workspaceCacheUnwritable", "缓存删不掉"))?;
    Ok(true)
}

/// 数一下缓存目录里有多少东西（给确认框显示）。
pub fn info(workspace_root: &Path) -> CacheInfo {
    let dir = cache_root(workspace_root);
    if !dir.is_dir() {
        return CacheInfo {
            exists: false,
            files: 0,
            bytes: 0,
        };
    }

    let mut files = 0u64;
    let mut bytes = 0u64;
    // 自己走一遍而不是引入 walkdir：这一层只需要「有多少文件、多大」，
    // 而目录结构就是我们自己写的，深度有限。
    let mut stack = vec![dir];
    while let Some(current) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&current) else {
            continue;
        };
        for item in read.flatten() {
            let Ok(metadata) = item.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                stack.push(item.path());
            } else {
                files += 1;
                bytes += metadata.len();
            }
        }
    }

    CacheInfo {
        exists: true,
        files,
        bytes,
    }
}

/// 把整个缓存目录删掉。返回删之前数到的那份信息，好让界面如实说「删掉了 N 个文件」。
///
/// 删不掉时**不当作成功**：目录可能正被别的程序占着（Windows 上很常见），或者是个只读
/// 位置 —— 那种情况下用户以为清干净了、实际没有，比直接报错更糟。
pub fn clear(workspace_root: &Path) -> Result<CacheInfo, AppError> {
    let dir = cache_root(workspace_root);
    let before = info(workspace_root);
    if !before.exists {
        return Ok(before);
    }

    std::fs::remove_dir_all(&dir).map_err(|_| {
        err(
            "workspaceCacheClearFailed",
            "缓存目录删不掉（可能正被别的程序占用）",
        )
    })?;
    Ok(before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("floral-cache-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn entry_path_mirrors_the_tree_under_one_cache_root() {
        let root = PathBuf::from("X:/ws");
        let entry = entry_path(&root, &root.join("论文/第一章.pdf"), "pdf-annotations").unwrap();

        assert_eq!(
            entry,
            PathBuf::from("X:/ws").join(CACHE_DIR_NAME).join("pdf-annotations").join("论文").join("第一章.pdf.json"),
            "一个工作区一个缓存根，里面按相对路径镜像目录树"
        );
    }

    #[test]
    fn entry_path_rejects_a_file_outside_the_root() {
        let root = PathBuf::from("X:/ws");
        let outside = PathBuf::from("X:/elsewhere/a.pdf");

        let error = entry_path(&root, &outside, "demo").unwrap_err();
        assert_eq!(error.code, "workspaceCachePathOutside");
    }

    #[test]
    fn entry_path_rejects_a_sneaky_plugin_name() {
        let root = PathBuf::from("X:/ws");
        let file = root.join("a.pdf");

        for bad in ["../escape", "a/b", "a\\b", "", "  ", ".", ".."] {
            let error = entry_path(&root, &file, bad).unwrap_err();
            assert_eq!(error.code, "workspaceCachePluginInvalid", "{bad} 应当被拒");
        }
    }

    #[test]
    fn root_for_prefers_the_innermost_workspace() {
        let outer = temp_dir("outer");
        let inner = outer.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let file = inner.join("a.pdf");
        fs::write(&file, b"%PDF-1.4").unwrap();

        let roots = vec![
            outer.canonicalize().unwrap(),
            inner.canonicalize().unwrap(),
        ];
        // 两个都包着这个文件时取**最长的那个**：否则同一个文件会因为「加过哪个文件夹」
        // 而把缓存落在不同位置。
        assert_eq!(root_for(&roots, &file).unwrap(), inner.canonicalize().unwrap());
    }

    #[test]
    fn root_for_falls_back_to_the_files_own_folder() {
        let dir = temp_dir("fallback");
        let file = dir.join("a.pdf");
        fs::write(&file, b"%PDF-1.4").unwrap();

        // 不在任何工作区里（「打开文件」进来的那种）→ 就用文件自己所在的目录。
        assert_eq!(root_for(&[], &file).unwrap(), dir.canonicalize().unwrap());
    }

    #[test]
    fn round_trips_a_value_and_reports_what_it_cleared() {
        let dir = temp_dir("roundtrip");
        let file = dir.join("sub/deep/a.pdf");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"%PDF-1.4").unwrap();

        let value = serde_json::json!({ "version": 1, "marks": [{ "page": 3 }] });
        write(&[], &file, "pdf-annotations", &value).unwrap();

        // 不在任何工作区里（「打开文件」进来的那种）→ 根就是**文件自己所在的目录**，
        // 相对路径因此只剩文件名。落点是用户说的「就在那个文件夹里面」。
        let expected = dir
            .canonicalize()
            .unwrap()
            .join("sub/deep")
            .join(CACHE_DIR_NAME)
            .join("pdf-annotations")
            .join("a.pdf.json");
        assert!(expected.is_file(), "缓存应当落在文件自己的目录下");

        assert_eq!(read(&[], &file, "pdf-annotations").unwrap(), Some(value));
        assert_eq!(read(&[], &file, "别的插件").unwrap(), None, "按插件分开存");

        // `info` 问的是**某一个根**的缓存目录（界面上那个确认框就是这么用的）。
        let counted = info(&dir.canonicalize().unwrap().join("sub/deep"));
        assert_eq!(counted.files, 1);
        assert!(counted.exists);

        assert!(remove(&[], &file, "pdf-annotations").unwrap());
        assert!(!remove(&[], &file, "pdf-annotations").unwrap(), "再删一次是 false，不是错");
        assert_eq!(read(&[], &file, "pdf-annotations").unwrap(), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_broken_cache_file_reads_as_nothing_instead_of_failing() {
        let dir = temp_dir("broken");
        let file = dir.join("a.pdf");
        fs::write(&file, b"%PDF-1.4").unwrap();

        let path = dir
            .canonicalize()
            .unwrap()
            .join(CACHE_DIR_NAME)
            .join("demo")
            .join("a.pdf.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{ this is not json").unwrap();

        // 缓存坏掉不该让插件打不开文件，让它当作没写过、重新存一遍即可。
        assert_eq!(read(&[], &file, "demo").unwrap(), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_value_over_the_limit() {
        let dir = temp_dir("toobig");
        let file = dir.join("a.pdf");
        fs::write(&file, b"%PDF-1.4").unwrap();

        let huge = serde_json::json!({ "blob": "x".repeat(MAX_VALUE_BYTES) });
        let error = write(&[], &file, "demo", &huge).unwrap_err();
        assert_eq!(error.code, "workspaceCacheValueTooLarge");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_removes_the_whole_folder_and_is_harmless_when_missing() {
        let dir = temp_dir("clear");
        let file = dir.join("a.pdf");
        fs::write(&file, b"%PDF-1.4").unwrap();
        write(&[], &file, "demo", &serde_json::json!({ "a": 1 })).unwrap();

        let root = dir.canonicalize().unwrap();
        let cleared = clear(&root).unwrap();
        assert_eq!(cleared.files, 1);
        assert!(!cache_root(&root).exists());

        // 目录本来就不在时不是错误 —— 「清理」这个动作的目的已经达成了。
        let again = clear(&root).unwrap();
        assert!(!again.exists);
        assert_eq!(again.files, 0);

        fs::remove_dir_all(&dir).ok();
    }
}
