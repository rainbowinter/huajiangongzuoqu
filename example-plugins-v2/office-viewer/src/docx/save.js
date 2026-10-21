/**
 * 另存 `.docx`。
 *
 * 核心原则（见 DESIGN.md 3.4）：**源真相是原始 ZIP 与原始 XML**。
 * 编辑时只改 `document.xml` 那棵 DOM，保存时把它序列化回去，其余条目逐字节搬运。
 * 这样样式、图片、关系、批注这些没动过的部件不会因为「重新生成 OOXML」而蒸发。
 *
 * 没有编辑（`doc.dirty !== true`）时直接返回原始字节，连 XMLSerializer 都不碰 ——
 * 那一步会改变属性顺序与空白，产生毫无意义的 diff。
 */

import { W_NS, child, parseXml } from "../xml.js";
import { ZipArchive, readLocalHeader, readRawCompressed } from "../zip.js";
import { writeZip } from "../zip-write.js";

const DEFAULT_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const encoder = new TextEncoder();

/**
 * 序列化 `word/document.xml`。
 *
 * XML 声明必须手动补：`XMLSerializer` 只输出根元素，而 OOXML 的声明里
 * `standalone="yes"` 是规范的一部分。原始声明原样保留（大小写、引号、编码都不改），
 * 没有就用默认值。输出不带 BOM。
 */
export function serializeDocumentXml(doc) {
  const source = doc?.source;
  if (!source?.documentXml) throw new Error("文档没有可序列化的 word/document.xml。");

  let xml =
    typeof source.documentXml === "string"
      ? source.documentXml
      : new XMLSerializer().serializeToString(source.documentXml);
  // Chrome 的 XMLSerializer 有时会把 prolog 一起带出来；先剥掉，避免重复声明。
  xml = xml.replace(/^\s*<\?xml[^>]*\?>\s*/, "");
  const declaration = source.declaration ? source.declaration : DEFAULT_DECLARATION;
  return encoder.encode(`${declaration}\r\n${xml}`);
}

/** 从中央目录条目拼出 `writeZip` 需要的原始压缩元数据。 */
function rawEntryMeta(bytes, entry) {
  const local = readLocalHeader(bytes, entry);
  return {
    method: entry.method,
    crc32: entry.crc32,
    compressed: entry.compressed,
    uncompressed: entry.uncompressed,
    dosTime: entry.dosTime,
    dosDate: entry.dosDate,
    flags: entry.flags,
    versionMadeBy: entry.versionMadeBy,
    internalAttrs: entry.internalAttrs,
    externalAttrs: entry.externalAttrs,
    comment: entry.comment,
    centralExtra: entry.centralExtra,
    localExtra: local.localExtra,
  };
}

/** 换掉 `document.xml` 时，时间戳与属性沿用原条目；extra 不沿用（可能含旧大小）。 */
function replacedEntryMeta(entry) {
  if (!entry) return undefined;
  return {
    dosTime: entry.dosTime,
    dosDate: entry.dosDate,
    flags: entry.flags,
    versionMadeBy: entry.versionMadeBy,
    internalAttrs: entry.internalAttrs,
    externalAttrs: entry.externalAttrs,
  };
}

/**
 * 生成另存用的 DOCX 字节。
 *
 * `doc.source.zip` 可以是 `ZipArchive`，也可以是原始字节。未编辑时优先返回
 * `doc.originalBytes`，其次 `doc.source.originalBytes`，保证与打开时逐字节一致。
 */
export async function buildSavedDocx(doc) {
  const source = doc?.source ?? {};
  if (doc?.dirty !== true) {
    // 直接返回同一个字节对象，连复制都不做 —— 未编辑时另存必须逐字节一致。
    const original =
      doc?.originalBytes ??
      source.originalBytes ??
      (source.zip instanceof ZipArchive ? source.zip.bytes : source.zip);
    if (!original) throw new Error("没有原始文档字节，无法另存。");
    return original;
  }

  let zip;
  if (source.zip instanceof ZipArchive) {
    zip = source.zip;
  } else {
    const zipBytes = source.zip ?? source.originalBytes ?? doc?.originalBytes;
    if (!zipBytes) throw new Error("没有原始 ZIP 数据，无法另存。");
    zip = new ZipArchive(zipBytes);
  }

  // 目录项（`word/` 之类）也按原顺序带回去：Word 不强制要求，但保真是验收标准。
  const all = [...zip.entries, ...(zip.directories ?? [])].sort(
    (a, b) => (a.centralIndex ?? 0) - (b.centralIndex ?? 0),
  );

  const entries = [];
  let replaced = false;
  for (const entry of all) {
    if (entry.name === "word/document.xml") {
      entries.push({
        name: entry.name,
        data: serializeDocumentXml(doc),
        meta: replacedEntryMeta(entry),
      });
      replaced = true;
    } else if (entry.name.endsWith("/")) {
      entries.push({
        name: entry.name,
        raw: new Uint8Array(0),
        meta: rawEntryMeta(zip.bytes, entry),
      });
    } else {
      entries.push({
        name: entry.name,
        raw: readRawCompressed(zip.bytes, entry),
        meta: rawEntryMeta(zip.bytes, entry),
      });
    }
  }

  // 理论上 document.xml 一定存在；万一原文件缺了，也把新内容补进去。
  if (!replaced) {
    entries.push({ name: "word/document.xml", data: serializeDocumentXml(doc) });
  }

  return writeZip(entries);
}

/** `报告.docx` → `报告-已编辑.docx`；空名字回退到 `文档-已编辑.docx`。 */
export function savedFileName(name) {
  const original = typeof name === "string" ? name : "";
  const base = original.replace(/\.docx$/i, "");
  if (base.trim() === "") return "文档-已编辑.docx";
  return `${base}-已编辑.docx`;
}

function collectBodyParagraphs(body) {
  const paragraphs = [];
  const visit = (element) => {
    for (const node of element.children) {
      if (node.namespaceURI !== W_NS) continue;
      switch (node.localName) {
        case "p":
          paragraphs.push(node);
          break;
        case "tbl":
          // 表格在 IR 里被拍平成 synthetic 行，不算真实段落。
          break;
        case "sdt":
          visit(child(node, "sdtContent") ?? node);
          break;
        case "customXml":
          visit(node);
          break;
        default:
          break;
      }
    }
  };
  visit(body);
  return paragraphs;
}

/** 与 `parse.js` 的 `collectPlainText` 不同：这里只拼 `w:t`，用于保存后校验。 */
function paragraphText(paragraph) {
  let text = "";
  if (typeof paragraph?.getElementsByTagNameNS !== "function") {
    throw new Error(
      `校验时拿到的不是元素：${Object.prototype.toString.call(paragraph)} ` +
        `local=${paragraph?.localName} nodeType=${paragraph?.nodeType} ` +
        `ctor=${paragraph?.constructor?.name}`,
    );
  }
  // 用下标遍历：某些 WebView 的 XML 文档里，这个集合不保证有 Symbol.iterator。
  const nodes = paragraph.getElementsByTagNameNS(W_NS, "t");
  for (let index = 0; index < nodes.length; index += 1) {
    text += nodes[index].textContent ?? "";
  }
  return text;
}

function expectedParagraphs(doc) {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  return blocks
    .filter(
      (block) =>
        block &&
        !block.synthetic &&
        block.kind === "paragraph" &&
        block.node &&
        block.node.namespaceURI === W_NS &&
        block.node.localName === "p",
    )
    .map((block) => block.node);
}

/**
 * 保存后自检：重新打开写出的 ZIP，确认 `document.xml` 合法，
 * 并且段落数与每段 `w:t` 文本和模型一致。任何异常都转成 `{ ok:false }`，不抛。
 */
export async function verifySavedDocx(bytes, doc) {
  try {
    const zip = new ZipArchive(bytes);
    if (!zip.has("word/document.xml")) {
      return { ok: false, message: "另存后的文档里没有 word/document.xml。" };
    }

    const documentXml = parseXml(await zip.text("word/document.xml"), "word/document.xml");
    const body = documentXml.getElementsByTagNameNS(W_NS, "body")[0] ?? null;
    if (!body) return { ok: false, message: "另存后的 document.xml 没有 w:body。" };

    const actual = collectBodyParagraphs(body);
    const expected = expectedParagraphs(doc);
    if (actual.length !== expected.length) {
      return {
        ok: false,
        message: `段落数不一致：期望 ${expected.length}，实际 ${actual.length}。`,
      };
    }

    for (let index = 0; index < expected.length; index += 1) {
      const expectedText = paragraphText(expected[index]);
      const actualText = paragraphText(actual[index]);
      if (expectedText !== actualText) {
        return {
          ok: false,
          message: `第 ${index + 1} 段文字不一致：期望「${expectedText}」，实际「${actualText}」。`,
        };
      }
    }

    return { ok: true, message: `校验通过：${actual.length} 段。` };
  } catch (error) {
    // 校验失败时把栈也带上：这类问题只会在真实文档上冒出来，光看 message 定位不了。
    return { ok: false, message: `校验失败：${error?.message ?? error}`, stack: error?.stack ?? null };
  }
}
