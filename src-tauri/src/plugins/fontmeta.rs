//! 从字体文件内部读元信息（族名 / 字重 / 是否斜体）。
//!
//! 为什么非要拆二进制：**文件名不可靠**。`JetBrainsMono-Regular.ttf` 按驼峰拆会得到
//! "Jet Brains Mono"，而真名是 "JetBrains Mono"；`FiraCode-Retina` 更是完全看不出归属。
//! 而 WebView 没有暴露任何读取字体内部名称的 API（`@font-face` 里的 `font-family` 是
//! **我们**起的名字，跟文件里写的是什么无关），所以只能在宿主侧把 sfnt 容器拆开。
//!
//! 只做需要的三件事：
//!
//! * `name` → 族名（优先 nameID 16「排版族名」，退回 1）与子族名；
//! * `OS/2` → `usWeightClass` 与 `fsSelection` 的斜体位；
//! * `head` → `macStyle` 的斜体位（`OS/2` 缺失时的兜底）。
//!
//! 全部按「读不到就给 `None`」写：截断的、非 sfnt 的、WOFF 压缩容器的一律安静地返回
//! 空结果，由调用方回落到文件名推导。这里**不允许 panic** —— 字体文件是用户随手丢进
//! 来的，什么形状都可能有。

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 单张表的读取上限。`name` 表正常只有几 KB，给足余量同时挡住被篡改的长度字段。
const MAX_TABLE_BYTES: usize = 4 * 1024 * 1024;

/// 一张字体表最多几张。正常字体几十张，上千张必然是坏文件。
const MAX_TABLES: usize = 512;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct FontMeta {
    /// 字体自己声明的族名。解析不出来时为 `None`。
    pub family: Option<String>,
    /// `OS/2.usWeightClass`（100–900 是常规取值，1–1000 之外视为无效）。
    pub weight: Option<u16>,
    /// `"italic"` 或 `"normal"`；两处标志位都读不到时为 `None`。
    pub style: Option<String>,
}

impl FontMeta {
    fn is_empty(&self) -> bool {
        self.family.is_none() && self.weight.is_none() && self.style.is_none()
    }
}

const SIG_TRUETYPE: u32 = 0x0001_0000;
const SIG_OTTO: u32 = 0x4F54_544F; // 'OTTO' —— CFF 轮廓的 OpenType
const SIG_TRUE: u32 = 0x7472_7565; // 'true'
const SIG_TYP1: u32 = 0x7479_7031; // 'typ1'
const SIG_TTCF: u32 = 0x7474_6366; // 'ttcf' —— 字体集合，取第一张

fn be_u16(data: &[u8], at: usize) -> Option<u16> {
    let slice = data.get(at..at + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

fn be_u32(data: &[u8], at: usize) -> Option<u32> {
    let slice = data.get(at..at + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// 第一张字体表的起始偏移。TTC 取第一张 —— 我们只需要"这个文件里有这么一个族"。
/// `WOFF` / `wOF2` 是压缩容器，不在这里处理，返回 `None` 交给文件名兜底。
fn sfnt_base(header: &[u8]) -> Option<usize> {
    let signature = be_u32(header, 0)?;
    if signature == SIG_TTCF {
        return be_u32(header, 12).map(|value| value as usize);
    }
    matches!(signature, SIG_TRUETYPE | SIG_OTTO | SIG_TRUE | SIG_TYP1).then_some(0)
}

fn read_at(file: &mut File, at: u64, len: usize) -> Option<Vec<u8>> {
    if len == 0 || len > MAX_TABLE_BYTES {
        return None;
    }
    file.seek(SeekFrom::Start(at)).ok()?;
    let mut buffer = vec![0u8; len];
    file.read_exact(&mut buffer).ok()?;
    Some(buffer)
}

/// `name` 表里的候选打分：**排版族名**优先于族名，Windows/Unicode 编码优先于 Mac。
///
/// 优先 16 是因为"老式"命名的字体会把字重塞进 nameID 1（于是每个字重都成一个族），
/// 而 16 始终是干净的家庭名。
fn name_score(platform: u16, encoding: u16, name_id: u16) -> u8 {
    let mut score = 0;
    if matches!(name_id, 16 | 17) {
        score += 4;
    }
    match (platform, encoding) {
        (0, _) | (3, 0) | (3, 1) | (3, 10) => score += 2,
        (1, 0) => score += 1,
        _ => {}
    }
    score
}

fn decode_name(bytes: &[u8], platform: u16, encoding: u16) -> Option<String> {
    match (platform, encoding) {
        (0, _) | (3, 0) | (3, 1) | (3, 10) => {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect();
            char::decode_utf16(units).collect::<Result<String, _>>().ok()
        }
        // MacRoman。字体名基本是 ASCII，高位字节按 Latin-1 兜底就够了。
        (1, _) => Some(bytes.iter().map(|&byte| byte as char).collect()),
        _ => None,
    }
}

/// 从 `name` 表里挑出族名与子族名。`table` 是**这张表自己的字节**，偏移从 0 起算。
fn parse_name_table(table: &[u8]) -> Option<(Option<String>, Option<String>)> {
    let count = be_u16(table, 2)? as usize;
    let string_offset = be_u16(table, 4)? as usize;

    let mut family: Option<(u8, String)> = None;
    let mut subfamily: Option<(u8, String)> = None;

    for index in 0..count {
        let at = 6 + index * 12;
        let platform = be_u16(table, at)?;
        let encoding = be_u16(table, at + 2)?;
        let name_id = be_u16(table, at + 6)?;
        let text_len = be_u16(table, at + 8)? as usize;
        let text_at = string_offset.checked_add(be_u16(table, at + 10)? as usize)?;

        let Some(raw) = table.get(text_at..text_at.checked_add(text_len)?) else {
            continue;
        };
        let Some(value) = decode_name(raw, platform, encoding) else {
            continue;
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }

        let score = name_score(platform, encoding, name_id);
        let slot = match name_id {
            1 | 16 => &mut family,
            2 | 17 => &mut subfamily,
            _ => continue,
        };
        if slot.as_ref().map_or(true, |(best, _)| score > *best) {
            *slot = Some((score, value));
        }
    }

    Some((family.map(|(_, value)| value), subfamily.map(|(_, value)| value)))
}

/// 读取一个字体文件。任何一步失败都只是让字段为 `None`。
pub fn read_font_meta(path: &Path) -> FontMeta {
    let mut meta = FontMeta::default();

    let Ok(mut file) = File::open(path) else {
        return meta;
    };

    let Some(header) = read_at(&mut file, 0, 16) else {
        return meta;
    };
    let Some(base) = sfnt_base(&header) else {
        return meta;
    };

    let Some(count_raw) = read_at(&mut file, base as u64 + 4, 2) else {
        return meta;
    };
    let count = u16::from_be_bytes([count_raw[0], count_raw[1]]) as usize;
    if count == 0 || count > MAX_TABLES {
        return meta;
    }

    let Some(directory) = read_at(&mut file, base as u64 + 12, count * 16) else {
        return meta;
    };

    let mut italic: Option<bool> = None;

    for index in 0..count {
        let at = index * 16;
        let Some(tag) = directory.get(at..at + 4) else {
            break;
        };
        let Some(offset) = be_u32(&directory, at + 8) else {
            break;
        };
        let Some(length) = be_u32(&directory, at + 12) else {
            break;
        };
        let length = length as usize;

        if tag == b"name" {
            if let Some(table) = read_at(&mut file, offset as u64, length) {
                if let Some((family, _)) = parse_name_table(&table) {
                    if family.is_some() {
                        meta.family = family;
                    }
                }
            }
        } else if tag == b"OS/2" {
            if let Some(table) = read_at(&mut file, offset as u64, length.min(128)) {
                if let Some(weight) = be_u16(&table, 4) {
                    if (1..=1000).contains(&weight) {
                        meta.weight = Some(weight);
                    }
                }
                // fsSelection 在偏移 62，位 0 是 ITALIC。
                if let Some(selection) = be_u16(&table, 62) {
                    italic = Some(selection & 0b1 != 0);
                }
            }
        } else if tag == b"head" {
            // macStyle 在偏移 44，位 1 是 italic。作为 OS/2 缺失时的兜底；
            // 只在还没定论时用它，免得覆盖 OS/2 的结论。
            if italic.is_none() {
                if let Some(table) = read_at(&mut file, offset as u64, length.min(64)) {
                    if let Some(mac_style) = be_u16(&table, 44) {
                        italic = Some(mac_style & 0b10 != 0);
                    }
                }
            }
        }
    }

    meta.style = italic.map(|value| if value { "italic" } else { "normal" }.to_string());

    if meta.is_empty() {
        return FontMeta::default();
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 拼一张 `name` 表：给定 [(nameID, 文本)]，用 Windows/Unicode(3,1) 编码。
    fn name_table(entries: &[(u16, &str)]) -> Vec<u8> {
        let count = entries.len() as u16;
        let string_offset = 6 + 12 * count;

        let mut strings: Vec<u8> = Vec::new();
        let mut records: Vec<u8> = Vec::new();

        for &(name_id, text) in entries {
            let encoded: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
            records.extend_from_slice(&3u16.to_be_bytes()); // platformID = Windows
            records.extend_from_slice(&1u16.to_be_bytes()); // encodingID = UCS-2
            records.extend_from_slice(&0x0409u16.to_be_bytes()); // languageID = en-US
            records.extend_from_slice(&name_id.to_be_bytes());
            records.extend_from_slice(&(encoded.len() as u16).to_be_bytes());
            records.extend_from_slice(&(strings.len() as u16).to_be_bytes());
            strings.extend_from_slice(&encoded);
        }

        let mut table: Vec<u8> = Vec::new();
        table.extend_from_slice(&0u16.to_be_bytes()); // format
        table.extend_from_slice(&count.to_be_bytes());
        table.extend_from_slice(&(string_offset as u16).to_be_bytes());
        table.extend_from_slice(&records);
        table.extend_from_slice(&strings);
        table
    }

    fn os2_table(weight: u16, italic: bool) -> Vec<u8> {
        let mut table = vec![0u8; 96];
        table[0..2].copy_from_slice(&4u16.to_be_bytes()); // version
        table[4..6].copy_from_slice(&weight.to_be_bytes()); // usWeightClass
        let selection: u16 = if italic { 0b1 } else { 0 };
        table[62..64].copy_from_slice(&selection.to_be_bytes()); // fsSelection
        table
    }

    fn head_table(italic: bool) -> Vec<u8> {
        let mut table = vec![0u8; 54];
        let mac_style: u16 = if italic { 0b10 } else { 0 };
        table[44..46].copy_from_slice(&mac_style.to_be_bytes()); // macStyle
        table
    }

    /// 组装一个最小 sfnt：只有 name / OS/2 / head 三张表，够 `read_font_meta` 用。
    fn build_font(entries: &[(u16, &str)], weight: u16, italic: bool) -> Vec<u8> {
        let tables: Vec<([u8; 4], Vec<u8>)> = vec![
            (*b"OS/2", os2_table(weight, italic)),
            (*b"head", head_table(italic)),
            (*b"name", name_table(entries)),
        ];

        let count = tables.len() as u16;
        let directory_len = 12 + count as usize * 16;

        let mut data = vec![0u8; 12];
        data[0..4].copy_from_slice(&SIG_TRUETYPE.to_be_bytes());
        data[4..6].copy_from_slice(&count.to_be_bytes());

        let mut body: Vec<u8> = Vec::new();
        for (tag, table) in &tables {
            let offset = directory_len + body.len();
            let mut record = Vec::with_capacity(16);
            record.extend_from_slice(tag);
            record.extend_from_slice(&0u32.to_be_bytes()); // checksum，解析时用不到
            record.extend_from_slice(&(offset as u32).to_be_bytes());
            record.extend_from_slice(&(table.len() as u32).to_be_bytes());
            data.extend_from_slice(&record);
            body.extend_from_slice(table);
        }
        data.extend_from_slice(&body);
        data
    }

    fn write_temp(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("floral-fontmeta-{tag}-{}.ttf", uuid::Uuid::new_v4()));
        fs::write(&path, bytes).expect("write font");
        path
    }

    #[test]
    fn reads_family_weight_and_style() {
        let path = write_temp(
            "basic",
            &build_font(
                &[(1, "JetBrains Mono"), (2, "Bold Italic"), (16, "JetBrains Mono")],
                700,
                true,
            ),
        );

        let meta = read_font_meta(&path);

        assert_eq!(meta.family.as_deref(), Some("JetBrains Mono"));
        assert_eq!(meta.weight, Some(700));
        assert_eq!(meta.style.as_deref(), Some("italic"));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn prefers_typographic_family_over_legacy_name_id_1() {
        // 老式命名把字重塞进 nameID 1；nameID 16 才是干净的家庭名。
        let path = write_temp(
            "typographic",
            &build_font(&[(1, "Fira Code Bold"), (2, "Regular"), (16, "Fira Code")], 700, false),
        );

        assert_eq!(read_font_meta(&path).family.as_deref(), Some("Fira Code"));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn falls_back_to_name_id_1_when_16_is_absent() {
        let path = write_temp("legacy", &build_font(&[(1, "Hack"), (2, "Regular")], 400, false));

        assert_eq!(read_font_meta(&path).family.as_deref(), Some("Hack"));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn reports_normal_style() {
        let path = write_temp("regular", &build_font(&[(1, "Hack"), (2, "Regular")], 400, false));

        let meta = read_font_meta(&path);

        assert_eq!(meta.style.as_deref(), Some("normal"));
        assert_eq!(meta.weight, Some(400));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn italic_falls_back_to_head_when_os2_is_missing() {
        let mut font = build_font(&[(1, "NoOs2")], 400, true);
        // 把 OS/2 那张表的 tag 改掉，模拟没有 OS/2 的字体
        let at = font
            .windows(4)
            .position(|window| window == b"OS/2")
            .expect("找到 OS/2");
        font[at..at + 4].copy_from_slice(b"XXXX");
        let path = write_temp("no-os2", &font);

        let meta = read_font_meta(&path);

        assert_eq!(meta.family.as_deref(), Some("NoOs2"));
        assert_eq!(meta.style.as_deref(), Some("italic"), "应回落到 head.macStyle");
        assert_eq!(meta.weight, None, "没有 OS/2 就没有字重");

        fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_non_sfnt_and_truncated_files() {
        // 这两类都必须安静返回空结果，绝不能 panic —— 用户会往里丢任何东西。
        for (tag, bytes) in [
            ("garbage", b"not a font at all".to_vec()),
            ("empty", Vec::new()),
            ("short", vec![0x00, 0x01, 0x00]),
            ("truncated", build_font(&[(1, "X")], 400, false)[..20].to_vec()),
        ] {
            let path = write_temp(tag, &bytes);
            let meta = read_font_meta(&path);
            assert_eq!(meta, FontMeta::default(), "{tag} 应得到空结果");
            fs::remove_file(&path).ok();
        }
    }

    #[test]
    fn missing_file_is_not_a_panic() {
        let meta = read_font_meta(Path::new("X:/nope/missing.ttf"));
        assert_eq!(meta, FontMeta::default());
    }

    #[test]
    fn out_of_range_weight_is_dropped() {
        let path = write_temp("bad-weight", &build_font(&[(1, "Weird")], 0, false));

        assert_eq!(read_font_meta(&path).weight, None);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn reads_the_first_font_of_a_collection() {
        // TTC：把单字体包塞进一个 ttcf 外壳里，偏移指向内层 sfnt。
        let mut inner = build_font(&[(1, "Collection Family"), (2, "Regular")], 500, false);
        // ttcf 头：tag(4) + version(4) + numFonts(4) + offsets[numFonts](4*1) = 16 字节
        let header_len = 16usize;

        // TTC 里的表偏移是**相对整个文件**的绝对偏移（不是相对各自 sfnt 头），
        // 所以内层字体往前挪了 header_len 之后，它自己那张表目录里的偏移也要跟着挪。
        let count = u16::from_be_bytes([inner[4], inner[5]]) as usize;
        for index in 0..count {
            let at = 12 + index * 16 + 8;
            let offset = u32::from_be_bytes([inner[at], inner[at + 1], inner[at + 2], inner[at + 3]]);
            inner[at..at + 4].copy_from_slice(&(offset + header_len as u32).to_be_bytes());
        }

        let mut ttc: Vec<u8> = Vec::new();
        ttc.extend_from_slice(b"ttcf");
        ttc.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        ttc.extend_from_slice(&1u32.to_be_bytes()); // numFonts
        ttc.extend_from_slice(&(header_len as u32).to_be_bytes()); // 第一张的偏移
        ttc.extend_from_slice(&inner);
        let path = write_temp("ttc", &ttc);

        let meta = read_font_meta(&path);

        assert_eq!(meta.family.as_deref(), Some("Collection Family"));
        assert_eq!(meta.weight, Some(500));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn woff_is_left_to_the_filename_heuristic() {
        let path = write_temp("woff", b"wOFF\x00\x01\x00\x00");

        assert_eq!(read_font_meta(&path), FontMeta::default());

        fs::remove_file(&path).ok();
    }
}
