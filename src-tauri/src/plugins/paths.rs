//! 插件目录布局与路径安全解析。
//!
//! 目录布局（全部位于笔记数据目录之下）：
//!
//! ```text
//! <data_dir>/
//!   plugins/                    插件代码，一个插件一个子目录
//!     <name>/plugin.json
//!     <name>/index.js
//!   plugins-state.json          启停状态与已授予权限
//!   plugin-data/                插件数据，与代码分离，插件更新不丢数据
//!     <name>/kv.json
//!     <name>/settings.json
//!   plugin-install/             市场安装的工作区（下载、解压、换目录、待清理的旧版本）
//!     <uuid>.zip
//!     <uuid>/
//!     trash/
//!   plugin-market.json          市场清单的版本水位（防回滚）
//! ```
//!
//! 代码与数据分离是刻意的：用户替换/升级插件目录时不应丢失插件的持久化数据。

use super::errors::{app_error, plugin_name_invalid, plugin_path_invalid};
use crate::services::notes::{default_store, AppError};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 单个插件文件的大小上限。插件是本地 JS，正常远小于此值。
pub const MAX_PLUGIN_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// 插件名称最大长度。
const MAX_PLUGIN_NAME_LEN: usize = 64;

#[derive(Debug, Clone)]
pub struct PluginPaths {
    /// 笔记数据目录本身。
    pub data_dir: PathBuf,
    /// `<data_dir>/plugins`
    pub root: PathBuf,
    /// `<data_dir>/plugin-data`
    pub data_root: PathBuf,
    /// `<data_dir>/plugins-state.json`
    pub state_path: PathBuf,
    /// `<data_dir>/plugin-install` —— 市场安装的工作区。
    ///
    /// 换目录要落盘、下载与解压都要有地方，用同一个数据目录保证**同盘**（跨盘的
    /// `rename` 在 Windows 上会直接失败）。
    ///
    /// ⚠️ **刻意不放 `plugins/` 里面**：那个目录下每个子目录都会被列举成插件，
    /// 一个 `.staging` 会让界面上凭空多出一个「损坏的插件」。
    pub staging_root: PathBuf,
    /// `<data_dir>/plugin-market.json` —— 市场清单的版本水位（防回滚）。
    pub market_progress_path: PathBuf,
}

impl PluginPaths {
    pub fn from_data_dir(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            root: data_dir.join("plugins"),
            data_root: data_dir.join("plugin-data"),
            state_path: data_dir.join("plugins-state.json"),
            staging_root: data_dir.join("plugin-install"),
            market_progress_path: data_dir.join("plugin-market.json"),
        }
    }

    /// 按当前配置解析数据目录。与项目既有约定一致：每次调用重建 store。
    pub fn resolve() -> Result<Self, AppError> {
        Ok(Self::from_data_dir(default_store()?.data_dir()))
    }

    /// 确保目录存在。`plugin-data/<name>` 与工作区里的临时目录都按需创建。
    pub fn ensure_dirs(&self) -> Result<(), AppError> {
        fs::create_dir_all(&self.root)?;
        fs::create_dir_all(&self.data_root)?;
        fs::create_dir_all(&self.staging_root)?;
        Ok(())
    }

    /// 市场安装的工作目录（每个安装尝试一个，互不打架）。
    pub fn trash_dir(&self) -> PathBuf {
        self.staging_root.join("trash")
    }

    /// 某个插件的数据目录，按需创建。
    pub fn data_dir_for(&self, name: &str) -> Result<PathBuf, AppError> {
        validate_plugin_name(name)?;
        let dir = self.data_root.join(name);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    pub fn kv_path(&self, name: &str) -> Result<PathBuf, AppError> {
        Ok(self.data_dir_for(name)?.join("kv.json"))
    }

    pub fn settings_path(&self, name: &str) -> Result<PathBuf, AppError> {
        Ok(self.data_dir_for(name)?.join("settings.json"))
    }
}

/// 校验插件名称。名称同时是目录名与数据键，因此必须严格。
///
/// 允许 `[A-Za-z0-9._-]`，首字符必须是字母或数字（排除 `..`、`.hidden`），
/// 长度不超过 64。这样 `..`、绝对路径、分隔符、Windows 保留前缀都不可能通过。
pub fn validate_plugin_name(name: &str) -> Result<(), AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PLUGIN_NAME_LEN || trimmed != name {
        return Err(plugin_name_invalid(name));
    }

    let mut chars = trimmed.chars();
    let first = chars.next().ok_or_else(|| plugin_name_invalid(name))?;
    if !first.is_ascii_alphanumeric() {
        return Err(plugin_name_invalid(name));
    }

    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(plugin_name_invalid(name));
    }

    Ok(())
}

/// 判断一个字符串是不是「干净的相对路径」：非空、且每一段都是普通名字。
///
/// 拒绝绝对路径、`..`、`.`、根与盘符前缀。这是路径校验的第一道关：`safe_join_file`
/// 拿它挡穿越，`sync` 拿它挡清单里写歪的 `main`。
pub fn is_plain_relative(relative: &str) -> bool {
    let trimmed = relative.trim();
    if trimmed.is_empty() || trimmed != relative {
        return false;
    }
    Path::new(trimmed)
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
}

/// 把一个插件目录下的**相对**路径安全解析为绝对路径。
///
/// 拒绝绝对路径、`..`、盘符前缀；`canonicalize()` 之后再确认结果仍落在 `base` 之内，
/// 因此符号链接逃逸同样会被挡住。要求目标存在、是普通文件、且不超过大小上限。
///
/// 这是修复原 `plugins_read` 路径穿越漏洞的核心函数：旧实现直接
/// `plugins_root()?.join(&name)` 并把不可信的 `manifest.main` 再 join 一次，
/// 任何放在插件目录里的 `plugin.json` 都能读到磁盘任意文件。
pub fn safe_join_file(base: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let trimmed = relative.trim();
    if !is_plain_relative(trimmed) {
        return Err(plugin_path_invalid(relative, "包含非法路径片段"));
    }

    let base_canonical = base
        .canonicalize()
        .map_err(|_| plugin_path_invalid(relative, "插件目录不存在"))?;

    let joined = base_canonical.join(trimmed);
    let canonical = joined
        .canonicalize()
        .map_err(|_| plugin_path_invalid(relative, "文件不存在"))?;

    if !canonical.starts_with(&base_canonical) {
        return Err(plugin_path_invalid(relative, "路径越出插件目录"));
    }

    let metadata = fs::metadata(&canonical)?;
    if !metadata.is_file() {
        return Err(plugin_path_invalid(relative, "目标不是普通文件"));
    }
    if metadata.len() > MAX_PLUGIN_FILE_BYTES {
        return Err(super::errors::plugin_file_too_large(
            relative,
            metadata.len(),
            MAX_PLUGIN_FILE_BYTES,
        ));
    }

    Ok(canonical)
}

/// 与 `safe_join_file` 同源的**目录**解析：同样的片段校验与 canonicalize 前缀检查，
/// 但要求目标存在、是目录，且不加体积上限。空串表示插件目录本身。
///
/// 单独抽出来是因为 `safe_join_file` 结尾的 `is_file()` 断言会把目录判为非法。
pub fn safe_join_dir(base: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let trimmed = relative.trim();

    let base_canonical = base
        .canonicalize()
        .map_err(|_| plugin_path_invalid(relative, "插件目录不存在"))?;

    if trimmed.is_empty() {
        return Ok(base_canonical);
    }
    if Path::new(trimmed).is_absolute() {
        return Err(plugin_path_invalid(relative, "不允许绝对路径"));
    }
    if !Path::new(trimmed)
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(plugin_path_invalid(relative, "包含非法路径片段"));
    }

    let canonical = base_canonical
        .join(trimmed)
        .canonicalize()
        .map_err(|_| plugin_path_invalid(relative, "目录不存在"))?;

    if !canonical.starts_with(&base_canonical) {
        return Err(plugin_path_invalid(relative, "路径越出插件目录"));
    }
    if !canonical.is_dir() {
        return Err(plugin_path_invalid(relative, "目标不是目录"));
    }

    Ok(canonical)
}

/// 定位插件目录本身（不含内部文件），要求它存在且是目录。
pub fn plugin_dir(paths: &PluginPaths, name: &str) -> Result<PathBuf, AppError> {
    validate_plugin_name(name)?;
    let dir = paths.root.join(name);
    let canonical_root = paths
        .root
        .canonicalize()
        .map_err(|_| app_error("pluginsDirMissing", "插件目录不存在"))?;
    let canonical = dir
        .canonicalize()
        .map_err(|_| super::errors::plugin_not_found(name))?;

    if !canonical.starts_with(&canonical_root) {
        return Err(plugin_path_invalid(name, "路径越出插件目录"));
    }
    if !canonical.is_dir() {
        return Err(super::errors::plugin_not_found(name));
    }

    Ok(canonical)
}

/// 只允许插件附带 `.js` / `.mjs` 作为入口。
pub fn is_supported_entry(relative: &str) -> bool {
    Path::new(relative)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "js" | "mjs"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_root(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "floral-plugin-paths-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_file(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        let mut file = fs::File::create(&path).expect("create file");
        file.write_all(contents.as_bytes()).expect("write file");
        path
    }

    #[test]
    fn accepts_reasonable_names() {
        for name in ["word-count", "outline", "markdown_table", "a1", "my.plugin"] {
            assert!(validate_plugin_name(name).is_ok(), "应接受 {name}");
        }
    }

    #[test]
    fn rejects_traversal_and_separators() {
        for name in [
            "",
            " ",
            ".",
            "..",
            "../escape",
            "..\\escape",
            "a/b",
            "a\\b",
            "C:\\abs",
            "/abs",
            ".hidden",
            "has space",
            "中文",
            "../../../etc/passwd",
            "trailing ",
        ] {
            assert!(validate_plugin_name(name).is_err(), "应拒绝 {name:?}");
        }
    }

    #[test]
    fn rejects_overlong_name() {
        let long = "a".repeat(MAX_PLUGIN_NAME_LEN + 1);
        assert!(validate_plugin_name(&long).is_err());
    }

    #[test]
    fn safe_join_reads_a_normal_nested_file() {
        let root = temp_root("ok");
        write_file(&root, "assets/theme.css", "body{}");

        let resolved = safe_join_file(&root, "assets/theme.css").expect("应解析成功");
        assert_eq!(
            fs::read_to_string(&resolved).unwrap(),
            "body{}",
            "应能读到内容"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn safe_join_blocks_traversal_absolute_and_directories() {
        let root = temp_root("escape");
        write_file(&root, "index.js", "// plugin");

        // 在 root 之外放一个"机密"文件，确认够不到
        let outside = root.parent().unwrap().join(format!(
            "floral-secret-{}.txt",
            uuid::Uuid::new_v4()
        ));
        write_file(
            outside.parent().unwrap(),
            outside.file_name().unwrap().to_str().unwrap(),
            "secret",
        );

        let relative_escape = format!("../{}", outside.file_name().unwrap().to_str().unwrap());
        for bad in [
            relative_escape.as_str(),
            "..",
            "../index.js",
            "sub/../../index.js",
            "",
            "   ",
        ] {
            assert!(
                safe_join_file(&root, bad).is_err(),
                "应拒绝相对逃逸 {bad:?}"
            );
        }

        assert!(
            safe_join_file(&root, outside.to_str().unwrap()).is_err(),
            "应拒绝绝对路径"
        );
        assert!(
            safe_join_file(&root, "assets").is_err(),
            "目录不是普通文件，应拒绝"
        );
        assert!(
            safe_join_file(&root, "missing.js").is_err(),
            "不存在的文件应拒绝"
        );

        fs::remove_file(&outside).ok();
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn safe_join_blocks_symlink_escape() {
        let root = temp_root("symlink");
        let outside_dir = temp_root("symlink-target");
        write_file(&outside_dir, "secret.txt", "secret");

        std::os::unix::fs::symlink(&outside_dir, root.join("link")).expect("create symlink");

        assert!(
            safe_join_file(&root, "link/secret.txt").is_err(),
            "符号链接逃逸应被 canonicalize + starts_with 挡住"
        );

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn safe_join_rejects_oversized_file() {
        let root = temp_root("large");
        let big = root.join("big.js");
        let file = fs::File::create(&big).unwrap();
        file.set_len(MAX_PLUGIN_FILE_BYTES + 1).unwrap();
        drop(file);

        assert!(
            safe_join_file(&root, "big.js").is_err(),
            "超过上限的文件应拒绝"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn entry_extension_must_be_javascript() {
        assert!(is_supported_entry("index.js"));
        assert!(is_supported_entry("nested/main.mjs"));
        assert!(is_supported_entry("INDEX.JS"));
        assert!(!is_supported_entry("index.ts"));
        assert!(!is_supported_entry("index.json"));
        assert!(!is_supported_entry("index"));
    }

    #[test]
    fn paths_layout_separates_code_from_data() {
        let data_dir = Path::new("X:/notes");
        let paths = PluginPaths::from_data_dir(data_dir);

        assert_eq!(paths.root, data_dir.join("plugins"));
        assert_eq!(paths.data_root, data_dir.join("plugin-data"));
        assert_eq!(paths.state_path, data_dir.join("plugins-state.json"));
        assert_eq!(paths.staging_root, data_dir.join("plugin-install"));
        assert_eq!(
            paths.market_progress_path,
            data_dir.join("plugin-market.json")
        );
        assert_ne!(
            paths.root, paths.data_root,
            "插件代码与插件数据必须是不同目录"
        );
        assert!(
            !paths.staging_root.starts_with(&paths.root),
            "工作区不能在 plugins/ 里面：那里每个子目录都会被列举成插件"
        );
    }
}
