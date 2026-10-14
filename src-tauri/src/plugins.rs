use crate::services::notes::{default_store, AppError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub main: String,
    pub description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    name: String,
    version: String,
    main: String,
    #[serde(default)]
    description: String,
}

fn plugins_root() -> Result<PathBuf, AppError> {
    Ok(default_store()?.data_dir().join("plugins"))
}

fn read_manifest(dir: &Path) -> Result<ManifestFile, AppError> {
    let raw = fs::read_to_string(dir.join("plugin.json"))?;
    Ok(serde_json::from_str(&raw)?)
}

#[tauri::command]
pub fn plugins_list() -> Result<Vec<PluginManifest>, AppError> {
    let root = plugins_root()?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut list = Vec::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let Ok(manifest) = read_manifest(&dir) else {
            continue;
        };
        list.push(PluginManifest {
            name: manifest.name,
            version: manifest.version,
            main: manifest.main,
            description: manifest.description,
        });
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

#[tauri::command]
pub fn plugins_read(name: String) -> Result<String, AppError> {
    let dir = plugins_root()?.join(&name);
    let manifest = read_manifest(&dir)?;
    Ok(fs::read_to_string(dir.join(&manifest.main))?)
}

#[tauri::command]
pub fn plugins_dir_path() -> Result<String, AppError> {
    let root = plugins_root()?;
    fs::create_dir_all(&root)?;
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugins_open_dir() -> Result<(), AppError> {
    let root = plugins_root()?;
    fs::create_dir_all(&root)?;

    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(&root);
    command.spawn().map_err(|error| AppError {
        code: "plugins".into(),
        message: format!("打开文件夹失败: {error}"),
        details: Default::default(),
    })?;
    Ok(())
}
