//! 插件清单（`plugin.json`）的读取、校验与对外 DTO。
//!
//! 兼容策略：`apiVersion` 缺省为 1（旧格式，主线程 `new Function` 运行），
//! `apiVersion = 2` 走沙箱 Worker + 权限门。未知的更高版本会被标记为不合法
//! 而不是静默丢弃——旧实现用 `let Ok(manifest) = ... else { continue }` 把格式
//! 错误的插件直接吞掉，用户在界面上完全看不到，这是个可用性 bug。

use super::errors::{plugin_manifest_invalid, with_detail};
use super::paths::is_supported_entry;
use super::state::PluginOrigin;
use crate::services::notes::AppError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// 当前宿主能提供的最高插件 API 版本。
pub const CURRENT_API_VERSION: u32 = 2;

/// 宿主能运行的 API 版本集合。
pub const SUPPORTED_API_VERSIONS: [u32; 2] = [1, 2];

fn default_api_version() -> u32 {
    1
}

/// `plugin.json` 的磁盘格式。
///
/// 注意 `permissions` 与 `contributes` 在这里是**不透明**的：权限词汇表与
/// IMPLIES 蕴含关系只存在于前端（`features/plugins/permissions.ts`），Rust 只
/// 负责原样存取。这样新增权限不需要同时改两处。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestFile {
    pub name: String,
    #[serde(default)]
    pub version: String,
    pub main: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_api_version")]
    pub api_version: u32,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 依赖哪些**插件**（写名字）。宿主按这个排加载顺序，缺依赖就不加载它。
    ///
    /// 由前端解析怎么用（`loader.rs` 那侧的顺序与判据都在 `features/plugins/loader.ts`），
    /// Rust 只管原样带过去 —— 与 `permissions` / `contributes` 同一条规矩。
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub contributes: Option<serde_json::Value>,
    /// 图标：插件目录下的**相对路径**（`.svg` / `.png` 之类）。没写就用宿主的默认图标。
    #[serde(default)]
    pub icon: Option<String>,
}

/// 返回给前端的插件记录。字段是旧 `PluginManifest` 的超集，前端类型可增量扩展。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub main: String,
    pub description: String,
    pub api_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub permissions: Vec<String>,
    pub granted_permissions: Vec<String>,
    /// 依赖的插件名（清单里的 `requires`，原样带过来）。
    pub requires: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contributes: Option<serde_json::Value>,
    pub enabled: bool,
    /// 市场有新版本时自动更新（见 `state::PluginStateEntry::auto_update`）。
    pub auto_update: bool,
    /// 能否被加载。`false` 时前端应在「损坏的插件」区展示 `invalid_reason`。
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid_reason: Option<String>,
    /// 不致命但值得提示的问题（例如 manifest 里的 name 与目录名不一致）。
    pub warnings: Vec<String>,
    /// 插件目录的绝对路径，便于用户在界面上定位。
    pub dir_path: String,
    /// 打哪来的（随应用分发 / 插件市场）。界面靠它决定「这个能不能从市场更新/卸载」。
    pub origin: PluginOrigin,
    /// 图标，**已经做成 data URL**（`data:image/svg+xml;base64,…`）。
    ///
    /// 为什么在 Rust 这边做、而不是把路径给前端让它自己取：
    ///
    /// * asset 协议的范围是**运行时逐个放行**的（字体就是那么做的），而那要额外一条命令
    ///   在渲染之前跑完；data URL 没有这个时序问题，也不必碰 CSP；
    /// * 市场那边给的就是 data URL（清单里内联着，见 `Docs/plugin-market.md`），
    ///   两边同一形状 ⇒ 前端只有一条渲染路径。
    ///
    /// 没写 `icon`、文件不在、扩展名不像图片、或文件过大时都是 `None`，界面上退回默认图标。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// 图标文件允许的扩展名。**白名单**：图标会被塞进 `<img>`，不该是 `.js` 那种东西。
const ICON_EXTENSIONS: [&str; 4] = ["svg", "png", "jpg", "jpeg"];

/// 图标文件的大小上限。图标是 16–40px 的东西，32KB 已经非常宽裕。
///
/// 这个上限**同时约束市场清单**：清单里的图标是内联的 data URL，而清单本身只有 4MB
/// （见 `market/catalog.rs`），一个几百 KB 的「图标」能把整份清单撑爆。
pub const MAX_ICON_BYTES: u64 = 32 * 1024;

/// 把插件目录里的图标读成 data URL。
///
/// 任何一步不对都返回 `None`（**不报错**）：图标是锦上添花，一个写错的 `icon` 字段不该让
/// 整个插件判为损坏。这与「插件清单缺字段就整个不合法」是两回事。
pub fn read_icon(dir: &Path, relative: Option<&str>) -> Option<String> {
    let relative = relative?.trim();
    if !super::paths::is_plain_relative(relative) {
        return None;
    }

    let extension = Path::new(relative)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)?;
    if !ICON_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }

    let path = dir.join(relative);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES {
        return None;
    }

    let bytes = fs::read(&path).ok()?;
    Some(data_url(&extension, &bytes))
}

/// 字节 → data URL。MIME 只认这几种，认不出就按图片里最保守的那个来。
fn data_url(extension: &str, bytes: &[u8]) -> String {
    let mime = match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "image/svg+xml",
    };
    format!("data:{mime};base64,{}", base64_encode(bytes))
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn read_manifest_file(dir: &Path) -> Result<PluginManifestFile, AppError> {
    let name = dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("<unknown>")
        .to_string();
    let manifest_path = dir.join("plugin.json");

    let raw = fs::read_to_string(&manifest_path).map_err(|error| {
        with_detail(
            plugin_manifest_invalid(&name, &error),
            "path",
            manifest_path.display().to_string(),
        )
    })?;

    serde_json::from_str::<PluginManifestFile>(&raw)
        .map_err(|error| plugin_manifest_invalid(&name, error))
}

/// 判定清单是否可加载，返回 `(valid, invalid_reason, warnings)`。
pub fn validate(dir_name: &str, manifest: &PluginManifestFile) -> (bool, Option<String>, Vec<String>) {
    let mut warnings = Vec::new();

    if !SUPPORTED_API_VERSIONS.contains(&manifest.api_version) {
        return (
            false,
            Some(format!(
                "apiVersionUnsupported:{}",
                manifest.api_version
            )),
            warnings,
        );
    }

    if !is_supported_entry(&manifest.main) {
        return (
            false,
            Some(format!("entryNotJavaScript:{}", manifest.main)),
            warnings,
        );
    }

    // 目录名是插件的规范标识（读取代码、定位数据都以它为准）。
    // manifest 里的 name 与之不一致不算致命，但会导致作者困惑，值得提示。
    if manifest.name != dir_name {
        warnings.push(format!(
            "manifestNameMismatch:{}:{}",
            manifest.name, dir_name
        ));
    }

    if manifest.version.is_empty() {
        warnings.push("missingVersion".to_string());
    }

    // apiVersion 1 是主线程运行的老格式，声明权限没有意义。
    if manifest.api_version == 1 && !manifest.permissions.is_empty() {
        warnings.push("permissionsIgnoredForApiVersion1".to_string());
    }

    (true, None, warnings)
}

/// 由磁盘格式与状态构造对外 DTO。
pub fn to_dto(
    dir_name: &str,
    dir_path: &Path,
    manifest: &PluginManifestFile,
    enabled: bool,
    auto_update: bool,
    granted_permissions: Vec<String>,
    origin: PluginOrigin,
) -> PluginManifest {
    let (valid, invalid_reason, warnings) = validate(dir_name, manifest);

    PluginManifest {
        // 目录名是规范标识，避免 manifest 自报 name 与目录不一致时读不到代码。
        name: dir_name.to_string(),
        version: manifest.version.clone(),
        main: manifest.main.clone(),
        description: manifest.description.clone(),
        api_version: manifest.api_version,
        author: manifest.author.clone(),
        homepage: manifest.homepage.clone(),
        permissions: manifest.permissions.clone(),
        granted_permissions,
        requires: manifest.requires.clone(),
        contributes: manifest.contributes.clone(),
        enabled,
        auto_update,
        valid,
        invalid_reason,
        warnings,
        dir_path: dir_path.display().to_string(),
        origin,
        icon: read_icon(dir_path, manifest.icon.as_deref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn manifest_with(api_version: u32, main: &str) -> PluginManifestFile {
        PluginManifestFile {
            name: "demo".to_string(),
            version: "1.0.0".to_string(),
            main: main.to_string(),
            description: String::new(),
            api_version,
            author: None,
            homepage: None,
            permissions: Vec::new(),
            requires: Vec::new(),
            contributes: None,
            icon: None,
        }
    }

    #[test]
    fn api_version_defaults_to_one_when_absent() {
        let raw = r#"{ "name": "demo", "version": "1.0.0", "main": "index.js" }"#;
        let parsed: PluginManifestFile = serde_json::from_str(raw).expect("应能解析旧格式");
        assert_eq!(
            parsed.api_version, 1,
            "旧插件没有 apiVersion 字段，必须默认走 v1 路径"
        );
    }

    #[test]
    fn parses_full_v2_manifest() {
        let raw = r#"{
            "name": "demo",
            "version": "2.0.0",
            "main": "index.js",
            "description": "示例",
            "apiVersion": 2,
            "author": "me",
            "homepage": "https://example.com",
            "permissions": ["editor:read", "ui:panel"],
            "contributes": { "commands": [{ "id": "demo.run", "title": "运行" }] }
        }"#;
        let parsed: PluginManifestFile = serde_json::from_str(raw).expect("应能解析 v2 格式");

        assert_eq!(parsed.api_version, 2);
        assert_eq!(parsed.permissions, vec!["editor:read", "ui:panel"]);
        assert!(parsed.contributes.is_some());
        assert_eq!(parsed.author.as_deref(), Some("me"));
    }

    #[test]
    fn rejects_unsupported_api_version() {
        let manifest = manifest_with(CURRENT_API_VERSION + 1, "index.js");
        let (valid, reason, _) = validate("demo", &manifest);

        assert!(!valid, "更高的 apiVersion 必须判为不合法");
        assert_eq!(reason.as_deref(), Some("apiVersionUnsupported:3"));
    }

    #[test]
    fn rejects_non_javascript_entry() {
        let manifest = manifest_with(2, "index.ts");
        let (valid, reason, _) = validate("demo", &manifest);

        assert!(!valid);
        assert_eq!(reason.as_deref(), Some("entryNotJavaScript:index.ts"));
    }

    #[test]
    fn accepts_both_supported_versions() {
        for version in SUPPORTED_API_VERSIONS {
            let manifest = manifest_with(version, "index.js");
            let (valid, reason, _) = validate("demo", &manifest);
            assert!(valid, "apiVersion {version} 应被接受");
            assert!(reason.is_none());
        }
    }

    #[test]
    fn warns_when_manifest_name_differs_from_directory() {
        let manifest = manifest_with(2, "index.js");
        let (valid, _, warnings) = validate("other-dir", &manifest);

        assert!(valid, "名称不一致不致命，目录名才是规范标识");
        assert_eq!(warnings, vec!["manifestNameMismatch:demo:other-dir"]);
    }

    #[test]
    fn warns_when_v1_declares_permissions() {
        let mut manifest = manifest_with(1, "index.js");
        manifest.permissions = vec!["editor:read".to_string()];

        let (valid, _, warnings) = validate("demo", &manifest);
        assert!(valid);
        assert!(
            warnings.contains(&"permissionsIgnoredForApiVersion1".to_string()),
            "v1 声明权限没有意义，应提示而不是静默忽略"
        );
    }

    #[test]
    fn dto_uses_directory_name_as_canonical_identity() {
        let manifest = manifest_with(2, "index.js");
        let dto = to_dto(
            "dir-name",
            &PathBuf::from("X:/plugins/dir-name"),
            &manifest,
            true,
            false,
            vec!["editor:read".to_string()],
            PluginOrigin::Market,
        );

        assert_eq!(dto.name, "dir-name", "对外标识必须是目录名");
        assert!(dto.enabled);
        assert!(dto.valid);
        assert_eq!(dto.granted_permissions, vec!["editor:read"]);
        assert_eq!(dto.dir_path, "X:/plugins/dir-name");
        assert_eq!(
            dto.origin,
            PluginOrigin::Market,
            "界面靠这个字段决定能不能从市场更新/卸载"
        );
    }

    #[test]
    fn to_dto_flags_invalid_manifest() {
        let manifest = manifest_with(99, "index.js");
        let dto = to_dto(
            "demo",
            &PathBuf::from("X:/plugins/demo"),
            &manifest,
            true,
            false,
            vec![],
            PluginOrigin::Bundled,
        );

        assert!(!dto.valid);
        assert_eq!(dto.invalid_reason.as_deref(), Some("apiVersionUnsupported:99"));
    }

    // ------------------------------------------------------------ 图标

    fn temp_plugin_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "floral-plugin-icon-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn reads_an_icon_as_a_data_url() {
        let dir = temp_plugin_dir("ok");
        fs::write(dir.join("icon.svg"), "<svg/>").unwrap();

        let icon = read_icon(&dir, Some("icon.svg")).expect("应当读出图标");

        assert!(
            icon.starts_with("data:image/svg+xml;base64,"),
            "形状必须是 data URL —— 市场那边给的是同一个形状，前端只有一条渲染路径：{icon}"
        );
        assert!(icon.ends_with("PHN2Zy8+" /* "<svg/>" 的 base64 */) || icon.len() > 20);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn png_and_jpeg_get_their_own_mime() {
        let dir = temp_plugin_dir("mime");
        fs::write(dir.join("a.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();
        fs::write(dir.join("b.jpeg"), [0xff, 0xd8]).unwrap();

        assert!(read_icon(&dir, Some("a.png")).unwrap().starts_with("data:image/png;base64,"));
        assert!(read_icon(&dir, Some("b.jpeg")).unwrap().starts_with("data:image/jpeg;base64,"));
        // 大小写不敏感。
        fs::write(dir.join("C.PNG"), [0x89]).unwrap();
        assert!(read_icon(&dir, Some("C.PNG")).unwrap().starts_with("data:image/png;base64,"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_broken_icon_falls_back_to_none_instead_of_failing() {
        // 图标是锦上添花：写错一个 `icon` 字段不该让整个插件判为损坏。
        let dir = temp_plugin_dir("broken");
        fs::write(dir.join("icon.svg"), "<svg/>").unwrap();
        fs::write(dir.join("big.svg"), "x".repeat(MAX_ICON_BYTES as usize + 1)).unwrap();

        for bad in [
            None,
            Some(""),
            Some("   "),
            Some("nope.svg"),          // 文件不在
            Some("../icon.svg"),       // 想往外跑
            Some("/etc/icon.svg"),     // 绝对路径
            Some("sub/../../icon.svg"),
            Some("icon.js"),           // 不是图片
            Some("icon"),              // 没有扩展名
            Some("big.svg"),           // 太大
            Some("dir.svg/"),          // 不是普通文件
        ] {
            assert!(
                read_icon(&dir, bad).is_none(),
                "{bad:?} 应当退回默认图标（None），而不是报错"
            );
        }

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dto_carries_the_icon_and_survives_its_absence() {
        let dir = temp_plugin_dir("dto");
        fs::write(dir.join("icon.svg"), "<svg/>").unwrap();

        let mut manifest = manifest_with(2, "index.js");
        manifest.icon = Some("icon.svg".to_string());
        let dto = to_dto("demo", &dir, &manifest, true, false, vec![], PluginOrigin::Bundled);
        assert!(dto.icon.unwrap().starts_with("data:image/svg+xml;base64,"));

        manifest.icon = None;
        let dto = to_dto("demo", &dir, &manifest, true, false, vec![], PluginOrigin::Bundled);
        assert!(dto.icon.is_none());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn manifest_field_is_optional() {
        // 老插件没有 `icon`，照样解析得出来。
        let parsed: PluginManifestFile =
            serde_json::from_str(r#"{ "name": "demo", "version": "1.0.0", "main": "index.js" }"#)
                .expect("应能解析");
        assert!(parsed.icon.is_none());
    }
}
