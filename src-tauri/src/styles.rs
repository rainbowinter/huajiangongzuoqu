//! 全局样式表 —— `<数据目录>/styles/*.css`。
//!
//! 目录里的每一份 `.css` 都会注入**每一个窗口**，**没有开关**：想让它不生效就把文件
//! 移走或改名。`custom.css` 只是其中约定俗成的那一份（首次运行从随包模板播种出来）。
//!
//! ```text
//! <数据目录>/styles/
//!   custom.css        首次运行播种，之后**再也不动用户这份**
//!   深色微调.css        用户自己加的，一样全局生效
//! ```
//!
//! ## 为什么是「轮询」而不是文件监视器
//!
//! 这个目录不在任何工作区里，应用既有的「保存即生效」（`plugin:assetsChanged`，
//! 见 `pluginPaths.rs`）够不到它 —— 那条路只在**应用内保存**时触发，用外部编辑器改
//! 文件不会发事件。要真做到「存一下就变」，只能自己盯。
//!
//! 盯的方式选了**每 2 秒比一次指纹**（文件名 + 修改时间 + 字节数），而不是引入
//! `notify` 这类文件监视库：
//!
//! * `desktop.rs` 的 `watch_idle_and_reclaim` 已经是这套写法（`thread::spawn` +
//!   `loop { sleep }`），照抄即可，**不引新依赖**；
//! * 只读 `metadata`、**从不读文件内容**，目录里通常不到十个文件，开销可以忽略；
//! * 轮询对「编辑器先写临时文件再改名」这种保存方式天然免疫，监视器还得处理
//!   各种 rename 事件。
//!
//! 比对的是**指纹**而不是内容，所以「改了又改回来、mtime 也变了」照样算变 —— 宁可
//! 多注入一次，也不要漏掉一次改动。
//!
//! ## ⚠️ 播种与数据目录迁移的先后顺序
//!
//! `services/notes.rs` 的 `migrate_data_dir_if_relocated` 用 `data_dir_has_user_data()`
//! 判断「新目录是不是干净的」，而它是**遍历目录条目**的 —— 只要新目录里**有任何文件**
//! 就认定「这里已经有用户数据」并**放弃迁移**。
//!
//! 我们往新目录写 `styles/custom.css`，正好会把一个全新目录变成「有用户数据」。
//!
//! 安全的原因是**顺序**：`migrate_data_dir_if_relocated` 跑在 `NoteStore` 构造期，
//! 而本模块的播种只在命令或轮询里发生 —— 两者都要先经 `default_store()` 拿到数据目录，
//! 也就是**一定排在构造之后**。本次会话的迁移判定那时已经做完了；下次会话 `config.data_dir`
//! 与解析结果一致，在 `:1467` 的 canonical 比较处就提前返回。
//!
//! **别把播种提到 `NoteStore` 构造之前**，否则现象是「老用户升级后笔记不见了」。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::plugins::paths::is_plain_relative;
use crate::services::notes::{default_store, AppError};

/// 数据目录下那个子目录名。
pub const STYLES_DIR: &str = "styles";

/// 首次运行播种的那份。名字是约定，用户当然可以删掉或改名。
pub const SEED_FILE: &str = "custom.css";

/// 样式变了就广播这个事件 —— 每个窗口收到后各自重新注入。
///
/// 之所以由 Rust 广播而不是每个窗口自己轮询：主窗口 / 小窗 / 磁贴各有一份 JS 上下文，
/// 让它们各跑一个定时器去敲磁盘纯属浪费。`app.emit` 天然覆盖所有窗口。
pub const STYLES_CHANGED_EVENT: &str = "global-styles-changed";

/// 轮询间隔。够短（改完几乎立刻看到），也够长（磁盘几乎无感）。
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// 单份样式表的大小上限。和插件资源同一个量级 —— 正常样式表只有几 KB。
const MAX_STYLE_BYTES: u64 = 4 * 1024 * 1024;

/// 文件名长度上限，纯粹是防呆。
const MAX_NAME_LEN: usize = 128;

/// 一份样式表的「指纹」：够判断有没有变，又不必读文件内容。
///
/// `mtimeMs` 在少数文件系统上精度只有秒，所以**同时比大小** —— 同一秒里改动且大小
/// 恰好不变的情况极罕见，真遇到也就是晚 2 秒生效，不会漏。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StyleStamp {
    pub name: String,
    pub mtime_ms: i64,
    pub size: u64,
}

fn style_error(message: impl Into<String>) -> AppError {
    AppError {
        code: "globalStyle".into(),
        message: message.into(),
        details: Default::default(),
    }
}

/// 文件名是不是一份样式表：**单个**文件名、以 `.css` 结尾（大小写不敏感）。
///
/// 抽成独立函数是为了能直接测 —— 它是路径校验的第一道关。
///
/// ⚠️ `is_plain_relative` **不够**：它只保证「每一段都是普通名字」，于是
/// `sub/x.css` 也过得去（它本来的用途就是允许基准目录内的多级相对路径）。
/// 而样式目录**不递归**，这里要的是单个文件名，所以必须再数一遍组件个数。
/// （这条是被单测抓出来的：漏了它，`sub/x.css` 会被当成合法样式表名字。）
pub fn is_style_file(name: &str) -> bool {
    if name.len() > MAX_NAME_LEN || !is_plain_relative(name) {
        return false;
    }
    if Path::new(name).components().count() != 1 {
        return false;
    }
    name.to_ascii_lowercase().ends_with(".css")
}

/// `<数据目录>/styles`。每次调用都按**当前**配置解析 —— 数据目录迁移之后自然跟过去。
pub fn styles_dir() -> Result<PathBuf, AppError> {
    Ok(default_store()?.data_dir().join(STYLES_DIR))
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// 列出目录里全部样式表的指纹，**按文件名排序**。
///
/// 排序不是可有可无的：注入顺序就是数组顺序，文件名的字典序是唯一稳定的依据
///（所以文档里教用户用 `10-`、`20-` 这样的前缀控制先后）。
pub fn list_stamps(dir: &Path) -> Result<Vec<StyleStamp>, AppError> {
    let mut stamps = Vec::new();
    if !dir.exists() {
        return Ok(stamps);
    }

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_style_file(name) {
            continue;
        }
        let meta = entry.metadata()?;
        stamps.push(StyleStamp {
            name: name.to_string(),
            mtime_ms: mtime_ms(&meta),
            size: meta.len(),
        });
    }

    stamps.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(stamps)
}

/// 把一个**来自前端的**文件名安全解析成绝对路径。
///
/// 三段校验，缺一不可：
/// 1. `is_style_file` —— 单一文件名、`.css` 结尾，`../x.css`、`a/b.css`、`x.txt` 全挡掉；
/// 2. `canonicalize()` —— 符号链接也现原形；
/// 3. 结果必须 `starts_with(base)` —— 万一前两道被绕过，这条兜底。
///
/// 和 `plugins/paths.rs::safe_join_file` 是同一套路子，只是基准目录不同。
pub fn safe_style_path(dir: &Path, name: &str) -> Result<PathBuf, AppError> {
    if !is_style_file(name) {
        return Err(style_error(format!("不是合法的样式表文件名：{name}")));
    }

    let base = dir
        .canonicalize()
        .map_err(|_| style_error("样式目录不存在"))?;
    let canonical = base
        .join(name)
        .canonicalize()
        .map_err(|_| style_error(format!("读不到样式表：{name}")))?;

    if !canonical.starts_with(&base) {
        return Err(style_error(format!("路径越出样式目录：{name}")));
    }

    let meta = fs::metadata(&canonical)?;
    if !meta.is_file() {
        return Err(style_error(format!("不是普通文件：{name}")));
    }
    if meta.len() > MAX_STYLE_BYTES {
        return Err(style_error(format!(
            "样式表太大：{name}（{} 字节，上限 {MAX_STYLE_BYTES}）",
            meta.len()
        )));
    }

    Ok(canonical)
}

/// 从随包资源里读模板。装机与开发期都读得到：`tauri_build` 会把
/// `bundle.resources` 映射的东西拷进 `target/{debug,release}/`（同 `docs.rs`）。
fn template_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("templates").join(SEED_FILE))
}

/// 读不到模板时的兜底。**不能直接报错留一个空目录** —— 用户点开文件夹看到空的会以为
/// 功能坏了；给一份带说明的最小骨架，至少知道该往哪儿写。
const FALLBACK_TEMPLATE: &str = "\
/* 花笺 · 全局样式表
 *
 * 这个目录里的每一份 .css 都会注入花笺的每一个窗口，没有开关 ——
 * 不想让它生效就把文件移走或改名。
 *
 * 改完保存即可，约两秒后自动生效（应用内的「设置 → 外观 → 全局样式」也能看状态）。
 */
";

/// 目录不存在就建；`custom.css` 不存在就播种。**已有文件一个字都不动。**
///
/// ⚠️ 调用时机见模块开头「播种与数据目录迁移的先后顺序」。
pub fn ensure_seeded(app: &AppHandle, dir: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dir)?;

    let seed = dir.join(SEED_FILE);
    if seed.exists() {
        return Ok(());
    }

    let content = template_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_else(|| FALLBACK_TEMPLATE.to_string());

    fs::write(&seed, content)?;
    Ok(())
}

/// 一份样式表连同它的内容 —— 注入用。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StyleSheet {
    pub name: String,
    pub mtime_ms: i64,
    pub size: u64,
    pub css: String,
}

/// 把目录里全部样式表**连内容一起**取回来。
///
/// 刻意做成**一次 IPC 拿全部**，而不是「先列名单再逐个读」：目录里通常只有两三份，
/// 一次往返比分两轮、每份再跑一趟要干净得多，前端也不必自己维护「读了一半」的中间态。
/// 单个文件读失败（比如读到一半被编辑器锁住）**跳过它继续**，不因为一份坏了就整批空手而归。
pub fn read_bundle(dir: &Path) -> Result<Vec<StyleSheet>, AppError> {
    let mut sheets = Vec::new();
    for stamp in list_stamps(dir)? {
        let path = match safe_style_path(dir, &stamp.name) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let Ok(css) = fs::read_to_string(&path) else {
            // 非 UTF-8、或刚好被别的进程占住 —— 这一份跳过，其余照常。
            continue;
        };
        sheets.push(StyleSheet {
            name: stamp.name,
            mtime_ms: stamp.mtime_ms,
            size: stamp.size,
            css,
        });
    }
    Ok(sheets)
}

#[tauri::command]
pub fn global_styles_bundle(app: AppHandle) -> Result<Vec<StyleSheet>, AppError> {
    let dir = styles_dir()?;
    ensure_seeded(&app, &dir)?;
    read_bundle(&dir)
}

/// 样式目录的绝对路径（顺带确保它存在），给界面显示用。
#[tauri::command]
pub fn global_styles_dir_path(app: AppHandle) -> Result<String, AppError> {
    let dir = styles_dir()?;
    ensure_seeded(&app, &dir)?;
    Ok(dir.to_string_lossy().to_string())
}

/// 在系统文件管理器里打开样式目录，并把路径回给前端（界面要显示它）。
///
/// 与 `plugins_open_dir` 同一套：Windows 用 `explorer`、macOS `open`、Linux `xdg-open`。
#[tauri::command]
pub fn global_styles_open_dir(app: AppHandle) -> Result<String, AppError> {
    let dir = styles_dir()?;
    ensure_seeded(&app, &dir)?;

    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(&dir).spawn().map_err(|error| {
        style_error(format!("打开样式文件夹失败：{error}（{}）", dir.display()))
    })?;

    Ok(dir.to_string_lossy().to_string())
}

/// 后台盯着样式目录，有变化就广播 [`STYLES_CHANGED_EVENT`]。
///
/// 写法照 `desktop.rs::watch_idle_and_reclaim`：一个守护线程 + `loop { sleep }`，
/// 进程退出时随线程一起结束。
pub fn watch(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // 先取一次基线：这样启动后那第一圈不会平白多发一次事件。
        let mut last = styles_dir()
            .map(|dir| list_stamps(&dir).unwrap_or_default())
            .unwrap_or_default();

        loop {
            std::thread::sleep(POLL_INTERVAL);

            let Ok(dir) = styles_dir() else {
                // 配置一时读不出来（比如刚改完数据目录）—— 下一圈再说。
                continue;
            };
            // 目录被用户整个删掉时自动补回来，`custom.css` 也会重新播种。
            let _ = ensure_seeded(&handle, &dir);

            let current = match list_stamps(&dir) {
                Ok(stamps) => stamps,
                Err(_) => continue,
            };
            if current == last {
                continue;
            }
            // 只在**真的变了**的时候打一行：用户报「改了没生效」时，这行日志能立刻
            // 分出是「没检测到变化」还是「检测到了但注入那侧出了问题」。
            eprintln!("[styles] 样式目录有变化，通知各窗口重新套用（{} 份）", current.len());
            last = current;
            // 广播失败只可能是所有窗口都关了；不停线程，用户再开窗口照样能收到。
            let _ = handle.emit(STYLES_CHANGED_EVENT, ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temp_dir(tag: &str) -> PathBuf {
        // 不引 tempfile：用进程 id + 纳秒凑一个够用的唯一目录。
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("floral-styles-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_plain_css_file_names_pass() {
        assert!(is_style_file("custom.css"));
        assert!(is_style_file("10-深色微调.CSS"));

        // 路径穿越、子目录、别的后缀、空名字一律不行。
        assert!(!is_style_file("../custom.css"));
        assert!(!is_style_file("..\\custom.css"));
        assert!(!is_style_file("sub/custom.css"));
        assert!(!is_style_file("/custom.css"));
        assert!(!is_style_file("C:/custom.css"));
        assert!(!is_style_file("custom.txt"));
        assert!(!is_style_file("custom"));
        assert!(!is_style_file(""));
        assert!(!is_style_file(" custom.css"));
    }

    #[test]
    fn list_is_sorted_and_only_picks_css() {
        let dir = temp_dir("list");
        fs::write(dir.join("20-b.css"), "b{}").unwrap();
        fs::write(dir.join("10-a.css"), "a{}").unwrap();
        fs::write(dir.join("readme.txt"), "note").unwrap();
        fs::create_dir(dir.join("nested.css")).unwrap();

        let stamps = list_stamps(&dir).unwrap();
        let names: Vec<&str> = stamps.iter().map(|s| s.name.as_str()).collect();
        // 顺序必须是字典序 —— 注入顺序就靠它，`10-` / `20-` 前缀才有意义。
        assert_eq!(names, vec!["10-a.css", "20-b.css"]);
        // 目录不能被当成样式表（`nested.css` 是个目录）。
        assert!(stamps.iter().all(|s| s.size > 0));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_directory_lists_as_empty_not_error() {
        let dir = temp_dir("missing");
        let gone = dir.join("nope");
        assert!(list_stamps(&gone).unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn safe_path_rejects_traversal_and_non_css() {
        let dir = temp_dir("safe");
        fs::write(dir.join("ok.css"), "a{}").unwrap();
        // 目录外放一份「机密」，确保穿越真的够得到东西 —— 否则这个断言是空的。
        fs::write(dir.parent().unwrap().join("secret.css"), "x").ok();

        assert!(safe_style_path(&dir, "ok.css").is_ok());
        assert!(safe_style_path(&dir, "../secret.css").is_err());
        assert!(safe_style_path(&dir, "sub/ok.css").is_err());
        assert!(safe_style_path(&dir, "ok.txt").is_err());
        assert!(safe_style_path(&dir, "nope.css").is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stamp_changes_when_file_is_rewritten() {
        let dir = temp_dir("stamp");
        fs::write(dir.join("a.css"), "a{}").unwrap();
        let before = list_stamps(&dir).unwrap();

        // 改大一点 —— 大小这一路一定会变，不依赖 mtime 的精度。
        fs::write(dir.join("a.css"), "a{} /* 加一点内容 */").unwrap();
        let after = list_stamps(&dir).unwrap();

        assert_ne!(before, after);
        fs::remove_dir_all(&dir).ok();
    }
}
