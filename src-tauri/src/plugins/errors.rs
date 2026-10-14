use crate::services::notes::AppError;
use std::collections::BTreeMap;

pub fn app_error(code: impl Into<String>, message: impl Into<String>) -> AppError {
    AppError {
        code: code.into(),
        message: message.into(),
        details: BTreeMap::new(),
    }
}

pub fn with_detail(
    mut error: AppError,
    key: impl Into<String>,
    value: impl Into<String>,
) -> AppError {
    error.details.insert(key.into(), value.into());
    error
}

pub fn plugin_name_invalid(name: &str) -> AppError {
    with_detail(
        app_error("pluginNameInvalid", format!("插件名称不合法：{name}")),
        "name",
        name,
    )
}

pub fn plugin_path_invalid(relative: &str, reason: &str) -> AppError {
    let error = app_error(
        "pluginPathInvalid",
        format!("插件文件路径不合法：{relative}（{reason}）"),
    );
    with_detail(error, "path", relative)
}

pub fn plugin_not_found(name: &str) -> AppError {
    with_detail(
        app_error("pluginNotFound", format!("找不到插件：{name}")),
        "name",
        name,
    )
}

pub fn plugin_manifest_invalid(name: &str, reason: impl std::fmt::Display) -> AppError {
    let error = app_error(
        "pluginManifestInvalid",
        format!("插件 {name} 的 plugin.json 无法解析：{reason}"),
    );
    with_detail(error, "name", name)
}

pub fn plugin_file_too_large(relative: &str, size: u64, max: u64) -> AppError {
    let error = app_error(
        "pluginFileTooLarge",
        format!("插件文件过大：{relative}（{size} 字节，上限 {max} 字节）"),
    );
    with_detail(error, "path", relative)
}
