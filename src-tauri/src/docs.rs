//! 随包分发的说明文档 ——「关于」面板那三篇。
//!
//! 文档本体放在仓库的 `Docs/user/` 下，由 `tauri.conf.json` 的 `bundle.resources`
//! 映射成安装目录里的 `docs/`。和 `example-plugins-v2` 走的是同一条路：`tauri_build`
//! 会把它拷进 `target/{debug,release}/`，所以开发时也读得到（Windows 上资源目录就是
//! exe 所在目录）。
//!
//! **为什么要有白名单**：文件名是前端传来的。不加限制的话，一个 `../../../` 就能读到
//! 任何文件 —— 而这条命令唯一的用途就是读固定那几篇说明，白名单既不损失功能，
//! 也把这类问题从根上堵死。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::services::notes::AppError;

/// 允许读取的文档文件名。加一篇说明文档时，这里和 `Docs/user/` 要一起动。
pub const ALLOWED_DOCS: &[&str] = &["whats-new.md", "guide.md", "feedback.md"];

/// 资源目录下的子目录名，与 `tauri.conf.json` 里 `bundle.resources` 的映射目标一致。
const DOCS_DIR: &str = "docs";

/// 文件名在不在白名单里。抽成独立函数是为了能直接测 —— 命令本身要 `AppHandle`，
/// 单测里造不出来。
pub fn is_allowed_doc(name: &str) -> bool {
    ALLOWED_DOCS.contains(&name)
}

/// 拼出文档在磁盘上的路径。
///
/// 白名单已经挡在前面了，这里**再接一道**：只取 `name` 的最后一段，任何路径分隔符
/// 与 `..` 都到不了 `join`。两道防线都不贵，而这类漏洞的代价很大。
pub fn bundled_doc_path(resource_dir: &Path, name: &str) -> PathBuf {
    let file = Path::new(name)
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_default();

    resource_dir.join(DOCS_DIR).join(file)
}

#[tauri::command]
pub fn read_bundled_doc(app: AppHandle, name: String) -> Result<String, AppError> {
    if !is_allowed_doc(&name) {
        return Err(AppError {
            code: "docNotAllowed".into(),
            message: format!("未知的说明文档：{name}"),
            details: Default::default(),
        });
    }

    let resource_dir = app.path().resource_dir().map_err(|error| AppError {
        code: "noResourceDir".into(),
        message: format!("取不到资源目录：{error}"),
        details: Default::default(),
    })?;

    let path = bundled_doc_path(&resource_dir, &name);
    std::fs::read_to_string(&path).map_err(|error| AppError {
        code: "io".into(),
        // 带上路径：装机后最容易出问题的一环就是「文档没被拷进去」，
        // 报错里没有路径就得靠猜。
        message: format!("读不到说明文档 {}：{error}", path.display()),
        details: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_whitelisted_documents_are_readable() {
        assert!(is_allowed_doc("guide.md"));
        assert!(is_allowed_doc("whats-new.md"));
        assert!(is_allowed_doc("feedback.md"));

        assert!(!is_allowed_doc("plugin-api.md"));
        assert!(!is_allowed_doc(""));
    }

    #[test]
    fn path_traversal_never_leaves_the_docs_directory() {
        let root = Path::new("C:/app");

        // 把「绕过白名单」和「绕过路径拼接」两条路一起堵上：即使有人改坏了白名单，
        // 拼出来的路径也必须还落在 docs/ 里。
        for hostile in [
            "../../config.json",
            "..\\..\\config.json",
            "sub/dir/guide.md",
            "/etc/passwd",
        ] {
            let path = bundled_doc_path(root, hostile);
            assert_eq!(path.parent(), Some(root.join(DOCS_DIR).as_path()));
        }
    }

    #[test]
    fn builds_the_path_under_the_docs_directory() {
        assert_eq!(
            bundled_doc_path(Path::new("C:/app"), "guide.md"),
            Path::new("C:/app").join("docs").join("guide.md")
        );
    }
}
