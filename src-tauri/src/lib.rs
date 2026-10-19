pub mod clipboard;
pub mod desktop;
pub mod docs;
pub mod json_io;
pub mod locales;
pub mod pdf;
pub mod plugins;
pub mod selfupdate;
pub mod services;
pub mod styles;
pub mod system;
pub mod updater;

use locales::Locale;
use services::notes::{default_store, AppConfig, AppError, Note, NoteMetadata, SaveNoteRequest};
use services::workspace;
use services::workspace_cache;
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
fn app_name() -> Result<String, AppError> {
    let locale = Locale::from_tag(&default_store()?.load_config()?.locale);
    Ok(locales::app_name(locale).to_string())
}

#[tauri::command]
fn notes_list() -> Result<Vec<NoteMetadata>, AppError> {
    default_store()?.list_notes()
}

#[tauri::command]
fn notes_get(id: String) -> Result<Note, AppError> {
    default_store()?.read_note(&id)
}

#[tauri::command]
fn notes_create(app: AppHandle, request: SaveNoteRequest) -> Result<Note, AppError> {
    let note = default_store()?.create_note(request)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_update(app: AppHandle, id: String, request: SaveNoteRequest) -> Result<Note, AppError> {
    let note = default_store()?.update_note(&id, request)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    default_store()?.delete_note(&id)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn notes_import_markdown(
    app: AppHandle,
    path: String,
    category: Option<String>,
) -> Result<Note, AppError> {
    let note = default_store()?
        .import_markdown_file(&PathBuf::from(path), &category.unwrap_or_default())?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_export_markdown(id: String, path: String) -> Result<(), AppError> {
    default_store()?.export_markdown_file(&id, &PathBuf::from(path))
}

#[tauri::command]
fn read_external_file(path: String) -> Result<String, AppError> {
    std::fs::read_to_string(&path).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
fn get_file_modified_time(path: String) -> Result<f64, AppError> {
    let metadata = std::fs::metadata(&path).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })?;
    let modified = metadata.modified().map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(duration.as_secs_f64() * 1000.0)
}

#[tauri::command]
fn save_external_file(path: String, content: String) -> Result<(), AppError> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError {
            code: "io".into(),
            message: e.to_string(),
            details: Default::default(),
        })?;
    }
    std::fs::write(&path, content).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })
}

/// 把**字节**写到用户选好的路径（插件视图的「另存为」）。
///
/// 参数走 **Tauri 的 raw body**（前端 `invoke("save_external_file_bytes", new Uint8Array(...), { headers: { path } })`）：
/// 一份 10MB 的 PDF 如果按 JSON 数组过一遍 IPC，会变成几十 MB 的文本，慢得肉眼可见。
/// 与 `images_save` 那种 `Vec<u8>` 老写法不同 —— 那个只适合几百 KB 的图。
///
/// ⚠️ 路径从**请求头**里来，因为 body 已经被字节占满了。它由宿主的原生保存对话框产生
/// （用户自己挑的），到这里不再做「是不是在某个目录里」的校验 —— 那条规则属于
/// `workspace_write_file` 那种「写进受管目录」的场景，而这里是「用户让我存到这儿」。
/// 前端那层也不给插件直接调：插件只能说「我想存这份东西」，路径由人拍板。
#[tauri::command]
fn save_external_file_bytes(request: tauri::ipc::Request<'_>) -> Result<(), AppError> {
    let path = request
        .headers()
        .get("x-floral-path")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        // 头是 ASCII 的（浏览器不会让我们塞中文进来），所以路径由前端做 percent-encoding。
        .map(|raw| percent_decode(&raw))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError {
            code: "io".into(),
            message: "没有给出要保存到哪个文件".into(),
            details: Default::default(),
        })?;

    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.clone(),
        // 走到这儿说明前端把参数写成了 JSON —— 那是它的 bug，说清楚而不是猜。
        _ => {
            return Err(AppError {
                code: "io".into(),
                message: "保存文件的入参形状不对（要的是 raw bytes）".into(),
                details: Default::default(),
            })
        }
    };

    if let Some(parent) = PathBuf::from(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| AppError {
                code: "io".into(),
                message: e.to_string(),
                details: Default::default(),
            })?;
        }
    }
    std::fs::write(&path, bytes).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })
}

/// 解 `%XX`。自己写是因为 `percent-encoding` 那套为了几个字节不值得引依赖。
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|value| u8::from_str_radix(value, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn categories_list() -> Result<Vec<String>, AppError> {
    default_store()?.list_categories()
}

#[tauri::command]
fn categories_create(app: AppHandle, name: String) -> Result<(), AppError> {
    default_store()?.create_category(&name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn categories_rename(app: AppHandle, old_name: String, new_name: String) -> Result<(), AppError> {
    default_store()?.rename_category(&old_name, &new_name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn categories_delete(app: AppHandle, name: String) -> Result<(), AppError> {
    default_store()?.delete_category(&name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn notes_move_category(
    app: AppHandle,
    id: String,
    category: String,
) -> Result<NoteMetadata, AppError> {
    let result = default_store()?.move_note_to_category(&id, &category)?;
    let _ = app.emit("notes-changed", ());
    Ok(result)
}

#[tauri::command]
fn images_save(note_id: String, data: Vec<u8>, extension: String) -> Result<String, AppError> {
    default_store()?.save_image(&note_id, &data, &extension)
}

#[tauri::command]
fn images_save_from_path(note_id: String, file_path: String) -> Result<String, AppError> {
    let path = PathBuf::from(&file_path);
    let data = std::fs::read(&path)?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("png")
        .to_string();
    default_store()?.save_image(&note_id, &data, &extension)
}

#[tauri::command]
fn images_get_base_dir() -> Result<String, AppError> {
    let store = default_store()?;
    store
        .data_dir()
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError {
            code: "path".into(),
            message: "invalid data dir path".into(),
            details: Default::default(),
        })
}

#[tauri::command]
fn images_clean_unused(note_id: String, content: String) -> Result<Vec<String>, AppError> {
    default_store()?.clean_unused_images(&note_id, &content)
}

#[tauri::command]
fn config_get() -> Result<AppConfig, AppError> {
    default_store()?.load_config()
}

#[tauri::command]
fn copy_background_image(_app: AppHandle, source_path: String) -> Result<String, AppError> {
    let source = PathBuf::from(source_path.trim());
    if !source.is_file() {
        return Err(AppError {
            code: "invalidSource".into(),
            message: "background image source not found".into(),
            details: Default::default(),
        });
    }

    let store = default_store()?;
    let dir = store.data_dir().join("backgrounds");
    fs::create_dir_all(&dir)?;

    let old_config = store.load_config()?;
    if !old_config.background_image_path.is_empty() {
        let old_path = PathBuf::from(&old_config.background_image_path);
        if old_path.starts_with(&dir) && old_path.is_file() {
            let _ = fs::remove_file(&old_path);
        }
    }

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("png");
    let dest = dir.join(format!("bg-{}.{}", uuid::Uuid::new_v4(), ext));
    fs::copy(&source, &dest)?;

    dest.to_str().map(str::to_string).ok_or_else(|| AppError {
        code: "path".into(),
        message: "invalid destination path".into(),
        details: Default::default(),
    })
}

#[tauri::command]
fn config_save(app: AppHandle, config: AppConfig) -> Result<AppConfig, AppError> {
    let store = default_store()?;
    let previous = store.load_config()?;
    desktop::apply_runtime_config(&app, &previous, &config).map_err(|error| {
        match error.downcast::<AppError>() {
            Ok(app_error) => *app_error,
            Err(error) => AppError {
                code: "desktopConfig".into(),
                message: error.to_string(),
                details: Default::default(),
            },
        }
    })?;
    let saved = store.save_config(config)?;
    if let Err(error) = desktop::refresh_shell_state(&app, &saved) {
        eprintln!("failed to refresh desktop shell state: {error}");
    }
    let _ = app.emit("config-changed", &saved);
    Ok(saved)
}

#[tauri::command]
fn config_migrate_data_dir(app: AppHandle, new_data_dir: String) -> Result<AppConfig, AppError> {
    let store = default_store()?;
    let new_path = PathBuf::from(&new_data_dir).join("floral");
    let new_store = store.migrate_data_to(&new_path)?;

    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(new_path.join("images"), true);
    let _ = scope.allow_directory(new_path.join("backgrounds"), true);

    let config = new_store.load_config()?;
    let _ = app.emit("config-changed", &config);
    Ok(config)
}

// ------------------------------------------------------------ 工作文件夹
//
// 这几个命令的共同点：目标路径必须落在**用户显式添加过**的工作文件夹之内。
// 校验不在前端做——前端的任何判断都只是提示，真正的闸在 `services::workspace`：
// canonicalize 之后做前缀匹配，因此 `..` 与符号链接都绕不过去。

/// 列出一个工作文件夹里**一层**的内容（目录树是按需懒加载的，不递归）。
#[tauri::command]
fn workspace_list_dir(dir: String) -> Result<workspace::WorkspaceListing, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::list_dir(&workspace::roots_from_config(&config.workspace_folders), &dir)
}

#[tauri::command]
fn workspace_read_file(path: String) -> Result<String, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::read_text_file(&workspace::roots_from_config(&config.workspace_folders), &path)
}

/// 读工作区文件的原始字节。
///
/// 返回 `tauri::ipc::Response` 而不是 `Vec<u8>`：这样 JS 侧拿到的是 **`ArrayBuffer`**，
/// 不经 JSON 数组、不做 base64（几百兆的 PDF 走数字数组是不可想象的）。
#[tauri::command]
fn workspace_read_file_bytes(path: String) -> Result<tauri::ipc::Response, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    let bytes =
        workspace::read_binary_file(&workspace::roots_from_config(&config.workspace_folders), &path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 读外部文件的原始字节。与 `read_external_file` 同样的取舍：那条本就地不限路径。
#[tauri::command]
fn read_external_file_bytes(path: String) -> Result<tauri::ipc::Response, AppError> {
    let bytes = std::fs::read(&path).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn workspace_write_file(path: String, content: String) -> Result<(), AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::write_text_file(
        &workspace::roots_from_config(&config.workspace_folders),
        &path,
        &content,
    )
}

/// 删除工作文件夹里的一个**文件**（目录会被拒绝）。
#[tauri::command]
fn workspace_delete_file(path: String) -> Result<(), AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::delete_file(&workspace::roots_from_config(&config.workspace_folders), &path)
}

/// 把文件或目录移动到另一个工作目录下，返回移动后的新路径。
#[tauri::command]
fn workspace_move_entry(path: String, target_dir: String) -> Result<String, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::move_entry(
        &workspace::roots_from_config(&config.workspace_folders),
        &path,
        &target_dir,
    )
}

/// 重命名工作区里的一个文件，返回新路径。
#[tauri::command]
fn workspace_rename_entry(path: String, new_name: String) -> Result<String, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::rename_entry(
        &workspace::roots_from_config(&config.workspace_folders),
        &path,
        &new_name,
    )
}

/// 把外部文件 / 文件夹复制进一个工作目录（拖入、粘贴都用它）。
#[tauri::command]
fn workspace_copy_entries(sources: Vec<String>, target_dir: String) -> Result<usize, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::copy_entries(
        &workspace::roots_from_config(&config.workspace_folders),
        &sources,
        &target_dir,
    )
}

/// 批量删除工作区里的文件 / 文件夹。
#[tauri::command]
fn workspace_delete_entries(paths: Vec<String>) -> Result<usize, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::delete_entries(
        &workspace::roots_from_config(&config.workspace_folders),
        &paths,
    )
}

/// 批量把工作区里的项目移动到一个目标目录。
#[tauri::command]
fn workspace_move_entries(paths: Vec<String>, target_dir: String) -> Result<usize, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::move_entries(
        &workspace::roots_from_config(&config.workspace_folders),
        &paths,
        &target_dir,
    )
}

/// 列出某个工作目录下的所有子目录，供「移动到…」选择目标。
#[tauri::command]
fn workspace_list_subdirs(dir: String) -> Result<Vec<String>, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::list_subdirs(&workspace::roots_from_config(&config.workspace_folders), &dir)
}

/// 数据目录的绝对路径。
///
/// 给插件用的：插件住在数据目录里，但**它不知道那个目录在哪**（路径由用户配置、还可能
/// 被迁移）。`api.workspace.openFolder` 的 `@data` / `@data/styles` 两个哨兵就靠这里解析。
#[tauri::command]
fn data_dir_path() -> Result<String, AppError> {
    Ok(default_store()?
        .data_dir()
        .to_string_lossy()
        .to_string())
}

/// 添加一个工作文件夹。
///
/// 除了写进配置，还要把该目录加进 asset 协议白名单：文件夹里的图片要能显示就得走
/// `convertFileSrc`，而它只对 scope 内的路径生效。
#[tauri::command]
fn workspace_add_folder(app: AppHandle, path: String) -> Result<AppConfig, AppError> {
    let root = workspace::normalize_root(&path)?;

    let store = default_store()?;
    let mut config = store.load_config()?;

    // 用规范化后的路径去重，避免同一个目录因写法不同（尾斜杠、短路径）被加两次。
    let already = workspace::roots_from_config(&config.workspace_folders)
        .iter()
        .any(|existing| existing == &root);

    // 存**普通形式**的路径：它会被原样回传给前端，再交给 `convertFileSrc` 生成
    // asset URL。verbatim 形式（`\\?\...`）与 scope 里登记的普通路径对不上，
    // 图片就会加载失败。
    let display = workspace::to_frontend_path(&root);
    if !already {
        config.workspace_folders.push(display.clone());
    }

    let saved = store.save_config(config)?;
    let _ = app.asset_protocol_scope().allow_directory(&display, true);
    let _ = app.emit("config-changed", &saved);
    Ok(saved)
}

// ---------------------------------------------------------------- 工作区缓存

/// 读一份插件写在某文件旁边的数据（`__floral-notepaper__/<插件>/…`）。没有就返回 `null`。
#[tauri::command]
fn workspace_cache_read(
    file: String,
    plugin: String,
) -> Result<Option<serde_json::Value>, AppError> {
    let roots = cache_roots()?;
    workspace_cache::read(&roots, Path::new(file.trim()), &plugin)
}

/// 写一份插件数据。整份重写、原子落盘。
#[tauri::command]
fn workspace_cache_write(
    file: String,
    plugin: String,
    value: serde_json::Value,
) -> Result<(), AppError> {
    let roots = cache_roots()?;
    workspace_cache::write(&roots, Path::new(file.trim()), &plugin, &value)
}

/// 删掉某文件上某个插件的缓存。文件本来就不在时不算错。
#[tauri::command]
fn workspace_cache_remove(file: String, plugin: String) -> Result<bool, AppError> {
    let roots = cache_roots()?;
    workspace_cache::remove(&roots, Path::new(file.trim()), &plugin)
}

/// 数一下某个工作文件夹里的缓存有多少（「移除工作文件夹」那个确认框要显示）。
#[tauri::command]
fn workspace_cache_info(path: String) -> Result<workspace_cache::CacheInfo, AppError> {
    Ok(workspace_cache::info(Path::new(path.trim())))
}

/// 把某个工作文件夹里的缓存整个删掉。用户点了「一起删掉」才调它。
#[tauri::command]
fn workspace_cache_clear(path: String) -> Result<workspace_cache::CacheInfo, AppError> {
    workspace_cache::clear(Path::new(path.trim()))
}

/// 当前的工作区根（已规范化）。缓存要按「文件落在哪个工作区里」定位。
fn cache_roots() -> Result<Vec<PathBuf>, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    Ok(workspace::roots_from_config(&config.workspace_folders))
}

/// 移除一个工作文件夹。
///
/// 这里**刻意不调用 `normalize_root`**：目录可能已经被删除或挪走，而那正是用户想要
/// 把它移出列表的场景；此时按存在性校验会拒绝移除，把用户卡死。
///
/// ⚠️ 这里**不动** `__floral-notepaper__` 里那份缓存：要不要连缓存一起清是用户的选择，
/// 由界面先问一句、再单独调 `workspace_cache_clear`。把「移出列表」与「删数据」绑成
/// 一个动作，迟早会有人只是想换个地方挂、结果把批注一起删了。
#[tauri::command]
fn workspace_remove_folder(app: AppHandle, path: String) -> Result<AppConfig, AppError> {
    let target = path.trim().to_string();

    let store = default_store()?;
    let mut config = store.load_config()?;
    config.workspace_folders.retain(|item| item.trim() != target);

    let saved = store.save_config(config)?;
    let _ = app.emit("config-changed", &saved);
    Ok(saved)
}

/// 图标 id 的**形状**校验：小写字母、数字、连字符，1–32 个字符。
///
/// 只认形状、不认名单（名单在前端 `WorkspaceIcons.tsx` 那一份）—— 见 `workspace_set_icon`
/// 的说明。抽成独立函数是为了能直接测：命令本身要 `AppHandle`，单测里造不出来。
fn is_valid_icon_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 给一个工作文件夹换图标（`icon` 传空 = 恢复默认）。
///
/// 只认形状不认名单：id 限 `[a-z0-9-]{1,32}`，**不在宿主里维护一份图标名单** ——
/// 那样 Rust 与前端各存一份、迟早对不上。前端认不出这个 id 就画回默认图标，
/// 所以「存了个已经删掉的图标名」最多是回到默认，不会出别的岔子。
#[tauri::command]
fn workspace_set_icon(app: AppHandle, path: String, icon: String) -> Result<AppConfig, AppError> {
    let target = path.trim().to_string();
    let wanted = icon.trim().to_ascii_lowercase();

    if !wanted.is_empty() && !is_valid_icon_id(&wanted) {
        return Err(AppError {
            code: "workspaceIconInvalid".into(),
            message: format!("图标名不合法：{icon}"),
            details: Default::default(),
        });
    }

    let store = default_store()?;
    let mut config = store.load_config()?;

    if wanted.is_empty() {
        config.workspace_icons.remove(&target);
    } else {
        config.workspace_icons.insert(target, wanted);
    }

    let saved = store.save_config(config)?;
    let _ = app.emit("config-changed", &saved);
    Ok(saved)
}

#[tauri::command]
fn global_shortcut_check(
    app: AppHandle,
    shortcut: String,
) -> Result<desktop::ShortcutCheckResult, AppError> {
    desktop::check_global_shortcut(&app, &shortcut)
}

#[tauri::command]
fn start_shortcut_recording(app: AppHandle) -> Result<(), AppError> {
    desktop::start_shortcut_recording(&app).map_err(|error| AppError {
        code: "shortcutRecording".into(),
        message: error.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
fn stop_shortcut_recording(app: AppHandle) -> Result<(), AppError> {
    desktop::stop_shortcut_recording(&app).map_err(|error| AppError {
        code: "shortcutRecording".into(),
        message: error.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
async fn open_notepad_window(
    app: AppHandle,
    note_id: Option<String>,
    bounds: Option<desktop::WindowBounds>,
) -> Result<String, AppError> {
    desktop::open_notepad_window(app, note_id, bounds).await
}

#[tauri::command]
async fn recycle_notepad_window(app: AppHandle, label: String) -> Result<(), AppError> {
    desktop::recycle_notepad_window(&app, &label)
}

/// Pre-shift the window by `(dx, dy)` logical px before starting an OS drag,
/// so a JS-side deadzone (e.g. tile double-click-to-edit) does not leave the
/// window lagging the cursor by the deadzone displacement.
#[tauri::command]
fn start_window_drag_with_offset(
    window: tauri::WebviewWindow,
    dx: f64,
    dy: f64,
) -> Result<(), AppError> {
    let scale = window.scale_factor()?;
    let pos = window.outer_position()?;
    let next_x = pos.x + (dx * scale).round() as i32;
    let next_y = pos.y + (dy * scale).round() as i32;
    window.set_position(tauri::PhysicalPosition::new(next_x, next_y))?;
    window.start_dragging()?;
    Ok(())
}

#[tauri::command]
async fn open_tile_window(
    app: AppHandle,
    note_id: String,
    bounds: Option<desktop::WindowBounds>,
) -> Result<String, AppError> {
    desktop::open_tile_window(app, note_id, bounds).await
}

#[tauri::command]
async fn toggle_tile_window(
    app: AppHandle,
    note_id: String,
    bounds: Option<desktop::WindowBounds>,
) -> Result<bool, AppError> {
    desktop::toggle_tile_window(app, note_id, bounds).await
}

#[tauri::command]
async fn open_note_in_editor(app: AppHandle, note_id: String) -> Result<(), AppError> {
    desktop::show_main_window(&app)?;
    let _ = app.emit("open-note", &note_id);
    Ok(())
}

#[tauri::command]
fn take_startup_file() -> Option<String> {
    desktop::take_startup_file()
}

fn cli_version_or_help_requested() -> bool {
    env::args().any(|arg| matches!(arg.as_str(), "--version" | "-V" | "--help" | "-h"))
}

#[cfg(windows)]
fn ensure_console() {
    use windows_sys::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};

    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            let _ = AllocConsole();
        }
    }
}

#[cfg(not(windows))]
fn ensure_console() {}

fn flush_attached_console_stdout() {
    let _ = std::io::stdout().flush();
}

fn print_cli_version() {
    let _ = writeln!(
        std::io::stdout(),
        "floral-notepaper {}",
        env!("CARGO_PKG_VERSION")
    );
    flush_attached_console_stdout();
}

fn print_cli_help() {
    let _ = writeln!(
        std::io::stdout(),
        "floral-notepaper {}\nFloral Notepaper - lightweight local note app\n\nUSAGE:\n    floral-notepaper [OPTIONS]\n\nOPTIONS:\n    -V, --version\n            Print version\n    -h, --help\n            Print help",
        env!("CARGO_PKG_VERSION"),
    );
    flush_attached_console_stdout();
}

pub fn try_exit_for_cli_version_or_help() {
    if !cli_version_or_help_requested() {
        return;
    }

    ensure_console();

    let wants_version = env::args().any(|arg| arg == "--version" || arg == "-V");
    let wants_help = env::args().any(|arg| arg == "--help" || arg == "-h");

    if wants_version {
        print_cli_version();
        std::process::exit(0);
    }

    if wants_help {
        print_cli_help();
        std::process::exit(0);
    }

    std::process::exit(0);
}

/// 单实例插件的开关判定，抽成纯函数以便单测。
fn single_instance_disabled_from(value: Option<&str>) -> bool {
    matches!(value, Some(raw) if raw.trim() == "1")
}

/// 开发调试逃生阀：设置 `FLORAL_NOTEPAPER_NO_SINGLE_INSTANCE=1` 时跳过单实例插件。
///
/// 单实例锁按应用 identifier（`com.floral-notepaper.app`）生效，因此本地源码调试实例
/// 会被机器上已安装的正式实例抢走锁并直接退出，无法启动。调试时用该环境变量绕开；
/// 正式发布版本不受影响，因为必须显式设置它才会生效。
fn single_instance_disabled() -> bool {
    let value = env::var("FLORAL_NOTEPAPER_NO_SINGLE_INSTANCE").ok();
    single_instance_disabled_from(value.as_deref())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_opener::init())
        // 自更新。端点来自 `tauri.conf.json` 的 `plugins.updater.endpoints`，
        // **默认为空 = 整个功能关闭**：前端问过 `update_endpoint` 之后连一次请求都不会发。
        // 见 `selfupdate` 模块。
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新装完之后要重启，那一步由 process 插件负责。
        .plugin(tauri_plugin_process::init());

    if single_instance_disabled() {
        eprintln!(
            "FLORAL_NOTEPAPER_NO_SINGLE_INSTANCE=1：已跳过单实例插件（仅用于本地调试）"
        );
    } else {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(file_path) = desktop::extract_file_arg(&args) {
                let _ = app.emit("open-external-file", file_path);
            }
            let _ = desktop::show_main_window(app);
        }));
    }

    builder
        .setup(|app| {
            if let Ok(store) = default_store() {
                let data = store.data_dir();
                let scope = app.asset_protocol_scope();
                let _ = scope.allow_directory(data.join("images"), true);
                let _ = scope.allow_directory(data.join("backgrounds"), true);

                // 已添加的工作文件夹也要放行。asset scope 是**运行时**状态，不会跨进程
                // 保留，重启后必须重新登记，否则工作文件夹里的图片会显示不出来。
                // 这里只读配置、失败就跳过：scope 是尽力而为的，不该让它挡住启动。
                if let Ok(config) = store.load_config() {
                    for root in workspace::roots_from_config(&config.workspace_folders) {
                        // 同样要用普通形式：asset 协议的 scope 按普通路径登记，
                        // `convertFileSrc` 生成的 URL 也是普通路径。
                        let _ = scope.allow_directory(workspace::to_frontend_path(&root), true);
                    }
                }
            }
            // 自动更新已整体停用 —— 本仓库是上游的 fork，且改动很大。
            // 原来的检查器指向 Achilng/floral-notepaper 与 Mirror酱，一旦真的走完更新
            // 流程就会把上游代码装进来，覆盖掉本仓库的全部改动。因此这里不再初始化
            // UpdaterState、不启动自动检查调度器，`invoke_handler` 里也不再注册
            // update_* 命令（前端对应的调用点已一并移除）。
            //
            // `pub mod updater` 仍然保留：`main.rs` 在安装辅助进程模式下要用
            // `updater::helper::run_cli`，且该模块自带的测试也在跑。删掉这个声明会让
            // 那些代码无法编译。
            // 版本校正：把随包分发的那份插件，同步到用户数据目录里已经装好的副本上
            // （应用升级后那份副本不会自己变，新宿主配老插件会出问题）。
            //
            // 时机放在这里：数据目录已定、asset scope 已登记，且早于前端任何
            // `plugins_list` —— 前端拿到的列表就已经是校正过的。
            //
            // 最后那句**不是自动成立的**：`tauri::app::setup` 先按配置把窗口建出来
            // （见该函数开头），再跑这个钩子，所以 WebView 其实已经在了。真正兜住的是
            // 派发机制 —— `#[tauri::command]` 由事件循环处理，而这个钩子跑完之前事件循环
            // 不会往下走，前端就算抢跑也只会排队等到校正之后才被受理。
            //
            // 结果存在模块里，由 `plugins_sync_report` 取走，前端据此决定要不要提示用户。
            // 校正失败只记日志，**绝不往上抛**：它是附带动作，不该挡住应用启动。
            match app.path().resource_dir() {
                Ok(resource_dir) => plugins::sync::sync_at_startup(&resource_dir),
                Err(error) => eprintln!("[plugins:sync] 取不到资源目录，跳过版本校正：{error}"),
            }

            // 全局样式表：盯着 `<数据目录>/styles/`，变了就广播给所有窗口。
            //
            // ⚠️ **必须在这里（而不是更早）起**：播种 `custom.css` 会往数据目录里写文件，
            // 而 `NoteStore` 构造期的 `migrate_data_dir_if_relocated` 用「目录里有没有文件」
            // 判断新目录干不干净、有文件就放弃迁移。放到 store 之后就没有这个问题。
            // 详见 `crate::styles` 模块开头的说明。
            styles::watch(app.handle());

            desktop::setup_desktop(app)?;
            Ok(())
        })
        .on_window_event(desktop::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            app_name,
            notes_list,
            notes_get,
            notes_create,
            notes_update,
            notes_delete,
            notes_import_markdown,
            notes_export_markdown,
            notes_move_category,
            read_external_file,
            save_external_file,
            get_file_modified_time,
            categories_list,
            categories_create,
            categories_rename,
            categories_delete,
            images_save,
            images_save_from_path,
            images_get_base_dir,
            images_clean_unused,
            config_get,
            copy_background_image,
            config_save,
            config_migrate_data_dir,
            global_shortcut_check,
            start_shortcut_recording,
            stop_shortcut_recording,
            open_notepad_window,
            recycle_notepad_window,
            start_window_drag_with_offset,
            open_tile_window,
            toggle_tile_window,
            open_note_in_editor,
            plugins::commands::plugins_list,
            plugins::commands::plugins_read,
            plugins::commands::plugins_read_asset,
            plugins::commands::plugins_list_assets,
            plugins::commands::plugins_list_fonts,
            plugins::commands::plugins_dir_path,
            plugins::commands::plugins_open_dir,
            plugins::commands::plugins_set_enabled,
            plugins::commands::plugins_set_auto_update,
            plugins::commands::plugins_set_permissions,
            plugins::commands::plugins_storage_get,
            plugins::commands::plugins_storage_set,
            plugins::commands::plugins_storage_delete,
            plugins::commands::plugins_storage_keys,
            plugins::commands::plugins_storage_clear,
            plugins::commands::plugins_settings_get,
            plugins::commands::plugins_settings_set,
            plugins::commands::plugins_sync_report,
            workspace_list_dir,
            workspace_read_file,
            workspace_write_file,
            data_dir_path,
            workspace_add_folder,
            workspace_remove_folder,
            workspace_set_icon,
            workspace_cache_read,
            workspace_cache_write,
            workspace_cache_remove,
            workspace_cache_info,
            workspace_cache_clear,
            workspace_delete_file,
            workspace_delete_entries,
            workspace_move_entry,
            workspace_move_entries,
            workspace_rename_entry,
            workspace_copy_entries,
            workspace_list_subdirs,
            clipboard::clipboard_copy_files,
            clipboard::clipboard_read_files,
            system::system_open_with,
            system::system_show_properties,
            take_startup_file,
            workspace_read_file_bytes,
            read_external_file_bytes,
            save_external_file_bytes,
            pdf::print_pdf,
            pdf::print_pdf_preview,
            pdf::print_with_dialog,
            selfupdate::update_endpoint,
            docs::read_bundled_doc,
            styles::global_styles_bundle,
            styles::global_styles_set_global,
            styles::global_styles_bind,
            styles::global_styles_dir_path,
            styles::global_styles_open_dir,
            plugins::market::commands::plugins_market_endpoint,
            plugins::market::commands::plugins_market_catalog,
            plugins::market::commands::plugins_market_install,
            plugins::market::commands::plugins_market_uninstall
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = _event
            {
                if !has_visible_windows {
                    if let Err(error) = desktop::show_main_window(_app_handle) {
                        eprintln!("failed to show main window on dock click: {error}");
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{is_valid_icon_id, single_instance_disabled_from};

    #[test]
    fn single_instance_disabled_only_for_explicit_flag() {
        assert!(single_instance_disabled_from(Some("1")));
        assert!(single_instance_disabled_from(Some(" 1 ")));

        assert!(!single_instance_disabled_from(None));
        assert!(!single_instance_disabled_from(Some("")));
        assert!(!single_instance_disabled_from(Some("0")));
        assert!(!single_instance_disabled_from(Some("true")));
        assert!(!single_instance_disabled_from(Some("yes")));
    }

    #[test]
    fn icon_ids_are_shape_checked_only() {
        assert!(is_valid_icon_id("folder"));
        assert!(is_valid_icon_id("code-2"));

        // 空串**不合法** —— 调用方用「空」表示恢复默认，所以那一条在调用点就分流了，
        // 永远走不到这个判定。
        assert!(!is_valid_icon_id(""));
        // 大写、空格、路径分隔符、超长都不收：这个值会原样存进配置、再交给前端去查表，
        // 宽松没有好处。
        assert!(!is_valid_icon_id("Folder"));
        assert!(!is_valid_icon_id("a b"));
        assert!(!is_valid_icon_id("../etc"));
        assert!(!is_valid_icon_id(&"a".repeat(33)));
    }
}
