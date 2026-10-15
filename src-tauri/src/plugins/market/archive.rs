//! 插件 zip 的安全解压。**市场这一块最危险的地方就是这里。**
//!
//! ## 为什么不用 `ZipArchive::extract`
//!
//! 它直接把条目名当路径拼上去写文件。zip 里的名字是**攻击者可控**的（哪怕清单经过签名，
//! zip 也是别人打出来的），所以 `../../` 能往外写、绝对路径能覆盖任意文件、符号链接能被
//! 穿越。这个文件里每一条校验都对应一类真实攻击：
//!
//! | 攻击 | 这里怎么挡 |
//! |---|---|
//! | zip-slip（`../`） | 逐段校验，`.` 与 `..` 一律拒绝 |
//! | 绝对路径 / 盘符 | 拒绝开头的 `/`、`\`，拒绝任何 `:` |
//! | 符号链接穿透 | zip 里的链接**条目**直接拒绝（不跟它走） |
//! | Windows 保留名 | `CON`/`NUL`/`COM1`… 拒绝 |
//! | 尾随点/空格被静默吃掉 | 拒绝 —— 否则 `a.` 与 `a` 会写成同一个文件 |
//! | 大小写碰撞 | 折叠后同名即拒绝（Windows 与 macOS 上它们是同一个文件） |
//! | zip bomb | 单文件上限 + 总量上限 + 条目数上限，且**按上限截断读** |
//! | 头部谎报大小 | 实际写出的字节数必须与头部声明一致 |
//!
//! ## 一条约定：zip 里恰好一层顶层目录，名字等于插件名
//!
//! `pdf-viewer-1.0.0.zip` 里必须是 `pdf-viewer/plugin.json`、`pdf-viewer/js/…`。
//! 这一条同时干掉两件事：zip-slip 的第一层（`..` 连前缀都对不上）与「散文件」的
//! 歧义（到底哪些文件属于这个插件）。发布脚本按这个约定打包（见 `Docs/plugin-market.md`）。

use super::super::errors::{app_error, with_detail};
use super::super::paths::MAX_PLUGIN_FILE_BYTES;
use crate::services::notes::AppError;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};

/// 单个文件的上限。与本地插件读取共用同一个值（`MAX_PLUGIN_FILE_BYTES`）。
pub const MAX_FILE_BYTES: u64 = MAX_PLUGIN_FILE_BYTES;
/// 解压后的总大小上限。pdf.js 那种库打进去也就几 MB，给足余量。
pub const MAX_TOTAL_BYTES: u64 = 48 * 1024 * 1024;
/// 条目数上限。
pub const MAX_ENTRIES: usize = 512;
/// 单个路径段的长度上限。
const MAX_SEGMENT_CHARS: usize = 128;
/// 整条相对路径的长度上限。
const MAX_PATH_CHARS: usize = 512;

/// Windows 保留设备名（大小写不敏感，且**只看第一个点之前的部分**：`con.js` 同样冲突）。
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 从归档里读出来的一条条目的元信息。
///
/// 单独定义一个结构是为了让「规划」这一步**不依赖 zip 库**：测试可以直接造一批条目，
/// 不必真的去打一个 zip。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// 规划好的一条：从归档的哪个下标读出，写到插件目录下的哪个相对路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedEntry {
    pub index: usize,
    pub relative: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchivePlan {
    pub entries: Vec<PlannedEntry>,
    pub total_bytes: u64,
}

/// 判断一个**相对路径串**是否干净：非空、逐段合法、不是绝对路径。
///
/// 这是所有校验的公共部分 —— 条目名去掉顶层目录之后要走它，`plugin.json` 里的 `main`
/// 也要走它（那边的入口是 `paths::is_plain_relative`，更宽松；这里更严，因为要落盘）。
pub fn relative_path_is_safe(relative: &str) -> bool {
    if relative.is_empty() || relative.chars().count() > MAX_PATH_CHARS {
        return false;
    }
    // 反斜杠一律拒绝：zip 规范用 `/`，出现 `\` 只可能是想骗某个解压器的解析。
    if relative.contains('\\') {
        return false;
    }
    if relative.starts_with('/') {
        return false;
    }
    // `:` 一口气干掉盘符（`C:`）与 NTFS 数据流（`a.txt:evil`）。
    if relative.contains(':') {
        return false;
    }

    relative.split('/').all(segment_is_safe)
}

fn segment_is_safe(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }
    if segment.chars().count() > MAX_SEGMENT_CHARS {
        return false;
    }
    // 控制字符（含 NUL）与空白两端：Windows 会静默裁掉后半段，于是 `a ` 与 `a` 撞车。
    if segment.chars().any(char::is_control) {
        return false;
    }
    if segment.trim() != segment {
        return false;
    }
    // Windows 上 `index.js.` 会写成 `index.js`。
    if segment.ends_with('.') {
        return false;
    }

    let stem = segment.split('.').next().unwrap_or_default();
    let upper = stem.to_ascii_uppercase();
    if RESERVED_NAMES.contains(&upper.as_str()) {
        return false;
    }

    true
}

/// 按约定取出顶层目录之后的部分。
///
/// 返回 `None` 表示这个名字**不属于这个插件**（前缀对不上）—— 那是最常见的 zip-slip
/// 形态：`../../evil.js` 或者 `别的插件/index.js`。
pub fn strip_root<'a>(name: &'a str, plugin: &str) -> Option<&'a str> {
    let rest = name.strip_prefix(plugin)?.strip_prefix('/')?;
    Some(rest)
}

/// 规划整份归档：逐条校验 + 汇总上限。
pub fn plan_archive(entries: &[RawEntry], plugin: &str) -> Result<ArchivePlan, AppError> {
    let mut planned: Vec<PlannedEntry> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut seen: HashSet<String> = HashSet::new();

    for (index, entry) in entries.iter().enumerate() {
        if entry.is_symlink {
            // 链接条目本身拒绝。跟着它读会读到插件目录之外，而「写一个链接进去」同样
            // 是攻击的一环（下一次解压/读取时顺着它走出去）。
            return Err(reject(
                "marketArchiveSymlink",
                format!("压缩包里含有符号链接条目：{}", entry.name),
                &entry.name,
            ));
        }

        let Some(stripped) = strip_root(&entry.name, plugin) else {
            return Err(reject(
                "marketArchiveUnexpectedEntry",
                format!(
                    "压缩包里的条目 {} 不在 {plugin}/ 目录下 —— 打包方式不符合约定",
                    entry.name
                ),
                &entry.name,
            ));
        };

        // ⚠️ **目录条目的名字以 `/` 结尾**（`font-pack/fonts/`）—— 7-Zip 就是这么写的。
        // 那个斜杠是「这是目录」的标记，不是路径的一部分；不去掉的话会切成
        // `["fonts", ""]`，末段为空被当成不安全，于是**任何带子目录的插件都装不上**
        // （实测踩过：font-pack 的 `fonts/`）。
        let relative = if entry.is_dir {
            stripped.strip_suffix('/').unwrap_or(stripped)
        } else {
            stripped
        };

        // 顶层目录自己那一条（`pdf-viewer/`）可以出现，跳过即可。
        if relative.is_empty() && entry.is_dir {
            continue;
        }
        if relative.is_empty() {
            return Err(reject(
                "marketArchiveUnexpectedEntry",
                format!("压缩包里有一个与插件同名的文件条目：{}", entry.name),
                &entry.name,
            ));
        }
        if !relative_path_is_safe(relative) {
            return Err(reject(
                "marketArchiveUnsafePath",
                format!("压缩包里的路径不安全：{}", entry.name),
                &entry.name,
            ));
        }

        // 大小写折叠后重名：在 Windows/macOS 上它们会写成同一个文件，谁覆盖谁取决于顺序。
        let folded = relative.to_ascii_lowercase();
        if !seen.insert(folded) {
            return Err(reject(
                "marketArchiveDuplicateEntry",
                format!("压缩包里有两个只在大小写上不同的条目：{relative}"),
                relative,
            ));
        }

        let size = if entry.is_dir { 0 } else { entry.size };
        if size > MAX_FILE_BYTES {
            return Err(with_detail(
                app_error(
                    "marketArchiveFileTooLarge",
                    format!("压缩包里的文件过大：{relative}（{size} 字节，上限 {MAX_FILE_BYTES}）"),
                ),
                "path",
                relative.to_string(),
            ));
        }

        total_bytes = total_bytes.saturating_add(size);
        planned.push(PlannedEntry {
            index,
            relative: relative.to_string(),
            size,
            is_dir: entry.is_dir,
        });
    }

    if planned.is_empty() {
        return Err(app_error("marketArchiveEmpty", "压缩包里没有文件"));
    }
    if planned.len() > MAX_ENTRIES {
        return Err(app_error(
            "marketArchiveTooManyEntries",
            format!(
                "压缩包里的条目太多（{} 个，上限 {MAX_ENTRIES}）",
                planned.len()
            ),
        ));
    }
    if total_bytes > MAX_TOTAL_BYTES {
        return Err(app_error(
            "marketArchiveTooLarge",
            format!("压缩包解压后过大（{total_bytes} 字节，上限 {MAX_TOTAL_BYTES}）"),
        ));
    }

    // 根上必须有 plugin.json：没有它就不是一个插件，早点说清楚比装完才发现好。
    if !planned
        .iter()
        .any(|entry| entry.relative == "plugin.json" && !entry.is_dir)
    {
        return Err(app_error(
            "marketArchiveMissingManifest",
            "压缩包根目录下没有 plugin.json —— 这不是一个插件（或者打包时多套了一层目录）",
        ));
    }

    Ok(ArchivePlan {
        entries: planned,
        total_bytes,
    })
}

fn reject(code: &str, message: String, path: &str) -> AppError {
    with_detail(app_error(code, message), "path", path.to_string())
}

/// 解压到 `target`（一个**新建的、空的**目录，通常是 staging）。
///
/// 目标路径由 `plan_archive` 校验过的相对路径拼出来，逐条写盘时**再按上限截断读**，
/// 并与头部声明的大小核对 —— 头部是压缩包自己写的，不能当真。
pub fn extract_to<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    plan: &ArchivePlan,
    target: &Path,
) -> Result<u64, AppError> {
    let mut written: u64 = 0;

    for entry in &plan.entries {
        let path = target.join(&entry.relative);

        if entry.is_dir {
            fs::create_dir_all(&path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let source = archive.by_index(entry.index).map_err(|error| {
            with_detail(
                app_error(
                    "marketArchiveReadFailed",
                    format!("读取压缩包里的 {} 失败：{error}", entry.relative),
                ),
                "path",
                entry.relative.clone(),
            )
        })?;

        let mut file = fs::File::create(&path)?;
        // 读 `size + 1`：超出头部声明的部分会被我们看见，从而判为「头部撒谎」。
        let mut limited = source.take(entry.size.saturating_add(1));
        let copied = io::copy(&mut limited, &mut file).map_err(|error| {
            with_detail(
                app_error(
                    "marketArchiveReadFailed",
                    format!("写出 {} 失败：{error}", entry.relative),
                ),
                "path",
                entry.relative.clone(),
            )
        })?;
        file.flush()?;

        if copied != entry.size {
            return Err(with_detail(
                app_error(
                    "marketArchiveSizeMismatch",
                    format!(
                        "压缩包里的 {} 实际有 {copied} 字节，头部却写着 {} 字节",
                        entry.relative, entry.size
                    ),
                ),
                "path",
                entry.relative.clone(),
            ));
        }

        written = written.saturating_add(copied);
    }

    Ok(written)
}

/// 从一段字节流解压（真实入口）。
///
/// 先规划再解压**两遍读**：规划那遍只看元信息，全部校验都过了才开始写盘。这样即便压缩包
/// 后半段是坏的，也不会留下「写了一半」的目录内容。
///
/// 参数是 `Read + Seek` 而不是 `Vec<u8>`：zip 要随机访问，而插件包可能有几十 MB —— 走
/// 文件句柄就不必把整包读进内存。
pub fn unpack<R: Read + Seek>(source: R, plugin: &str, target: &Path) -> Result<ArchivePlan, AppError> {
    let mut archive = zip::ZipArchive::new(source).map_err(|error| {
        app_error(
            "marketArchiveInvalid",
            format!("压缩包无法解析：{error}"),
        )
    })?;

    let entries: Vec<RawEntry> = (0..archive.len())
        .map(|index| {
            let entry = archive.by_index(index)?;
            Ok(RawEntry {
                name: entry.name().to_string(),
                size: entry.size(),
                is_dir: entry.is_dir(),
                is_symlink: entry.is_symlink(),
            })
        })
        .collect::<Result<_, zip::result::ZipError>>()
        .map_err(|error| app_error("marketArchiveInvalid", format!("读取压缩包目录失败：{error}")))?;

    let plan = plan_archive(&entries, plugin)?;
    extract_to(&mut archive, &plan, target)?;
    Ok(plan)
}

/// 插件目录下的相对路径 → 绝对路径，并确认它没有跑出目标目录。
///
/// `relative_path_is_safe` 已经拒绝了一切可疑写法，这里再加一道基于组件的前缀检查：
/// 万一将来有人放宽了上面的规则，这一道还能兜住。
pub fn resolve_within(target: &Path, relative: &str) -> Result<PathBuf, AppError> {
    if !relative_path_is_safe(relative) {
        return Err(reject(
            "marketArchiveUnsafePath",
            format!("路径不安全：{relative}"),
            relative,
        ));
    }
    let mut resolved = PathBuf::from(target);
    for segment in relative.split('/') {
        resolved.push(segment);
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn entry(name: &str, size: u64) -> RawEntry {
        RawEntry {
            name: name.to_string(),
            size,
            is_dir: false,
            is_symlink: false,
        }
    }

    fn dir(name: &str) -> RawEntry {
        RawEntry {
            name: name.to_string(),
            size: 0,
            is_dir: true,
            is_symlink: false,
        }
    }

    /// 一份最普通的包：顶层目录 + plugin.json + index.js + 一个子目录。
    fn good_entries() -> Vec<RawEntry> {
        vec![
            dir("demo/"),
            entry("demo/plugin.json", 120),
            entry("demo/index.js", 400),
            // 子目录**自己那一条**（7-Zip 会写出来），名字以 `/` 结尾。
            dir("demo/assets/"),
            entry("demo/assets/theme.css", 200),
        ]
    }

    #[test]
    fn accepts_a_well_formed_archive() {
        let plan = plan_archive(&good_entries(), "demo").expect("应当通过");

        let relatives: Vec<&str> = plan.entries.iter().map(|e| e.relative.as_str()).collect();
        assert_eq!(
            relatives,
            vec!["plugin.json", "index.js", "assets", "assets/theme.css"],
            "顶层目录本身那一条要跳过，其余去掉前缀"
        );
        assert_eq!(plan.total_bytes, 720);
    }

    #[test]
    fn accepts_nested_directory_entries() {
        // ⚠️ 这条是回归测试。zip 里的目录条目名字**以 `/` 结尾**（`demo/assets/`），
        // 那个斜杠是「这是目录」的标记而不是路径的一部分。曾经没去掉它，于是
        // `demo/assets/` 被切成 `["assets", ""]`、末段为空判成不安全 ——
        // **任何带子目录的插件都装不上**（实测踩过：font-pack 的 `fonts/`）。
        let plan = plan_archive(&good_entries(), "demo").expect("带子目录的包必须能装");

        let assets = plan
            .entries
            .iter()
            .find(|entry| entry.relative == "assets")
            .expect("子目录本身那一条要在计划里");
        assert!(assets.is_dir, "它应当被当成目录");
        assert_eq!(assets.size, 0, "目录不占字节");
    }

    #[test]
    fn rejects_a_file_entry_that_pretends_to_be_a_directory() {
        // 名字以 `/` 结尾、却**不是**目录条目 —— zip 里这东西是不合法的，别替它猜。
        let entries = vec![
            entry("demo/plugin.json", 1),
            RawEntry {
                name: "demo/assets/".to_string(),
                size: 10,
                is_dir: false,
                is_symlink: false,
            },
        ];

        assert_eq!(
            plan_archive(&entries, "demo").unwrap_err().code,
            "marketArchiveUnsafePath"
        );
    }

    #[test]
    fn rejects_entries_outside_the_plugin_directory() {
        // zip-slip 的最常见形态：前缀对不上。
        for name in [
            "../evil.js",
            "demo/../../evil.js",
            "other/index.js",
            "/etc/passwd",
            "D:/evil.js",
            "demo",
        ] {
            let entries = vec![dir("demo/"), entry("demo/plugin.json", 1), entry(name, 1)];
            let plan = plan_archive(&entries, "demo");

            assert!(plan.is_err(), "应当拒绝 {name:?}");
            let code = plan.unwrap_err().code;
            assert!(
                code == "marketArchiveUnsafePath" || code == "marketArchiveUnexpectedEntry",
                "{name:?} 的错误码是 {code}"
            );
        }
    }

    #[test]
    fn rejects_unsafe_segments() {
        let bad = [
            "demo/a/../../b.js",
            "demo/./index.js",
            "demo//index.js",
            "demo/a\\b.js",
            "demo/C:/evil.js",
            "demo/a.txt:stream",
            "demo/con.js",
            "demo/NUL",
            "demo/COM1.txt",
            "demo/trailing.",
            "demo/trailing ",
            "demo/ leading.js",
            "demo/a\u{0}b.js",
            "demo/a\nb.js",
        ];

        for name in bad {
            let entries = vec![entry("demo/plugin.json", 1), entry(name, 1)];
            assert!(
                plan_archive(&entries, "demo").is_err(),
                "应当拒绝 {name:?}"
            );
        }
    }

    #[test]
    fn accepts_harmless_names_that_look_scary() {
        // 这些容易被误伤：`con` 出现在中间、点的用法、连字符。
        let entries = vec![
            entry("demo/plugin.json", 1),
            entry("demo/console.js", 1),
            entry("demo/.hidden", 1),
            entry("demo/a.b.c.js", 1),
            entry("demo/my-plugin_v2.js", 1),
            entry("demo/中文名.js", 1),
        ];

        let plan = plan_archive(&entries, "demo").expect("这些名字都是合法的");
        assert_eq!(plan.entries.len(), 6);
    }

    #[test]
    fn rejects_symlink_entries() {
        let entries = vec![
            entry("demo/plugin.json", 1),
            RawEntry {
                name: "demo/link".to_string(),
                size: 0,
                is_dir: false,
                is_symlink: true,
            },
        ];

        let error = plan_archive(&entries, "demo").unwrap_err();
        assert_eq!(error.code, "marketArchiveSymlink");
    }

    #[test]
    fn rejects_case_insensitive_duplicates() {
        // 在 Windows 与 macOS 上这是同一个文件，谁最后写谁赢 —— 不能听天由命。
        let entries = vec![
            entry("demo/plugin.json", 1),
            entry("demo/Index.js", 10),
            entry("demo/index.JS", 20),
        ];

        let error = plan_archive(&entries, "demo").unwrap_err();
        assert_eq!(error.code, "marketArchiveDuplicateEntry");
    }

    #[test]
    fn rejects_oversized_file_and_total() {
        let entries = vec![
            entry("demo/plugin.json", 1),
            entry("demo/big.js", MAX_FILE_BYTES + 1),
        ];
        assert_eq!(
            plan_archive(&entries, "demo").unwrap_err().code,
            "marketArchiveFileTooLarge"
        );

        // 每个都在单文件上限之内，但加起来超了总量上限。
        let one = MAX_FILE_BYTES;
        let count = (MAX_TOTAL_BYTES / one) as usize + 2;
        let mut many = vec![entry("demo/plugin.json", 1)];
        for index in 0..count {
            many.push(entry(&format!("demo/f{index}.js"), one));
        }
        assert_eq!(
            plan_archive(&many, "demo").unwrap_err().code,
            "marketArchiveTooLarge"
        );
    }

    #[test]
    fn rejects_too_many_entries() {
        let mut entries = vec![entry("demo/plugin.json", 1)];
        for index in 0..MAX_ENTRIES {
            entries.push(entry(&format!("demo/f{index}.js"), 1));
        }

        assert_eq!(
            plan_archive(&entries, "demo").unwrap_err().code,
            "marketArchiveTooManyEntries"
        );
    }

    #[test]
    fn requires_a_manifest_at_the_root() {
        // 少一层目录或者根本不是插件，都要早点说清楚。
        let entries = vec![entry("demo/index.js", 1)];
        assert_eq!(
            plan_archive(&entries, "demo").unwrap_err().code,
            "marketArchiveMissingManifest"
        );

        // 藏在子目录里的 plugin.json 不算数（打包时多套了一层）。
        let nested = vec![entry("demo/demo/plugin.json", 1)];
        assert_eq!(
            plan_archive(&nested, "demo").unwrap_err().code,
            "marketArchiveMissingManifest"
        );

        let empty: Vec<RawEntry> = vec![];
        assert_eq!(
            plan_archive(&empty, "demo").unwrap_err().code,
            "marketArchiveEmpty"
        );
    }

    #[test]
    fn resolve_within_stays_inside() {
        let target = Path::new("X:/staging/demo");
        assert_eq!(
            resolve_within(target, "js/pdf.js").unwrap(),
            target.join("js").join("pdf.js")
        );
        assert!(resolve_within(target, "../escape.js").is_err());
    }

    // ------------------------------------------------------------ 真打一个 zip 来解

    /// 打一个最小可用的 zip（deflate），用来验解压这一步本身。
    fn make_zip(files: &[(&str, &str)]) -> Vec<u8> {
        make_zip_with_dirs(files, &[])
    }

    /// 同上，外加**显式的目录条目**（7-Zip 会写，而它的名字以 `/` 结尾）。
    fn make_zip_with_dirs(files: &[(&str, &str)], dirs: &[&str]) -> Vec<u8> {
        use zip::write::SimpleFileOptions;

        let mut buffer = io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for name in dirs {
                writer.add_directory(*name, options).unwrap();
            }
            for (name, content) in files {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("floral-market-zip-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn unpacks_a_real_zip() {
        // 打一个**带显式目录条目**的包 —— 7-Zip 就是这么写的，而「目录条目名字以 `/`
        // 结尾」正是踩过的那个坑。`start_file("demo/js/lib.js")` 不会自己带上目录条目。
        let bytes = make_zip_with_dirs(
            &[
                ("demo/plugin.json", r#"{ "name": "demo", "main": "index.js" }"#),
                ("demo/index.js", "// plugin"),
                ("demo/js/lib.js", "// lib"),
            ],
            &["demo/js/"],
        );
        let target = temp_dir("ok");

        let plan = unpack(io::Cursor::new(bytes), "demo", &target).expect("应当解压成功");
        assert_eq!(plan.entries.len(), 4, "三个文件 + 一条目录条目");
        assert_eq!(
            fs::read_to_string(target.join("index.js")).unwrap(),
            "// plugin"
        );
        assert_eq!(
            fs::read_to_string(target.join("js").join("lib.js")).unwrap(),
            "// lib"
        );
        assert!(target.join("js").is_dir());

        fs::remove_dir_all(&target).ok();
    }

    #[test]
    fn refuses_a_traversal_zip_without_writing_anything() {
        // 关键一条：**规划阶段就拒绝**，所以磁盘上不会有半个文件。
        let bytes = make_zip(&[("demo/plugin.json", "{}"), ("demo/../../evil.js", "pwned")]);
        let target = temp_dir("slip");

        let error = unpack(io::Cursor::new(bytes), "demo", &target).unwrap_err();
        assert_eq!(error.code, "marketArchiveUnsafePath");

        let written: Vec<_> = fs::read_dir(&target).unwrap().filter_map(Result::ok).collect();
        assert!(written.is_empty(), "被拒绝的包不该在磁盘上留下任何东西");

        fs::remove_dir_all(&target).ok();
    }

    #[test]
    fn refuses_a_zip_that_lies_about_size() {
        // 头部声明 5 字节、真实内容只有 2 字节（`{}`）→ 必须判为撒谎而不是照单全收。
        //
        // 反方向（声明得比实际小）挡不住：那要我们预先知道真实长度，而整数都是从同一个
        // 头部来的。所以真正兜底的是**按声明长度截断读**（`take`），谎报也撑不爆内存。
        let mut bytes = make_zip(&[("demo/plugin.json", "{}")]);
        let target = temp_dir("liar");
        let plan = ArchivePlan {
            entries: vec![PlannedEntry {
                index: 0,
                relative: "plugin.json".to_string(),
                size: 5,
                is_dir: false,
            }],
            total_bytes: 5,
        };
        let mut archive = zip::ZipArchive::new(io::Cursor::new(std::mem::take(&mut bytes))).unwrap();
        let error = extract_to(&mut archive, &plan, &target).unwrap_err();

        assert_eq!(error.code, "marketArchiveSizeMismatch");
        fs::remove_dir_all(&target).ok();
    }
}
