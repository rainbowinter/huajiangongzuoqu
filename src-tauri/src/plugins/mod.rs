//! 插件宿主后端。
//!
//! 目录布局、路径安全、清单解析、启停与权限状态、插件级持久化分别放在
//! `paths` / `manifest` / `state` / `store` / `assets` 里，`commands.rs` 只做
//! `#[tauri::command]` 薄封装——与 `updater/` 子系统的组织方式保持一致。
//!
//! `sync.rs` 是唯一会**写**插件代码目录的模块（其余都只读代码、只写数据）：应用升级后
//! 把随包分发的那份插件同步到用户数据目录里已装的副本上。它只覆盖没被用户改过的文件，
//! 详见其模块注释。
//!
//! 关于「插件标识」：**目录名就是规范标识**。读取代码、定位数据、存取状态全部
//! 以目录名为准，manifest 里的 `name` 只用于展示与提示（不一致会产生一条 warning）。
//! 原实现以 manifest 的 `name` 做列举、却以同名目录做读取，两者不一致时插件会
//! 列举得到但读不出来。

pub mod assets;
pub mod commands;
pub mod errors;
pub mod fontmeta;
pub mod manifest;
pub mod market;
pub mod paths;
pub mod state;
pub mod store;
pub mod sync;

use crate::services::notes::AppError;
use manifest::{read_manifest_file, to_dto, PluginManifest};
use paths::{validate_plugin_name, PluginPaths};
use std::fs;
use std::path::Path;

/// 列举插件目录下的全部条目。
///
/// 与旧实现的关键差别：**不合法或损坏的插件不会被静默丢弃**，而是以
/// `valid: false` + `invalidReason` 的形式返回，让界面上能看到"这个插件坏了"。
/// 旧实现用 `let Ok(manifest) = ... else { continue }` 直接吞掉，用户只会觉得
/// 插件莫名其妙没生效。
pub fn scan_plugins(paths: &PluginPaths) -> Result<Vec<PluginManifest>, AppError> {
    if !paths.root.is_dir() {
        return Ok(Vec::new());
    }

    let state = state::load(&paths.state_path, &paths.data_dir);
    let mut list = Vec::new();

    for entry in fs::read_dir(&paths.root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }

        let dir = entry.path();
        let dir_name = dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();

        list.push(build_record(&dir, &dir_name, &state));
    }

    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

fn invalid_record(
    dir: &Path,
    dir_name: &str,
    reason: impl Into<String>,
    warnings: Vec<String>,
) -> PluginManifest {
    PluginManifest {
        name: dir_name.to_string(),
        version: String::new(),
        main: String::new(),
        description: String::new(),
        api_version: 0,
        author: None,
        homepage: None,
        permissions: Vec::new(),
        granted_permissions: Vec::new(),
        requires: Vec::new(),
        contributes: None,
        enabled: false,
        // 清单都读不出来，更谈不上自动更新。
        auto_update: false,
        valid: false,
        invalid_reason: Some(reason.into()),
        warnings,
        dir_path: dir.display().to_string(),
        origin: state::PluginOrigin::Bundled,
        // 清单都读不出来，图标更没得谈。
        icon: None,
    }
}

fn build_record(dir: &Path, dir_name: &str, state: &state::PluginStateFile) -> PluginManifest {
    if let Err(error) = validate_plugin_name(dir_name) {
        return invalid_record(dir, dir_name, error.code, Vec::new());
    }

    let manifest = match read_manifest_file(dir) {
        Ok(manifest) => manifest,
        Err(error) => return invalid_record(dir, dir_name, error.code, Vec::new()),
    };

    let entry = state.entry(dir_name);
    let granted = entry.effective_permissions(&manifest.permissions);

    to_dto(
        dir_name,
        dir,
        &manifest,
        entry.enabled,
        entry.auto_update,
        granted,
        entry.origin,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_paths(tag: &str) -> PluginPaths {
        let mut dir = std::env::temp_dir();
        dir.push(format!("floral-plugins-scan-{tag}-{}", uuid::Uuid::new_v4()));
        let paths = PluginPaths::from_data_dir(&dir);
        paths.ensure_dirs().expect("ensure dirs");
        paths
    }

    fn write_plugin(paths: &PluginPaths, name: &str, manifest: &str, entry: &str) {
        let dir = paths.root.join(name);
        fs::create_dir_all(&dir).expect("create plugin dir");
        let mut json = fs::File::create(dir.join("plugin.json")).expect("create manifest");
        json.write_all(manifest.as_bytes()).expect("write manifest");
        let mut js = fs::File::create(dir.join(entry)).expect("create entry");
        js.write_all(b"// plugin").expect("write entry");
    }

    #[test]
    fn missing_root_lists_nothing() {
        let mut dir = std::env::temp_dir();
        dir.push(format!("floral-plugins-empty-{}", uuid::Uuid::new_v4()));
        let paths = PluginPaths::from_data_dir(&dir);

        assert!(scan_plugins(&paths).unwrap().is_empty());
    }

    #[test]
    fn lists_valid_plugins_sorted_by_name() {
        let paths = temp_paths("valid");
        write_plugin(
            &paths,
            "word-count",
            r#"{ "name": "word-count", "version": "1.0.0", "main": "index.js" }"#,
            "index.js",
        );
        write_plugin(
            &paths,
            "outline",
            r#"{ "name": "outline", "version": "1.0.0", "main": "index.js" }"#,
            "index.js",
        );

        let list = scan_plugins(&paths).unwrap();
        let names: Vec<_> = list.iter().map(|p| p.name.as_str()).collect();

        assert_eq!(names, vec!["outline", "word-count"]);
        assert!(list.iter().all(|p| p.valid && p.enabled));
        assert!(
            list.iter().all(|p| p.api_version == 1),
            "没有 apiVersion 字段的旧插件应判为 v1"
        );

        fs::remove_dir_all(paths.data_dir).ok();
    }

    #[test]
    fn broken_plugin_is_reported_not_swallowed() {
        let paths = temp_paths("broken");
        write_plugin(&paths, "good", r#"{ "name": "good", "version": "1.0.0", "main": "index.js" }"#, "index.js");

        // 清单无法解析
        write_plugin(&paths, "bad-json", "{ not json", "index.js");
        // 入口不是 JS
        write_plugin(
            &paths,
            "bad-entry",
            r#"{ "name": "bad-entry", "version": "1.0.0", "main": "index.ts" }"#,
            "index.js",
        );
        // apiVersion 超出宿主支持范围
        write_plugin(
            &paths,
            "too-new",
            r#"{ "name": "too-new", "version": "3.0.0", "main": "index.js", "apiVersion": 99 }"#,
            "index.js",
        );

        let list = scan_plugins(&paths).unwrap();
        let by_name = |n: &str| list.iter().find(|p| p.name == n).unwrap();

        assert_eq!(list.len(), 4, "损坏的插件也必须出现在列表里");
        assert!(by_name("good").valid);
        assert!(!by_name("bad-json").valid);
        assert_eq!(
            by_name("bad-json").invalid_reason.as_deref(),
            Some("pluginManifestInvalid")
        );
        assert!(!by_name("bad-entry").valid);
        assert_eq!(
            by_name("bad-entry").invalid_reason.as_deref(),
            Some("entryNotJavaScript:index.ts")
        );
        assert!(!by_name("too-new").valid);
        assert_eq!(
            by_name("too-new").invalid_reason.as_deref(),
            Some("apiVersionUnsupported:99")
        );

        fs::remove_dir_all(paths.data_dir).ok();
    }

    #[test]
    fn grants_declared_permissions_until_user_configures_them() {
        let paths = temp_paths("grants");
        write_plugin(
            &paths,
            "demo",
            r#"{ "name": "demo", "version": "2.0.0", "main": "index.js",
                 "apiVersion": 2, "permissions": ["editor:read", "ui:panel"] }"#,
            "index.js",
        );

        let list = scan_plugins(&paths).unwrap();
        assert_eq!(
            list[0].granted_permissions,
            vec!["editor:read".to_string(), "ui:panel".to_string()],
            "从未配置过的插件按清单声明自动授予"
        );
        assert_eq!(list[0].api_version, 2);
        assert!(list[0].valid);

        fs::remove_dir_all(paths.data_dir).ok();
    }

    #[test]
    fn ignores_plain_files_in_plugins_dir() {
        let paths = temp_paths("files");
        fs::write(paths.root.join("readme.md"), b"not a plugin").unwrap();
        write_plugin(&paths, "real", r#"{ "name": "real", "version": "1.0.0", "main": "index.js" }"#, "index.js");

        let list = scan_plugins(&paths).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "real");

        fs::remove_dir_all(paths.data_dir).ok();
    }
}
