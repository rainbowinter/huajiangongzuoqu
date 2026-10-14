//! 插件附带资源的读取。
//!
//! 用途：v2 插件可以带自己的样式表或附加脚本，由宿主按需读取后注入到
//! **面板的隔离容器**里，而不是主世界。所有读取都经过 `paths::safe_join_file`，
//! 因此路径穿越与符号链接逃逸会被拒绝，并且有体积上限。
//!
//! 只支持**文本类型**，返回 `String`。二进制资源（png/jpg/webp）不在本轮范围内：
//! 跨 IPC 传二进制要么退化成数字数组、要么引入 base64 依赖，两者都不划算；
//! 图标请用内联 SVG。

use super::errors::{app_error, plugin_path_invalid, with_detail};
use super::paths::{plugin_dir, safe_join_file, PluginPaths};
use crate::services::notes::AppError;
use std::path::Path;

/// 允许插件读取的资源类型。白名单而不是黑名单——插件没有理由读可执行文件。
const ALLOWED_EXTENSIONS: [&str; 8] = ["css", "js", "mjs", "json", "svg", "html", "txt", "md"];

fn extension_of(relative: &str) -> Option<String> {
    Path::new(relative)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

pub fn read_asset(paths: &PluginPaths, name: &str, relative: &str) -> Result<String, AppError> {
    let extension =
        extension_of(relative).ok_or_else(|| plugin_path_invalid(relative, "缺少扩展名"))?;

    if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        return Err(with_detail(
            app_error(
                "pluginAssetTypeNotAllowed",
                format!("插件资源类型不允许：.{extension}"),
            ),
            "extension",
            extension,
        ));
    }

    let dir = plugin_dir(paths, name)?;
    let path = safe_join_file(&dir, relative)?;

    std::fs::read_to_string(&path).map_err(|error| {
        with_detail(
            app_error("pluginAssetNotText", "插件资源不是有效的 UTF-8 文本"),
            "reason",
            error.to_string(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_paths(tag: &str, plugin: &str) -> PluginPaths {
        let mut dir = std::env::temp_dir();
        dir.push(format!("floral-plugin-assets-{tag}-{}", uuid::Uuid::new_v4()));
        let paths = PluginPaths::from_data_dir(&dir);
        paths.ensure_dirs().expect("ensure dirs");
        fs::create_dir_all(paths.root.join(plugin)).expect("create plugin dir");
        paths
    }

    fn write(paths: &PluginPaths, plugin: &str, relative: &str, bytes: &[u8]) {
        let path = paths.root.join(plugin).join(relative);
        fs::create_dir_all(path.parent().unwrap()).expect("create parent");
        fs::write(path, bytes).expect("write asset");
    }

    #[test]
    fn reads_allowed_asset_types() {
        let paths = temp_paths("allowed", "demo");
        write(&paths, "demo", "assets/theme.css", b"body{color:red}");
        write(&paths, "demo", "icon.svg", b"<svg/>");
        write(&paths, "demo", "extra/panel.html", b"<p>hi</p>");

        assert_eq!(
            read_asset(&paths, "demo", "assets/theme.css").unwrap(),
            "body{color:red}"
        );
        assert_eq!(read_asset(&paths, "demo", "icon.svg").unwrap(), "<svg/>");
        assert_eq!(
            read_asset(&paths, "demo", "extra/panel.html").unwrap(),
            "<p>hi</p>"
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn rejects_disallowed_extensions() {
        let paths = temp_paths("disallowed", "demo");
        write(&paths, "demo", "payload.exe", b"MZ");
        write(&paths, "demo", "icon.png", b"\x89PNG");
        write(&paths, "demo", "noext", b"hi");

        for bad in ["payload.exe", "icon.png", "noext"] {
            assert!(read_asset(&paths, "demo", bad).is_err(), "应拒绝 {bad}");
        }

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn rejects_non_utf8_content() {
        let paths = temp_paths("binary", "demo");
        write(&paths, "demo", "bogus.css", &[0xff, 0xfe, 0xfd]);

        let error = read_asset(&paths, "demo", "bogus.css").unwrap_err();
        assert_eq!(error.code, "pluginAssetNotText");

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn rejects_traversal() {
        let paths = temp_paths("traversal", "demo");

        for bad in ["../secret.css", "..\\secret.css", "/etc/passwd.css"] {
            assert!(
                read_asset(&paths, "demo", bad).is_err(),
                "应拒绝穿越尝试 {bad}"
            );
        }

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn rejects_unknown_plugin() {
        let paths = temp_paths("unknown", "demo");
        assert!(read_asset(&paths, "nope", "a.css").is_err());
        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }
}
