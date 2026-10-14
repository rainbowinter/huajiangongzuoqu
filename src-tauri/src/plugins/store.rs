//! 每个插件的持久化：键值存储（`kv.json`）与设置值（`settings.json`）。
//!
//! 并发模型：花笺是多窗口应用，每个 WebView 窗口都会独立调用这些命令，因此
//! 两个窗口可能同时对同一插件做读-改-写。这里用一层**目录级文件锁**把读改写
//! 串行化，避免丢更新；写入本身走 `json_io::write_json_atomic`，即使发生意外
//! 也不会写出半个文件。锁走的是与 `updater/file_lock.rs` 相同的
//! `create_new` + 陈旧锁回收策略。
//!
//! 注意：`clear_kv` 只清 `kv.json`，**不动** `settings.json`——设置是用户在界面上
//! 配的，不应该被插件一句 `storage.clear()` 抹掉。

use super::errors::{app_error, with_detail};
use super::paths::PluginPaths;
use crate::json_io::write_json_atomic;
use crate::services::notes::AppError;
use chrono::Utc;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

/// 单个键的长度上限。
const MAX_KEY_BYTES: usize = 1024;
/// 单个值的序列化长度上限。与插件文件的体积上限保持同一量级。
const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;
/// 等待锁的最长时间。
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
/// 轮询间隔。
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// 超过这个年龄的锁视为进程崩溃残留，可回收。
const STALE_LOCK_AGE: Duration = Duration::from_secs(60);

/// 一个插件数据目录的读写锁。`Drop` 时释放。
pub struct DataDirLock {
    path: PathBuf,
}

impl Drop for DataDirLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_data_dir_lock(data_dir: &Path) -> Result<DataDirLock, AppError> {
    fs::create_dir_all(data_dir)?;
    let lock_path = data_dir.join(".lock");

    let deadline = Instant::now() + LOCK_TIMEOUT;
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                let _ = writeln!(file, "{} {}", std::process::id(), Utc::now().to_rfc3339());
                return Ok(DataDirLock { path: lock_path });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                remove_stale_lock(&lock_path);
                if Instant::now() >= deadline {
                    return Err(with_detail(
                        app_error("pluginStoreBusy", "插件数据被占用，请稍后重试"),
                        "path",
                        lock_path.display().to_string(),
                    ));
                }
                thread::sleep(LOCK_POLL_INTERVAL);
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn remove_stale_lock(lock_path: &Path) {
    let Ok(metadata) = fs::metadata(lock_path) else {
        return;
    };
    let Ok(modified) = metadata.modified() else {
        return;
    };
    let Ok(age) = SystemTime::now().duration_since(modified) else {
        return;
    };
    if age >= STALE_LOCK_AGE {
        let _ = fs::remove_file(lock_path);
    }
}

/// 读-改-写。整个操作在插件数据目录的锁内完成。
pub fn with_data_dir_lock<T>(
    paths: &PluginPaths,
    name: &str,
    action: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let data_dir = paths.data_dir_for(name)?;
    let _guard = acquire_data_dir_lock(&data_dir)?;
    action()
}

fn read_json_map(path: &Path) -> Result<BTreeMap<String, Value>, AppError> {
    if !path.is_file() {
        return Ok(BTreeMap::new());
    }

    let raw = fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(BTreeMap::new());
    }

    match serde_json::from_str::<BTreeMap<String, Value>>(&raw) {
        Ok(map) => Ok(map),
        Err(_) => {
            // 文件损坏时不要静默丢弃：先留一份现场再重新开始，与 updater/settings.rs 一致。
            let stamp = Utc::now().format("%Y%m%d%H%M%S");
            let backup = path.with_extension(format!("corrupt-{stamp}.json"));
            let _ = fs::rename(path, &backup);
            Ok(BTreeMap::new())
        }
    }
}

fn write_json_map(path: &Path, map: &BTreeMap<String, Value>) -> Result<(), AppError> {
    write_json_atomic(path, map)
}

pub fn validate_key(key: &str) -> Result<(), AppError> {
    if key.trim().is_empty() {
        return Err(app_error("pluginStorageKeyInvalid", "存储键不能为空"));
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(with_detail(
            app_error("pluginStorageKeyInvalid", "存储键过长"),
            "key",
            key.chars().take(64).collect::<String>(),
        ));
    }
    Ok(())
}

pub fn validate_value(value: &Value) -> Result<(), AppError> {
    let serialized = serde_json::to_vec(value)?;
    if serialized.len() > MAX_VALUE_BYTES {
        return Err(with_detail(
            app_error("pluginStorageValueTooLarge", "存储值过大"),
            "bytes",
            serialized.len().to_string(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- 键值存储

pub fn list_keys(paths: &PluginPaths, name: &str) -> Result<Vec<String>, AppError> {
    let path = paths.kv_path(name)?;
    let map = read_json_map(&path)?;
    Ok(map.keys().cloned().collect())
}

pub fn get_value(paths: &PluginPaths, name: &str, key: &str) -> Result<Option<Value>, AppError> {
    validate_key(key)?;
    let path = paths.kv_path(name)?;
    let map = read_json_map(&path)?;
    Ok(map.get(key).cloned())
}

pub fn set_value(
    paths: &PluginPaths,
    name: &str,
    key: &str,
    value: Value,
) -> Result<(), AppError> {
    validate_key(key)?;
    validate_value(&value)?;

    let path = paths.kv_path(name)?;
    with_data_dir_lock(paths, name, || {
        let mut map = read_json_map(&path)?;
        map.insert(key.to_string(), value);
        write_json_map(&path, &map)
    })
}

pub fn delete_value(paths: &PluginPaths, name: &str, key: &str) -> Result<(), AppError> {
    validate_key(key)?;

    let path = paths.kv_path(name)?;
    with_data_dir_lock(paths, name, || {
        let mut map = read_json_map(&path)?;
        map.remove(key);
        write_json_map(&path, &map)
    })
}

pub fn clear_values(paths: &PluginPaths, name: &str) -> Result<(), AppError> {
    let path = paths.kv_path(name)?;
    with_data_dir_lock(paths, name, || write_json_map(&path, &BTreeMap::new()))
}

// ------------------------------------------------------------------ 设置值

/// 设置项以对象形式对外（前端按键读），内部与 KV 分开存。
pub fn get_settings(paths: &PluginPaths, name: &str) -> Result<Map<String, Value>, AppError> {
    let path = paths.settings_path(name)?;
    let map = read_json_map(&path)?;
    Ok(map.into_iter().collect())
}

pub fn set_settings(
    paths: &PluginPaths,
    name: &str,
    values: Map<String, Value>,
) -> Result<Map<String, Value>, AppError> {
    for (key, value) in &values {
        validate_key(key)?;
        validate_value(value)?;
    }

    let path = paths.settings_path(name)?;
    with_data_dir_lock(paths, name, || {
        let mut map = read_json_map(&path)?;
        for (key, value) in values {
            map.insert(key, value);
        }
        write_json_map(&path, &map)?;
        Ok(map.into_iter().collect())
    })
}

/// 供外部读取某个插件的数据目录（例如删除插件时清理数据）。
pub fn remove_plugin_data(paths: &PluginPaths, name: &str) -> Result<(), AppError> {
    let dir = paths.data_root.join(name);
    if dir.is_dir() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_paths(tag: &str) -> PluginPaths {
        let mut dir = std::env::temp_dir();
        dir.push(format!("floral-plugin-store-{tag}-{}", uuid::Uuid::new_v4()));
        let paths = PluginPaths::from_data_dir(&dir);
        paths.ensure_dirs().expect("ensure dirs");
        paths
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let paths = temp_paths("missing");
        assert!(list_keys(&paths, "demo").unwrap().is_empty());
        assert!(get_value(&paths, "demo", "nope").unwrap().is_none());
        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn set_get_delete_roundtrip() {
        let paths = temp_paths("roundtrip");

        set_value(&paths, "demo", "count", json!(3)).unwrap();
        set_value(&paths, "demo", "name", json!("花笺")).unwrap();

        assert_eq!(get_value(&paths, "demo", "count").unwrap(), Some(json!(3)));
        assert_eq!(
            get_value(&paths, "demo", "name").unwrap(),
            Some(json!("花笺"))
        );

        let mut keys = list_keys(&paths, "demo").unwrap();
        keys.sort();
        assert_eq!(keys, vec!["count", "name"]);

        delete_value(&paths, "demo", "count").unwrap();
        assert!(get_value(&paths, "demo", "count").unwrap().is_none());
        assert_eq!(list_keys(&paths, "demo").unwrap(), vec!["name"]);

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn values_persist_across_reads() {
        let paths = temp_paths("persist");

        set_value(&paths, "demo", "token", json!({ "a": [1, 2, 3] })).unwrap();

        // 重新解析一遍路径，模拟下一次进程启动
        let again = PluginPaths::from_data_dir(paths.root.parent().unwrap());
        assert_eq!(
            get_value(&again, "demo", "token").unwrap(),
            Some(json!({ "a": [1, 2, 3] }))
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn clear_removes_kv_but_keeps_settings() {
        let paths = temp_paths("clear");

        set_value(&paths, "demo", "scratch", json!(1)).unwrap();
        let mut values = Map::new();
        values.insert("countMode".to_string(), json!("words"));
        set_settings(&paths, "demo", values).unwrap();

        clear_values(&paths, "demo").unwrap();

        assert!(list_keys(&paths, "demo").unwrap().is_empty());
        assert_eq!(
            get_settings(&paths, "demo").unwrap().get("countMode"),
            Some(&json!("words")),
            "storage.clear() 不应抹掉用户的设置"
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn settings_values_round_trip() {
        let paths = temp_paths("settings");

        let mut values = Map::new();
        values.insert("countMode".to_string(), json!("chars"));
        set_settings(&paths, "demo", values).unwrap();

        let mut patch = Map::new();
        patch.insert("theme".to_string(), json!("dark"));
        let merged = set_settings(&paths, "demo", patch).unwrap();

        assert_eq!(merged.get("countMode"), Some(&json!("chars")));
        assert_eq!(merged.get("theme"), Some(&json!("dark")));

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn corrupt_file_is_quarantined_not_lost() {
        let paths = temp_paths("corrupt");
        let kv = paths.kv_path("demo").unwrap();
        fs::write(&kv, "{ this is not json").unwrap();

        assert!(list_keys(&paths, "demo").unwrap().is_empty());

        let quarantined: Vec<_> = fs::read_dir(kv.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("corrupt"))
            .collect();
        assert!(
            !quarantined.is_empty(),
            "损坏的文件应被另存现场，而不是直接删掉"
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn rejects_bad_keys_and_oversized_values() {
        let paths = temp_paths("validate");

        assert!(set_value(&paths, "demo", "", json!(1)).is_err());
        assert!(set_value(&paths, "demo", "   ", json!(1)).is_err());
        assert!(set_value(&paths, "demo", &"k".repeat(MAX_KEY_BYTES + 1), json!(1)).is_err());

        let huge = json!("x".repeat(MAX_VALUE_BYTES + 1));
        assert!(
            set_value(&paths, "demo", "big", huge).is_err(),
            "超过体积上限的值应被拒绝"
        );

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn data_dir_lock_serialises_concurrent_writers() {
        let paths = temp_paths("lock");
        let data_dir = paths.data_dir_for("demo").unwrap();

        {
            let _held = acquire_data_dir_lock(&data_dir).unwrap();
            assert!(
                data_dir.join(".lock").is_file(),
                "持锁期间应存在锁文件"
            );
        }

        assert!(
            !data_dir.join(".lock").is_file(),
            "释放后锁文件应被删除"
        );

        // 能重新获取说明锁确实释放了
        let _again = acquire_data_dir_lock(&data_dir).unwrap();

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    #[test]
    fn stale_lock_is_reclaimed() {
        let paths = temp_paths("stale");
        let data_dir = paths.data_dir_for("demo").unwrap();
        let lock = data_dir.join(".lock");
        fs::write(&lock, "0 stale").unwrap();

        // 把 mtime 推到很久以前
        let old = SystemTime::now() - STALE_LOCK_AGE - Duration::from_secs(60);
        let _ = filetime_set(&lock, old);

        let _guard = acquire_data_dir_lock(&data_dir).expect("陈旧锁应被回收后成功获取");

        fs::remove_dir_all(paths.root.parent().unwrap()).ok();
    }

    /// 仅测试用：设置文件 mtime，用于伪造一个"陈旧锁"。
    fn filetime_set(path: &Path, time: SystemTime) -> io::Result<()> {
        let file = OpenOptions::new().write(true).open(path)?;
        file.set_modified(time)
    }
}
