//! 插件清单（`plugin.json`）的读取、校验与对外 DTO。
//!
//! 兼容策略：`apiVersion` 缺省为 1（旧格式，主线程 `new Function` 运行），
//! `apiVersion = 2` 走沙箱 Worker + 权限门。未知的更高版本会被标记为不合法
//! 而不是静默丢弃——旧实现用 `let Ok(manifest) = ... else { continue }` 把格式
//! 错误的插件直接吞掉，用户在界面上完全看不到，这是个可用性 bug。

use super::errors::{plugin_manifest_invalid, with_detail};
use super::paths::is_supported_entry;
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
    #[serde(default)]
    pub contributes: Option<serde_json::Value>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contributes: Option<serde_json::Value>,
    pub enabled: bool,
    /// 能否被加载。`false` 时前端应在「损坏的插件」区展示 `invalid_reason`。
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid_reason: Option<String>,
    /// 不致命但值得提示的问题（例如 manifest 里的 name 与目录名不一致）。
    pub warnings: Vec<String>,
    /// 插件目录的绝对路径，便于用户在界面上定位。
    pub dir_path: String,
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
    granted_permissions: Vec<String>,
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
        contributes: manifest.contributes.clone(),
        enabled,
        valid,
        invalid_reason,
        warnings,
        dir_path: dir_path.display().to_string(),
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
            contributes: None,
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
            vec!["editor:read".to_string()],
        );

        assert_eq!(dto.name, "dir-name", "对外标识必须是目录名");
        assert!(dto.enabled);
        assert!(dto.valid);
        assert_eq!(dto.granted_permissions, vec!["editor:read"]);
        assert_eq!(dto.dir_path, "X:/plugins/dir-name");
    }

    #[test]
    fn to_dto_flags_invalid_manifest() {
        let manifest = manifest_with(99, "index.js");
        let dto = to_dto("demo", &PathBuf::from("X:/plugins/demo"), &manifest, true, vec![]);

        assert!(!dto.valid);
        assert_eq!(dto.invalid_reason.as_deref(), Some("apiVersionUnsupported:99"));
    }
}
