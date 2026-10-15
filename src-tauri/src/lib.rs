pub mod desktop;
pub mod docs;
pub mod json_io;
pub mod locales;
pub mod plugins;
pub mod selfupdate;
pub mod services;
pub mod updater;

use locales::Locale;
use services::notes::{default_store, AppConfig, AppError, Note, NoteMetadata, SaveNoteRequest};
use services::workspace;
use std::{env, fs, io::Write, path::PathBuf};
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

/// 列出某个工作目录下的所有子目录，供「移动到…」选择目标。
#[tauri::command]
fn workspace_list_subdirs(dir: String) -> Result<Vec<String>, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    workspace::list_subdirs(&workspace::roots_from_config(&config.workspace_folders), &dir)
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

/// 移除一个工作文件夹。
///
/// 这里**刻意不调用 `normalize_root`**：目录可能已经被删除或挪走，而那正是用户想要
/// 把它移出列表的场景；此时按存在性校验会拒绝移除，把用户卡死。
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
            workspace_add_folder,
            workspace_remove_folder,
            workspace_delete_file,
            workspace_move_entry,
            workspace_list_subdirs,
            take_startup_file,
            workspace_read_file_bytes,
            read_external_file_bytes,
            selfupdate::update_endpoint,
            docs::read_bundled_doc,
            plugins::market::config::plugins_market_endpoint
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
    use super::single_instance_disabled_from;

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
}
