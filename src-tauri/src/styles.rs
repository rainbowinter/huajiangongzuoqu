//! 全局样式表 —— `<数据目录>/styles/`。
//!
//! ```text
//! <数据目录>/styles/
//!   custom.css        首次运行从随包模板播种。**永远生效**，改完约两秒自动套用
//!   深色微调.css        用户自己加的。**默认不生效** —— 要在「样式」面板里开成全局，
//!                     或者挂到某一个打开的文件上
//! ```
//!
//! ## 三种生效方式（判据只在 [`applied_names`] 一处）
//!
//! 1. **常开**：`custom.css`。它是那份「这是我的界面」的主样式表，不给开关；
//! 2. **全局**：用户在「样式」面板里挨个打开的（`StylesConfig::global`）；
//! 3. **按文件**：挂到某一个打开的文件上的（`StylesConfig::files`，键是文件路径或笔记 id）。
//!
//! 为什么不让「目录里有就生效」：那个模型下用户没法试一份样式 —— 放进目录就已经作用于
//! 整个界面了，想知道效果只能先移走。默认关闭、想用再开，才有试的余地。
//!
//! 注入顺序仍是**文件名的码点序**（`10-` / `20-` 前缀控制先后的用法不变）。
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
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::plugins::paths::is_plain_relative;
use crate::services::notes::{default_store, AppError, StylesConfig};

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

/// 这份样式表是不是**常开**的（也就是那份主样式表）。
///
/// 大小写不敏感：Windows 上用户把 `custom.css` 改成 `Custom.css` 是同一个文件，判据跟
/// 文件系统一致才不会出现「改名之后开关冒出来了」。
pub fn is_always_on(name: &str) -> bool {
    name.eq_ignore_ascii_case(SEED_FILE)
}

/// 这一步该注入**哪几份**：常开的 + 显式打开的 + 挂在当前文件上的。
///
/// `stamps` 是目录里现有的全部样式表 —— 判定要经过它，配置里写了而文件不在的条目就
/// **静默失效**（用户在面板里开过、后来把文件删了，那是正常操作，不该报错）。
///
/// 结果**按文件名排序去重**：注入顺序就是数组顺序，码点序是唯一稳定的依据（文档里教
/// 用户用 `10-` / `20-` 前缀控制先后）。排序收口在这儿，调用方不必自己记得。
pub fn applied_names(
    stamps: &[StyleStamp],
    config: &StylesConfig,
    file_key: Option<&str>,
) -> Vec<String> {
    let bound = file_key.and_then(|key| config.files.get(key));

    let mut names: Vec<String> = stamps
        .iter()
        .filter(|stamp| {
            is_always_on(&stamp.name)
                || config.global.iter().any(|item| item == &stamp.name)
                || bound.is_some_and(|list| list.iter().any(|item| item == &stamp.name))
        })
        .map(|stamp| stamp.name.clone())
        .collect();

    names.sort();
    names.dedup();
    names
}

/// 名单里加减一项，**不留重复**。开着再开一次、关着再关一次都是无操作。
fn set_membership(list: &mut Vec<String>, name: &str, enabled: bool) {
    list.retain(|item| item != name);
    if enabled {
        list.push(name.to_string());
    }
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
 * 这一份（custom.css）**永远生效** —— 它就是花笺的主样式表。改完保存即可，
 * 约两秒后自动套用到每一个窗口。
 *
 * 同目录里**其它** .css 默认不生效：去右侧栏的「样式」面板把它们开成全局，
 * 或者挂到某一个打开的文件上。想试一份新样式就新建一个文件，别直接改这里。
 *
 * 「插件」面板里展开 css-modifier → 「打开样式工作区」，可以把这个文件夹加进
 * 左侧工作区，直接在花笺里改。
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

/// 一份样式表连同它的内容与三个状态位 —— 注入与「样式」面板共用这一份快照。
///
/// **连没生效的也一起发**（`css` 照样带上）：面板要把它们列出来给用户开，而列出来就得
/// 知道名字与大小；开关状态只有 Rust 一个权威，前端不再算第二遍。目录里通常只有两三份，
/// 一次 IPC 拿全比分两轮干净得多。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StyleSheet {
    pub name: String,
    pub mtime_ms: i64,
    pub size: u64,
    pub css: String,
    /// 现在这份会不会被注入。`custom.css` 恒为 `true`。
    pub applied: bool,
    /// 全局开关现在开着没有。`custom.css` 恒为 `true`（它就是「全局」本身）。
    pub global: bool,
    /// 这份挂**在这个文件**上没有（`global_styles_bundle` 传进来的那个 `file_key`）。
    /// 没传文件时恒为 `false`。
    ///
    /// 与 `applied` 不是一回事：一份既全局开着、又挂在这个文件上时，`applied` 与 `bound`
    /// 会同时为真；而「当前文件」那一段的开关要显示的是**挂没挂**，不是「生不生效」——
    /// 不然把它从文件上摘掉、全局那颗还亮着，开关却看着没动。
    pub bound: bool,
    /// 常开、界面上把开关钉死的那一份。
    pub locked: bool,
}

/// 把目录里全部样式表**连内容一起**取回来，并标上当前文件视角下的三个状态位。
///
/// 单个文件读失败（非 UTF-8、或刚好被编辑器锁住）**跳过它继续**，不因为一份坏了就
/// 整批空手而归。
pub fn read_bundle(
    dir: &Path,
    config: &StylesConfig,
    file_key: Option<&str>,
) -> Result<Vec<StyleSheet>, AppError> {
    let stamps = list_stamps(dir)?;
    let applied = applied_names(&stamps, config, file_key);
    let bound = file_key.and_then(|key| config.files.get(key));

    let mut sheets = Vec::new();
    for stamp in stamps {
        let path = match safe_style_path(dir, &stamp.name) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let Ok(css) = fs::read_to_string(&path) else {
            continue;
        };
        let always = is_always_on(&stamp.name);
        sheets.push(StyleSheet {
            applied: always || applied.contains(&stamp.name),
            global: always || config.global.iter().any(|item| item == &stamp.name),
            bound: bound.is_some_and(|list| list.iter().any(|item| item == &stamp.name)),
            locked: always,
            name: stamp.name,
            mtime_ms: stamp.mtime_ms,
            size: stamp.size,
            css,
        });
    }
    Ok(sheets)
}

/// 当前该注入的样式表。`file_key` 传当前打开的文件（外部文件路径 / 笔记 id），
/// 没打开任何东西时不传。
///
/// ## 两条这里**不能**做的事
///
/// 1. **别用 `load_config()`** —— 那不是个读操作：它会规范化字段并 `write_json_atomic`
///    把整份配置**落盘一次**（Windows 上那次 fsync 是真 FlushFileBuffers），而这条命令
///    每几秒就要被问一次。更要命的是 `watch()` 每 2 秒也在**读**同一个文件，写读相撞
///    就是一次失败的 rename ⇒ 前端拿到错误 ⇒ **保留旧快照**，表现成「点了刷新等半天、
///    而且刷不出来」。用 `peek_config()`，它一个字节都不写。
/// 2. **别做成同步命令** —— 不带 `(async)` 的 `#[tauri::command]` 跑在**主线程**上，
///    里面一慢就是整个界面冻住（`pdf.rs` 那两条慢命令也是为这个加的 `(async)`）。
///    这条命令要读目录、读文件，属于「慢」那一类。
#[tauri::command(async)]
pub fn global_styles_bundle(
    app: AppHandle,
    file_key: Option<String>,
) -> Result<Vec<StyleSheet>, AppError> {
    let started = Instant::now();
    let dir = styles_dir()?;
    ensure_seeded(&app, &dir)?;
    let config = default_store()?.peek_config()?.styles;
    let bundle = read_bundle(&dir, &config, file_key.as_deref())?;

    // 只在**慢**的时候出声。用户报「刷新要等好几秒」时，这一行能立刻分出是磁盘慢
    // （这里）；还是一开始就没走到这里（那问题在前端或命令之外）。平时它是静的。
    let elapsed = started.elapsed();
    if elapsed.as_millis() > 30 {
        eprintln!(
            "[styles] 取回样式表用了 {} ms（{} 份）—— 这个数字不该这么大",
            elapsed.as_millis(),
            bundle.len()
        );
    }
    Ok(bundle)
}

/// 把一份样式表开成 / 关掉**全局**。
///
/// `custom.css` 不给关：它永远是全局的那一份，想让它不生效就把文件改名。报错而不是
/// 静默忽略 —— 界面上那颗开关本来就画成钉死的，走到这儿说明有人绕过了界面。
#[tauri::command(async)]
pub fn global_styles_set_global(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> Result<StylesConfig, AppError> {
    if !is_style_file(&name) {
        return Err(style_error(format!("不是合法的样式表文件名：{name}")));
    }
    if is_always_on(&name) {
        return Err(style_error("custom.css 永远是全局样式表，不能关掉"));
    }

    // 读用 `peek_config`、写用 `save_config`：一次改动只落盘一次。（`load_config` 自己
    // 也会落盘，两个叠起来就是白写一遍 —— 那正是上面 `global_styles_bundle` 踩过的坑。）
    let store = default_store()?;
    let mut config = store.peek_config()?;
    set_membership(&mut config.styles.global, &name, enabled);
    let saved = store.save_config(config)?;

    // 开关变化不是**文件**变化，轮询那条路看不见它，得自己广播一次。
    let _ = app.emit(STYLES_CHANGED_EVENT, ());
    Ok(saved.styles)
}

/// 把一份样式表挂到 / 摘离**某一个文件**。
///
/// `file_key` 是外部文件的绝对路径，或者笔记 id —— 与插件面板、工作区缓存同一个 key。
#[tauri::command(async)]
pub fn global_styles_bind(
    app: AppHandle,
    file_key: String,
    name: String,
    enabled: bool,
) -> Result<StylesConfig, AppError> {
    if file_key.trim().is_empty() {
        return Err(style_error("没有打开任何文件，先打开一个再配"));
    }
    if !is_style_file(&name) {
        return Err(style_error(format!("不是合法的样式表文件名：{name}")));
    }

    let store = default_store()?;
    let mut config = store.peek_config()?;
    {
        let list = config.styles.files.entry(file_key.clone()).or_default();
        set_membership(list, &name, enabled);
    }
    // 摘空了就把这个键也去掉，别在配置里留一个空壳 —— 它没有任何含义，
    // 而且用户换过文件名之后会越攒越多。
    if config
        .styles
        .files
        .get(&file_key)
        .is_some_and(|list| list.is_empty())
    {
        config.styles.files.remove(&file_key);
    }
    let saved = store.save_config(config)?;

    let _ = app.emit(STYLES_CHANGED_EVENT, ());
    Ok(saved.styles)
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

    fn stamps_of(names: &[&str]) -> Vec<StyleStamp> {
        let mut stamps: Vec<StyleStamp> = names
            .iter()
            .map(|name| StyleStamp {
                name: (*name).to_string(),
                mtime_ms: 0,
                size: 1,
            })
            .collect();
        stamps.sort_by(|left, right| left.name.cmp(&right.name));
        stamps
    }

    fn styles_config(global: &[&str], files: &[(&str, &[&str])]) -> StylesConfig {
        StylesConfig {
            global: global.iter().map(|name| (*name).to_string()).collect(),
            files: files
                .iter()
                .map(|(key, names)| {
                    (
                        (*key).to_string(),
                        names.iter().map(|name| (*name).to_string()).collect(),
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn custom_css_is_the_only_one_on_by_default() {
        let stamps = stamps_of(&["custom.css", "10-深色.css", "20-紧凑.css"]);
        let config = StylesConfig::default();

        // 目录里有三份，默认只有那份主样式表生效 —— 用户放进去的新文件不该直接改掉整个界面。
        assert_eq!(applied_names(&stamps, &config, None), vec!["custom.css"]);
    }

    #[test]
    fn custom_css_stays_on_regardless_of_naming_or_config() {
        let stamps = stamps_of(&["Custom.CSS", "other.css"]);

        // 大小写不同也是它；配置里空着也一样常开。
        assert_eq!(applied_names(&stamps, &StylesConfig::default(), None), vec![
            "Custom.CSS"
        ]);

        // 有人把它塞进「关掉」的名单里（老配置、手改配置文件）—— 照样生效。
        let config = styles_config(&["other.css"], &[]);
        let applied = applied_names(&stamps, &config, None);
        assert!(applied.contains(&"Custom.CSS".to_string()));
        assert!(applied.contains(&"other.css".to_string()));
    }

    #[test]
    fn global_and_per_file_are_separate_switches() {
        let stamps = stamps_of(&["custom.css", "a.css", "b.css", "c.css"]);
        let config = styles_config(&["b.css"], &[("note-1", &["c.css"])]);

        // 另一篇笔记：只有常开的 + 全局打开的。
        assert_eq!(applied_names(&stamps, &config, Some("note-2")), vec![
            "b.css",
            "custom.css"
        ]);
        // 那一篇：多出挂在它身上的那份。顺序仍是码点序（`b` 在 `c` 前，`custom` 在最后）。
        assert_eq!(applied_names(&stamps, &config, Some("note-1")), vec![
            "b.css",
            "c.css",
            "custom.css"
        ]);
        // 没打开任何文件时，按文件挂的那份不该冒出来。
        assert_eq!(applied_names(&stamps, &config, None), vec![
            "b.css",
            "custom.css"
        ]);
    }

    #[test]
    fn config_entries_for_missing_files_are_silently_ignored() {
        let stamps = stamps_of(&["custom.css"]);
        // 用户在面板里开过一份、后来把文件删了 —— 那是正常操作，不该报错也不该出现。
        let config = styles_config(&["gone.css"], &[("note-1", &["also-gone.css"])]);

        assert_eq!(applied_names(&stamps, &config, Some("note-1")), vec![
            "custom.css"
        ]);
    }

    #[test]
    fn applied_names_sorts_and_dedupes() {
        // 同一份既全局开、又挂在这个文件上 —— 只能出现一次。
        let stamps = stamps_of(&["custom.css", "20-b.css", "10-a.css"]);
        let config = styles_config(&["20-b.css"], &[("note-1", &["20-b.css", "10-a.css"])]);

        assert_eq!(applied_names(&stamps, &config, Some("note-1")), vec![
            "10-a.css",
            "20-b.css",
            "custom.css"
        ]);
    }

    #[test]
    fn set_membership_never_duplicates() {
        let mut list: Vec<String> = Vec::new();
        set_membership(&mut list, "a.css", true);
        set_membership(&mut list, "a.css", true);
        assert_eq!(list, vec!["a.css"]);

        set_membership(&mut list, "a.css", false);
        set_membership(&mut list, "a.css", false);
        assert!(list.is_empty());
    }

    #[test]
    fn read_bundle_keeps_unapplied_sheets_with_their_flags() {
        let dir = temp_dir("bundle");
        fs::write(dir.join("custom.css"), "body{}").unwrap();
        fs::write(dir.join("extra.css"), "p{}").unwrap();

        let config = styles_config(&[], &[]);
        let sheets = read_bundle(&dir, &config, None).unwrap();
        let by_name: std::collections::HashMap<_, _> =
            sheets.iter().map(|sheet| (sheet.name.as_str(), sheet)).collect();

        // 没生效的那份**也在清单里**（面板要列出来给用户开），只是 applied 为 false。
        assert_eq!(sheets.len(), 2);
        let custom = by_name["custom.css"];
        assert!(custom.applied && custom.global && custom.locked);
        assert_eq!(custom.css, "body{}");

        let extra = by_name["extra.css"];
        assert!(!extra.applied && !extra.global && !extra.bound && !extra.locked);

        // 「挂在这个文件上」与「生效」是两件事：全局开着的那份挂到文件上之后，
        // `applied` 不变（本来就生效），但 `bound` 要跟着变 —— 当前文件那一段的开关看的是它。
        let bound_config = styles_config(&["extra.css"], &[("note-1", &["extra.css"])]);
        let sheets = read_bundle(&dir, &bound_config, Some("note-1")).unwrap();
        let extra = sheets.iter().find(|sheet| sheet.name == "extra.css").unwrap();
        assert!(extra.applied && extra.global && extra.bound);

        // 别的文件看不到这次绑定。
        let sheets = read_bundle(&dir, &bound_config, Some("note-2")).unwrap();
        let extra = sheets.iter().find(|sheet| sheet.name == "extra.css").unwrap();
        assert!(extra.applied && extra.global && !extra.bound);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_the_seed_name_is_always_on() {
        // 防呆：`custom.css` 的近亲一律不算常开 —— 判据一旦放宽成「包含」，
        // 用户随手建的 `my-custom.css` 就会静悄悄地绕开开关。
        for name in ["custom2.css", "my-custom.css", "custom.css.bak", "custom"] {
            assert!(!is_always_on(name), "{name} 不该被当成常开那份");
        }
        assert!(is_always_on("custom.css"));
        assert!(is_always_on("Custom.CSS"));
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
