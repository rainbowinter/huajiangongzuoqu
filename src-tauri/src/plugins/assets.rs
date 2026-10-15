//! 插件附带资源的读取。
//!
//! 用途：v2 插件可以带自己的样式表或附加脚本，由宿主按需读取后注入到
//! **面板的隔离容器**里，而不是主世界。所有读取都经过 `paths::safe_join_file`，
//! 因此路径穿越与符号链接逃逸会被拒绝，并且有体积上限。
//!
//! 只支持**文本类型**，返回 `String`。二进制资源（png/jpg/webp）不在本轮范围内：
//! 跨 IPC 传二进制要么退化成数字数组、要么引入 base64 依赖，两者都不划算；
//! 图标请用内联 SVG。
//!
//! **字体是唯一的例外，而且只开了半扇门**：`list_fonts` 会把 `.ttf/.otf/...` 的
//! **文件名与绝对路径**列出来，但既不读内容、也不允许走 `read_asset`。真正把字体送进
//! WebView 的是 asset 协议（宿主用 `convertFileSrc` 生成 URL），因此二进制从不经过 IPC，
//! 也就不需要 base64。绝对路径**只回给主世界的宿主代码**，插件侧永远只拿得到字体族名。

use super::fontmeta;
use super::errors::{app_error, plugin_path_invalid, with_detail};
use super::paths::{plugin_dir, safe_join_dir, safe_join_file, PluginPaths};
use crate::services::notes::AppError;
use crate::services::workspace::to_frontend_path;
use serde::Serialize;
use std::path::{Component, Path};

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

/// 列出插件目录下某个子目录里**允许读取**的文本资源文件名（不递归）。
///
/// 存在的理由：插件只能按已知路径读取，没有这个能力就没法实现「往文件夹里丢一份 CSS
/// 就生效」这类用法——插件得先知道文件夹里有什么。返回的是**文件名**而非路径，调用方
/// 仍需把名字交给 `read_asset`，走同一条安全解析与白名单。
pub fn list_assets(
    paths: &PluginPaths,
    name: &str,
    relative_dir: &str,
) -> Result<Vec<String>, AppError> {
    let dir = plugin_dir(paths, name)?;
    let target = safe_join_dir(&dir, relative_dir)?;

    let entries = std::fs::read_dir(&target).map_err(|error| {
        with_detail(
            app_error("pluginAssetDirUnreadable", "插件资源目录无法读取"),
            "reason",
            error.to_string(),
        )
    })?;

    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let allowed = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .is_some_and(|ext| ALLOWED_EXTENSIONS.contains(&ext.as_str()));
        if !allowed {
            continue;
        }

        if let Some(file_name) = path.file_name().and_then(|value| value.to_str()) {
            names.push(file_name.to_string());
        }
    }

    // 排序让注入顺序稳定：插件的样式表之间可能有依赖（后者覆盖前者），
    // 而文件系统的返回顺序是不保证的。
    names.sort();
    Ok(names)
}

// ------------------------------------------------------------------ 字体

/// 允许插件列出的字体文件类型。
///
/// 与 `ALLOWED_EXTENSIONS` 刻意分开：那一份是**可读文本**的白名单，`read_asset` 会把
/// 命中的文件按 UTF-8 读进来 —— 拿它去读字体只会得到一句"不是有效的 UTF-8 文本"。
/// 字体走的是另一条路：这里**只列名与路径**，内容由 asset 协议直接交给 WebView。
pub const FONT_EXTENSIONS: [&str; 5] = ["ttf", "otf", "ttc", "woff", "woff2"];

/// 单个字体文件的大小上限。
///
/// 过了这个数的多半不是字体（比如误把整包 zip 丢了进来），拦下来免得 WebView 去解析
/// 一个几百 MB 的文件。超限的**跳过而不是报错**：一个坏文件不该让整个字体目录失效。
pub const MAX_FONT_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// 一个可供 WebView 加载的字体文件。
#[derive(Debug, Clone, Serialize)]
pub struct FontAsset {
    /// 文件名（含扩展名），例如 `JetBrainsMono-Regular.ttf`。
    pub file: String,
    /// **普通形式**的绝对路径，供宿主 `convertFileSrc` 生成 asset URL。
    ///
    /// ⚠️ 只能交给主世界的宿主代码。插件侧拿到的应当是字体**族名**，不是路径 ——
    /// 这是"插件不触碰文件系统"那条边界的一部分。
    pub path: String,
    /// 从字体内部 `name` 表读出的**真实**族名，见 `fontmeta`。
    ///
    /// 文件名靠不住：`JetBrainsMono-Regular.ttf` 按驼峰拆是 "Jet Brains Mono"，真名却是
    /// "JetBrains Mono"。读不出来（WOFF 压缩容器、损坏文件）时为 `None`，由前端按文件名兜底。
    pub family: Option<String>,
    /// `OS/2.usWeightClass`。
    pub weight: Option<u16>,
    /// `"italic"` 或 `"normal"`。
    pub style: Option<String>,
}

fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| allowed.contains(&ext.as_str()))
}

/// 解析插件的字体目录，返回**普通形式**的绝对路径。
///
/// 单独暴露是因为调用方还要拿它去登记 asset 协议的放行范围：`convertFileSrc` 生成的
/// URL 按普通路径编码，而 `canonicalize()` 在 Windows 上给的是 `\\?\...` verbatim 形式，
/// 两者对不上，登记了也加载不出来。
pub fn fonts_dir(paths: &PluginPaths, name: &str, relative_dir: &str) -> Result<String, AppError> {
    let dir = plugin_dir(paths, name)?;
    Ok(to_frontend_path(&safe_join_dir(&dir, relative_dir)?))
}

/// 列出插件某个子目录里的字体文件（不递归，按文件名排序）。
///
/// 目录不存在时返回空列表而不是报错：默认的字体插件在用户还没往里丢字体时就该能正常
/// 加载，只是"暂时没有字体"。
pub fn list_fonts(
    paths: &PluginPaths,
    name: &str,
    relative_dir: &str,
) -> Result<Vec<FontAsset>, AppError> {
    let dir = plugin_dir(paths, name)?;

    // 目录不存在是常态 —— 用户还没往 fonts/ 里丢东西，插件不该因此加载失败。
    //
    // ⚠️ 只对**合法的相对路径**做这个探测：`/etc`、`../..` 这类要先交给
    // `safe_join_dir` 报错，不能因为"探不到"就被当成空目录悄悄放过。
    let trimmed = relative_dir.trim();
    let is_plain_relative = !trimmed.is_empty()
        && !Path::new(trimmed).is_absolute()
        && Path::new(trimmed)
            .components()
            .all(|part| matches!(part, Component::Normal(_)));

    if is_plain_relative && !dir.join(trimmed).is_dir() {
        return Ok(Vec::new());
    }

    let target = safe_join_dir(&dir, relative_dir)?;

    let entries = match std::fs::read_dir(&target) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };

    let mut paths_found: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !has_extension(&path, &FONT_EXTENSIONS) {
            continue;
        }
        let too_large = std::fs::metadata(&path)
            .map(|meta| meta.len() > MAX_FONT_FILE_BYTES)
            .unwrap_or(true);
        if too_large {
            eprintln!(
                "跳过过大的字体文件：{}（上限 {} 字节）",
                path.display(),
                MAX_FONT_FILE_BYTES
            );
            continue;
        }
        paths_found.push(path);
    }

    // 排序让注入顺序稳定：多字重字体的 `@font-face` 规则顺序不该随文件系统抖动。
    paths_found.sort();

    Ok(paths_found
        .into_iter()
        .filter_map(|path| {
            let file = path.file_name()?.to_str()?.to_string();

            // 拆一次 sfnt 拿真实族名。只读表头那几十字节，不整个文件读进来 ——
            // 一个大字重包十来个文件，全读进来会白白吃掉几十 MB。
            let meta = fontmeta::read_font_meta(&path);

            Some(FontAsset {
                file,
                path: to_frontend_path(&path),
                family: meta.family,
                weight: meta.weight,
                style: meta.style,
            })
        })
        .collect())
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

    #[test]
    fn lists_only_allowed_assets_sorted() {
        let paths = temp_paths("list", "demo");
        write(&paths, "demo", "styles/b.css", b"b{}");
        write(&paths, "demo", "styles/a.css", b"a{}");
        write(&paths, "demo", "styles/readme.txt", b"hi");
        // 白名单外的类型应被过滤
        write(&paths, "demo", "styles/photo.png", b"\x89PNG");
        // 子目录不递归，不应出现在结果里
        write(&paths, "demo", "styles/nested/c.css", b"c{}");

        assert_eq!(
            list_assets(&paths, "demo", "styles").unwrap(),
            vec!["a.css", "b.css", "readme.txt"]
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn lists_plugin_root_when_dir_is_empty() {
        let paths = temp_paths("list-root", "demo");
        write(&paths, "demo", "theme.css", b"a{}");

        assert_eq!(
            list_assets(&paths, "demo", "").unwrap(),
            vec!["theme.css"]
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn rejects_listing_outside_plugin_dir() {
        let paths = temp_paths("list-traversal", "demo");

        for bad in ["../", "..\\..", "/etc"] {
            assert!(
                list_assets(&paths, "demo", bad).is_err(),
                "应拒绝越界目录 {bad}"
            );
        }

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    // -------------------------------------------------------------- 字体

    #[test]
    fn lists_only_font_files_sorted() {
        let paths = temp_paths("fonts", "font-pack");
        write(&paths, "font-pack", "fonts/Zeta-Bold.ttf", b"z");
        write(&paths, "font-pack", "fonts/Alpha-Regular.otf", b"a");
        write(&paths, "font-pack", "fonts/Middle.woff2", b"m");
        // 非字体类型应被过滤
        write(&paths, "font-pack", "fonts/readme.md", b"docs");
        write(&paths, "font-pack", "fonts/theme.css", b"body{}");
        // 子目录不递归
        write(&paths, "font-pack", "fonts/nested/Deep.ttf", b"d");

        let fonts = list_fonts(&paths, "font-pack", "fonts").unwrap();
        let names: Vec<&str> = fonts.iter().map(|font| font.file.as_str()).collect();

        assert_eq!(names, vec!["Alpha-Regular.otf", "Middle.woff2", "Zeta-Bold.ttf"]);

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn font_paths_are_plain_absolute_paths() {
        // Windows 的 `canonicalize()` 会给出 `\\?\C:\...` verbatim 形式，而
        // `convertFileSrc` 生成的 asset URL 按**普通**路径编码——两者对不上字体就
        // 加载不出来。这一条守住 `to_frontend_path` 别被绕过去。
        let paths = temp_paths("fonts-path", "font-pack");
        write(&paths, "font-pack", "fonts/Alpha.ttf", b"a");

        let fonts = list_fonts(&paths, "font-pack", "fonts").unwrap();

        assert_eq!(fonts.len(), 1);
        assert!(
            !fonts[0].path.starts_with(r"\\?\"),
            "不应是 verbatim 路径：{}",
            fonts[0].path
        );
        assert!(Path::new(&fonts[0].path).is_absolute());
        assert!(fonts[0].path.ends_with("Alpha.ttf"));

        // `fonts_dir` 返回的目录没有结尾分隔符，字体路径是它下面的一层 ——
        // 调用方拿这个目录去登记 asset scope，两者必须对得上。
        let dir = fonts_dir(&paths, "font-pack", "fonts").unwrap();
        assert!(dir.ends_with("fonts"), "应指向 fonts 目录：{dir}");
        assert!(
            fonts[0]
                .path
                .starts_with(&format!("{dir}{}", std::path::MAIN_SEPARATOR)),
            "字体路径应落在 {dir} 之内：{}",
            fonts[0].path
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn missing_font_dir_is_empty_not_an_error() {
        // 用户还没往 fonts/ 里丢东西是常态，不该让插件加载失败。
        let paths = temp_paths("fonts-missing", "font-pack");

        assert!(list_fonts(&paths, "font-pack", "fonts").unwrap().is_empty());

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn font_listing_rejects_traversal() {
        let paths = temp_paths("fonts-traversal", "font-pack");
        fs::create_dir_all(paths.root.join("font-pack").join("fonts")).unwrap();

        for bad in ["../", "..\\..", "/etc", "fonts/../.."] {
            assert!(
                list_fonts(&paths, "font-pack", bad).is_err(),
                "应拒绝越界目录 {bad}"
            );
        }

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn oversized_fonts_are_skipped_not_fatal() {
        let paths = temp_paths("fonts-large", "font-pack");
        write(&paths, "font-pack", "fonts/Good.ttf", b"g");

        let big = paths.root.join("font-pack").join("fonts").join("Huge.ttf");
        let file = fs::File::create(&big).unwrap();
        file.set_len(MAX_FONT_FILE_BYTES + 1).unwrap();
        drop(file);

        let fonts = list_fonts(&paths, "font-pack", "fonts").unwrap();

        assert_eq!(
            fonts.iter().map(|font| font.file.as_str()).collect::<Vec<_>>(),
            vec!["Good.ttf"],
            "超大文件应被跳过，剩下的照常返回"
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn font_files_are_not_readable_as_text_assets() {
        // 两条白名单必须保持分开：字体走 asset 协议，不该能被 `read_asset` 读出来。
        let paths = temp_paths("fonts-not-text", "font-pack");
        write(&paths, "font-pack", "fonts/Alpha.ttf", b"a");

        let error = read_asset(&paths, "font-pack", "fonts/Alpha.ttf").unwrap_err();
        assert_eq!(error.code, "pluginAssetTypeNotAllowed");

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }
}
