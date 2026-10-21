//#region src/zip-write.js
/**
* 最小 ZIP 写入器。
*
* 另存 `.docx` 时只有 `word/document.xml` 会被重新序列化，其余条目必须原样搬回去。
* 所以这里不接受「解压后再压缩」那种做法，而是让调用方选择：
*
*   - `{ name, data }`：给未压缩字节，自己算 CRC，尝试 deflate；
*   - `{ name, raw, meta }`：给原压缩字节，按原方法 / CRC / 大小 / 时间原样写入。
*
* 不写 ZIP64：DOCX 正常远小于 4 GiB，条目也远少于 65535 个。超过限制就显式报错，
* 而不是悄悄写出一份打不开的文件。
*/
const LOCAL_SIGNATURE$1 = 67324752;
const CENTRAL_SIGNATURE$1 = 33639248;
const EOCD_SIGNATURE$1 = 101010256;
const FLAG_UTF8 = 2048;
const VERSION_NEEDED = 20;
const MAX_UINT32 = 4294967295;
const MAX_ENTRIES$1 = 65535;
const MAX_OUTPUT = 256 * 1024 * 1024;
const EMPTY = new Uint8Array(0);
const encoder$2 = new TextEncoder();
/** 标准 CRC-32（IEEE 802.3）查表。 */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();
/** 表驱动 CRC-32；结果是无符号 32 位整数（`"123456789"` → `0xCBF43926`）。 */
function crc32(bytes) {
	let crc = 4294967295;
	for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ crc >>> 8;
	return (crc ^ 4294967295) >>> 0;
}
/**
* 用浏览器 / Node 自带的 `CompressionStream("deflate-raw")` 压缩。
*
* 环境不支持，或者压缩流本身出错时返回 `null` —— 调用方退回到「存储」，
* 另存不应该因为压缩不可用而失败。
*/
async function deflateRaw(bytes) {
	if (typeof CompressionStream !== "function") return null;
	try {
		const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	} catch {
		return null;
	}
}
function toBytes(value, label) {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	throw new Error(`${label} 必须是 Uint8Array 或 ArrayBuffer。`);
}
function toCommentBytes(comment) {
	if (comment === void 0 || comment === null || comment === "") return EMPTY;
	if (typeof comment === "string") return encoder$2.encode(comment);
	return toBytes(comment, "ZIP 注释");
}
function assertUint32(value, label) {
	if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) throw new Error(`${label} 超出 ZIP 32 位范围（${value}）。`);
}
function assertUint16(value, label) {
	if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${label} 超出 ZIP 16 位范围（${value}）。`);
}
/** 当前时间的 DOS 时间戳；没给元数据时用它，至少不会写出 1980 年的怪日期。 */
function dosDateTime(date = /* @__PURE__ */ new Date()) {
	const year = Math.min(2107, Math.max(1980, date.getFullYear()));
	return {
		dosTime: date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2),
		dosDate: year - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate()
	};
}
/**
* 重建通用位标记：数据描述符位必须清掉（我们会在本地头里直接写大小与 CRC），
* UTF-8 位在文件名含非 ASCII 字节时补上。其余位原样保留。
*/
function normalizeFlags(flags, nameBytes) {
	let result = (flags ?? 0) & -9;
	if (nameBytes.some((byte) => byte >= 128) || (flags ?? 0) & FLAG_UTF8) result |= FLAG_UTF8;
	return result;
}
async function prepareEntry(entry) {
	if (!entry || typeof entry.name !== "string" || entry.name === "") throw new Error("ZIP 条目缺少 name。");
	const name = entry.name;
	const nameBytes = encoder$2.encode(name);
	assertUint16(nameBytes.length, `ZIP 条目 ${name} 的文件名长度`);
	const meta = entry.meta ?? {};
	const defaults = dosDateTime();
	const dosTime = meta.dosTime ?? defaults.dosTime;
	const dosDate = meta.dosDate ?? defaults.dosDate;
	assertUint16(dosTime, `ZIP 条目 ${name} 的 DOS 时间`);
	assertUint16(dosDate, `ZIP 条目 ${name} 的 DOS 日期`);
	const flags = normalizeFlags(meta.flags, nameBytes);
	const localExtra = meta.localExtra ? toBytes(meta.localExtra, "localExtra") : EMPTY;
	const centralExtra = meta.centralExtra ? toBytes(meta.centralExtra, "centralExtra") : EMPTY;
	const commentBytes = toCommentBytes(meta.comment);
	assertUint16(localExtra.length, `ZIP 条目 ${name} 的本地 extra 长度`);
	assertUint16(centralExtra.length, `ZIP 条目 ${name} 的中央目录 extra 长度`);
	assertUint16(commentBytes.length, `ZIP 条目 ${name} 的注释长度`);
	let method;
	let crc;
	let compressedBytes;
	let uncompressedSize;
	if (entry.raw !== void 0) {
		compressedBytes = toBytes(entry.raw, `ZIP 条目 ${name} 的 raw`);
		method = meta.method;
		if (method === void 0) throw new Error(`ZIP 条目 ${name} 的 raw 数据缺少 meta.method。`);
		uncompressedSize = meta.uncompressed;
		if (uncompressedSize === void 0) {
			if (method !== 0) throw new Error(`ZIP 条目 ${name} 的 raw 数据缺少 meta.uncompressed。`);
			uncompressedSize = compressedBytes.length;
		}
		crc = meta.crc32;
		if (crc === void 0) {
			if (method !== 0) throw new Error(`ZIP 条目 ${name} 的 raw 数据缺少 meta.crc32。`);
			crc = crc32(compressedBytes);
		}
	} else {
		const data = toBytes(entry.data ?? EMPTY, `ZIP 条目 ${name} 的 data`);
		method = 0;
		compressedBytes = data;
		uncompressedSize = data.length;
		crc = crc32(data);
		const deflated = await deflateRaw(data);
		if (deflated && deflated.length < data.length) {
			method = 8;
			compressedBytes = deflated;
		}
	}
	assertUint32(uncompressedSize, `ZIP 条目 ${name} 的原始大小`);
	assertUint32(compressedBytes.length, `ZIP 条目 ${name} 的压缩后大小`);
	assertUint32(crc, `ZIP 条目 ${name} 的 CRC`);
	return {
		name,
		nameBytes,
		method,
		flags,
		dosTime,
		dosDate,
		crc,
		compressed: compressedBytes.length,
		uncompressed: uncompressedSize,
		compressedBytes,
		localExtra,
		centralExtra,
		commentBytes,
		versionMadeBy: meta.versionMadeBy ?? VERSION_NEEDED,
		internalAttrs: meta.internalAttrs ?? 0,
		externalAttrs: meta.externalAttrs ?? 0,
		localOffset: 0
	};
}
function makeLocalHeader(entry) {
	const bytes = new Uint8Array(30 + entry.nameBytes.length + entry.localExtra.length);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, LOCAL_SIGNATURE$1, true);
	view.setUint16(4, VERSION_NEEDED, true);
	view.setUint16(6, entry.flags, true);
	view.setUint16(8, entry.method, true);
	view.setUint16(10, entry.dosTime, true);
	view.setUint16(12, entry.dosDate, true);
	view.setUint32(14, entry.crc, true);
	view.setUint32(18, entry.compressed, true);
	view.setUint32(22, entry.uncompressed, true);
	view.setUint16(26, entry.nameBytes.length, true);
	view.setUint16(28, entry.localExtra.length, true);
	bytes.set(entry.nameBytes, 30);
	bytes.set(entry.localExtra, 30 + entry.nameBytes.length);
	return bytes;
}
function makeCentralRecord(entry) {
	const bytes = new Uint8Array(46 + entry.nameBytes.length + entry.centralExtra.length + entry.commentBytes.length);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, CENTRAL_SIGNATURE$1, true);
	view.setUint16(4, entry.versionMadeBy, true);
	view.setUint16(6, VERSION_NEEDED, true);
	view.setUint16(8, entry.flags, true);
	view.setUint16(10, entry.method, true);
	view.setUint16(12, entry.dosTime, true);
	view.setUint16(14, entry.dosDate, true);
	view.setUint32(16, entry.crc, true);
	view.setUint32(20, entry.compressed, true);
	view.setUint32(24, entry.uncompressed, true);
	view.setUint16(28, entry.nameBytes.length, true);
	view.setUint16(30, entry.centralExtra.length, true);
	view.setUint16(32, entry.commentBytes.length, true);
	view.setUint16(34, 0, true);
	view.setUint16(36, entry.internalAttrs, true);
	view.setUint32(38, entry.externalAttrs, true);
	view.setUint32(42, entry.localOffset, true);
	let offset = 46;
	bytes.set(entry.nameBytes, offset);
	offset += entry.nameBytes.length;
	bytes.set(entry.centralExtra, offset);
	offset += entry.centralExtra.length;
	bytes.set(entry.commentBytes, offset);
	return bytes;
}
function makeEndOfCentralDirectory(count, centralSize, centralOffset) {
	const bytes = new Uint8Array(22);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, EOCD_SIGNATURE$1, true);
	view.setUint16(4, 0, true);
	view.setUint16(6, 0, true);
	view.setUint16(8, count, true);
	view.setUint16(10, count, true);
	view.setUint32(12, centralSize, true);
	view.setUint32(16, centralOffset, true);
	view.setUint16(20, 0, true);
	return bytes;
}
/**
* 写出一份 ZIP。
*
* `entries` 的顺序就是输出顺序。每个条目：
*
*   `{ name, data?, raw?, meta? }`
*
* - `data`：未压缩内容；
* - `raw`：已经压缩好的字节，此时 `meta` 需要带上 `method` / `crc32` /
*   `uncompressed`（可选 `dosTime` / `dosDate` / `flags` / extra / 注释 / 属性）。
*
* 返回 `Uint8Array`。
*/
async function writeZip(entries) {
	if (!Array.isArray(entries)) throw new Error("writeZip 需要条目数组。");
	if (entries.length > MAX_ENTRIES$1) throw new Error(`ZIP 条目太多（${entries.length}），当前写入器不支持超过 65535 个。`);
	const prepared = [];
	for (const entry of entries) prepared.push(await prepareEntry(entry));
	const localChunks = [];
	let localOffset = 0;
	for (const entry of prepared) {
		const header = makeLocalHeader(entry);
		entry.localOffset = localOffset;
		localChunks.push(header, entry.compressedBytes);
		localOffset += header.length + entry.compressedBytes.length;
		if (localOffset > MAX_OUTPUT) throw new Error("ZIP 输出超过 256 MiB，当前写入器不支持。");
		assertUint32(localOffset, "ZIP 本地数据偏移");
	}
	const centralChunks = [];
	let centralSize = 0;
	for (const entry of prepared) {
		const record = makeCentralRecord(entry);
		centralChunks.push(record);
		centralSize += record.length;
		assertUint32(centralSize, "ZIP 中央目录大小");
	}
	assertUint16(prepared.length, "ZIP 条目数量");
	assertUint32(localOffset, "ZIP 中央目录偏移");
	const total = localOffset + centralSize + 22;
	if (total > MAX_OUTPUT) throw new Error("ZIP 输出超过 256 MiB，当前写入器不支持。");
	const eocd = makeEndOfCentralDirectory(prepared.length, centralSize, localOffset);
	const output = new Uint8Array(total);
	let position = 0;
	for (const chunk of localChunks) {
		output.set(chunk, position);
		position += chunk.length;
	}
	for (const chunk of centralChunks) {
		output.set(chunk, position);
		position += chunk.length;
	}
	output.set(eocd, position);
	return output;
}
//#endregion
//#region src/docx/blank.js
/**
* 空文档。
*
* 花笺的「新建文件」会先创建一个 0 字节的 `.docx`。那不是合法的 ZIP，
* 但用户的意思很清楚：这里应该是一张白纸。与其报「文件太小」，
* 不如在内存里生成一份最小的合法 DOCX，再走正常的解析 / 编辑 / 另存链路。
*/
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const encoder$1 = new TextEncoder();
function escapeXml(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function documentXml(text = "") {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}">
  <w:body>
    ${String(text).replace(/\r\n?/g, "\n").split("\n").map((line) => line ? `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>` : "<w:p/>").join("") || "<w:p/>"}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"
               w:header="850" w:footer="992" w:gutter="0"/>
      <w:cols w:space="720"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>
      <w:sz w:val="21"/><w:szCs w:val="21"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr>
      <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
    </w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`;
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>
</Relationships>`;
/** 一份最小的、能正常打开与另存的空白 DOCX。 */
async function blankDocxBytes(text = "") {
	return writeZip([
		{
			name: "[Content_Types].xml",
			data: encoder$1.encode(CONTENT_TYPES)
		},
		{
			name: "_rels/.rels",
			data: encoder$1.encode(ROOT_RELS)
		},
		{
			name: "word/document.xml",
			data: encoder$1.encode(documentXml(text))
		},
		{
			name: "word/styles.xml",
			data: encoder$1.encode(STYLES_XML)
		},
		{
			name: "word/_rels/document.xml.rels",
			data: encoder$1.encode(DOCUMENT_RELS)
		}
	]);
}
//#endregion
//#region src/units.js
/**
* 单位换算。
*
* 引擎内部统一用 **CSS px（96dpi）**：
*
* * 1 pt = 4/3 px
* * 1 twip = 1/20 pt = 1/15 px
* * 1 inch = 914400 EMU = 96 px
*/
const PT_TO_PX = 4 / 3;
function twipsToPx(value) {
	return (Number(value) || 0) / 15;
}
function ptToPx(value) {
	return (Number(value) || 0) * PT_TO_PX;
}
function halfPointsToPx(value) {
	return (Number(value) || 0) / 2 * PT_TO_PX;
}
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
//#endregion
//#region src/xml.js
/**
* OOXML 的 XML 读取助手。
*
* 命名空间必须按 `namespaceURI` 判，不能按前缀 —— 文档里的前缀是作者随便起的，
* `w:p` 和 `a:p` 的 localName 都叫 `p`。所以这一层只认 (namespaceURI, localName)，
* 再给几个读属性的短函数。
*/
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const V_NS = "urn:schemas-microsoft-com:vml";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
function parseXml(text, label) {
	const document = new DOMParser().parseFromString(text, "application/xml");
	if (document.getElementsByTagName("parsererror").length > 0) throw new Error(`${label} 不是一份合法的 XML。`);
	return document;
}
function isW(element, localName) {
	return Boolean(element) && element.localName === localName && element.namespaceURI === "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
}
/** 直接子元素里所有 `w:<localName>`。 */
function children(element, localName) {
	if (!element) return [];
	const result = [];
	for (const childElement of element.children) if (isW(childElement, localName)) result.push(childElement);
	return result;
}
/** 直接子元素里第一个 `w:<localName>`。 */
function child(element, localName) {
	if (!element) return null;
	for (const childElement of element.children) if (isW(childElement, localName)) return childElement;
	return null;
}
/** 任意命名空间下、按 localName 找第一个后代。 */
function firstDescendant(element, localName, namespaceURI) {
	if (!element) return null;
	for (const descendant of element.getElementsByTagName("*")) {
		if (descendant.localName !== localName) continue;
		if (namespaceURI && descendant.namespaceURI !== namespaceURI) continue;
		return descendant;
	}
	return null;
}
function allDescendants(element, localName, namespaceURI) {
	const result = [];
	if (!element) return result;
	for (const descendant of element.getElementsByTagName("*")) {
		if (descendant.localName !== localName) continue;
		if (namespaceURI && descendant.namespaceURI !== namespaceURI) continue;
		result.push(descendant);
	}
	return result;
}
/** 读 `w:<name>` 属性。`getAttributeNS` 对带前缀的文档最稳。 */
function attr(element, name, namespaceURI = W_NS) {
	if (!element) return null;
	const value = element.getAttributeNS(namespaceURI, name);
	if (value !== null) return value;
	const plain = element.getAttribute(name);
	if (plain !== null) return plain;
	return element.getAttribute(`w:${name}`);
}
function numAttr(element, name, fallback = null) {
	const value = attr(element, name);
	if (value === null || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}
/**
* `w:b` / `w:keepNext` 这类开关：
* 没有 `w:val` 就是 true；`w:val="0"` / `"false"` / `"off"` 是 false。
*/
function boolAttr(element, name, fallback = false) {
	if (!element) return fallback;
	const value = attr(element, name);
	if (value === null) return true;
	return !(value === "0" || value === "false" || value === "off");
}
/** `w:val` 的简写。 */
function val(element, fallback = null) {
	return attr(element, "val") ?? fallback;
}
//#endregion
//#region src/zip.js
/**
* 只读 ZIP。
*
* DOCX 就是一个 ZIP。这里不引第三方解压库：
* WebView2（Chromium）与 Node 都支持 `DecompressionStream("deflate-raw")`，
* 而 DOCX 的条目只有「存储」和「deflate」两种压缩方式。
*
* 这样插件可以完全自包含，不必把 fflate 之类的库再打进来。
*/
const EOCD_SIGNATURE = 101010256;
const CENTRAL_SIGNATURE = 33639248;
const LOCAL_SIGNATURE = 67324752;
const ZIP64 = 4294967295;
function dataViewOf(bytes) {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
/**
* 扫描 ZIP 中央目录。
*
* 只读中央目录，不解压 —— 打开文档时先知道有哪些部件，再按需读。
*
* 每个条目除了「名字 / 压缩方式 / 大小 / 偏移」，还保留中央目录里的全部元数据：
* 时间戳、属性、注释、原始文件名与 extra 字段。另存 `.docx` 时，没改过的条目要
* 逐字节原样带回去，这些字段一个都不能丢（见 `zip-write.js`）。
*
* 目录项（`word/` 这种以 `/` 结尾的条目）不算部件，单独收在 `directories` 里。
*/
function scanCentralDirectory(bytes) {
	if (bytes.length < 22) throw new Error("文件太小，不是一份有效的 ZIP / DOCX。");
	const view = dataViewOf(bytes);
	const minOffset = Math.max(0, bytes.length - 65557);
	let eocd = -1;
	for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
		eocd = offset;
		break;
	}
	if (eocd < 0) throw new Error("找不到 ZIP 目录：这不是一份 DOCX。");
	const count = view.getUint16(eocd + 10, true);
	const directoryOffset = view.getUint32(eocd + 16, true);
	if (count === 65535 || directoryOffset === ZIP64) throw new Error("这份文档用了 ZIP64 结构，当前版本还不支持。");
	if (directoryOffset >= bytes.length) throw new Error("ZIP 目录偏移越界，文件可能已损坏。");
	const decoder = new TextDecoder("utf-8");
	const entries = [];
	const directories = [];
	let offset = directoryOffset;
	for (let index = 0; index < count; index += 1) {
		if (offset + 46 > bytes.length) throw new Error("ZIP 目录被截断了。");
		if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new Error("ZIP 目录项格式不对，文件可能已损坏。");
		const versionMadeBy = view.getUint16(offset + 4, true);
		const versionNeeded = view.getUint16(offset + 6, true);
		const flags = view.getUint16(offset + 8, true);
		const method = view.getUint16(offset + 10, true);
		const dosTime = view.getUint16(offset + 12, true);
		const dosDate = view.getUint16(offset + 14, true);
		const crc32 = view.getUint32(offset + 16, true);
		const compressed = view.getUint32(offset + 20, true);
		const uncompressed = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const internalAttrs = view.getUint16(offset + 36, true);
		const externalAttrs = view.getUint32(offset + 38, true);
		const localOffset = view.getUint32(offset + 42, true);
		const nameStart = offset + 46;
		const nameEnd = nameStart + nameLength;
		if (nameEnd > bytes.length) throw new Error("ZIP 文件名越界，文件可能已损坏。");
		const rawName = bytes.subarray(nameStart, nameEnd);
		const name = decoder.decode(rawName).replace(/\\/g, "/");
		const extraStart = nameEnd;
		const extraEnd = extraStart + extraLength;
		const commentStart = extraEnd;
		const commentEnd = commentStart + commentLength;
		if (commentEnd > bytes.length) throw new Error("ZIP 目录项越界，文件可能已损坏。");
		const entry = {
			name,
			centralIndex: index,
			method,
			compressed,
			uncompressed,
			localOffset,
			versionMadeBy,
			versionNeeded,
			flags,
			dosTime,
			dosDate,
			crc32,
			internalAttrs,
			externalAttrs,
			comment: decoder.decode(bytes.subarray(commentStart, commentEnd)),
			rawName,
			centralExtra: bytes.subarray(extraStart, extraEnd),
			nameLength,
			extraLength,
			commentLength
		};
		if (name.endsWith("/")) directories.push(entry);
		else {
			if (compressed === ZIP64 || uncompressed === ZIP64 || localOffset === ZIP64) throw new Error("这份文档用了 ZIP64 结构，当前版本还不支持。");
			entries.push(entry);
		}
		offset = commentEnd;
	}
	return {
		entries,
		directories,
		hasDirectories: directories.length > 0
	};
}
/**
* 读本地文件头。中央目录里没有本地 extra 字段（两者可以不同），
* 所以原样搬运压缩数据时要先到这里取一次。
*/
function readLocalHeader(bytes, entry) {
	const view = dataViewOf(bytes);
	if (entry.localOffset + 30 > bytes.length) throw new Error("ZIP 条目偏移越界。");
	if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) throw new Error(`ZIP 条目 ${entry.name} 的本地头损坏。`);
	const nameLength = view.getUint16(entry.localOffset + 26, true);
	const extraLength = view.getUint16(entry.localOffset + 28, true);
	const dataStart = entry.localOffset + 30 + nameLength + extraLength;
	if (dataStart > bytes.length) throw new Error(`ZIP 条目 ${entry.name} 的本地头被截断了。`);
	return {
		nameLength,
		extraLength,
		dataStart,
		localExtra: bytes.subarray(dataStart - extraLength, dataStart)
	};
}
/** 取一个条目的原始压缩字节（不解压）。 */
function readRawCompressed(bytes, entry) {
	const { dataStart } = readLocalHeader(bytes, entry);
	const dataEnd = dataStart + entry.compressed;
	if (dataEnd > bytes.length) throw new Error(`ZIP 条目 ${entry.name} 被截断了。`);
	return bytes.subarray(dataStart, dataEnd);
}
async function inflateRaw(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** 读一个条目的原始字节（自动解压）。 */
async function readZipEntry(bytes, entry) {
	const compressed = readRawCompressed(bytes, entry);
	let output;
	if (entry.method === 0) output = compressed;
	else if (entry.method === 8) output = await inflateRaw(compressed);
	else throw new Error(`ZIP 条目 ${entry.name} 用了不支持的压缩方式（${entry.method}）。`);
	if (entry.uncompressed > 0 && output.length !== entry.uncompressed) throw new Error(`ZIP 条目 ${entry.name} 解压后的大小对不上。`);
	return output;
}
var ZipArchive = class {
	constructor(bytes) {
		this.bytes = bytes;
		const scan = scanCentralDirectory(bytes);
		this.entries = scan.entries;
		this.directories = scan.directories;
		this.hasDirectoryEntries = scan.hasDirectories;
		this.byName = new Map(this.entries.map((entry) => [entry.name, entry]));
	}
	has(name) {
		return this.byName.has(name);
	}
	entry(name) {
		return this.byName.get(name) ?? null;
	}
	async read(name) {
		const entry = this.byName.get(name);
		if (!entry) throw new Error(`DOCX 里没有 ${name}。`);
		return readZipEntry(this.bytes, entry);
	}
	async text(name) {
		return new TextDecoder("utf-8").decode(await this.read(name));
	}
	async textOrNull(name) {
		if (!this.byName.has(name)) return null;
		return this.text(name);
	}
};
//#endregion
//#region src/docx/props.js
/**
* `w:rPr` / `w:pPr` 的解析与合并。
*
* 这里只把 **实际写出来的属性** 放进对象（没写就是 `undefined`），
* 因为样式级联靠的就是「后一层覆盖前一层」；把所有默认值先填满会把「没写」和
* 「显式写了默认值」混为一谈。
*/
function toggle(element, fallback = true) {
	if (!element) return fallback;
	const value = attr(element, "val");
	if (value === null) return true;
	return !(value === "0" || value === "false" || value === "off");
}
function nonNull(object) {
	const result = {};
	for (const [key, value] of Object.entries(object)) if (value !== null && value !== void 0) result[key] = value;
	return result;
}
function parseRunProps(rPr) {
	const props = {};
	if (!rPr) return props;
	const style = child(rPr, "rStyle");
	if (style) props.styleId = val(style);
	const fonts = child(rPr, "rFonts");
	if (fonts) {
		const parsed = nonNull({
			ascii: attr(fonts, "ascii"),
			hAnsi: attr(fonts, "hAnsi"),
			eastAsia: attr(fonts, "eastAsia"),
			cs: attr(fonts, "cs"),
			asciiTheme: attr(fonts, "asciiTheme"),
			hAnsiTheme: attr(fonts, "hAnsiTheme"),
			eastAsiaTheme: attr(fonts, "eastAsiaTheme"),
			cstheme: attr(fonts, "cstheme")
		});
		if (Object.keys(parsed).length > 0) props.fonts = parsed;
	}
	const sz = child(rPr, "sz");
	if (sz) props.size = numAttr(sz, "val");
	const szCs = child(rPr, "szCs");
	if (szCs) props.sizeCs = numAttr(szCs, "val");
	if (child(rPr, "b")) props.bold = toggle(child(rPr, "b"));
	if (child(rPr, "i")) props.italic = toggle(child(rPr, "i"));
	if (child(rPr, "caps")) props.caps = toggle(child(rPr, "caps"));
	if (child(rPr, "smallCaps")) props.smallCaps = toggle(child(rPr, "smallCaps"));
	if (child(rPr, "strike")) props.strike = toggle(child(rPr, "strike"));
	if (child(rPr, "dstrike")) props.doubleStrike = toggle(child(rPr, "dstrike"));
	if (child(rPr, "vanish")) props.vanish = toggle(child(rPr, "vanish"));
	const underline = child(rPr, "u");
	if (underline) props.underline = val(underline, "single");
	const color = child(rPr, "color");
	if (color) props.color = val(color, "auto");
	const highlight = child(rPr, "highlight");
	if (highlight) props.highlight = val(highlight);
	const shading = child(rPr, "shd");
	if (shading) {
		const fill = attr(shading, "fill");
		if (fill && fill !== "auto" && fill !== "none") props.shading = fill;
	}
	const vertAlign = child(rPr, "vertAlign");
	if (vertAlign) props.vertAlign = val(vertAlign);
	const spacing = child(rPr, "spacing");
	if (spacing) props.spacing = numAttr(spacing, "val");
	const position = child(rPr, "position");
	if (position) props.position = numAttr(position, "val");
	const lang = child(rPr, "lang");
	if (lang) props.lang = nonNull({
		val: attr(lang, "val"),
		eastAsia: attr(lang, "eastAsia")
	});
	const eastAsianLayout = child(rPr, "eastAsianLayout");
	if (eastAsianLayout) {
		props.vert = attr(eastAsianLayout, "vert");
		props.vertCompress = toggle(child(eastAsianLayout, "vertCompress"));
	}
	return props;
}
function parseIndent(element) {
	if (!element) return void 0;
	const parsed = nonNull({
		left: numAttr(element, "left") ?? numAttr(element, "start"),
		right: numAttr(element, "right") ?? numAttr(element, "end"),
		firstLine: numAttr(element, "firstLine"),
		hanging: numAttr(element, "hanging"),
		leftChars: numAttr(element, "leftChars") ?? numAttr(element, "startChars"),
		rightChars: numAttr(element, "rightChars") ?? numAttr(element, "endChars"),
		firstLineChars: numAttr(element, "firstLineChars"),
		hangingChars: numAttr(element, "hangingChars")
	});
	return Object.keys(parsed).length > 0 ? parsed : void 0;
}
function parseSpacing(element) {
	if (!element) return void 0;
	const parsed = nonNull({
		before: numAttr(element, "before"),
		after: numAttr(element, "after"),
		beforeLines: numAttr(element, "beforeLines"),
		afterLines: numAttr(element, "afterLines"),
		line: numAttr(element, "line"),
		lineRule: attr(element, "lineRule")
	});
	return Object.keys(parsed).length > 0 ? parsed : void 0;
}
function parseNumPr(element) {
	if (!element) return void 0;
	const ilvl = child(element, "ilvl");
	const numId = child(element, "numId");
	const parsed = nonNull({
		ilvl: ilvl ? numAttr(ilvl, "val", 0) : void 0,
		numId: numId ? numAttr(numId, "val") : void 0
	});
	return Object.keys(parsed).length > 0 ? parsed : void 0;
}
function parseTabs(element) {
	if (!element) return void 0;
	const tabs = [];
	for (const tab of children(element, "tab")) tabs.push({
		val: attr(tab, "val", "left") ?? "left",
		pos: numAttr(tab, "pos", 0) ?? 0,
		leader: attr(tab, "leader") ?? null
	});
	return tabs.length > 0 ? tabs : void 0;
}
function parseParagraphProps(pPr) {
	const props = {};
	if (!pPr) return props;
	const style = child(pPr, "pStyle");
	if (style) props.styleId = val(style);
	const jc = child(pPr, "jc");
	if (jc) props.jc = val(jc);
	const ind = parseIndent(child(pPr, "ind"));
	if (ind) props.ind = ind;
	const spacing = parseSpacing(child(pPr, "spacing"));
	if (spacing) props.spacing = spacing;
	const numPr = parseNumPr(child(pPr, "numPr"));
	if (numPr) props.numPr = numPr;
	const tabs = parseTabs(child(pPr, "tabs"));
	if (tabs) props.tabs = tabs;
	if (child(pPr, "keepNext")) props.keepNext = toggle(child(pPr, "keepNext"));
	if (child(pPr, "keepLines")) props.keepLines = toggle(child(pPr, "keepLines"));
	if (child(pPr, "pageBreakBefore")) props.pageBreakBefore = toggle(child(pPr, "pageBreakBefore"));
	if (child(pPr, "widowControl")) props.widowControl = toggle(child(pPr, "widowControl"));
	if (child(pPr, "contextualSpacing")) props.contextualSpacing = toggle(child(pPr, "contextualSpacing"));
	if (child(pPr, "snapToGrid")) props.snapToGrid = toggle(child(pPr, "snapToGrid"));
	if (child(pPr, "kinsoku")) props.kinsoku = toggle(child(pPr, "kinsoku"));
	if (child(pPr, "overflowPunct")) props.overflowPunct = toggle(child(pPr, "overflowPunct"));
	if (child(pPr, "topLinePunct")) props.topLinePunct = toggle(child(pPr, "topLinePunct"));
	if (child(pPr, "autoSpaceDE")) props.autoSpaceDE = toggle(child(pPr, "autoSpaceDE"));
	if (child(pPr, "autoSpaceDN")) props.autoSpaceDN = toggle(child(pPr, "autoSpaceDN"));
	const outline = child(pPr, "outlineLvl");
	if (outline) props.outlineLvl = numAttr(outline, "val");
	const textAlignment = child(pPr, "textAlignment");
	if (textAlignment) props.textAlignment = val(textAlignment);
	return props;
}
function mergeRunProps(target, source) {
	if (!source) return target;
	for (const [key, value] of Object.entries(source)) {
		if (value === void 0 || value === null) continue;
		if (key === "fonts") {
			target.fonts = { ...target.fonts };
			for (const [fontKey, fontValue] of Object.entries(value)) if (fontValue !== null && fontValue !== void 0) target.fonts[fontKey] = fontValue;
			continue;
		}
		target[key] = value;
	}
	return target;
}
function mergeParagraphProps(target, source) {
	if (!source) return target;
	for (const [key, value] of Object.entries(source)) {
		if (value === void 0 || value === null) continue;
		if (key === "ind" || key === "spacing" || key === "numPr") {
			target[key] = {
				...target[key],
				...value
			};
			continue;
		}
		target[key] = value;
	}
	return target;
}
/** `w:docDefaults` 里的两个默认属性块。 */
function parseDocDefaults(stylesElement) {
	const defaults = child(stylesElement, "docDefaults");
	const rPrDefault = child(defaults, "rPrDefault");
	const pPrDefault = child(defaults, "pPrDefault");
	return {
		rPr: parseRunProps(child(rPrDefault, "rPr")),
		pPr: parseParagraphProps(child(pPrDefault, "pPr"))
	};
}
//#endregion
//#region src/docx/numbering.js
/**
* 自动编号（`word/numbering.xml`）。
*
* M1 只做「把编号文字算出来并插到段落开头」：计数器、`%1.%2` 模板、常见数字格式、
* 缩进级别。复杂的 `lvlOverride` / 重新开始规则 / 多级列表重启，等 M7 再细做。
*/
function parseLevel(levelElement) {
	return {
		ilvl: numAttr(levelElement, "ilvl", 0) ?? 0,
		start: numAttr(levelElement, "start", 1) ?? 1,
		numFmt: val(child(levelElement, "numFmt"), "decimal") ?? "decimal",
		lvlText: val(child(levelElement, "lvlText"), "") ?? "",
		suff: val(child(levelElement, "suff"), "tab") ?? "tab",
		pStyle: val(child(levelElement, "pStyle")),
		pPr: parseParagraphProps(child(levelElement, "pPr")),
		rPr: parseRunProps(child(levelElement, "rPr"))
	};
}
function parseNumbering(numberingDocument) {
	const abstractNums = /* @__PURE__ */ new Map();
	const nums = /* @__PURE__ */ new Map();
	if (!numberingDocument) return {
		abstractNums,
		nums
	};
	const root = numberingDocument.documentElement;
	for (const abstractElement of children(root, "abstractNum")) {
		const id = attr(abstractElement, "abstractNumId");
		if (!id) continue;
		const levels = /* @__PURE__ */ new Map();
		for (const levelElement of children(abstractElement, "lvl")) {
			const level = parseLevel(levelElement);
			levels.set(level.ilvl, level);
		}
		abstractNums.set(id, {
			id,
			levels
		});
	}
	for (const numElement of children(root, "num")) {
		const id = attr(numElement, "numId");
		if (!id) continue;
		const abstractNumId = val(child(numElement, "abstractNumId"));
		const overrides = /* @__PURE__ */ new Map();
		for (const overrideElement of children(numElement, "lvlOverride")) {
			const ilvl = numAttr(overrideElement, "ilvl", 0) ?? 0;
			const startElement = child(overrideElement, "startOverride");
			const levelElement = child(overrideElement, "lvl");
			overrides.set(ilvl, {
				start: startElement ? numAttr(startElement, "val") : null,
				level: levelElement ? parseLevel(levelElement) : null
			});
		}
		nums.set(id, {
			id,
			abstractNumId,
			overrides
		});
	}
	return {
		abstractNums,
		nums
	};
}
function resolveNumberingLevel(numbering, numId, ilvl) {
	const num = numbering.nums.get(String(numId));
	if (!num) return null;
	const abstract = numbering.abstractNums.get(num.abstractNumId);
	if (!abstract) return null;
	const override = num.overrides.get(ilvl);
	if (override?.level) return override.level;
	return abstract.levels.get(ilvl) ?? null;
}
const DIGITS = [
	"零",
	"一",
	"二",
	"三",
	"四",
	"五",
	"六",
	"七",
	"八",
	"九"
];
const UNITS = [
	"",
	"十",
	"百",
	"千"
];
const TRADITIONAL = [
	"甲",
	"乙",
	"丙",
	"丁",
	"戊",
	"己",
	"庚",
	"辛",
	"壬",
	"癸"
];
function chineseNumber(value) {
	const number = Math.floor(value);
	if (number <= 0) return "零";
	if (number < 10) return DIGITS[number];
	if (number < 20) return `十${number % 10 === 0 ? "" : DIGITS[number % 10]}`;
	if (number < 1e4) {
		let result = "";
		let rest = number;
		for (let unit = 3; unit >= 0; unit -= 1) {
			const digit = Math.floor(rest / 10 ** unit);
			rest %= 10 ** unit;
			if (digit === 0) {
				if (result && rest > 0 && !result.endsWith("零")) result += "零";
				continue;
			}
			result += DIGITS[digit] + UNITS[unit];
		}
		return result.replace(/零+$/, "");
	}
	return String(number);
}
function romanNumber(value) {
	const table = [
		[1e3, "m"],
		[900, "cm"],
		[500, "d"],
		[400, "cd"],
		[100, "c"],
		[90, "xc"],
		[50, "l"],
		[40, "xl"],
		[10, "x"],
		[9, "ix"],
		[5, "v"],
		[4, "iv"],
		[1, "i"]
	];
	let number = Math.max(0, Math.floor(value));
	let result = "";
	for (const [amount, glyph] of table) while (number >= amount) {
		result += glyph;
		number -= amount;
	}
	return result;
}
function letters(value) {
	let number = Math.max(1, Math.floor(value));
	let result = "";
	while (number > 0) {
		const digit = (number - 1) % 26;
		result = String.fromCharCode(97 + digit) + result;
		number = Math.floor((number - 1) / 26);
	}
	return result;
}
function formatCounter(value, numFmt) {
	switch (numFmt) {
		case "decimal": return String(value);
		case "decimalZero": return String(value).padStart(2, "0");
		case "lowerLetter": return letters(value);
		case "upperLetter": return letters(value).toUpperCase();
		case "lowerRoman": return romanNumber(value);
		case "upperRoman": return romanNumber(value).toUpperCase();
		case "chineseCounting":
		case "chineseCountingThousand":
		case "ideographDigital": return chineseNumber(value);
		case "ideographTraditional": return TRADITIONAL[(value - 1) % 10] ?? String(value);
		case "none": return "";
		case "bullet": return "";
		default: return String(value);
	}
}
function formatLevelText(level, counters, numbering, numId) {
	if (level.numFmt === "bullet") return level.lvlText || "•";
	if (level.numFmt === "none") return "";
	return level.lvlText.replace(/%([1-9])/g, (_, digit) => {
		const index = Number(digit) - 1;
		const counter = counters[index];
		if (counter === void 0) return "";
		return formatCounter(counter, resolveNumberingLevel(numbering, numId, index)?.numFmt ?? "decimal");
	});
}
/**
* 给一个带 `numPr` 的段落算出编号文字（不含后缀）。
*
* 返回 `{ text, level, suffix }`；`numId=0` / 找不到定义时返回 `null`。
*/
function nextNumberingLabel(state, numbering, numPr) {
	if (!numPr || numPr.numId === void 0 || numPr.numId === null) return null;
	const numId = String(numPr.numId);
	if (numId === "0") return null;
	const num = numbering.nums.get(numId);
	if (!num) return null;
	if (!numbering.abstractNums.get(num.abstractNumId)) return null;
	const ilvl = Math.max(0, numPr.ilvl ?? 0);
	const level = resolveNumberingLevel(numbering, numId, ilvl);
	if (!level) return null;
	let counters = state.counters.get(numId);
	if (!counters) {
		counters = [];
		state.counters.set(numId, counters);
	}
	for (let index = 0; index <= ilvl; index += 1) if (counters[index] === void 0) {
		const definition = resolveNumberingLevel(numbering, numId, index);
		counters[index] = (definition?.start ?? 1) - 1;
	}
	counters[ilvl] += 1;
	for (let index = ilvl + 1; index < counters.length; index += 1) counters[index] = void 0;
	return {
		text: formatLevelText(level, counters, numbering, numId),
		level,
		suffix: level.suff
	};
}
function numberingSuffix(suffix) {
	if (suffix === "space") return " ";
	if (suffix === "nothing") return "";
	return "	";
}
//#endregion
//#region src/docx/styles.js
/**
* 样式表与级联。
*
* Word 的规则是：
*
*   docDefaults → 默认段落样式 → 段落样式 basedOn 链 → 字符样式 basedOn 链 → 直接格式
*
* 段落样式里的 `w:rPr` 会作用到这一段的所有 run，字符样式再在上面覆盖。
* `basedOn` 可能是环，链要走成有环检测。
*/
function parseStyles(stylesDocument) {
	if (!stylesDocument) return {
		defaults: {
			rPr: {},
			pPr: {}
		},
		byId: /* @__PURE__ */ new Map(),
		defaultsByType: {}
	};
	const root = stylesDocument.documentElement;
	const defaults = parseDocDefaults(root);
	const byId = /* @__PURE__ */ new Map();
	const defaultsByType = {};
	for (const styleElement of children(root, "style")) {
		const id = attr(styleElement, "styleId");
		if (!id) continue;
		const type = attr(styleElement, "type") ?? "paragraph";
		const entry = {
			id,
			type,
			isDefault: boolAttr(styleElement, "default", false),
			name: val(child(styleElement, "name")),
			basedOn: val(child(styleElement, "basedOn")),
			next: val(child(styleElement, "next")),
			link: val(child(styleElement, "link")),
			pPr: parseParagraphProps(child(styleElement, "pPr")),
			rPr: parseRunProps(child(styleElement, "rPr"))
		};
		byId.set(id, entry);
		if (entry.isDefault && !defaultsByType[type]) defaultsByType[type] = id;
	}
	return {
		defaults,
		byId,
		defaultsByType
	};
}
function styleChain(styles, styleId) {
	const chain = [];
	const seen = /* @__PURE__ */ new Set();
	let current = styleId;
	while (current && styles.byId.has(current) && !seen.has(current)) {
		seen.add(current);
		const style = styles.byId.get(current);
		chain.push(style);
		current = style.basedOn;
	}
	return chain.reverse();
}
function mergedParagraphStyles(styles, styleId) {
	const chain = [];
	const seen = /* @__PURE__ */ new Set();
	const candidates = [...styleChain(styles, styles.defaultsByType.paragraph), ...styleId ? styleChain(styles, styleId) : []];
	for (const style of candidates) {
		if (seen.has(style.id)) continue;
		seen.add(style.id);
		chain.push(style);
	}
	return chain;
}
/**
* 解析一个 `w:p`。
*
* 返回 `{ props, styleChain }` —— 后一项要给这一段里的 run 用（段落样式里的 rPr
* 会作用到所有 run）。
*/
function resolveParagraph(pElement, styles) {
	const direct = parseParagraphProps(child(pElement, "pPr"));
	const chain = mergedParagraphStyles(styles, direct.styleId);
	const props = mergeParagraphProps({}, styles.defaults.pPr);
	for (const style of chain) mergeParagraphProps(props, style.pPr);
	mergeParagraphProps(props, direct);
	return {
		props,
		styleChain: chain
	};
}
/** 解析一个 `w:r`。`paragraphStyleChain` 来自 `resolveParagraph`。 */
function resolveRun(rElement, paragraphStyleChain, styles) {
	const direct = parseRunProps(child(rElement, "rPr"));
	const props = mergeRunProps({}, styles.defaults.rPr);
	for (const style of paragraphStyleChain) mergeRunProps(props, style.rPr);
	const characterStyleId = direct.styleId ?? styles.defaultsByType.character;
	for (const style of styleChain(styles, characterStyleId)) mergeRunProps(props, style.rPr);
	mergeRunProps(props, direct);
	return props;
}
/** 没有 run 的段落（或编号标签）用的基础字符属性。 */
function defaultRunProps(styles, paragraphStyleChain) {
	const props = mergeRunProps({}, styles.defaults.rPr);
	for (const style of paragraphStyleChain) mergeRunProps(props, style.rPr);
	for (const style of styleChain(styles, styles.defaultsByType.character)) mergeRunProps(props, style.rPr);
	return props;
}
//#endregion
//#region src/docx/section.js
/**
* 页面设置与全局设置。
*
* M1 只取**最后一个 sectPr**（绝大多数文档只有一个节）。分节符、分栏、页眉页脚
* 的位置先留着，等分页引擎稳定后再接。
*/
const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;
function lastSectionElement(bodyElement) {
	const direct = children(bodyElement, "sectPr");
	if (direct.length > 0) return direct[direct.length - 1];
	let found = null;
	for (const paragraph of children(bodyElement, "p")) {
		const section = child(child(paragraph, "pPr"), "sectPr");
		if (section) found = section;
	}
	return found;
}
function parseSection(bodyElement) {
	const sectPr = lastSectionElement(bodyElement);
	const pageSize = child(sectPr, "pgSz");
	const margins = child(sectPr, "pgMar");
	const columns = child(sectPr, "cols");
	const grid = child(sectPr, "docGrid");
	let widthTwips = numAttr(pageSize, "w", A4_WIDTH_TWIPS) ?? A4_WIDTH_TWIPS;
	let heightTwips = numAttr(pageSize, "h", A4_HEIGHT_TWIPS) ?? A4_HEIGHT_TWIPS;
	if (attr(pageSize, "orient") === "landscape" && widthTwips < heightTwips) [widthTwips, heightTwips] = [heightTwips, widthTwips];
	const margin = {
		top: twipsToPx(numAttr(margins, "top", 1440)),
		right: twipsToPx(numAttr(margins, "right", 1800)),
		bottom: twipsToPx(numAttr(margins, "bottom", 1440)),
		left: twipsToPx(numAttr(margins, "left", 1800)),
		header: twipsToPx(numAttr(margins, "header", 851)),
		footer: twipsToPx(numAttr(margins, "footer", 992)),
		gutter: twipsToPx(numAttr(margins, "gutter", 0))
	};
	const pageWidth = twipsToPx(widthTwips);
	const pageHeight = twipsToPx(heightTwips);
	const columnCount = Math.max(1, numAttr(columns, "num", 1) ?? 1);
	const columnSpace = twipsToPx(numAttr(columns, "space", 425));
	const contentWidth = pageWidth - margin.left - margin.right - margin.gutter;
	return {
		pageWidth,
		pageHeight,
		margin,
		contentWidth: columnCount > 1 ? (contentWidth - columnSpace * (columnCount - 1)) / columnCount : contentWidth,
		contentHeight: pageHeight - margin.top - margin.bottom,
		columns: {
			count: columnCount,
			space: columnSpace
		},
		docGrid: {
			type: attr(grid, "type") ?? "default",
			linePitch: twipsToPx(numAttr(grid, "linePitch", 312)),
			charSpace: numAttr(grid, "charSpace", 0) ?? 0,
			snapsLines: attr(grid, "type") === "lines" || attr(grid, "type") === "linesAndChars"
		}
	};
}
function parseSettings(settingsDocument) {
	if (!settingsDocument) return { defaultTabStop: twipsToPx(420) };
	const root = settingsDocument.documentElement;
	return {
		defaultTabStop: twipsToPx(numAttr(child(root, "defaultTabStop"), "val", 420)),
		characterSpacingControl: val(child(root, "characterSpacingControl"))
	};
}
//#endregion
//#region src/docx/theme.js
/**
* `word/theme/theme1.xml` 的字体方案。
*
* 文档里的 `w:rFonts` 经常不写具体字体，而是写 `w:asciiTheme="minorHAnsi"` /
* `w:eastAsiaTheme="minorEastAsia"`。真正用哪套字体由主题决定 —— 不解析这个文件，
* 中文文档很容易全部掉回默认字体。
*/
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const FALLBACK = {
	major: {
		latin: "Calibri Light",
		eastAsia: "宋体",
		cs: "Arial"
	},
	minor: {
		latin: "Calibri",
		eastAsia: "宋体",
		cs: "Arial"
	}
};
function typefaceOf(element) {
	if (!element) return "";
	return (element.getAttribute("typeface") ?? "").trim();
}
function easternTypeface(fontElement, fallback) {
	if (!fontElement) return fallback;
	const direct = typefaceOf(firstDescendant(fontElement, "ea", A_NS));
	if (direct) return direct;
	const fonts = allDescendants(fontElement, "font", A_NS);
	for (const script of [
		"Hans",
		"Hant",
		"Jpan",
		"Hang"
	]) {
		const value = typefaceOf(fonts.find((element) => element.getAttribute("script") === script));
		if (value) return value;
	}
	return fallback;
}
function readFont(fontElement, fallback) {
	if (!fontElement) return fallback;
	return {
		latin: typefaceOf(firstDescendant(fontElement, "latin", A_NS)) || fallback.latin,
		eastAsia: easternTypeface(fontElement, fallback.eastAsia),
		cs: typefaceOf(firstDescendant(fontElement, "cs", A_NS)) || fallback.cs
	};
}
function parseTheme(themeDocument) {
	if (!themeDocument) return FALLBACK;
	const fontScheme = firstDescendant(themeDocument.documentElement, "fontScheme");
	if (!fontScheme) return FALLBACK;
	return {
		major: readFont(firstDescendant(fontScheme, "majorFont"), FALLBACK.major),
		minor: readFont(firstDescendant(fontScheme, "minorFont"), FALLBACK.minor)
	};
}
/** `w:asciiTheme="minorHAnsi"` → 主题里对应的字体名。 */
function resolveThemeFont(theme, key) {
	if (!key) return null;
	const value = String(key).toLowerCase();
	if (value.includes("eastasia")) return value.startsWith("major") ? theme.major.eastAsia : theme.minor.eastAsia;
	if (value.includes("bidi")) return value.startsWith("major") ? theme.major.cs : theme.minor.cs;
	return value.startsWith("major") ? theme.major.latin : theme.minor.latin;
}
//#endregion
//#region src/docx/parse.js
/**
* DOCX → 渲染用的文档模型。
*
* 输出尽量「扁」：
*
*   blocks: [{ kind: "paragraph", props, items, numbering, ... }]
*   items:  [{ kind: "text" | "tab" | "lineBreak" | "pageBreak" | "image", ... }]
*
* 排版引擎只需要认识 `items`，不需要再碰 OOXML。编辑层以后会在这之上加一层
* 「段落 / run ↔ 原 XML 节点」的指针，所以这里保留 `block.node` 与 `run.node`。
*/
const HIGHLIGHT_COLORS = {
	black: "#000000",
	blue: "#0000ff",
	cyan: "#00ffff",
	green: "#00ff00",
	magenta: "#ff00ff",
	red: "#ff0000",
	yellow: "#ffff00",
	white: "#ffffff",
	darkBlue: "#000080",
	darkCyan: "#008080",
	darkGreen: "#008000",
	darkMagenta: "#800080",
	darkRed: "#800000",
	darkYellow: "#808000",
	darkGray: "#808080",
	lightGray: "#c0c0c0"
};
const IMAGE_TYPES = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp",
	svg: "image/svg+xml",
	tif: "image/tiff",
	tiff: "image/tiff"
};
function normalizeColor(value) {
	if (!value || value === "auto") return null;
	const match = /^([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value);
	return match ? `#${match[1].toLowerCase()}` : null;
}
function effectiveRunStyle(props, theme) {
	const fonts = props.fonts ?? {};
	const latin = fonts.ascii ?? resolveThemeFont(theme, fonts.asciiTheme) ?? fonts.hAnsi ?? resolveThemeFont(theme, fonts.hAnsiTheme) ?? theme.minor.latin;
	const eastAsia = fonts.eastAsia ?? resolveThemeFont(theme, fonts.eastAsiaTheme) ?? theme.minor.eastAsia;
	return {
		fontLatin: latin || "Calibri",
		fontEastAsia: eastAsia || "宋体",
		sizePx: halfPointsToPx(props.size ?? 21),
		bold: props.bold === true,
		italic: props.italic === true,
		underline: Boolean(props.underline) && props.underline !== "none",
		underlineStyle: props.underline ?? null,
		strike: props.strike === true,
		doubleStrike: props.doubleStrike === true,
		color: normalizeColor(props.color),
		background: props.highlight ? HIGHLIGHT_COLORS[props.highlight] ?? null : normalizeColor(props.shading),
		vertAlign: props.vertAlign ?? null,
		letterSpacingPx: twipsToPx(props.spacing ?? 0),
		caps: props.caps === true,
		smallCaps: props.smallCaps === true,
		lang: props.lang ?? null
	};
}
/**
* 文本 item 的来源信息。
*
* `node` / `runNode` 是编辑层写回 XML 的锚点；`nested` 表示这个 run 不直接挂在段落上
* （超链接、修订、sdt 里），结构性分段/合并要绕开它。`editable:false` 的是合成内容
* （编号、符号、表格拍平行）或图片，光标不能落进去、保存也不会写回。
*/
function sourceOf(node, runNode, nested, extra = {}) {
	return {
		node,
		runNode,
		nested,
		editable: true,
		synthetic: null,
		...extra
	};
}
function textItem(text, style, source = {}) {
	return text ? {
		kind: "text",
		text,
		style,
		...source
	} : null;
}
function resolveTarget(baseDir, target) {
	if (/^[a-z]+:/i.test(target)) return null;
	const parts = `${baseDir}/${target}`.split("/");
	const stack = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return stack.join("/");
}
function parseRelationships(relationshipDocument) {
	const map = /* @__PURE__ */ new Map();
	if (!relationshipDocument) return map;
	const root = relationshipDocument.documentElement;
	for (const element of root.children) {
		if (element.localName !== "Relationship") continue;
		const id = element.getAttribute("Id");
		const target = element.getAttribute("Target");
		if (!id || !target) continue;
		map.set(id, {
			target,
			type: element.getAttribute("Type") ?? "",
			external: element.getAttribute("TargetMode") === "External"
		});
	}
	return map;
}
function parseStyleValue(value) {
	const match = /^\s*([\d.]+)\s*(pt|px|in|cm|mm)?\s*$/i.exec(value ?? "");
	if (!match) return 0;
	const number = Number(match[1]);
	switch ((match[2] ?? "px").toLowerCase()) {
		case "pt": return number * 4 / 3;
		case "in": return number * 96;
		case "cm": return number * 96 / 2.54;
		case "mm": return number * 96 / 25.4;
		default: return number;
	}
}
function vmlSize(shape) {
	const style = shape?.getAttribute("style") ?? "";
	const width = /(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style)?.[1];
	const height = /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(style)?.[1];
	return {
		width: parseStyleValue(width),
		height: parseStyleValue(height)
	};
}
function arrayBufferToBase64(bytes) {
	let binary = "";
	const chunk = 32768;
	for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	return btoa(binary);
}
async function loadImage(context, relationshipId) {
	const relationship = context.relationships.get(relationshipId);
	if (!relationship || relationship.external) return null;
	const path = resolveTarget("word", relationship.target);
	if (!path) return null;
	if (context.imageCache.has(path)) return context.imageCache.get(path);
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	const mime = IMAGE_TYPES[extension];
	if (!mime || !context.zip.has(path)) {
		const missing = {
			src: null,
			label: `[${extension ? extension.toUpperCase() : "图片"}]`
		};
		context.imageCache.set(path, missing);
		return missing;
	}
	try {
		const result = {
			src: `data:${mime};base64,${arrayBufferToBase64(await context.zip.read(path))}`,
			label: null
		};
		context.imageCache.set(path, result);
		return result;
	} catch (error) {
		context.warnings.push(`图片 ${path} 读取失败：${error?.message ?? error}`);
		const failed = {
			src: null,
			label: "[图片读取失败]"
		};
		context.imageCache.set(path, failed);
		return failed;
	}
}
async function parseImage(element, style, context) {
	let relationshipId = null;
	let width = 0;
	let height = 0;
	let alt = "";
	let anchor = null;
	if (element.localName === "drawing") {
		const extent = firstDescendant(element, "extent", WP_NS);
		width = extent ? Number(extent.getAttribute("cx") ?? 0) / 9525 : 0;
		height = extent ? Number(extent.getAttribute("cy") ?? 0) / 9525 : 0;
		relationshipId = firstDescendant(element, "blip", "http://schemas.openxmlformats.org/drawingml/2006/main")?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? null;
		const docPr = firstDescendant(element, "docPr", WP_NS);
		alt = docPr?.getAttribute("descr") || docPr?.getAttribute("title") || "";
		const anchorElement = firstDescendant(element, "anchor", WP_NS);
		if (anchorElement) {
			const offset = (name) => {
				const position = firstDescendant(anchorElement, name, WP_NS);
				const value = firstDescendant(position, "posOffset", WP_NS);
				return {
					value: value ? Number(value.textContent ?? 0) / 9525 : 0,
					relativeFrom: position?.getAttribute("relativeFrom") ?? ""
				};
			};
			const horizontal = offset("positionH");
			const vertical = offset("positionV");
			const wrap = [
				"wrapNone",
				"wrapSquare",
				"wrapTight",
				"wrapThrough",
				"wrapTopAndBottom"
			].find((name) => firstDescendant(anchorElement, name, "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing")) ?? "wrapNone";
			anchor = {
				x: horizontal.value,
				y: vertical.value,
				relativeH: horizontal.relativeFrom,
				relativeV: vertical.relativeFrom,
				behindDoc: anchorElement.getAttribute("behindDoc") === "1",
				wrap
			};
		}
	} else if (element.localName === "pict") {
		const size = vmlSize(firstDescendant(element, "shape", V_NS));
		width = size.width;
		height = size.height;
		const imageData = firstDescendant(element, "imagedata", V_NS);
		relationshipId = imageData?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? null;
		alt = imageData?.getAttribute("alt") ?? "";
	}
	if (!relationshipId) return null;
	const image = await loadImage(context, relationshipId);
	if (!image) return null;
	return {
		kind: "image",
		src: image.src,
		label: image.label,
		alt,
		width: width > 0 ? width : 240,
		height: height > 0 ? height : 180,
		anchor,
		style
	};
}
async function parseRun(runElement, context, paragraphStyleChain, paragraphElement) {
	const style = effectiveRunStyle(resolveRun(runElement, paragraphStyleChain, context.styles), context.theme);
	const items = [];
	const nested = runElement.parentElement !== paragraphElement;
	const source = (node, extra) => sourceOf(node, runElement, nested, extra);
	for (const element of runElement.children) switch (element.localName) {
		case "t": {
			const item = textItem(element.textContent ?? "", style, source(element));
			if (item) items.push(item);
			break;
		}
		case "tab":
			items.push({
				kind: "tab",
				style,
				...source(element)
			});
			break;
		case "br": {
			const type = attr(element, "type");
			items.push({
				kind: type === "page" ? "pageBreak" : "lineBreak",
				...source(element)
			});
			break;
		}
		case "cr":
			items.push({
				kind: "lineBreak",
				...source(element)
			});
			break;
		case "noBreakHyphen":
			items.push({
				kind: "text",
				text: "‑",
				style,
				...source(element, {
					editable: false,
					synthetic: "symbol"
				})
			});
			break;
		case "softHyphen":
			items.push({
				kind: "text",
				text: "­",
				style,
				...source(element, {
					editable: false,
					synthetic: "symbol"
				})
			});
			break;
		case "sym": {
			const code = attr(element, "char");
			if (code) {
				const font = attr(element, "font");
				items.push({
					kind: "text",
					text: String.fromCharCode(Number.parseInt(code, 16)),
					style: font ? {
						...style,
						fontLatin: font,
						fontEastAsia: font
					} : style,
					...source(element, {
						editable: false,
						synthetic: "symbol"
					})
				});
			}
			break;
		}
		case "drawing":
		case "pict": {
			const image = await parseImage(element, style, context);
			if (image) items.push({
				...image,
				...source(element, { editable: false })
			});
			break;
		}
		case "instrText":
		case "delText":
		case "fldChar":
		case "lastRenderedPageBreak":
		case "footnoteReference":
		case "endnoteReference":
		case "commentReference": break;
		default: break;
	}
	return items;
}
async function parseParagraphItems(paragraphElement, context, paragraphStyleChain) {
	const items = [];
	const visit = async (element) => {
		for (const node of element.children) {
			if (node.namespaceURI !== "http://schemas.openxmlformats.org/wordprocessingml/2006/main") continue;
			switch (node.localName) {
				case "pPr":
				case "bookmarkStart":
				case "bookmarkEnd":
				case "proofErr":
				case "commentRangeStart":
				case "commentRangeEnd":
				case "commentReference": break;
				case "r":
					items.push(...await parseRun(node, context, paragraphStyleChain, paragraphElement));
					break;
				case "hyperlink":
				case "fldSimple":
				case "ins":
				case "smartTag":
				case "customXml":
					await visit(node);
					break;
				case "sdt":
					await visit(child(node, "sdtContent") ?? node);
					break;
				case "del": break;
				case "drawing":
				case "pict": {
					const image = await parseImage(node, null, context);
					if (image) items.push(image);
					break;
				}
				default: break;
			}
		}
	};
	await visit(paragraphElement);
	return items;
}
function collectPlainText(element) {
	let text = "";
	for (const node of element.getElementsByTagName("*")) {
		if (node.namespaceURI !== "http://schemas.openxmlformats.org/wordprocessingml/2006/main") continue;
		if (node.localName === "t") text += node.textContent ?? "";
		else if (node.localName === "tab") text += "	";
		else if (node.localName === "br" || node.localName === "cr") text += "\n";
	}
	return text;
}
function borderFrom(element) {
	if (!element) return null;
	const style = attr(element, "val") ?? "single";
	if (style === "nil" || style === "none") return {
		style: "none",
		widthPx: 0
	};
	return {
		style: "single",
		widthPx: (numAttr(element, "sz", 4) ?? 4) / 8 * (4 / 3),
		color: attr(element, "color") ?? "000000"
	};
}
function parseBorders(container) {
	if (!container) return null;
	const edges = [
		"top",
		"left",
		"bottom",
		"right",
		"insideH",
		"insideV"
	];
	const out = {};
	for (const edge of edges) {
		const border = borderFrom(child(container, edge));
		if (border) out[edge] = border;
	}
	return Object.keys(out).length > 0 ? out : null;
}
function parseTableWidth(tblPr, contentWidth, gridWidths) {
	const widthElement = child(tblPr, "tblW");
	const type = attr(widthElement, "type") ?? "auto";
	const value = numAttr(widthElement, "w", 0) ?? 0;
	if (type === "pct") return contentWidth * value / 5e3;
	if (type === "dxa" && value > 0) return twipsToPx(value);
	const sum = gridWidths.reduce((total, width) => total + width, 0);
	return sum > 0 ? sum : contentWidth;
}
function parseCellMargins(tblPr) {
	const margins = child(tblPr, "tblCellMar");
	const margin = {
		left: 108,
		right: 108,
		top: 0,
		bottom: 0
	};
	if (!margins) return {
		...margin,
		left: twipsToPx(108),
		right: twipsToPx(108)
	};
	for (const edge of [
		"left",
		"right",
		"top",
		"bottom"
	]) {
		const element = child(margins, edge);
		if (element) margin[edge] = numAttr(element, "w", 108) ?? 108;
	}
	return {
		left: twipsToPx(margin.left),
		right: twipsToPx(margin.right),
		top: twipsToPx(margin.top),
		bottom: twipsToPx(margin.bottom)
	};
}
/** 解析表格；单元格里的段落仍走完整的段落解析（字体 / 编号 / 图片）。 */
async function parseTable(tableElement, context, paragraphIndex, contentWidth) {
	const tblPr = child(tableElement, "tblPr");
	const gridWidths = children(child(tableElement, "tblGrid"), "gridCol").map((column) => twipsToPx(numAttr(column, "w", 0) ?? 0));
	let tableWidth = parseTableWidth(tblPr, contentWidth, gridWidths);
	if (gridWidths.length === 0) {
		const columnCount = Math.max(1, ...children(tableElement, "tr").map((row) => children(row, "tc").reduce((sum, cell) => sum + (numAttr(child(child(cell, "tcPr"), "gridSpan"), "val", 1) ?? 1), 0)));
		tableWidth = tableWidth > 0 ? tableWidth : contentWidth;
		gridWidths.push(...Array.from({ length: columnCount }, () => tableWidth / columnCount));
	}
	const gridSum = gridWidths.reduce((sum, width) => sum + width, 0);
	if (!(tableWidth > 0)) tableWidth = gridSum;
	const scale = gridSum > 0 ? tableWidth / gridSum : 1;
	const columnWidths = gridWidths.map((width) => width * scale);
	const alignment = attr(child(tblPr, "jc"), "val") ?? "left";
	const tableBorders = parseBorders(child(tblPr, "tblBorders"));
	const styleId = attr(child(tblPr, "tblStyle"), "val") ?? "";
	const borders = tableBorders ?? (/TableGrid/i.test(styleId) ? {
		top: {
			style: "single",
			widthPx: .5,
			color: "000000"
		},
		left: {
			style: "single",
			widthPx: .5,
			color: "000000"
		},
		bottom: {
			style: "single",
			widthPx: .5,
			color: "000000"
		},
		right: {
			style: "single",
			widthPx: .5,
			color: "000000"
		},
		insideH: {
			style: "single",
			widthPx: .5,
			color: "000000"
		},
		insideV: {
			style: "single",
			widthPx: .5,
			color: "000000"
		}
	} : null);
	const cellMargins = parseCellMargins(tblPr);
	const rows = [];
	let cellParagraphIndex = 0;
	for (const [rowIndex, rowElement] of children(tableElement, "tr").entries()) {
		const trPr = child(rowElement, "trPr");
		const cantSplitElement = trPr ? child(trPr, "cantSplit") : null;
		const row = {
			index: rowIndex,
			cantSplit: Boolean(cantSplitElement) && attr(cantSplitElement, "val") !== "0",
			tableHeader: Boolean(trPr ? child(trPr, "tblHeader") : null),
			height: null,
			heightRule: null,
			cells: []
		};
		const heightElement = child(trPr, "trHeight");
		if (heightElement) {
			row.height = twipsToPx(numAttr(heightElement, "val", 0) ?? 0);
			row.heightRule = attr(heightElement, "hRule") ?? "atLeast";
		}
		let gridColumn = 0;
		for (const cellElement of children(rowElement, "tc")) {
			const tcPr = child(cellElement, "tcPr");
			const span = Math.max(1, numAttr(child(tcPr, "gridSpan"), "val", 1) ?? 1);
			const vMergeElement = child(tcPr, "vMerge");
			const vMerge = vMergeElement ? attr(vMergeElement, "val") === "restart" ? "restart" : "continue" : null;
			if (gridColumn >= columnWidths.length) {
				context.warnings.push("表格行里的单元格数超过了 tblGrid，多出的单元格已忽略。");
				continue;
			}
			const tcWidthElement = child(tcPr, "tcW");
			const tcWidth = numAttr(tcWidthElement, "w", 0) ?? 0;
			const cellWidth = tcWidth > 0 && attr(tcWidthElement, "type") !== "pct" ? twipsToPx(tcWidth) : columnWidths.slice(gridColumn, gridColumn + span).reduce((sum, width) => sum + width, 0);
			const paragraphs = [];
			for (const contentElement of cellElement.children) {
				if (contentElement.namespaceURI !== "http://schemas.openxmlformats.org/wordprocessingml/2006/main") continue;
				if (contentElement.localName === "p") {
					paragraphs.push(await parseParagraphElement(contentElement, context, cellParagraphIndex, `t${paragraphIndex}r${rowIndex}c${gridColumn}p${paragraphs.length}`));
					cellParagraphIndex += 1;
				} else if (contentElement.localName === "tbl") {
					context.warnings.push("单元格里的嵌套表格暂时按行拍平成文本。");
					const style = effectiveRunStyle({}, context.theme);
					for (const nestedRow of children(contentElement, "tr")) {
						const text = children(nestedRow, "tc").map((nestedCell) => children(nestedCell, "p").map(collectPlainText).join(" ").trim()).filter(Boolean).join("  |  ");
						if (!text) continue;
						const props = {
							jc: "left",
							spacing: {
								line: 240,
								lineRule: "auto"
							}
						};
						paragraphs.push({
							kind: "paragraph",
							index: cellParagraphIndex,
							key: `t${paragraphIndex}r${rowIndex}c${gridColumn}n${paragraphs.length}`,
							props,
							propsBase: props,
							items: [{
								kind: "text",
								text,
								style
							}],
							labelItems: [],
							defaultStyle: style,
							numbering: null,
							outlineLevel: null,
							node: nestedRow,
							editable: false,
							synthetic: "nested-table"
						});
						cellParagraphIndex += 1;
					}
				}
			}
			const cellBorders = parseBorders(child(tcPr, "tcBorders"));
			const margins = { ...cellMargins };
			const cellMarginElement = child(tcPr, "tcMar");
			if (cellMarginElement) for (const edge of [
				"left",
				"right",
				"top",
				"bottom"
			]) {
				const element = child(cellMarginElement, edge);
				if (element) margins[edge] = twipsToPx(numAttr(element, "w", 108) ?? 108);
			}
			row.cells.push({
				gridColumn,
				span,
				vMerge,
				width: cellWidth,
				blocks: paragraphs,
				fill: attr(child(tcPr, "shd"), "fill") ?? null,
				verticalAlign: attr(child(tcPr, "vAlign"), "val") ?? "top",
				borders: cellBorders,
				margins
			});
			gridColumn += span;
		}
		rows.push(row);
	}
	for (const row of rows) {
		const sum = row.cells.reduce((total, cell) => total + cell.width, 0);
		if (!(sum > 0) || Math.abs(sum - tableWidth) <= .5) continue;
		const factor = tableWidth / sum;
		for (const cell of row.cells) cell.width *= factor;
	}
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) for (const cell of rows[rowIndex].cells) {
		if (cell.vMerge !== "restart") continue;
		cell.rowSpan = 1;
		for (let nextIndex = rowIndex + 1; nextIndex < rows.length; nextIndex += 1) {
			const target = rows[nextIndex].cells.find((candidate) => candidate.gridColumn === cell.gridColumn);
			if (!target || target.vMerge !== "continue") break;
			target.continuation = true;
			cell.rowSpan += 1;
		}
	}
	return {
		kind: "table",
		index: paragraphIndex,
		key: `t${paragraphIndex}`,
		rows,
		props: {
			width: tableWidth,
			alignment,
			columnWidths,
			cellMargins,
			borders,
			styleId
		},
		node: tableElement,
		editable: false,
		synthetic: null
	};
}
function mergeNumberingIndent(props, level) {
	const source = level?.pPr?.ind;
	if (!source) return props;
	const target = { ...props.ind };
	for (const key of [
		"left",
		"right",
		"firstLine",
		"hanging",
		"leftChars",
		"rightChars",
		"firstLineChars",
		"hangingChars"
	]) if (target[key] === void 0 && source[key] !== void 0) target[key] = source[key];
	return {
		...props,
		ind: target
	};
}
/**
* 解析一个 `w:p`。编号标签**不在这里生成** —— 它依赖文档顺序上的计数器，
* 单段重解析时算不准；统一交给 `refreshNumbering(doc)`。
*/
async function parseParagraphElement(paragraphElement, context, index, key) {
	const resolved = resolveParagraph(paragraphElement, context.styles);
	const baseProps = resolved.props;
	return {
		kind: "paragraph",
		index,
		key,
		props: baseProps,
		propsBase: baseProps,
		items: await parseParagraphItems(paragraphElement, context, resolved.styleChain),
		labelItems: [],
		defaultStyle: effectiveRunStyle(defaultRunProps(context.styles, resolved.styleChain), context.theme),
		numbering: null,
		outlineLevel: baseProps.outlineLvl ?? null,
		node: paragraphElement,
		styleChain: resolved.styleChain,
		editable: true,
		synthetic: null
	};
}
/**
* 按文档顺序重建所有编号标签与编号带来的缩进。
*
* 编号文字只存在于 `block.labelItems`，永远不写进 `items` / XML；分段、合并、撤销之后
* 调一次即可，不必重解析整篇文档。
*/
function refreshNumbering(doc) {
	const state = { counters: /* @__PURE__ */ new Map() };
	for (const block of doc.blocks) {
		block.labelItems = [];
		block.numbering = null;
		if (block.propsBase) block.props = block.propsBase;
		const numPr = block.propsBase?.numPr;
		if (!numPr || block.editable === false) continue;
		const numbering = nextNumberingLabel(state, doc.numbering, numPr);
		if (!numbering) continue;
		block.props = mergeNumberingIndent(block.propsBase, numbering.level);
		const labelProps = defaultRunProps(doc.styles, block.styleChain ?? []);
		const labelStyle = effectiveRunStyle({
			...labelProps,
			...numbering.level?.rPr,
			fonts: {
				...labelProps.fonts,
				...numbering.level?.rPr?.fonts
			}
		}, doc.theme);
		const suffix = numberingSuffix(numbering.suffix);
		const prefix = [];
		const source = {
			node: null,
			runNode: null,
			nested: false,
			editable: false,
			synthetic: "numbering"
		};
		if (numbering.text) prefix.push({
			kind: "text",
			text: numbering.text,
			style: labelStyle,
			...source
		});
		if (suffix === "	") prefix.push({
			kind: "tab",
			style: labelStyle,
			...source
		});
		else if (suffix) prefix.push({
			kind: "text",
			text: suffix,
			style: labelStyle,
			...source
		});
		block.labelItems = prefix;
		block.numbering = {
			text: numbering.text,
			suffix: numbering.suffix
		};
		block.outlineLevel = block.props.outlineLvl ?? null;
	}
}
/**
* 重新解析单个段落（XML 改完之后调）。
*
* 只替换这一块，不动其它块；编号与索引随后统一刷新。
*/
async function reparseBlock(doc, block) {
	if (!block?.node || block.node.localName !== "p") return block;
	const parsed = await parseParagraphElement(block.node, doc.source.context, block.index, block.key);
	parsed.editable = true;
	parsed.synthetic = null;
	if (block.container) {
		parsed.container = block.container;
		block.container.cell.blocks[block.container.index] = parsed;
	} else doc.blocks[block.index] = parsed;
	refreshNumbering(doc);
	rebuildBlockIndices(doc);
	return parsed;
}
/** 编辑后重算状态栏用的统计（表格数沿用解析时的值）。 */
function recountStats(doc) {
	const stats = {
		paragraphs: 0,
		runs: 0,
		tables: doc.blocks.filter((block) => block.kind === "table").length,
		images: 0,
		chars: 0
	};
	for (const block of doc.blocks) {
		if (block.synthetic || block.kind !== "paragraph") continue;
		stats.paragraphs += 1;
		for (const item of block.items ?? []) if (item.kind === "text") {
			stats.runs += 1;
			stats.chars += item.text.length;
		} else if (item.kind === "image") stats.images += 1;
	}
	doc.stats = stats;
	return stats;
}
/** 分段 / 合并之后重排 `index` 与 `keyToIndex`。 */
function rebuildBlockIndices(doc) {
	doc.keyToIndex = /* @__PURE__ */ new Map();
	doc.keyToBlock = /* @__PURE__ */ new Map();
	doc.keyOrder = /* @__PURE__ */ new Map();
	let order = 0;
	for (const [index, block] of doc.blocks.entries()) {
		block.index = index;
		if (block.key) {
			doc.keyToIndex.set(block.key, index);
			doc.keyToBlock.set(block.key, block);
		}
		if (block.kind !== "table") {
			if (block.key) doc.keyOrder.set(block.key, order++);
			continue;
		}
		for (const row of block.rows ?? []) for (const cell of row.cells ?? []) for (const [paragraphIndex, paragraph] of cell.blocks.entries()) {
			paragraph.index = paragraphIndex;
			paragraph.container = {
				table: block,
				row,
				cell,
				index: paragraphIndex
			};
			doc.keyToBlock.set(paragraph.key, paragraph);
			doc.keyOrder.set(paragraph.key, order);
			order += 1;
		}
	}
	return doc;
}
/** 遍历 `w:body` 生成段落 / 表格块；初次解析与撤销快照恢复共用。 */
async function buildBlocks(body, context, stats) {
	const blocks = [];
	const visitBody = async (parent) => {
		for (const element of parent.children) {
			if (element.namespaceURI !== "http://schemas.openxmlformats.org/wordprocessingml/2006/main") continue;
			if (element.localName === "p") {
				const paragraph = await parseParagraphElement(element, context, blocks.length, `p${blocks.length}`);
				blocks.push(paragraph);
				stats.paragraphs += 1;
				stats.runs += paragraph.items.filter((item) => item.kind === "text").length;
				stats.images += paragraph.items.filter((item) => item.kind === "image").length;
				stats.chars += paragraph.items.filter((item) => item.kind === "text").reduce((sum, item) => sum + item.text.length, 0);
			} else if (element.localName === "tbl") {
				stats.tables += 1;
				const table = await parseTable(element, context, blocks.length, context.section.contentWidth);
				for (const row of table.rows) for (const cell of row.cells) for (const [paragraphIndex, paragraph] of cell.blocks.entries()) {
					paragraph.index = paragraphIndex;
					paragraph.container = {
						table,
						row,
						cell,
						index: paragraphIndex
					};
					stats.paragraphs += 1;
					stats.chars += paragraph.items.filter((item) => item.kind === "text").reduce((sum, item) => sum + item.text.length, 0);
					stats.images += paragraph.items.filter((item) => item.kind === "image").length;
				}
				blocks.push(table);
			} else if (element.localName === "sdt") await visitBody(child(element, "sdtContent") ?? element);
			else if (element.localName === "customXml" || element.localName === "altChunk") if (element.localName === "customXml") await visitBody(element);
			else context.warnings.push("M1 不处理 altChunk（外部嵌入内容）。");
		}
	};
	await visitBody(body);
	if (blocks.length === 0) blocks.push({
		kind: "paragraph",
		index: 0,
		key: "p0",
		props: {},
		propsBase: {},
		items: [],
		labelItems: [],
		defaultStyle: effectiveRunStyle({}, context.theme),
		numbering: null,
		outlineLevel: null,
		node: body,
		editable: false,
		synthetic: "empty-body"
	});
	return blocks;
}
/**
* 用一份新的 `document.xml` 重建整篇 IR。
*
* 撤销 / 重做用整份 XML 快照（第一版实现）；block key 按文档顺序重新分配，
* 所以历史里记录的光标用「段落序号 + 文本偏移」，不能用 key。
*/
async function replaceDocumentXml(doc, xmlText) {
	const documentXml = parseXml(xmlText, "word/document.xml");
	const body = child(documentXml.documentElement, "body");
	if (!body) throw new Error("快照里没有 w:body。");
	doc.source.documentXml = documentXml;
	doc.source.body = body;
	doc.source.context.warnings = [];
	const stats = {
		paragraphs: 0,
		runs: 0,
		tables: 0,
		images: 0,
		chars: 0
	};
	doc.blocks = await buildBlocks(body, doc.source.context, stats);
	doc.stats = stats;
	doc.nextKey = doc.blocks.length;
	refreshNumbering(doc);
	rebuildBlockIndices(doc);
	return doc;
}
async function parseDocx(bytes) {
	const zip = new ZipArchive(bytes);
	const documentXmlText = await zip.text("word/document.xml");
	const declaration = /^\s*(<\?xml[^>]*\?>)/.exec(documentXmlText)?.[1] ?? "";
	const documentXml = parseXml(documentXmlText, "word/document.xml");
	const stylesXml = await zip.textOrNull("word/styles.xml");
	const themeXml = await zip.textOrNull("word/theme/theme1.xml");
	const settingsXml = await zip.textOrNull("word/settings.xml");
	const numberingXml = await zip.textOrNull("word/numbering.xml");
	const relationshipsXml = await zip.textOrNull("word/_rels/document.xml.rels");
	const styles = parseStyles(stylesXml ? parseXml(stylesXml, "word/styles.xml") : null);
	const theme = parseTheme(themeXml ? parseXml(themeXml, "word/theme/theme1.xml") : null);
	const settings = parseSettings(settingsXml ? parseXml(settingsXml, "word/settings.xml") : null);
	const numbering = parseNumbering(numberingXml ? parseXml(numberingXml, "word/numbering.xml") : null);
	const relationships = parseRelationships(relationshipsXml ? parseXml(relationshipsXml, "word/_rels/document.xml.rels") : null);
	const body = child(documentXml.documentElement, "body");
	if (!body) throw new Error("这份 DOCX 没有 w:body。");
	const context = {
		zip,
		styles,
		theme,
		settings,
		numbering,
		relationships,
		section: parseSection(body),
		warnings: [],
		imageCache: /* @__PURE__ */ new Map()
	};
	const stats = {
		paragraphs: 0,
		runs: 0,
		tables: 0,
		images: 0,
		chars: 0
	};
	const blocks = await buildBlocks(body, context, stats);
	const doc = {
		blocks,
		section: context.section,
		settings: context.settings,
		theme,
		styles,
		numbering,
		warnings: [...new Set(context.warnings)],
		stats,
		source: {
			zip,
			documentXml,
			body,
			context,
			declaration
		},
		keyToIndex: /* @__PURE__ */ new Map(),
		nextKey: blocks.length
	};
	refreshNumbering(doc);
	rebuildBlockIndices(doc);
	return doc;
}
//#endregion
//#region src/docx/save.js
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
const DEFAULT_DECLARATION = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
const encoder = new TextEncoder();
/**
* 序列化 `word/document.xml`。
*
* XML 声明必须手动补：`XMLSerializer` 只输出根元素，而 OOXML 的声明里
* `standalone="yes"` 是规范的一部分。原始声明原样保留（大小写、引号、编码都不改），
* 没有就用默认值。输出不带 BOM。
*/
function serializeDocumentXml(doc) {
	const source = doc?.source;
	if (!source?.documentXml) throw new Error("文档没有可序列化的 word/document.xml。");
	let xml = typeof source.documentXml === "string" ? source.documentXml : new XMLSerializer().serializeToString(source.documentXml);
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
		localExtra: local.localExtra
	};
}
/** 换掉 `document.xml` 时，时间戳与属性沿用原条目；extra 不沿用（可能含旧大小）。 */
function replacedEntryMeta(entry) {
	if (!entry) return void 0;
	return {
		dosTime: entry.dosTime,
		dosDate: entry.dosDate,
		flags: entry.flags,
		versionMadeBy: entry.versionMadeBy,
		internalAttrs: entry.internalAttrs,
		externalAttrs: entry.externalAttrs
	};
}
/**
* 生成另存用的 DOCX 字节。
*
* `doc.source.zip` 可以是 `ZipArchive`，也可以是原始字节。未编辑时优先返回
* `doc.originalBytes`，其次 `doc.source.originalBytes`，保证与打开时逐字节一致。
*/
async function buildSavedDocx(doc) {
	const source = doc?.source ?? {};
	if (doc?.dirty !== true) {
		const original = doc?.originalBytes ?? source.originalBytes ?? (source.zip instanceof ZipArchive ? source.zip.bytes : source.zip);
		if (!original) throw new Error("没有原始文档字节，无法另存。");
		return original;
	}
	let zip;
	if (source.zip instanceof ZipArchive) zip = source.zip;
	else {
		const zipBytes = source.zip ?? source.originalBytes ?? doc?.originalBytes;
		if (!zipBytes) throw new Error("没有原始 ZIP 数据，无法另存。");
		zip = new ZipArchive(zipBytes);
	}
	const all = [...zip.entries, ...zip.directories ?? []].sort((a, b) => (a.centralIndex ?? 0) - (b.centralIndex ?? 0));
	const entries = [];
	let replaced = false;
	for (const entry of all) if (entry.name === "word/document.xml") {
		entries.push({
			name: entry.name,
			data: serializeDocumentXml(doc),
			meta: replacedEntryMeta(entry)
		});
		replaced = true;
	} else if (entry.name.endsWith("/")) entries.push({
		name: entry.name,
		raw: new Uint8Array(0),
		meta: rawEntryMeta(zip.bytes, entry)
	});
	else entries.push({
		name: entry.name,
		raw: readRawCompressed(zip.bytes, entry),
		meta: rawEntryMeta(zip.bytes, entry)
	});
	if (!replaced) entries.push({
		name: "word/document.xml",
		data: serializeDocumentXml(doc)
	});
	return writeZip(entries);
}
/** `报告.docx` → `报告-已编辑.docx`；空名字回退到 `文档-已编辑.docx`。 */
function savedFileName(name) {
	const base = (typeof name === "string" ? name : "").replace(/\.docx$/i, "");
	if (base.trim() === "") return "文档-已编辑.docx";
	return `${base}-已编辑.docx`;
}
function collectBodyParagraphs(body) {
	const paragraphs = [];
	const visit = (element) => {
		for (const node of element.children) {
			if (node.namespaceURI !== "http://schemas.openxmlformats.org/wordprocessingml/2006/main") continue;
			switch (node.localName) {
				case "p":
					paragraphs.push(node);
					break;
				case "tbl": break;
				case "sdt":
					visit(child(node, "sdtContent") ?? node);
					break;
				case "customXml":
					visit(node);
					break;
				default: break;
			}
		}
	};
	visit(body);
	return paragraphs;
}
/** 与 `parse.js` 的 `collectPlainText` 不同：这里只拼 `w:t`，用于保存后校验。 */
function paragraphText(paragraph) {
	let text = "";
	if (typeof paragraph?.getElementsByTagNameNS !== "function") throw new Error(`校验时拿到的不是元素：${Object.prototype.toString.call(paragraph)} local=${paragraph?.localName} nodeType=${paragraph?.nodeType} ctor=${paragraph?.constructor?.name}`);
	const nodes = paragraph.getElementsByTagNameNS(W_NS, "t");
	for (let index = 0; index < nodes.length; index += 1) text += nodes[index].textContent ?? "";
	return text;
}
function expectedParagraphs(doc) {
	return (Array.isArray(doc?.blocks) ? doc.blocks : []).filter((block) => block && !block.synthetic && block.kind === "paragraph" && block.node && block.node.namespaceURI === "http://schemas.openxmlformats.org/wordprocessingml/2006/main" && block.node.localName === "p").map((block) => block.node);
}
/**
* 保存后自检：重新打开写出的 ZIP，确认 `document.xml` 合法，
* 并且段落数与每段 `w:t` 文本和模型一致。任何异常都转成 `{ ok:false }`，不抛。
*/
async function verifySavedDocx(bytes, doc) {
	try {
		const zip = new ZipArchive(bytes);
		if (!zip.has("word/document.xml")) return {
			ok: false,
			message: "另存后的文档里没有 word/document.xml。"
		};
		const body = parseXml(await zip.text("word/document.xml"), "word/document.xml").getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "body")[0] ?? null;
		if (!body) return {
			ok: false,
			message: "另存后的 document.xml 没有 w:body。"
		};
		const actual = collectBodyParagraphs(body);
		const expected = expectedParagraphs(doc);
		if (actual.length !== expected.length) return {
			ok: false,
			message: `段落数不一致：期望 ${expected.length}，实际 ${actual.length}。`
		};
		for (let index = 0; index < expected.length; index += 1) {
			const expectedText = paragraphText(expected[index]);
			const actualText = paragraphText(actual[index]);
			if (expectedText !== actualText) return {
				ok: false,
				message: `第 ${index + 1} 段文字不一致：期望「${expectedText}」，实际「${actualText}」。`
			};
		}
		return {
			ok: true,
			message: `校验通过：${actual.length} 段。`
		};
	} catch (error) {
		return {
			ok: false,
			message: `校验失败：${error?.message ?? error}`,
			stack: error?.stack ?? null
		};
	}
}
//#endregion
//#region src/edit/source-map.js
/**
* 光标 / 选区 ↔ 段落 item 的换算。
*
* 光标形状是 `{ blockKey, itemIndex, offset }`：
*
* * `blockKey` 是段落稳定 id —— 分段、合并会让 `block.index` 变，key 不变；
* * `itemIndex` 是 `block.items` 的下标（编号标签在 `labelItems` 里，不参与）；
* * `offset` 是 item 文本内的**码点**偏移；制表符 / 换行 / 图片这类原子 item
*   只能落在它前面（`itemIndex,0`）或后面（`itemIndex+1,0`）。
*
* 这个模块不碰 DOM，可以在 Node 里单测。
*/
/** 一个 item 在“段落文本偏移”里占几个字符。 */
function itemLength(item) {
	if (!item) return 0;
	if (item.kind === "text") return Array.from(item.text ?? "").length;
	return 1;
}
function isEditableBlock(block) {
	return Boolean(block) && block.editable !== false && block.synthetic == null;
}
function blockByKey(doc, key) {
	if (!doc || !key) return null;
	const direct = doc.keyToBlock?.get(key);
	if (direct) return direct;
	const index = doc.keyToIndex?.get(key);
	if (index == null) return null;
	return doc.blocks[index] ?? null;
}
function blockStartCaret(block) {
	return {
		blockKey: block.key,
		itemIndex: 0,
		offset: 0
	};
}
function blockEndCaret(block) {
	const items = block.items ?? [];
	if (items.length === 0) return blockStartCaret(block);
	const last = items.length - 1;
	const item = items[last];
	if (item.kind === "text") return {
		blockKey: block.key,
		itemIndex: last,
		offset: Array.from(item.text ?? "").length
	};
	return {
		blockKey: block.key,
		itemIndex: last + 1,
		offset: 0
	};
}
/** 同一段内比较两个 item 位置。 */
function compareInBlock(a, b) {
	if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
	return (a.offset ?? 0) - (b.offset ?? 0);
}
function compareCaret(doc, a, b) {
	if (!a || !b) return 0;
	if (a.blockKey !== b.blockKey) return (doc.keyOrder?.get(a.blockKey) ?? doc.keyToIndex?.get(a.blockKey) ?? Number.MAX_SAFE_INTEGER) - (doc.keyOrder?.get(b.blockKey) ?? doc.keyToIndex?.get(b.blockKey) ?? Number.MAX_SAFE_INTEGER);
	return compareInBlock(a, b);
}
function selectionOrdered(doc, selection) {
	if (!selection?.anchor || !selection.focus) return null;
	const order = compareCaret(doc, selection.anchor, selection.focus);
	if (order <= 0) return {
		start: selection.anchor,
		end: selection.focus,
		collapsed: order === 0
	};
	return {
		start: selection.focus,
		end: selection.anchor,
		collapsed: false
	};
}
/** 段落纯文本偏移：itemLength 累加，文本 item 再加 offset。 */
function blockTextOffset(block, caret) {
	const items = block.items ?? [];
	const itemIndex = Math.max(0, Math.min(caret.itemIndex ?? 0, items.length));
	let offset = 0;
	for (let index = 0; index < itemIndex; index += 1) offset += itemLength(items[index]);
	if (items[itemIndex]?.kind === "text") offset += Math.max(0, caret.offset ?? 0);
	return offset;
}
/** 段落纯文本偏移 → 光标；用于重解析后把光标挪回原来的文字位置。 */
function blockOffsetCaret(block, offset) {
	const items = block.items ?? [];
	let remaining = Math.max(0, offset ?? 0);
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		const length = itemLength(item);
		if (remaining < length) {
			if (item.kind === "text") return {
				blockKey: block.key,
				itemIndex: index,
				offset: remaining
			};
			return {
				blockKey: block.key,
				itemIndex: index,
				offset: 0
			};
		}
		if (remaining === length) {
			if (item.kind === "text") return {
				blockKey: block.key,
				itemIndex: index,
				offset: length
			};
			return {
				blockKey: block.key,
				itemIndex: index + 1,
				offset: 0
			};
		}
		remaining -= length;
	}
	return blockEndCaret(block);
}
/** 找到 key 之后（dir=1）或之前（dir=-1）最近的可编辑段落。 */
function adjacentEditableBlock(doc, key, dir) {
	const current = blockByKey(doc, key);
	if (current?.container) {
		const { cell, index } = current.container;
		for (let cursor = index + dir; cursor >= 0 && cursor < cell.blocks.length; cursor += dir) {
			const block = cell.blocks[cursor];
			if (isEditableBlock(block)) return block;
		}
		return null;
	}
	const start = doc.keyToIndex?.get(key);
	if (start == null) return null;
	for (let index = start + dir; index >= 0 && index < doc.blocks.length; index += dir) {
		const block = doc.blocks[index];
		if (isEditableBlock(block)) return block;
	}
	return null;
}
/** 把可能越界 / 落在不可编辑 item 里的光标收回到合法位置。 */
function normalizeCaret(doc, caret) {
	if (!caret) return null;
	let block = blockByKey(doc, caret.blockKey);
	if (!block || !isEditableBlock(block)) {
		block = adjacentEditableBlock(doc, caret.blockKey, 1);
		if (!block) block = doc.blocks.find((candidate) => candidate.key) ?? null;
		if (!block) return null;
		return blockStartCaret(block);
	}
	const items = block.items ?? [];
	let itemIndex = Math.max(0, Math.min(caret.itemIndex ?? 0, items.length));
	let offset = Math.max(0, caret.offset ?? 0);
	if (itemIndex === items.length) return {
		blockKey: block.key,
		itemIndex,
		offset: 0
	};
	const item = items[itemIndex];
	if (item.kind === "text") {
		const length = Array.from(item.text ?? "").length;
		offset = Math.min(offset, length);
	} else if (offset > 0) {
		itemIndex += 1;
		offset = 0;
	}
	return {
		blockKey: block.key,
		itemIndex,
		offset
	};
}
/** 前一个 / 后一个光标位置（不处理上下行）。 */
function stepCaret(doc, caret, dir) {
	const normalized = normalizeCaret(doc, caret);
	if (!normalized) return null;
	const block = blockByKey(doc, normalized.blockKey);
	if (!block) return null;
	if (dir > 0) {
		if (normalized.itemIndex < block.items.length) {
			const item = block.items[normalized.itemIndex];
			if (item.kind === "text") {
				const length = Array.from(item.text ?? "").length;
				if (normalized.offset < length) return {
					...normalized,
					offset: normalized.offset + 1
				};
			}
			return {
				blockKey: block.key,
				itemIndex: normalized.itemIndex + 1,
				offset: 0
			};
		}
		const next = adjacentEditableBlock(doc, block.key, 1);
		return next ? blockStartCaret(next) : normalized;
	}
	if (normalized.offset > 0) return {
		...normalized,
		offset: normalized.offset - 1
	};
	if (normalized.itemIndex > 0) {
		const previous = block.items[normalized.itemIndex - 1];
		if (previous.kind === "text") return {
			blockKey: block.key,
			itemIndex: normalized.itemIndex - 1,
			offset: Array.from(previous.text ?? "").length
		};
		return {
			blockKey: block.key,
			itemIndex: normalized.itemIndex - 1,
			offset: 0
		};
	}
	const before = adjacentEditableBlock(doc, block.key, -1);
	return before ? blockEndCaret(before) : normalized;
}
/** 选区文字；跨段时用换行连接。 */
function selectionText(doc, selection) {
	const ordered = selectionOrdered(doc, selection);
	if (!ordered || ordered.collapsed) return "";
	const startIndex = doc.keyToIndex?.get(ordered.start.blockKey);
	const endIndex = doc.keyToIndex?.get(ordered.end.blockKey);
	if (startIndex == null || endIndex == null) return "";
	const parts = [];
	for (let index = startIndex; index <= endIndex; index += 1) {
		const block = doc.blocks[index];
		if (!isEditableBlock(block)) continue;
		const text = blockText(block);
		const from = index === startIndex ? blockTextOffset(block, ordered.start) : 0;
		const to = index === endIndex ? blockTextOffset(block, ordered.end) : text.length;
		parts.push(text.slice(from, Math.max(from, to)));
	}
	return parts.join("\n");
}
/** 双击选词：返回光标所在词的范围；点在空白/标点上返回 null。 */
function wordRangeAt(doc, caret) {
	const block = blockByKey(doc, caret?.blockKey);
	if (!block || !isEditableBlock(block)) return null;
	const item = block.items?.[caret.itemIndex];
	if (!item) return null;
	if (item.kind !== "text") return {
		anchor: {
			blockKey: block.key,
			itemIndex: caret.itemIndex,
			offset: 0
		},
		focus: {
			blockKey: block.key,
			itemIndex: caret.itemIndex + 1,
			offset: 0
		}
	};
	const chars = Array.from(item.text ?? "");
	const isWord = (char) => Boolean(char) && /[\p{L}\p{N}_'’-]/u.test(char);
	let start = Math.max(0, Math.min(caret.offset ?? 0, chars.length));
	let end = start;
	while (start > 0 && isWord(chars[start - 1])) start -= 1;
	while (end < chars.length && isWord(chars[end])) end += 1;
	if (start === end) return null;
	return {
		anchor: {
			blockKey: block.key,
			itemIndex: caret.itemIndex,
			offset: start
		},
		focus: {
			blockKey: block.key,
			itemIndex: caret.itemIndex,
			offset: end
		}
	};
}
/** 段落里的可编辑文字（tab 变 \t，换行变 \n，图片不计）。 */
function blockText(block) {
	let text = "";
	for (const item of block.items ?? []) if (item.kind === "text") text += item.text;
	else if (item.kind === "tab") text += "	";
	else if (item.kind === "lineBreak") text += "\n";
	return text;
}
//#endregion
//#region src/edit/history.js
/**
* 撤销 / 重做。
*
* 第一版用**整份 document.xml 快照**：实现简单、天然保住所有未知内容。
* 段落级快照是后续优化（DESIGN.md 里写的那种），接口不变。
*
* 光标位置不能存 blockKey —— 撤销会整篇重建、key 重新分配；这里存
* `{ blockIndex, offset }`，恢复时再换算回光标。
*/
const MAX_ENTRIES = 200;
const MAX_BYTES = 16 * 1024 * 1024;
const COALESCE_MS = 800;
function samePoint(a, b) {
	return Boolean(a && b) && a.blockIndex === b.blockIndex && a.offset === b.offset;
}
function createHistory({ initialXml = "" } = {}) {
	const undoStack = [];
	const redoStack = [];
	let savedXml = initialXml;
	let totalBytes = 0;
	function trim() {
		while (undoStack.length > MAX_ENTRIES || totalBytes > MAX_BYTES && undoStack.length > 1) {
			const removed = undoStack.shift();
			totalBytes -= removed.size ?? 0;
		}
	}
	/**
	* 记录一次改动。连续输入 / 删除会在同一段、光标相接、800ms 内合并成一步。
	*/
	function record(entry) {
		const size = (entry.beforeXml?.length ?? 0) + (entry.afterXml?.length ?? 0);
		const last = undoStack[undoStack.length - 1];
		if (last && entry.kind === "text" && last.kind === "text" && entry.blockIndex === last.blockIndex && samePoint(entry.selectionBefore, last.selectionAfter) && entry.time - last.time < COALESCE_MS) {
			totalBytes -= last.size ?? 0;
			last.afterXml = entry.afterXml;
			last.selectionAfter = entry.selectionAfter;
			last.time = entry.time;
			last.size = (last.beforeXml?.length ?? 0) + (last.afterXml?.length ?? 0);
			totalBytes += last.size;
			redoStack.length = 0;
			trim();
			return;
		}
		undoStack.push({
			...entry,
			size
		});
		totalBytes += size;
		redoStack.length = 0;
		trim();
	}
	function undo() {
		const entry = undoStack.pop();
		if (!entry) return null;
		totalBytes -= entry.size ?? 0;
		redoStack.push(entry);
		return entry;
	}
	function redo() {
		const entry = redoStack.pop();
		if (!entry) return null;
		undoStack.push(entry);
		totalBytes += entry.size ?? 0;
		trim();
		return entry;
	}
	function reset(xml) {
		undoStack.length = 0;
		redoStack.length = 0;
		totalBytes = 0;
		savedXml = xml;
	}
	function markSaved(xml) {
		savedXml = xml;
	}
	function isDirty(currentXml) {
		return currentXml !== savedXml;
	}
	return {
		record,
		undo,
		redo,
		reset,
		markSaved,
		isDirty,
		canUndo: () => undoStack.length > 0,
		canRedo: () => redoStack.length > 0,
		size: () => undoStack.length
	};
}
//#endregion
//#region src/edit/ooxml.js
/**
* 直接改 `word/document.xml` 的低层助手。
*
* 原则：**只动编辑命中的那些 `w:r` / `w:t`**，不重建段落、不碰未知内容。
* 域代码、批注范围、书签、图片这些不认识的子元素原样留着。
*/
/** 创建 `w:<name>`；沿用文档已有的 `w` 前缀（XMLSerializer 会补声明）。 */
function createW(document, localName) {
	return document.createElementNS(W_NS, `w:${localName}`);
}
function paragraphOf(block) {
	const node = block?.node;
	return isW(node, "p") ? node : null;
}
function runPropsOf(runNode) {
	if (!runNode) return null;
	for (const child of runNode.children) if (isW(child, "rPr")) return child;
	return null;
}
/** 克隆一段 run 的 `w:rPr`；没有就返回 null（继承段落/文档默认）。 */
function cloneRunProps(runNode) {
	const props = runPropsOf(runNode);
	return props ? props.cloneNode(true) : null;
}
/** `w:rPr` 子元素的 schema 顺序；插入新属性时按它排，Word 才不会挑刺。 */
const RPR_ORDER = [
	"rStyle",
	"rFonts",
	"b",
	"bCs",
	"i",
	"iCs",
	"caps",
	"smallCaps",
	"strike",
	"dstrike",
	"color",
	"spacing",
	"w",
	"kern",
	"position",
	"sz",
	"szCs",
	"highlight",
	"u",
	"effect",
	"bdr",
	"shd",
	"fitText",
	"vertAlign",
	"rtl",
	"cs",
	"em",
	"lang",
	"eastAsianLayout",
	"specVanish",
	"oMath"
];
function ensureRunProps(runNode) {
	const existing = runPropsOf(runNode);
	if (existing) return existing;
	const props = createW(runNode.ownerDocument, "rPr");
	runNode.insertBefore(props, runNode.firstChild);
	return props;
}
function rprChild(props, name) {
	for (const child of props.children) if (isW(child, name)) return child;
	return null;
}
function ensureRprChild(props, name) {
	const existing = rprChild(props, name);
	if (existing) return existing;
	const element = createW(props.ownerDocument, name);
	const order = RPR_ORDER.indexOf(name);
	const next = Array.from(props.children).find((child) => {
		const index = RPR_ORDER.indexOf(child.localName);
		return index >= 0 && order >= 0 && index > order;
	});
	props.insertBefore(element, next ?? null);
	return element;
}
function removeRprChild(props, name) {
	for (const child of Array.from(props.children)) if (isW(child, name)) props.removeChild(child);
}
function toggleValue(element) {
	if (!element) return false;
	const value = attr(element, "val");
	return value === null || ![
		"0",
		"false",
		"off",
		"none"
	].includes(value);
}
/** 某一段 run 当前有没有这个字符格式。 */
function runFormatState(runNode, key) {
	const props = runPropsOf(runNode);
	if (!props) return false;
	if (key === "bold") return toggleValue(rprChild(props, "b"));
	if (key === "italic") return toggleValue(rprChild(props, "i"));
	if (key === "underline") return toggleValue(rprChild(props, "u"));
	if (key === "strike") return toggleValue(rprChild(props, "strike"));
	if (key === "vertAlign") {
		const element = rprChild(props, "vertAlign");
		return element ? attr(element, "val") : null;
	}
	return false;
}
/**
* 把一种字符格式写到 run 上。
*
* `format = { key, value? }`；bold / italic / underline / strike 不带 value 时
* 由调用方先算好“开还是关”，这里只负责写。
*/
function setRunFormat(runNode, format) {
	const props = ensureRunProps(runNode);
	const { key, value } = format;
	if (key === "bold" || key === "italic") {
		const name = key === "bold" ? "b" : "i";
		const alias = `${name}Cs`;
		if (value) {
			ensureRprChild(props, name);
			ensureRprChild(props, alias);
		} else {
			removeRprChild(props, name);
			removeRprChild(props, alias);
		}
		return;
	}
	if (key === "underline" || key === "strike") {
		if (value) {
			const element = ensureRprChild(props, key === "underline" ? "u" : "strike");
			if (key === "underline") element.setAttributeNS(W_NS, "w:val", "single");
		} else removeRprChild(props, key === "underline" ? "u" : "strike");
		return;
	}
	if (key === "vertAlign") {
		if (value === "superscript" || value === "subscript") ensureRprChild(props, "vertAlign").setAttributeNS(W_NS, "w:val", value);
		else removeRprChild(props, "vertAlign");
		return;
	}
	if (key === "color") {
		if (value) ensureRprChild(props, "color").setAttributeNS(W_NS, "w:val", String(value));
		else removeRprChild(props, "color");
		return;
	}
}
/** 只统计顶层 run 里的文字长度（tab / 换行 / 图片按 1 个位置算）。 */
function runTextLength(run) {
	let length = 0;
	for (const child of run.children) {
		if (isW(child, "rPr")) continue;
		if (isW(child, "t")) length += Array.from(child.textContent ?? "").length;
		else length += 1;
	}
	return length;
}
/** 在 run 内部的某个字符位置拆成两个 run（右边克隆 rPr）。 */
function splitRunAtLocal(paragraph, run, localOffset) {
	let remaining = localOffset;
	let first = true;
	for (const child of Array.from(run.childNodes)) {
		if (child.nodeType === 1 && isW(child, "rPr")) continue;
		const length = isW(child, "t") ? Array.from(child.textContent ?? "").length : 1;
		if (remaining === 0) {
			if (!first) splitRunBefore(paragraph, run, child);
			return;
		}
		if (remaining < length) {
			if (isW(child, "t")) {
				const right = splitTextNode(child, remaining);
				if (right) splitRunBefore(paragraph, run, right);
			}
			return;
		}
		remaining -= length;
		first = false;
	}
}
/**
* 在段落的某个文本偏移处把 run 切开，让选区边界落在 run 边界上。
* 只处理顶层的 `w:r`；超链接 / 修订里的嵌套 run 暂不支持结构化切分。
*/
function splitRunsAtOffset(block, offset) {
	const paragraph = paragraphOf(block);
	if (!paragraph || offset <= 0) return;
	let position = 0;
	for (const run of paragraph.children) {
		if (!isW(run, "r")) continue;
		const length = runTextLength(run);
		if (offset > position && offset < position + length) {
			splitRunAtLocal(paragraph, run, offset - position);
			return;
		}
		if (offset === position + length) return;
		position += length;
	}
}
/** 选区覆盖到的顶层 run。 */
function runsInRange(block, start, end) {
	const paragraph = paragraphOf(block);
	if (!paragraph) return [];
	const result = [];
	let position = 0;
	for (const run of paragraph.children) {
		if (!isW(run, "r")) continue;
		const length = runTextLength(run);
		if (length > 0 && position + length > start && position < end) result.push(run);
		position += length;
	}
	return result;
}
/** 设置 `w:t` 文本，并保留前后空格。 */
function setTextNode(textNode, text) {
	if (!textNode) return;
	textNode.textContent = text;
	textNode.setAttributeNS(XML_NS, "xml:space", "preserve");
}
function makeTextNode(document, text) {
	const node = createW(document, "t");
	setTextNode(node, text);
	return node;
}
/** 新建一个 run：可选克隆来源 run 的 rPr，再放入一段文字。 */
function makeTextRun(document, text, rPrSourceRun = null, rPrSourceNode = null) {
	const run = createW(document, "r");
	const props = rPrSourceNode ? rPrSourceNode.cloneNode(true) : cloneRunProps(rPrSourceRun);
	if (props) run.appendChild(props);
	run.appendChild(makeTextNode(document, text));
	return run;
}
/** 把节点插在 `reference` 之前 / 之后；reference 为空时放到段落末尾。 */
function insertNear(paragraph, reference, node, before) {
	if (reference?.parentNode) {
		reference.parentNode.insertBefore(node, before ? reference : reference.nextSibling);
		return node;
	}
	paragraph.appendChild(node);
	return node;
}
function previousItem(items, index) {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) if (items[cursor]?.runNode) return items[cursor];
	return null;
}
/** 在光标处插入文字；返回被改动的 `w:t`（或新建的 run）。 */
function insertText(block, caret, text) {
	const paragraph = paragraphOf(block);
	if (!paragraph || !text) return null;
	const items = block.items ?? [];
	const item = items[caret.itemIndex];
	if (item?.kind === "text" && item.node?.parentNode) {
		const chars = Array.from(item.node.textContent ?? "");
		const offset = Math.max(0, Math.min(caret.offset ?? 0, chars.length));
		chars.splice(offset, 0, ...Array.from(text));
		setTextNode(item.node, chars.join(""));
		return item.node;
	}
	const document = paragraph.ownerDocument;
	const run = makeTextRun(document, text, item?.runNode ?? previousItem(items, caret.itemIndex)?.runNode ?? null);
	if (item?.runNode) insertNear(paragraph, item.runNode, run, true);
	else {
		const last = items[items.length - 1];
		if (last?.runNode) insertNear(paragraph, last.runNode, run, false);
		else paragraph.appendChild(run);
	}
	return run;
}
/** run 里除了 `w:rPr` 之外还有内容吗？ */
function runHasContent(runNode) {
	for (const child of runNode.childNodes) {
		if (child.nodeType === 3 && child.textContent.trim()) return true;
		if (child.nodeType === 1 && !isW(child, "rPr")) return true;
	}
	return false;
}
/** 清掉空 run；域代码 / 批注范围等未知子元素会让 run 保留下来。 */
function cleanupRun(runNode) {
	if (!runNode?.parentNode) return;
	if (!runHasContent(runNode)) runNode.parentNode.removeChild(runNode);
}
function removeNode(node) {
	if (!node?.parentNode) return;
	const run = node.parentNode;
	run.removeChild(node);
	if (isW(run, "r")) cleanupRun(run);
}
/**
* 删除同一段内的半开区间 `[start, end)`（段落文本偏移）。
*
* 从后往前删：前面的 item 偏移不会因为后面的删除而改变。
*/
function deleteRange(block, start, end) {
	const items = block.items ?? [];
	const ranges = [];
	let offset = 0;
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		const length = item.kind === "text" ? Array.from(item.text ?? "").length : 1;
		ranges.push({
			item,
			start: offset,
			end: offset + length
		});
		offset += length;
	}
	for (let index = ranges.length - 1; index >= 0; index -= 1) {
		const range = ranges[index];
		const from = Math.max(start, range.start);
		const to = Math.min(end, range.end);
		if (to <= from) continue;
		const item = range.item;
		if (item.kind === "text" && item.node) {
			const chars = Array.from(item.node.textContent ?? "");
			const localFrom = from - range.start;
			const localTo = to - range.start;
			chars.splice(localFrom, localTo - localFrom);
			setTextNode(item.node, chars.join(""));
			if (chars.length === 0) removeNode(item.node);
			continue;
		}
		removeNode(item.node);
	}
}
function directParagraphProps(paragraph) {
	return paragraph?.children ? Array.from(paragraph.children).find((node) => isW(node, "pPr")) ?? null : null;
}
function numberingProperties(paragraph) {
	const pPr = directParagraphProps(paragraph);
	if (!pPr?.children) return null;
	return Array.from(pPr.children).find((node) => isW(node, "numPr")) ?? null;
}
/**
* 去掉这一段的列表属性（项目符号 / 编号）。
*
* Word 的行为：光标在列表项开头按退格，第一次只取消列表格式、文字留下；
* 再按一次才会并到上一段。`w:ind` 里如果只是编号带来的缩进，会随编号一起失效。
*/
function removeListNumbering(block) {
	const paragraph = paragraphOf(block);
	if (!paragraph) return false;
	const pPr = directParagraphProps(paragraph);
	const numPr = numberingProperties(paragraph);
	if (!pPr || !numPr) return false;
	pPr.removeChild(numPr);
	return true;
}
/** 多级列表：把当前段升/降一级（`w:ilvl`）。返回是否真的改了。 */
function changeListLevel(block, delta) {
	const paragraph = paragraphOf(block);
	if (!paragraph) return false;
	const numPr = numberingProperties(paragraph);
	if (!numPr) return false;
	const ilvl = Array.from(numPr.children).find((node) => isW(node, "ilvl"));
	const next = (ilvl ? Number(attr(ilvl, "val") ?? 0) : 0) + delta;
	if (!Number.isFinite(next) || next < 0) return false;
	if (ilvl) ilvl.setAttributeNS(W_NS, "w:val", String(next));
	else {
		const created = createW(paragraph.ownerDocument, "ilvl");
		created.setAttributeNS(W_NS, "w:val", String(next));
		numPr.insertBefore(created, numPr.firstChild);
	}
	return true;
}
function splitTextNode(textNode, offset) {
	const chars = Array.from(textNode.textContent ?? "");
	if (offset <= 0 || offset >= chars.length) return null;
	const right = textNode.cloneNode(false);
	setTextNode(textNode, chars.slice(0, offset).join(""));
	setTextNode(right, chars.slice(offset).join(""));
	textNode.parentNode.insertBefore(right, textNode.nextSibling);
	return right;
}
/**
* 在 `run` 里的 `node` 之前把 run 拆成两半，返回新的右半边 run。
* 右半边会克隆原 run 的 `w:rPr`，并接收 `node` 及其后的所有兄弟。
*/
function splitRunBefore(paragraph, run, node) {
	const right = createW(paragraph.ownerDocument, "r");
	const props = runPropsOf(run);
	if (props) right.appendChild(props.cloneNode(true));
	let moving = false;
	for (const child of Array.from(run.childNodes)) {
		if (moving) {
			right.appendChild(child);
			continue;
		}
		if (child === node) {
			moving = true;
			right.appendChild(child);
		}
	}
	run.parentNode.insertBefore(right, run.nextSibling);
	return right;
}
function cloneParagraphProperties(paragraph) {
	for (const child of paragraph.children) {
		if (!isW(child, "pPr")) continue;
		const clone = child.cloneNode(true);
		for (const section of Array.from(clone.children)) if (isW(section, "sectPr")) clone.removeChild(section);
		return clone;
	}
	return null;
}
function paragraphHasSectionBreak(paragraph) {
	for (const child of paragraph.children) {
		if (!isW(child, "pPr")) continue;
		for (const inner of child.children) if (isW(inner, "sectPr")) return true;
	}
	return false;
}
/**
* 在光标处把段落拆成两段。
*
* 返回新段落的 `w:p` 节点；调用方负责重解析与插入 block。
* 不支持：表格拍平行、嵌套容器（超链接/修订/sdt）里的光标、带分节符的段落。
*/
function splitParagraphAt(block, caret) {
	const paragraph = paragraphOf(block);
	if (!paragraph) return { unsupported: "not-paragraph" };
	if (paragraphHasSectionBreak(paragraph)) return { unsupported: "section" };
	const item = (block.items ?? [])[caret.itemIndex];
	if (item?.nested) return { unsupported: "nested" };
	let anchor = null;
	let splitNode = null;
	if (item?.kind === "text" && item.node?.parentNode) {
		const chars = Array.from(item.node.textContent ?? "");
		const offset = Math.max(0, Math.min(caret.offset ?? 0, chars.length));
		splitNode = item.node;
		if (offset > 0 && offset < chars.length) {
			const rightText = splitTextNode(item.node, offset);
			splitNode = rightText;
			anchor = splitRunBefore(paragraph, item.node.parentNode, rightText);
		} else if (offset === 0) anchor = splitRunBefore(paragraph, item.node.parentNode, item.node);
		else anchor = item.node.parentNode.nextSibling ?? null;
	} else if (item?.node?.parentNode) anchor = splitRunBefore(paragraph, item.node.parentNode, item.node);
	else anchor = null;
	if (splitNode && !anchor) {}
	const document = paragraph.ownerDocument;
	const created = createW(document, "p");
	const props = cloneParagraphProperties(paragraph);
	if (props) created.appendChild(props);
	paragraph.parentNode.insertBefore(created, paragraph.nextSibling);
	if (anchor) {
		let moving = false;
		for (const child of Array.from(paragraph.childNodes)) {
			if (isW(child, "pPr")) continue;
			if (!moving) if (child === anchor) moving = true;
			else continue;
			created.appendChild(child);
		}
	}
	return {
		node: created,
		element: paragraph
	};
}
function nextParagraphElement(block) {
	let node = block?.node?.nextSibling ?? null;
	while (node && node.nodeType !== 1) node = node.nextSibling;
	return isW(node, "p") ? node : null;
}
/** 把 `next` 段落并进 `block`（段首退格）；返回被删掉的段落节点。 */
function mergeParagraphs(block, nextBlock) {
	const paragraph = paragraphOf(block);
	const next = paragraphOf(nextBlock);
	if (!paragraph || !next) return { unsupported: "not-paragraph" };
	if (paragraph.parentNode !== next.parentNode) return { unsupported: "different-parent" };
	if (paragraphHasSectionBreak(next)) return { unsupported: "section" };
	if (nextParagraphElement(block) !== next) return { unsupported: "not-adjacent" };
	for (const child of Array.from(next.childNodes)) {
		if (isW(child, "pPr")) continue;
		paragraph.appendChild(child);
	}
	next.parentNode.removeChild(next);
	return { node: paragraph };
}
/** 空文档（node 是 w:body）物化成真正的段落，插在末尾 sectPr 之前。 */
function materializeParagraph(body) {
	const document = body.ownerDocument;
	const paragraph = createW(document, "p");
	let reference = null;
	for (const child of body.children) if (isW(child, "sectPr")) {
		reference = child;
		break;
	}
	body.insertBefore(paragraph, reference);
	return paragraph;
}
/** 在光标处插入一个原子 run（`w:br` / `w:tab`）。 */
function insertAtomic(block, caret, localName) {
	const paragraph = paragraphOf(block);
	if (!paragraph) return null;
	const items = block.items ?? [];
	const item = items[caret.itemIndex];
	const document = paragraph.ownerDocument;
	const run = createW(document, "r");
	const props = cloneRunProps(item?.runNode ?? items[caret.itemIndex - 1]?.runNode ?? null);
	if (props) run.appendChild(props);
	run.appendChild(createW(document, localName));
	if (item?.kind === "text" && item.node?.parentNode) {
		const chars = Array.from(item.node.textContent ?? "");
		const offset = Math.max(0, Math.min(caret.offset ?? 0, chars.length));
		if (offset > 0 && offset < chars.length) {
			const rightText = splitTextNode(item.node, offset);
			insertNear(paragraph, splitRunBefore(paragraph, item.node.parentNode, rightText), run, true);
			return run;
		}
		const atEnd = offset >= chars.length;
		insertNear(paragraph, item.runNode, run, !atEnd);
	} else if (item?.runNode) insertNear(paragraph, item.runNode, run, true);
	else {
		const last = items[items.length - 1];
		if (last?.runNode) insertNear(paragraph, last.runNode, run, false);
		else paragraph.appendChild(run);
	}
	return run;
}
function insertLineBreak(block, caret) {
	return insertAtomic(block, caret, "br");
}
function insertTab(block, caret) {
	return insertAtomic(block, caret, "tab");
}
function element(document, localName, attrs = {}) {
	const node = createW(document, localName);
	for (const [name, value] of Object.entries(attrs)) node.setAttributeNS(W_NS, `w:${name}`, String(value));
	return node;
}
/**
* 新建一张最基本的表格：等宽列、单线边框、普通单元格。
*
* `widthPx` 是正文栏宽；列宽按 twip 均分（1px = 15twip）。
*/
function createTable(document, rows, cols, widthPx) {
	const table = createW(document, "tbl");
	const props = createW(document, "tblPr");
	props.appendChild(element(document, "tblW", {
		w: 5e3,
		type: "pct"
	}));
	props.appendChild(element(document, "jc", { val: "left" }));
	const borders = createW(document, "tblBorders");
	for (const edge of [
		"top",
		"left",
		"bottom",
		"right",
		"insideH",
		"insideV"
	]) borders.appendChild(element(document, edge, {
		val: "single",
		sz: 4,
		space: 0,
		color: "000000"
	}));
	props.appendChild(borders);
	const margins = createW(document, "tblCellMar");
	margins.appendChild(element(document, "top", {
		w: 0,
		type: "dxa"
	}));
	margins.appendChild(element(document, "left", {
		w: 108,
		type: "dxa"
	}));
	margins.appendChild(element(document, "bottom", {
		w: 0,
		type: "dxa"
	}));
	margins.appendChild(element(document, "right", {
		w: 108,
		type: "dxa"
	}));
	props.appendChild(margins);
	table.appendChild(props);
	const columnTwips = Math.max(600, Math.round(widthPx / 15 / cols));
	const grid = createW(document, "tblGrid");
	for (let col = 0; col < cols; col += 1) grid.appendChild(element(document, "gridCol", { w: columnTwips }));
	table.appendChild(grid);
	for (let row = 0; row < rows; row += 1) {
		const tr = createW(document, "tr");
		for (let col = 0; col < cols; col += 1) {
			const tc = createW(document, "tc");
			const tcPr = createW(document, "tcPr");
			tcPr.appendChild(element(document, "tcW", {
				w: columnTwips,
				type: "dxa"
			}));
			tc.appendChild(tcPr);
			tc.appendChild(createW(document, "p"));
			tr.appendChild(tc);
		}
		table.appendChild(tr);
	}
	return table;
}
//#endregion
//#region src/edit/operations.js
/**
* 编辑操作：把「光标 + 输入」翻译成 XML 改动，再重解析受影响的段落。
*
* 每个操作返回 `{ dirtyKeys, caretAfter }`：`caretAfter` 用**段落文本偏移**表示，
* 这样重解析后即使 item 被拆开 / 合并，也能把光标放回同一个字。
*/
const textLength = (text) => Array.from(text ?? "").length;
function nextKey(doc) {
	doc.nextKey = Math.max(doc.nextKey ?? 0, doc.blocks.length);
	return `p${doc.nextKey++}`;
}
function requireEditable(doc, caret) {
	const block = blockByKey(doc, caret?.blockKey);
	if (!block || !isEditableBlock(block)) return null;
	return block;
}
/** 空文档的唯一占位块第一次被编辑时，物化成真正的 `w:p`。 */
async function ensureEditableParagraph(doc, block) {
	if (block?.synthetic !== "empty-body") return block;
	const parsed = await parseParagraphElement(materializeParagraph(doc.source.body), doc.source.context, 0, block.key);
	parsed.editable = true;
	parsed.synthetic = null;
	doc.blocks[0] = parsed;
	rebuildBlockIndices(doc);
	return parsed;
}
/**
* 在光标处插入文字；返回重解析后的段落与新光标。
* 调用方负责先处理选区。
*/
async function insertTextAt(doc, caret, text) {
	let block = requireEditable(doc, caret);
	if (!block) {
		const candidate = blockByKey(doc, caret?.blockKey);
		if (candidate?.synthetic === "empty-body") {
			block = await ensureEditableParagraph(doc, candidate);
			caret = blockOffsetCaret(block, 0);
		}
	}
	if (!block || !text) return null;
	const offset = blockTextOffset(block, caret);
	insertText(block, caret, text);
	const parsed = await reparseBlock(doc, block);
	return {
		dirtyKeys: [parsed.key],
		caretAfter: blockOffsetCaret(parsed, offset + textLength(text)),
		block: parsed
	};
}
/**
* 给选区里的文字设置字符格式。
*
* 先在两端的字符偏移处切开 run，保证格式只落在选中的那段文字上；然后逐个 run
* 写 `w:rPr`。`bold / italic / underline / strike` 是开关：选区里不是全带这个格式
* 就统一加上，全带就去掉。
*/
async function applyRunFormat(doc, selection, format) {
	const ordered = selectionOrdered(doc, selection);
	if (!ordered || ordered.collapsed) return { unsupported: "empty-selection" };
	const startBlock = blockByKey(doc, ordered.start.blockKey);
	const endBlock = blockByKey(doc, ordered.end.blockKey);
	const sameCell = startBlock?.container && endBlock?.container && startBlock.container.cell === endBlock.container.cell;
	const ranges = [];
	if (sameCell) {
		const collection = startBlock.container.cell.blocks;
		const startIndex = startBlock.container.index;
		const endIndex = endBlock.container.index;
		for (let index = startIndex; index <= endIndex; index += 1) {
			const block = collection[index];
			if (!isEditableBlock(block)) continue;
			ranges.push({
				block,
				start: index === startIndex ? blockTextOffset(block, ordered.start) : 0,
				end: index === endIndex ? blockTextOffset(block, ordered.end) : blockTextOffset(block, blockEndCaret(block))
			});
		}
	} else {
		const startIndex = doc.keyToIndex?.get(ordered.start.blockKey);
		const endIndex = doc.keyToIndex?.get(ordered.end.blockKey);
		if (startIndex == null || endIndex == null) return { unsupported: "no-format-range" };
		for (let index = startIndex; index <= endIndex; index += 1) {
			const block = doc.blocks[index];
			if (!isEditableBlock(block)) continue;
			ranges.push({
				block,
				start: index === startIndex ? blockTextOffset(block, ordered.start) : 0,
				end: index === endIndex ? blockTextOffset(block, ordered.end) : blockTextOffset(block, blockEndCaret(block))
			});
		}
	}
	const toggleKeys = new Set([
		"bold",
		"italic",
		"underline",
		"strike"
	]);
	const dirtyKeys = [];
	for (const { block, start, end } of ranges) {
		if (end <= start) continue;
		let itemOffset = 0;
		for (const item of block.items ?? []) {
			const length = itemLength(item);
			if (item.nested && itemOffset + length > start && itemOffset < end) return { unsupported: "nested" };
			itemOffset += length;
		}
		splitRunsAtOffset(block, start);
		splitRunsAtOffset(block, end);
		const runs = runsInRange(block, start, end);
		if (runs.length === 0) continue;
		let value = format.value;
		if (toggleKeys.has(format.key) && value === void 0) value = !runs.every((run) => runFormatState(run, format.key));
		for (const run of runs) setRunFormat(run, {
			key: format.key,
			value
		});
		const parsed = await reparseBlock(doc, block);
		dirtyKeys.push(parsed.key);
	}
	if (dirtyKeys.length === 0) return { unsupported: "no-format-range" };
	return {
		dirtyKeys,
		caretAfter: ordered.end,
		selectionAfter: {
			anchor: selection.anchor,
			focus: selection.focus
		}
	};
}
/** 删除同一段内的 `[start, end)`。 */
async function deleteWithinBlock(doc, block, start, end) {
	if (!block || !isEditableBlock(block)) return null;
	const startOffset = blockTextOffset(block, start);
	const endOffset = blockTextOffset(block, end);
	if (endOffset <= startOffset) return {
		dirtyKeys: [],
		caretAfter: blockOffsetCaret(block, startOffset),
		block
	};
	deleteRange(block, startOffset, endOffset);
	const parsed = await reparseBlock(doc, block);
	return {
		dirtyKeys: [parsed.key],
		caretAfter: blockOffsetCaret(parsed, startOffset),
		block: parsed
	};
}
/**
* 退格：同段内删一个字；落到段首时交给调用方做段合并（M5.4）。
*/
/** 列表属性改动后：重解析这一段、重新编号，光标留在段首。 */
async function refreshListParagraph(doc, block) {
	const parsed = await reparseBlock(doc, block);
	return {
		dirtyKeys: doc.blocks.map((candidate) => candidate.key),
		caretAfter: blockOffsetCaret(parsed, 0)
	};
}
async function deleteBackward(doc, caret) {
	const block = requireEditable(doc, caret);
	if (!block) return null;
	if (blockTextOffset(block, caret) === 0) {
		const numPr = block.propsBase?.numPr ?? block.props?.numPr;
		if (numPr) {
			if ((numPr.ilvl ?? 0) > 0 ? changeListLevel(block, -1) : removeListNumbering(block)) return refreshListParagraph(doc, block);
		}
		return {
			merge: "backward",
			block,
			caret
		};
	}
	const before = stepCaret(doc, caret, -1);
	if (!before || before.blockKey !== block.key) return {
		merge: "backward",
		block,
		caret
	};
	return deleteWithinBlock(doc, block, before, caret);
}
/** Delete：同段内删一个字；落到段尾时交给调用方做段合并（M5.4）。 */
async function deleteForward(doc, caret) {
	const block = requireEditable(doc, caret);
	if (!block) return null;
	const endOffset = blockTextOffset(block, blockEndCaret(block));
	if (blockTextOffset(block, caret) >= endOffset) return {
		merge: "forward",
		block,
		caret
	};
	const after = stepCaret(doc, caret, 1);
	if (!after || after.blockKey !== block.key) return {
		merge: "forward",
		block,
		caret
	};
	return deleteWithinBlock(doc, block, caret, after);
}
/**
* 替换选区（同段或跨段）。
* 返回 `{ unsupported: ... }` 时由编辑器 toast 提示，不破坏文档。
*/
async function replaceSelection(doc, selection, text) {
	const { anchor, focus } = selection ?? {};
	if (!anchor || !focus) return null;
	const block = requireEditable(doc, anchor);
	if (!block) return null;
	if (anchor.blockKey !== focus.blockKey) return replaceCrossBlockSelection(doc, selection, text);
	const start = blockTextOffset(block, anchor) <= blockTextOffset(block, focus) ? anchor : focus;
	const deleted = await deleteWithinBlock(doc, block, start, start === anchor ? focus : anchor);
	if (!deleted) return null;
	if (text) {
		const inserted = await insertTextAt(doc, deleted.caretAfter, text);
		if (inserted) inserted.dirtyKeys = [block.key];
		return inserted;
	}
	return deleted;
}
/**
* 跨段删除 / 替换：删掉起点段尾、中间整段、终点段首，再把终点段剩下内容并回起点段。
* Word 里跨段选中后按退格就是这个结果。
*/
async function replaceCrossBlockSelection(doc, selection, text) {
	const ordered = selectionOrdered(doc, selection);
	if (!ordered || ordered.collapsed) return null;
	const startBlock = blockByKey(doc, ordered.start.blockKey);
	const endBlock = blockByKey(doc, ordered.end.blockKey);
	if (!isEditableBlock(startBlock) || !isEditableBlock(endBlock)) return { unsupported: "not-adjacent" };
	const sameCell = startBlock.container && endBlock.container && startBlock.container.cell === endBlock.container.cell;
	const collection = sameCell ? startBlock.container.cell.blocks : doc.blocks;
	const startIndex = sameCell ? startBlock.container.index : doc.keyToIndex.get(startBlock.key);
	const endIndex = sameCell ? endBlock.container.index : doc.keyToIndex.get(endBlock.key);
	if (startIndex == null || endIndex == null || endIndex <= startIndex) return { unsupported: "not-adjacent" };
	for (let index = startIndex + 1; index < endIndex; index += 1) if (!isEditableBlock(collection[index])) return { unsupported: "not-adjacent" };
	if (!startBlock.node?.parentNode || endBlock.node?.parentNode !== startBlock.node.parentNode) return { unsupported: "not-adjacent" };
	const startOffset = blockTextOffset(startBlock, ordered.start);
	const endOffset = blockTextOffset(endBlock, ordered.end);
	const startLength = blockTextOffset(startBlock, blockEndCaret(startBlock));
	if (startOffset < startLength) deleteRange(startBlock, startOffset, startLength);
	if (endOffset > 0) deleteRange(endBlock, 0, endOffset);
	for (let index = endIndex - 1; index > startIndex; index -= 1) {
		const block = collection[index];
		block.node?.parentNode?.removeChild(block.node);
		collection.splice(index, 1);
	}
	const merged = mergeParagraphs(startBlock, endBlock);
	if (merged?.unsupported) return { unsupported: merged.unsupported };
	collection.splice(startIndex + 1, 1);
	const parsed = await reparseBlock(doc, startBlock);
	refreshNumbering(doc);
	rebuildBlockIndices(doc);
	let caretAfter = blockOffsetCaret(parsed, startOffset);
	if (text) {
		const inserted = await insertTextAt(doc, caretAfter, text);
		if (inserted) caretAfter = inserted.caretAfter;
	}
	return {
		dirtyKeys: doc.blocks.map((candidate) => candidate.key),
		caretAfter
	};
}
/** 回车：在光标处拆成两段。返回新段落里的光标。 */
async function splitParagraph(doc, caret) {
	let block = requireEditable(doc, caret);
	if (!block) {
		const candidate = blockByKey(doc, caret?.blockKey);
		if (candidate?.synthetic === "empty-body") {
			block = await ensureEditableParagraph(doc, candidate);
			caret = blockOffsetCaret(block, 0);
		}
	}
	if (!block) return null;
	const result = splitParagraphAt(block, caret);
	if (result?.unsupported) return { unsupported: result.unsupported };
	const key = nextKey(doc);
	const container = block.container;
	const index = container ? container.index + 1 : block.index + 1;
	await reparseBlock(doc, block);
	const created = await parseParagraphElement(result.node, doc.source.context, index, key);
	if (container) {
		created.container = {
			table: container.table,
			row: container.row,
			cell: container.cell,
			index
		};
		container.cell.blocks.splice(index, 0, created);
	} else doc.blocks.splice(index, 0, created);
	refreshNumbering(doc);
	rebuildBlockIndices(doc);
	return {
		dirtyKeys: doc.blocks.map((candidate) => candidate.key),
		caretAfter: {
			blockKey: created.key,
			itemIndex: 0,
			offset: 0
		}
	};
}
/** Shift+Enter：段内手动换行。 */
async function insertSoftBreak(doc, caret) {
	const block = requireEditable(doc, caret);
	if (!block) return null;
	const offset = blockTextOffset(block, caret);
	insertLineBreak(block, caret);
	const parsed = await reparseBlock(doc, block);
	return {
		dirtyKeys: [parsed.key],
		caretAfter: blockOffsetCaret(parsed, offset + 1)
	};
}
/** 把下一段并进当前段；光标停在接缝处。 */
async function mergeWithNext(doc, block) {
	const next = adjacentEditableBlock(doc, block.key, 1);
	if (!next) return null;
	const joinOffset = blockTextOffset(block, blockEndCaret(block));
	const result = mergeParagraphs(block, next);
	if (result?.unsupported) return { unsupported: result.unsupported };
	const parsed = await reparseBlock(doc, block);
	if (next.container) {
		const cell = next.container.cell;
		const nextIndex = cell.blocks.findIndex((candidate) => candidate.key === next.key);
		if (nextIndex >= 0) cell.blocks.splice(nextIndex, 1);
	} else {
		const nextIndex = doc.blocks.findIndex((candidate) => candidate.key === next.key);
		if (nextIndex >= 0) doc.blocks.splice(nextIndex, 1);
	}
	refreshNumbering(doc);
	rebuildBlockIndices(doc);
	return {
		dirtyKeys: doc.blocks.map((candidate) => candidate.key),
		caretAfter: blockOffsetCaret(parsed, joinOffset)
	};
}
/** 段首退格：把当前段并进上一段。 */
async function mergeWithPrevious(doc, block) {
	const previous = adjacentEditableBlock(doc, block.key, -1);
	if (!previous) return null;
	return mergeWithNext(doc, previous);
}
async function insertTabAt(doc, caret) {
	const block = requireEditable(doc, caret);
	if (!block) return null;
	const offset = blockTextOffset(block, caret);
	insertTab(block, caret);
	const parsed = await reparseBlock(doc, block);
	return {
		dirtyKeys: [parsed.key],
		caretAfter: blockOffsetCaret(parsed, offset + 1)
	};
}
/**
* 粘贴纯文本：`\n` 分段、`\t` 变 `w:tab`。
*
* 每次插入都会重解析，但整次粘贴在调用方看来是**一个**事务（一次撤销）。
*/
async function insertPlainText(doc, caret, text) {
	const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
	if (lines.length === 1 && lines[0] === "") return null;
	let current = caret;
	let last = null;
	for (let index = 0; index < lines.length; index += 1) {
		if (index > 0) {
			last = await splitParagraph(doc, current);
			if (!last || last.unsupported) return last;
			current = last.caretAfter;
		}
		const parts = lines[index].split("	");
		for (let part = 0; part < parts.length; part += 1) {
			if (part > 0) {
				last = await insertTabAt(doc, current);
				if (!last) return null;
				current = last.caretAfter;
			}
			if (parts[part]) {
				last = await insertTextAt(doc, current, parts[part]);
				if (!last) return null;
				current = last.caretAfter;
			}
		}
	}
	return {
		dirtyKeys: doc.blocks.map((block) => block.key),
		caretAfter: current
	};
}
/**
* 在光标所在段落之后插入一张新表格。
*
* 插入后整篇重解析（表格创建不常发生）；光标落到第一个单元格里，随后
* 走和普通表格编辑完全相同的链路。
*/
async function insertTableAt(doc, caret, rows, cols) {
	const block = requireEditable(doc, caret);
	if (!block) return null;
	if (block.container) return { unsupported: "nested-table" };
	const paragraph = block.node;
	if (!paragraph?.parentNode) return null;
	const table = createTable(doc.source.documentXml, Math.max(1, Math.min(20, rows)), Math.max(1, Math.min(12, cols)), doc.section?.contentWidth ?? 415);
	paragraph.parentNode.insertBefore(table, paragraph.nextSibling);
	let next = table.nextSibling;
	while (next && next.nodeType !== 1) next = next.nextSibling;
	if (!next || next.localName === "sectPr") {
		const trailing = doc.source.documentXml.createElementNS(paragraph.namespaceURI, "w:p");
		table.parentNode.insertBefore(trailing, table.nextSibling);
	}
	const tableIndex = block.index + 1;
	await replaceDocumentXml(doc, new XMLSerializer().serializeToString(doc.source.documentXml));
	const cellParagraph = (doc.blocks[tableIndex]?.kind === "table" ? doc.blocks[tableIndex] : doc.blocks.find((candidate) => candidate.kind === "table"))?.rows?.[0]?.cells?.[0]?.blocks?.[0];
	if (!cellParagraph) return null;
	return {
		dirtyKeys: doc.blocks.map((candidate) => candidate.key),
		caretAfter: {
			blockKey: cellParagraph.key,
			itemIndex: 0,
			offset: 0
		}
	};
}
//#endregion
//#region src/layout/measure.js
/**
* 文本测量。
*
* 行排版不能交给浏览器自己换行：我们要知道每个词的宽度、每一行的行高，才能按 Word 的
* 规则分页。这里用 Canvas 2D 的 `measureText`，并按「字体 + 文本」缓存。
*
* ⚠️ 测量与最终 DOM 渲染必须用**同一套字体栈**，否则量出来 100px、画出来 103px，
* 行尾就会溢出或者留下一条缝。`fontFamily()` 是唯一的字体栈来源。
*/
let canvas = null;
let context = null;
const widthCache = /* @__PURE__ */ new Map();
const metricsCache = /* @__PURE__ */ new Map();
const browserMetricsCache = /* @__PURE__ */ new Map();
function getContext() {
	if (!context) {
		canvas = document.createElement("canvas");
		context = canvas.getContext("2d");
		if ("fontKerning" in context) context.fontKerning = "none";
	}
	return context;
}
function quoted(name) {
	if (!name) return "";
	const trimmed = String(name).trim();
	if (!trimmed) return "";
	if (trimmed.includes(",")) return trimmed;
	return `"${trimmed.replace(/"/g, "")}"`;
}
function looksSerif(name) {
	return /times|georgia|garamond|cambria|宋体|仿宋|楷体|serif/i.test(name ?? "");
}
function fontFamily(style, isCJK, options = {}) {
	if (options.fontOverride) return `${quoted(options.fontOverride)}, ${isCJK ? "\"SimSun\", \"宋体\", \"Microsoft YaHei\", serif" : looksSerif(options.fontOverride) ? "\"Times New Roman\", serif" : "\"Arial\", \"Helvetica\", sans-serif"}`;
	return `${quoted(isCJK ? style.fontEastAsia : style.fontLatin)}, ${isCJK ? "\"SimSun\", \"宋体\", \"Microsoft YaHei\", serif" : looksSerif(style.fontLatin) ? "\"Times New Roman\", serif" : "\"Arial\", \"Helvetica\", sans-serif"}`;
}
function effectiveSizePx(style, options = {}) {
	const base = options.sizeOverridePt != null ? ptToPx(options.sizeOverridePt) : style.sizePx;
	return Math.max(1, base * (style.sizeFactor ?? 1));
}
function fontString(style, isCJK, options = {}) {
	const size = effectiveSizePx(style, options);
	return `${style.italic ? "italic " : ""}${style.bold ? "700" : "400"} ${size}px ${fontFamily(style, isCJK, options)}`;
}
function measureText(text, style, isCJK, options = {}) {
	if (!text) return 0;
	const font = fontString(style, isCJK, options);
	const key = `${font}\u0000${text}`;
	const cached = widthCache.get(key);
	if (cached !== void 0) return cached;
	const ctx = getContext();
	ctx.font = font;
	const width = ctx.measureText(text).width;
	if (widthCache.size > 12e4) widthCache.clear();
	widthCache.set(key, width);
	return width;
}
/**
* 中文字体的「单倍行高 / 字号」系数。
*
* 这些值来自 differential/out/calibration.md（WPS PDF 反推）：
* 宋体 13.68/10.5、黑体 15.72/1.15/10.45、仿宋 15.60/1.15/10.45、
* 楷体 15.72/1.15/10.45、微软雅黑 20.76/1.15/10.45。
*
* Canvas 的 `fontBoundingBox*` 对宋体只报 ~0.95em，比 WPS 小一大截；
* 中文字体统一按字体族查表，西文继续用 Canvas。
*/
const CJK_FONT_METRICS = [
	[
		/simsun|宋体|songti/i,
		1.303,
		1
	],
	[
		/simhei|黑体|heiti/i,
		1.308,
		.977
	],
	[
		/fangsong|仿宋/i,
		1.298,
		.977
	],
	[
		/kaiti|楷体/i,
		1.308,
		.989
	],
	[
		/yahei|雅黑/i,
		1.727,
		1.241
	]
];
function cjkMetrics(family) {
	for (const [pattern, lineFactor, ascentFactor] of CJK_FONT_METRICS) if (pattern.test(family ?? "")) return {
		lineFactor,
		ascentFactor
	};
	return {
		lineFactor: 1.303,
		ascentFactor: 1
	};
}
function fontMetrics(style, isCJK, options = {}) {
	const font = fontString(style, isCJK, options);
	const key = `${font}\u0000metrics`;
	const cached = metricsCache.get(key);
	if (cached) return cached;
	const size = effectiveSizePx(style, options);
	let result;
	if (isCJK) {
		const { lineFactor, ascentFactor } = cjkMetrics(style.fontEastAsia);
		const lineHeight = size * lineFactor;
		const ascent = size * ascentFactor;
		result = {
			ascent,
			descent: Math.max(0, lineHeight - ascent),
			lineHeight,
			size
		};
	} else {
		const ctx = getContext();
		ctx.font = font;
		const measured = ctx.measureText("国Ag");
		const ascent = measured.fontBoundingBoxAscent || size * .82;
		const descent = measured.fontBoundingBoxDescent || size * .22;
		result = {
			ascent,
			descent,
			lineHeight: ascent + descent,
			size
		};
	}
	if (metricsCache.size > 4e3) metricsCache.clear();
	metricsCache.set(key, result);
	return result;
}
/**
* 浏览器实际排版时用的字体度量。
*
* `fontMetrics()` 是按 WPS 校准过的**逻辑**度量（宋体 1em ascent），不能直接
* 拿来算 DOM 里文字落在哪：CSS 行盒用的是字体文件自己的 ascent/descent。
* 渲染器需要后者来把行盒基线挪到 `line.baseline`。
*/
function browserFontMetrics(style, isCJK, options = {}) {
	const font = fontString(style, isCJK, options);
	const cached = browserMetricsCache.get(font);
	if (cached) return cached;
	const ctx = getContext();
	ctx.font = font;
	const measured = ctx.measureText("国Ag");
	const size = effectiveSizePx(style, options);
	const result = {
		ascent: measured.fontBoundingBoxAscent || size * .82,
		descent: measured.fontBoundingBoxDescent || size * .22
	};
	if (browserMetricsCache.size > 4e3) browserMetricsCache.clear();
	browserMetricsCache.set(font, result);
	return result;
}
//#endregion
//#region src/edit/hit-test.js
/**
* 用排版结果做命中和几何计算。
*
* 不读 DOM 行：懒渲染的页面没有行元素，但布局数据一直都在。这样点击、拖选、
* 光标绘制在「还没画出来的页」上也能工作。
*
* 坐标约定：`x` / `y` 都是**页面内容盒**坐标（已经过页面边距），`pageIndex` 是页号。
*/
function charCount(text) {
	return Array.from(text ?? "").length;
}
/** 默认测量：与排版使用同一个 Canvas 测量与字体栈。 */
function defaultMeasure(text, style, isCJK) {
	return measureText(text, style, isCJK);
}
/** 一行里文字内容相对 `.line` 左端的起点（含对齐与编号标签）。 */
function lineContentStart(line) {
	return (line.paddingLeft ?? 0) + alignmentOffset(line);
}
/** 第一颗可编辑字符的 x：编号标签占位，光标要落在它后面。 */
function lineTextStart(line) {
	return lineContentStart(line) + (line.labelWidth ?? 0);
}
function lineTextEnd(line) {
	const textWidth = line.naturalWidth - (line.labelWidth ?? 0);
	return lineTextStart(line) + textWidth + (line.letterSpacing ?? 0) * Math.max(0, line.charCount - 1);
}
function alignmentOffset(line) {
	const extra = (line.availableWidth ?? 0) - (line.naturalWidth ?? 0);
	if (extra <= 0) return 0;
	if (line.alignment === "center") return extra / 2;
	if (line.alignment === "right" || line.alignment === "end") return extra;
	return 0;
}
function lineForCaret(block, caret) {
	const lines = block?.lines ?? [];
	if (lines.length === 0) return null;
	let best = lines[0];
	for (const line of lines) {
		const afterStart = compareCaretLike(caret, line.startCaret) >= 0;
		const beforeEnd = compareCaretLike(caret, line.endCaret) <= 0;
		if (afterStart && beforeEnd) return line;
		if (afterStart) best = line;
	}
	return best;
}
function compareCaretLike(a, b) {
	if (!a || !b) return 0;
	if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
	return (a.offset ?? 0) - (b.offset ?? 0);
}
function atomEndX(line, atom, x) {
	return x + (atom.width ?? 0) + (atom.kind === "text" ? (line.letterSpacing ?? 0) * charCount(atom.text) : 0);
}
/** 文本 atom 内第 `count` 个码点处的宽度。 */
function prefixWidth(atom, count, line, measure) {
	if (count <= 0) return 0;
	return (measure(Array.from(atom.text).slice(0, count).join(""), atom.style, atom.isCJK) ?? 0) + (line.letterSpacing ?? 0) * count;
}
/**
* 光标在某个（已知属于该行的）行里的 x。
* 光标不在这一行时由调用方处理。
*/
function caretX(line, caret, measure = defaultMeasure) {
	let x = lineContentStart(line);
	if (!caret) return x;
	const atoms = line.atoms ?? [];
	for (const atom of atoms) {
		if (atom.itemIndex == null || atom.itemIndex < 0) {
			x += atom.width ?? 0;
			continue;
		}
		if (caret.itemIndex < atom.itemIndex) return x;
		if (caret.itemIndex > atom.itemIndex) {
			x = atomEndX(line, atom, x);
			continue;
		}
		if (atom.kind === "text") {
			const start = atom.charStart ?? 0;
			const end = atom.charEnd ?? start + charCount(atom.text);
			if (caret.offset >= end) {
				x = atomEndX(line, atom, x);
				continue;
			}
			if (caret.offset <= start) return x;
			return x + prefixWidth(atom, caret.offset - start, line, measure);
		}
		return x;
	}
	return x;
}
/** 光标矩形（页面内容盒坐标）。 */
function caretRect(layout, caret, measure = defaultMeasure) {
	if (!caret) return null;
	const block = layout.keyToBlock?.get(caret.blockKey) ?? layout.blocks.find((candidate) => candidate.key === caret.blockKey);
	if (!block) return null;
	const line = lineForCaret(block, caret);
	if (!line) return null;
	const x = (line.tableOriginX ?? 0) + caretX(line, caret, measure);
	return {
		pageIndex: line.pageIndex,
		x,
		y: (line.tableOriginY ?? 0) + line.top,
		width: 1,
		height: line.height
	};
}
/** 一页里所有视觉行（正文行 + 表格单元格行），都带页面内容盒坐标的原点。 */
function visualLines(page, layout) {
	const entries = [];
	const items = page.items ?? page.lines.map((line) => ({
		kind: "line",
		line
	}));
	for (const item of items) {
		if (item.kind === "line") {
			const line = item.line;
			const block = layout.keyToBlock?.get(line.blockKey) ?? layout.blocks[line.paragraphIndex];
			entries.push({
				line,
				block,
				originX: 0,
				originY: 0
			});
			continue;
		}
		if (item.kind !== "table-row") continue;
		for (const cell of item.row.cells) {
			if (cell.hidden) continue;
			const originX = item.table.x + cell.x + (cell.margins?.left ?? 0);
			const originY = item.top + (cell.contentTop ?? 0);
			for (const line of cell.lines ?? []) entries.push({
				line,
				block: layout.keyToBlock?.get(line.blockKey),
				originX,
				originY
			});
		}
	}
	return entries;
}
/**
* 文本点 → 光标。
*
* `pageIndex` 已确定；`x` / `y` 是页面内容盒坐标。`y` 落在行间时取最近的一行。
*/
function hitTest(layout, pageIndex, x, y, measure = defaultMeasure) {
	const page = layout.pages[pageIndex];
	if (!page) return null;
	const entries = visualLines(page, layout).filter((entry) => entry.block);
	if (entries.length === 0) return null;
	const scored = entries.map((candidate) => {
		const top = candidate.originY + candidate.line.top;
		const left = candidate.originX + (candidate.line.paddingLeft ?? 0);
		return {
			...candidate,
			top,
			bottom: top + candidate.line.height,
			left,
			right: left + candidate.line.availableWidth
		};
	});
	const vertical = scored.filter((candidate) => y >= candidate.top && y <= candidate.bottom);
	const dx = (candidate) => x < candidate.left ? candidate.left - x : x > candidate.right ? x - candidate.right : 0;
	let entry;
	if (vertical.length > 0) {
		entry = vertical.find((candidate) => dx(candidate) === 0);
		if (!entry) entry = vertical.reduce((best, candidate) => dx(candidate) < dx(best) ? candidate : best);
	} else {
		const dy = (candidate) => y < candidate.top ? candidate.top - y : y - candidate.bottom;
		entry = scored.reduce((best, candidate) => {
			const distance = dy(candidate);
			const bestDistance = dy(best);
			if (distance < bestDistance) return candidate;
			if (distance === bestDistance && dx(candidate) < dx(best)) return candidate;
			return best;
		});
	}
	const { line, block, originX } = entry;
	const localX = x - originX;
	const toCaret = (itemIndex, offset) => ({
		blockKey: block.key,
		itemIndex,
		offset
	});
	if (localX <= lineTextStart(line)) return toCaret(line.startCaret.itemIndex, line.startCaret.offset);
	let cursor = lineContentStart(line);
	for (const atom of line.atoms ?? []) {
		if (atom.itemIndex == null || atom.itemIndex < 0) {
			cursor += atom.width ?? 0;
			continue;
		}
		const width = atom.width ?? 0;
		if (localX <= cursor + width) {
			if (atom.kind === "text") {
				const chars = Array.from(atom.text);
				let local = chars.length;
				for (let count = 0; count <= chars.length; count += 1) {
					const left = cursor + prefixWidth(atom, count, line, measure);
					const right = cursor + prefixWidth(atom, count + 1, line, measure);
					if (localX < right) {
						local = localX - left <= right - localX ? count : count + 1;
						break;
					}
				}
				local = Math.max(0, Math.min(local, chars.length));
				return toCaret(atom.itemIndex, (atom.charStart ?? 0) + local);
			}
			return localX < cursor + width / 2 ? toCaret(atom.itemIndex, 0) : toCaret(atom.itemIndex + 1, 0);
		}
		cursor += width;
	}
	return toCaret(line.endCaret.itemIndex, line.endCaret.offset);
}
/** 选区矩形（页面内容盒坐标）。跨页时每页各自返回。 */
function selectionRects(layout, start, end, measure = defaultMeasure) {
	if (!start || !end) return [];
	if (start.blockKey === end.blockKey) {
		const block = layout.keyToBlock?.get(start.blockKey);
		if (!block?.lines) return [];
		const forward = compareCaretLike(start, end) <= 0;
		const fromCaret = forward ? start : end;
		const toCaret = forward ? end : start;
		const rects = [];
		for (const line of block.lines) {
			if (compareCaretLike(fromCaret, line.endCaret) > 0) continue;
			if (compareCaretLike(line.startCaret, toCaret) > 0) continue;
			const x1 = compareCaretLike(fromCaret, line.startCaret) <= 0 ? lineTextStart(line) : caretX(line, fromCaret, measure);
			const x2 = compareCaretLike(toCaret, line.endCaret) >= 0 ? lineTextEnd(line) : caretX(line, toCaret, measure);
			if (x2 <= x1 + .5) continue;
			rects.push({
				pageIndex: line.pageIndex,
				x: (line.tableOriginX ?? 0) + x1,
				y: (line.tableOriginY ?? 0) + line.top,
				width: x2 - x1,
				height: line.height
			});
		}
		return rects;
	}
	const startBlock = layout.keyToBlock?.get(start.blockKey);
	const endBlock = layout.keyToBlock?.get(end.blockKey);
	if (startBlock?.container && endBlock?.container && startBlock.container.cell === endBlock.container.cell) {
		const blocks = startBlock.container.cell.blocks;
		const a = startBlock.container.index;
		const b = endBlock.container.index;
		const forward = a < b || a === b && compareCaretLike(start, end) <= 0;
		const fromIndex = forward ? a : b;
		const toIndex = forward ? b : a;
		const fromCaret = forward ? start : end;
		const toCaret = forward ? end : start;
		const rects = [];
		for (let index = fromIndex; index <= toIndex; index += 1) {
			const block = blocks[index];
			for (const line of block?.lines ?? []) {
				if (fromIndex === toIndex) continue;
				const startsBeforeLineEnd = fromIndex < index || compareCaretLike(fromCaret, line.endCaret) <= 0;
				const endsAfterLineStart = toIndex > index || compareCaretLike(line.startCaret, toCaret) <= 0;
				if (!startsBeforeLineEnd || !endsAfterLineStart) continue;
				const x1 = fromIndex < index || compareCaretLike(fromCaret, line.startCaret) <= 0 ? lineTextStart(line) : caretX(line, fromCaret, measure);
				const x2 = toIndex > index || compareCaretLike(toCaret, line.endCaret) >= 0 ? lineTextEnd(line) : caretX(line, toCaret, measure);
				if (x2 <= x1 + .5) continue;
				rects.push({
					pageIndex: line.pageIndex,
					x: (line.tableOriginX ?? 0) + x1,
					y: (line.tableOriginY ?? 0) + line.top,
					width: x2 - x1,
					height: line.height
				});
			}
		}
		return rects;
	}
	const startIndex = layout.keyToIndex?.get(start.blockKey);
	const endIndex = layout.keyToIndex?.get(end.blockKey);
	if (startIndex == null || endIndex == null) return [];
	const forward = startIndex < endIndex || startIndex === endIndex && compareCaretLike(start, end) <= 0;
	const fromIndex = forward ? startIndex : endIndex;
	const toIndex = forward ? endIndex : startIndex;
	const fromCaret = forward ? start : end;
	const toCaret = forward ? end : start;
	const rects = [];
	for (let index = fromIndex; index <= toIndex; index += 1) {
		const block = layout.blocks[index];
		if (!block || block.editable === false || block.synthetic != null) continue;
		for (const line of block.lines ?? []) {
			const startsBeforeLineEnd = fromIndex < index || fromIndex === index && compareCaretLike(fromCaret, line.endCaret) <= 0;
			const endsAfterLineStart = toIndex > index || toIndex === index && compareCaretLike(line.startCaret, toCaret) <= 0;
			if (!startsBeforeLineEnd || !endsAfterLineStart) continue;
			const x1 = fromIndex < index || fromIndex === index && compareCaretLike(fromCaret, line.startCaret) <= 0 ? lineTextStart(line) : caretX(line, fromCaret, measure);
			const x2 = toIndex > index || toIndex === index && compareCaretLike(toCaret, line.endCaret) >= 0 ? lineTextEnd(line) : caretX(line, toCaret, measure);
			if (x2 <= x1 + .5) continue;
			rects.push({
				pageIndex: line.pageIndex,
				x: x1,
				y: line.top,
				width: x2 - x1,
				height: line.height
			});
		}
	}
	return rects;
}
/**
* 屏幕坐标 → `{ pageIndex, x, y }`（页面内容盒坐标）。
*
* 每页的 `getBoundingClientRect()` 已经把缩放和滚动算进去了，比手算页间距稳。
*/
function pagePointFromClient({ clientX, clientY, renderer, section, zoom = 1 }) {
	const pages = renderer?.pageElements ?? [];
	if (pages.length === 0) return null;
	let pageIndex = 0;
	let best = Infinity;
	pages.forEach((element, index) => {
		const rect = element.getBoundingClientRect();
		if (clientY >= rect.top && clientY <= rect.bottom) {
			pageIndex = index;
			best = 0;
		} else {
			const distance = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
			if (distance < best) {
				best = distance;
				pageIndex = index;
			}
		}
	});
	const rect = pages[pageIndex].getBoundingClientRect();
	return {
		pageIndex,
		x: (clientX - rect.left) / zoom - (section.margin?.left ?? 0),
		y: (clientY - rect.top) / zoom - (section.margin?.top ?? 0)
	};
}
/** 所有视觉行，按页、按 top 顺序；上下键用它跨段、跨页移动。 */
function flatLines(layout) {
	const result = [];
	layout.blocks.forEach((block, blockIndex) => {
		if (block.editable === false || block.synthetic != null) return;
		for (const line of block.lines ?? []) result.push({
			block,
			blockIndex,
			line
		});
	});
	result.sort((a, b) => {
		if (a.line.pageIndex !== b.line.pageIndex) return a.line.pageIndex - b.line.pageIndex;
		return a.line.top - b.line.top;
	});
	return result;
}
/** 上下移动：保持目标列，找相邻视觉行。 */
function verticalCaret(layout, caret, direction, desiredX, measure = defaultMeasure) {
	const flat = flatLines(layout);
	if (flat.length === 0) return null;
	const rect = caretRect(layout, caret, measure);
	let current = -1;
	if (rect) current = flat.findIndex((entry) => entry.line.pageIndex === rect.pageIndex && rect.y >= entry.line.top - .5 && rect.y < entry.line.top + entry.line.height);
	if (current < 0) return null;
	const target = flat[current + direction];
	if (!target) return null;
	const x = desiredX ?? rect.x;
	return hitTest(layout, target.line.pageIndex, x, target.line.top + Math.min(target.line.height / 2, 4), measure);
}
//#endregion
//#region src/edit/overlay.js
/**
* 光标、选区与输入法预览的绘制层。
*
* 每页一个 `.edit-overlay`，挂在 `.page` 上（与 `.page-content` 平级），所以
* `renderPageContent` 整块重画时它不会跟着消失。坐标是页面坐标（含页边距）。
*/
const OVERLAY_CLASS = "edit-overlay";
const SELECTION_CLASS = "edit-selection";
const CARET_CLASS = "edit-caret";
const COMPOSITION_CLASS = "edit-composition";
function makeDiv(className) {
	const element = document.createElement("div");
	element.className = className;
	return element;
}
function createOverlay({ renderer, section, onCaretMoved }) {
	const overlays = /* @__PURE__ */ new Map();
	let disposed = false;
	const marginLeft = section?.margin?.left ?? 0;
	const marginTop = section?.margin?.top ?? 0;
	function overlayFor(pageIndex) {
		const existing = overlays.get(pageIndex);
		if (existing && existing.isConnected) return existing;
		const page = renderer.elementAt(pageIndex);
		if (!page) return null;
		const overlay = makeDiv(OVERLAY_CLASS);
		page.appendChild(overlay);
		overlays.set(pageIndex, overlay);
		return overlay;
	}
	function clear(overlay) {
		overlay.replaceChildren();
	}
	function draw(state) {
		if (disposed) return;
		const layout = state.layout;
		if (!layout) return;
		for (const overlay of overlays.values()) clear(overlay);
		const rects = state.selection?.anchor && state.selection?.focus ? selectionRects(layout, state.selection.anchor, state.selection.focus) : [];
		const grouped = /* @__PURE__ */ new Map();
		for (const rect of rects) {
			const list = grouped.get(rect.pageIndex) ?? [];
			list.push(rect);
			grouped.set(rect.pageIndex, list);
		}
		const caret = state.caret ? caretRect(layout, state.caret) : null;
		if (caret) {
			const list = grouped.get(caret.pageIndex) ?? [];
			grouped.set(caret.pageIndex, list);
		}
		for (const [pageIndex, pageRects] of grouped.entries()) {
			const overlay = overlayFor(pageIndex);
			if (!overlay) continue;
			for (const rect of pageRects) {
				if (!rect.width && !rect.height) continue;
				const element = makeDiv(SELECTION_CLASS);
				element.style.left = `${marginLeft + rect.x}px`;
				element.style.top = `${marginTop + rect.y}px`;
				element.style.width = `${rect.width}px`;
				element.style.height = `${rect.height}px`;
				overlay.appendChild(element);
			}
		}
		if (caret) {
			const overlay = overlayFor(caret.pageIndex);
			if (overlay) {
				const element = makeDiv(CARET_CLASS);
				element.style.left = `${marginLeft + caret.x}px`;
				element.style.top = `${marginTop + caret.y}px`;
				element.style.height = `${caret.height}px`;
				overlay.appendChild(element);
				onCaretMoved?.({
					pageIndex: caret.pageIndex,
					x: marginLeft + caret.x,
					y: marginTop + caret.y,
					height: caret.height
				});
			}
			if (state.composition?.text) {
				const element = document.createElement("span");
				element.className = COMPOSITION_CLASS;
				element.textContent = state.composition.text;
				if (state.composition.style) {
					const style = state.composition.style;
					element.style.fontFamily = style.fontFamily ?? "";
					element.style.fontSize = style.fontSize ?? "";
					element.style.lineHeight = `${caret.height}px`;
					element.style.color = style.color ?? "";
				}
				element.style.left = `${marginLeft + caret.x}px`;
				element.style.top = `${marginTop + caret.y}px`;
				element.style.minHeight = `${caret.height}px`;
				overlay.appendChild(element);
			}
		}
	}
	function destroy() {
		disposed = true;
		for (const overlay of overlays.values()) overlay.remove();
		overlays.clear();
	}
	return {
		draw,
		destroy
	};
}
//#endregion
//#region src/edit/editor.js
/**
* 编辑器的「视图侧」：光标、选区、焦点与键盘/指针。
*
* 输入与 XML 修改不在这里 —— M5.2 起由 `operations.js` 接管；这一层只负责
* 「用户在哪个位置、看到什么」，并把位置维护成与布局无关的 `{blockKey,itemIndex,offset}`。
*/
function collapsed(selection) {
	if (!selection?.anchor || !selection?.focus) return true;
	return selection.anchor.blockKey === selection.focus.blockKey && selection.anchor.itemIndex === selection.focus.itemIndex && selection.anchor.offset === selection.focus.offset;
}
function createEditor(options) {
	const { pagesElement, viewport, ime } = options;
	let doc = options.doc;
	let layout = options.layout;
	let renderer = options.renderer;
	let section = options.section;
	const getZoom = options.getZoom ?? (() => 1);
	let selection = null;
	let desiredX = null;
	let dragging = false;
	let overlay = null;
	/** 输入法组合：{ selection, text }；只画预览，不碰 XML。 */
	let composition = null;
	let lastCompositionEnd = 0;
	function serializeXml() {
		return new XMLSerializer().serializeToString(doc.source.documentXml);
	}
	function pointOf(caret) {
		const block = blockByKey(doc, caret?.blockKey);
		if (!block) return null;
		return {
			blockIndex: block.index,
			offset: blockTextOffset(block, caret)
		};
	}
	function caretOfPoint(point) {
		if (!point) return null;
		const index = Math.max(0, Math.min(point.blockIndex ?? 0, doc.blocks.length - 1));
		let block = doc.blocks[index];
		if (!block || !isEditableBlock(block)) block = doc.blocks.find(isEditableBlock) ?? null;
		if (!block) return null;
		return blockOffsetCaret(block, point.offset ?? 0);
	}
	const history = createHistory({ initialXml: serializeXml() });
	doc.dirty = false;
	function editableRange() {
		const blocks = doc.blocks.filter(isEditableBlock);
		if (blocks.length === 0) return null;
		return {
			start: blockStartCaret(blocks[0]),
			end: blockEndCaret(blocks[blocks.length - 1])
		};
	}
	function compositionStyle() {
		if (!selection) return null;
		const block = blockByKey(doc, selection.focus.blockKey);
		const style = (block?.items?.[selection.focus.itemIndex])?.style ?? block?.defaultStyle;
		if (!style) return null;
		return {
			fontFamily: fontFamily(style, true),
			fontSize: `${effectiveSizePx(style)}px`,
			color: style.color ?? ""
		};
	}
	function draw() {
		if (!overlay) return;
		const caret = selection && (collapsed(selection) || composition) ? selection.focus : null;
		overlay.draw({
			layout,
			selection: composition ? null : selection,
			caret,
			composition: composition ? {
				text: composition.text,
				style: compositionStyle()
			} : null
		});
	}
	function positionIme() {
		if (!ime || !selection) return;
		const rect = caretRect(layout, selection.focus);
		if (!rect) {
			ime.style.left = "-1000px";
			ime.style.top = "-1000px";
			return;
		}
		const page = renderer.elementAt(rect.pageIndex);
		if (!page) return;
		const pageRect = page.getBoundingClientRect();
		const zoom = getZoom();
		const left = pageRect.left + ((section.margin?.left ?? 0) + rect.x) * zoom;
		const top = pageRect.top + ((section.margin?.top ?? 0) + rect.y) * zoom;
		ime.style.left = `${Math.round(left)}px`;
		ime.style.top = `${Math.round(top)}px`;
		ime.style.height = `${Math.max(1, Math.round(rect.height * zoom))}px`;
	}
	function scrollCaretIntoView() {
		if (!selection) return;
		const rect = caretRect(layout, selection.focus);
		if (!rect) return;
		const page = renderer.elementAt(rect.pageIndex);
		if (!page) return;
		const zoom = getZoom();
		const pageRect = page.getBoundingClientRect();
		const viewRect = viewport.getBoundingClientRect();
		const top = pageRect.top + ((section.margin?.top ?? 0) + rect.y) * zoom;
		const bottom = top + Math.max(rect.height, 12) * zoom;
		const padding = 28;
		if (top < viewRect.top + padding) viewport.scrollTop -= viewRect.top + padding - top;
		else if (bottom > viewRect.bottom - padding) viewport.scrollTop += bottom - (viewRect.bottom - padding);
	}
	function setSelection(next, { extend = false, scroll = true } = {}) {
		if (!next?.focus) return;
		if (extend && selection) selection = {
			anchor: normalizeCaret(doc, selection.anchor) ?? selection.anchor,
			focus: normalizeCaret(doc, next.focus)
		};
		else {
			const caret = normalizeCaret(doc, next.focus);
			selection = caret ? {
				anchor: caret,
				focus: caret
			} : null;
		}
		draw();
		positionIme();
		if (scroll) scrollCaretIntoView();
	}
	function setCaret(caret, options = {}) {
		setSelection({ focus: caret }, options);
	}
	function ensureFocus() {
		if (!ime) return;
		if (document.activeElement !== ime) ime.focus({ preventScroll: true });
	}
	let editQueue = Promise.resolve();
	function enqueueEdit(task) {
		editQueue = editQueue.then(task).catch((error) => {
			options.onError?.(error);
		});
	}
	async function settleEdit(result) {
		if (!result) return;
		if (result.unsupported) {
			options.onUnsupported?.(result.unsupported);
			return;
		}
		if (result.merge) {
			options.onMerge?.(result);
			return;
		}
		if (!result.caretAfter) return;
		await options.onEdited?.(result);
		selection = result.selectionAfter ? {
			anchor: result.selectionAfter.anchor,
			focus: result.selectionAfter.focus
		} : {
			anchor: result.caretAfter,
			focus: result.caretAfter
		};
		desiredX = null;
		draw();
		positionIme();
		scrollCaretIntoView();
	}
	/**
	* 一次用户动作 = 一个入队任务 + 一条历史记录。
	*
	* `beforeXml` 在任务之前取，`afterXml` 在重排之后取；两字符串相同就不记
	* （例如在空段末尾按 Delete）。
	*/
	function runEdit(kind, task) {
		enqueueEdit(async () => {
			if (!selection) return;
			const beforeXml = serializeXml();
			const selectionBefore = pointOf(selection.focus);
			const result = await task();
			if (!result) return;
			if (result.unsupported) {
				options.onUnsupported?.(result.unsupported);
				return;
			}
			if (result.merge) {
				options.onMerge?.(result);
				return;
			}
			if (!result.caretAfter) return;
			recountStats(doc);
			await settleEdit(result);
			const afterXml = serializeXml();
			if (afterXml === beforeXml) return;
			history.record({
				beforeXml,
				afterXml,
				selectionBefore,
				selectionAfter: pointOf(selection?.focus),
				blockIndex: selectionBefore?.blockIndex ?? 0,
				kind,
				time: Date.now()
			});
			doc.dirty = history.isDirty(afterXml);
			options.onDirtyChange?.(doc.dirty);
		});
	}
	function insertTextData(text) {
		runEdit("text", async () => {
			const current = selection;
			return collapsed(current) ? insertTextAt(doc, current.focus, text) : replaceSelection(doc, current, text);
		});
	}
	function deleteBackwardData() {
		runEdit("text", async () => {
			const current = selection;
			const result = collapsed(current) ? await deleteBackward(doc, current.focus) : await replaceSelection(doc, current, "");
			if (result?.merge === "backward") return await mergeWithPrevious(doc, result.block) ?? null;
			return result;
		});
	}
	function deleteForwardData() {
		runEdit("text", async () => {
			const current = selection;
			const result = collapsed(current) ? await deleteForward(doc, current.focus) : await replaceSelection(doc, current, "");
			if (result?.merge === "forward") return await mergeWithNext(doc, result.block) ?? null;
			return result;
		});
	}
	function enterData(soft) {
		runEdit("struct", async () => {
			let current = selection;
			if (!collapsed(current)) {
				const deleted = await replaceSelection(doc, current, "");
				if (!deleted || deleted.unsupported) return deleted;
				current = {
					anchor: deleted.caretAfter,
					focus: deleted.caretAfter
				};
			}
			return soft ? insertSoftBreak(doc, current.focus) : splitParagraph(doc, current.focus);
		});
	}
	function copySelection(event) {
		if (!selection || collapsed(selection)) return false;
		const text = selectionText(doc, selection);
		if (!text) return false;
		event.clipboardData?.setData("text/plain", text);
		event.preventDefault();
		return true;
	}
	function cutSelection(event) {
		if (!copySelection(event)) return;
		const current = selection;
		runEdit("text", async () => replaceSelection(doc, current, ""));
	}
	function onCopy(event) {
		copySelection(event);
	}
	function onCut(event) {
		cutSelection(event);
	}
	function pasteText(text) {
		if (!text) return;
		const limit = 1e6;
		const clipped = text.length > limit ? text.slice(0, limit) : text;
		if (clipped !== text) options.onUnsupported?.("paste-large");
		runEdit("paste", async () => {
			let current = selection;
			if (!collapsed(current)) {
				const deleted = await replaceSelection(doc, current, "");
				if (!deleted || deleted.unsupported) return deleted;
				current = {
					anchor: deleted.caretAfter,
					focus: deleted.caretAfter
				};
			}
			return insertPlainText(doc, current.focus, clipped);
		});
	}
	function onPaste(event) {
		const text = event.clipboardData?.getData("text/plain") ?? "";
		event.preventDefault();
		if (text) pasteText(text);
	}
	async function restoreSnapshot(entry, useAfter) {
		const xml = useAfter ? entry.afterXml : entry.beforeXml;
		const point = useAfter ? entry.selectionAfter : entry.selectionBefore;
		await replaceDocumentXml(doc, xml);
		await options.onEdited?.({
			dirtyKeys: doc.blocks.map((block) => block.key),
			caretAfter: null
		});
		const caret = caretOfPoint(point);
		selection = caret ? {
			anchor: caret,
			focus: caret
		} : null;
		desiredX = null;
		draw();
		positionIme();
		if (caret) scrollCaretIntoView();
		doc.dirty = history.isDirty(serializeXml());
		options.onDirtyChange?.(doc.dirty);
	}
	function undoEdit() {
		enqueueEdit(async () => {
			const entry = history.undo();
			if (entry) await restoreSnapshot(entry, false);
		});
	}
	function redoEdit() {
		enqueueEdit(async () => {
			const entry = history.redo();
			if (entry) await restoreSnapshot(entry, true);
		});
	}
	function caretFromEvent(event) {
		const point = pagePointFromClient({
			clientX: event.clientX,
			clientY: event.clientY,
			renderer,
			section,
			zoom: getZoom()
		});
		if (!point) return null;
		return hitTest(layout, point.pageIndex, point.x, point.y);
	}
	function onPointerDown(event) {
		if (event.button !== 0) return;
		const caret = caretFromEvent(event);
		if (!caret) return;
		const targetBlock = blockByKey(doc, caret.blockKey);
		if (!targetBlock || !isEditableBlock(targetBlock)) return;
		event.preventDefault();
		ensureFocus();
		if (event.detail >= 3) {
			const block = blockByKey(doc, caret.blockKey);
			if (block && isEditableBlock(block)) {
				setSelection({
					anchor: blockStartCaret(block),
					focus: blockEndCaret(block)
				});
				dragging = false;
				return;
			}
		}
		dragging = true;
		desiredX = null;
		try {
			pagesElement.setPointerCapture?.(event.pointerId);
		} catch {}
		setSelection({ focus: caret }, { extend: event.shiftKey });
	}
	function onPointerMove(event) {
		if (!dragging) return;
		const caret = caretFromEvent(event);
		if (!caret) return;
		event.preventDefault();
		setSelection({ focus: caret }, {
			extend: true,
			scroll: false
		});
	}
	function onPointerUp(event) {
		if (!dragging) return;
		dragging = false;
		try {
			pagesElement.releasePointerCapture?.(event.pointerId);
		} catch {}
	}
	function onDoubleClick(event) {
		const caret = caretFromEvent(event);
		if (!caret) return;
		const block = blockByKey(doc, caret.blockKey);
		if (!block || !isEditableBlock(block)) return;
		event.preventDefault();
		ensureFocus();
		const range = wordRangeAt(doc, caret);
		if (range) setSelection(range);
	}
	function currentLine() {
		if (!selection) return null;
		const block = layout.keyToBlock?.get(selection.focus.blockKey) ?? layout.blocks.find((candidate) => candidate.key === selection.focus.blockKey);
		if (!block) return null;
		return {
			block,
			line: lineForCaret(block, selection.focus)
		};
	}
	function moveVertical(direction, extend) {
		if (!selection) return;
		const rect = caretRect(layout, selection.focus);
		if (!rect) return;
		const target = verticalCaret(layout, selection.focus, direction, desiredX ?? rect.x);
		if (!target) return;
		if (desiredX == null) desiredX = rect.x;
		setSelection({ focus: target }, {
			extend,
			scroll: false
		});
	}
	function moveLineEdge(toEnd, extend) {
		const current = currentLine();
		if (!current?.line) return;
		const caret = toEnd ? current.line.endCaret : current.line.startCaret;
		setSelection({ focus: {
			blockKey: current.block.key,
			...caret
		} }, {
			extend,
			scroll: false
		});
	}
	function movePage(direction, extend) {
		const rect = caretRect(layout, selection.focus);
		if (!rect) return;
		const targetPage = Math.max(0, Math.min(layout.pages.length - 1, rect.pageIndex + direction));
		if (targetPage === rect.pageIndex) return;
		const target = hitTest(layout, targetPage, rect.x, 4);
		if (target) setSelection({ focus: target }, {
			extend,
			scroll: false
		});
	}
	function onKeyDown(event) {
		if (!selection || event.isComposing) return;
		const mod = event.ctrlKey || event.metaKey;
		const extend = event.shiftKey;
		let handled = true;
		switch (event.key) {
			case "ArrowLeft":
				if (!mod) setSelection({ focus: stepCaret(doc, selection.focus, -1) }, { extend });
				break;
			case "ArrowRight":
				if (!mod) setSelection({ focus: stepCaret(doc, selection.focus, 1) }, { extend });
				break;
			case "ArrowUp":
				moveVertical(-1, extend);
				break;
			case "ArrowDown":
				moveVertical(1, extend);
				break;
			case "Home":
				if (mod) {
					const block = blockByKey(doc, selection.focus.blockKey);
					if (block) setSelection({ focus: blockStartCaret(block) }, { extend });
				} else moveLineEdge(false, extend);
				break;
			case "End":
				if (mod) {
					const block = blockByKey(doc, selection.focus.blockKey);
					if (block) setSelection({ focus: blockEndCaret(block) }, { extend });
				} else moveLineEdge(true, extend);
				break;
			case "PageUp":
				movePage(-1, extend);
				break;
			case "PageDown":
				movePage(1, extend);
				break;
			case "a":
			case "A":
				if (mod) {
					const range = editableRange();
					if (range) setSelection(range);
				} else handled = false;
				break;
			case "z":
			case "Z":
				if (mod) if (event.shiftKey) redoEdit();
				else undoEdit();
				else handled = false;
				break;
			case "y":
			case "Y":
				if (mod) redoEdit();
				else handled = false;
				break;
			case "s":
			case "S":
				if (mod) options.onSave?.();
				else handled = false;
				break;
			case "Escape":
				setSelection({ focus: selection.focus });
				break;
			case "Tab": break;
			case "Backspace":
				deleteBackwardData();
				break;
			case "Delete":
				deleteForwardData();
				break;
			case "Enter":
				enterData(event.shiftKey);
				break;
			default: handled = false;
		}
		if (handled) {
			event.preventDefault();
			desiredX = null;
		}
	}
	function cloneSelection(value) {
		if (!value?.anchor || !value?.focus) return null;
		return {
			anchor: { ...value.anchor },
			focus: { ...value.focus }
		};
	}
	function onCompositionStart() {
		if (!selection) return;
		composition = {
			selection: cloneSelection(selection),
			text: ""
		};
		draw();
	}
	function onCompositionUpdate(event) {
		if (!composition) {
			if (!selection) return;
			composition = {
				selection: cloneSelection(selection),
				text: ""
			};
		}
		composition.text = event.data ?? "";
		draw();
	}
	function onCompositionEnd(event) {
		const pending = composition;
		composition = null;
		lastCompositionEnd = performance.now();
		if (ime) ime.value = "";
		if (!pending?.selection) {
			draw();
			return;
		}
		const text = event.data ?? pending.text ?? "";
		if (!text) {
			draw();
			return;
		}
		const base = pending.selection;
		enqueueEdit(async () => {
			await settleEdit(collapsed(base) ? await insertTextAt(doc, base.focus, text) : await replaceSelection(doc, base, text));
		});
	}
	function onBeforeInput(event) {
		if (event.isComposing) return;
		if (event.inputType === "insertCompositionText") {
			event.preventDefault();
			return;
		}
		if (event.inputType === "insertText" && performance.now() - lastCompositionEnd < 80) {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		switch (event.inputType) {
			case "insertText":
				if (typeof event.data === "string" && event.data) insertTextData(event.data);
				break;
			case "deleteContentBackward":
			case "deleteWordBackward":
				deleteBackwardData();
				break;
			case "deleteContentForward":
			case "deleteWordForward":
				deleteForwardData();
				break;
			case "insertParagraph":
				enterData(false);
				break;
			case "insertLineBreak":
				enterData(true);
				break;
			case "historyUndo":
				undoEdit();
				break;
			case "historyRedo":
				redoEdit();
				break;
			case "insertFromPaste": {
				const text = event.dataTransfer?.getData("text/plain") ?? (typeof event.data === "string" ? event.data : "");
				if (text) pasteText(text);
				break;
			}
			case "deleteByCut":
				if (selection && !collapsed(selection)) {
					const current = selection;
					runEdit("text", async () => replaceSelection(doc, current, ""));
				}
				break;
			default: break;
		}
	}
	function update(next) {
		if (next.doc) doc = next.doc;
		if (next.layout) layout = next.layout;
		if (next.section) section = next.section;
		if (next.renderer && next.renderer !== renderer) {
			renderer = next.renderer;
			overlay?.destroy();
			overlay = createOverlay({
				renderer,
				section
			});
		} else if (!overlay) overlay = createOverlay({
			renderer,
			section
		});
		if (selection) {
			const anchor = normalizeCaret(doc, selection.anchor);
			const focus = normalizeCaret(doc, selection.focus);
			selection = anchor && focus ? {
				anchor,
				focus
			} : null;
		}
		draw();
		positionIme();
	}
	function destroy() {
		overlay?.destroy();
		overlay = null;
		pagesElement.removeEventListener("pointerdown", onPointerDown);
		pagesElement.removeEventListener("pointermove", onPointerMove);
		pagesElement.removeEventListener("pointerup", onPointerUp);
		pagesElement.removeEventListener("pointercancel", onPointerUp);
		pagesElement.removeEventListener("dblclick", onDoubleClick);
		ime?.removeEventListener("keydown", onKeyDown);
		ime?.removeEventListener("beforeinput", onBeforeInput);
		ime?.removeEventListener("compositionstart", onCompositionStart);
		ime?.removeEventListener("compositionupdate", onCompositionUpdate);
		ime?.removeEventListener("compositionend", onCompositionEnd);
		ime?.removeEventListener("copy", onCopy);
		ime?.removeEventListener("cut", onCut);
		ime?.removeEventListener("paste", onPaste);
	}
	pagesElement.addEventListener("pointerdown", onPointerDown);
	pagesElement.addEventListener("pointermove", onPointerMove);
	pagesElement.addEventListener("pointerup", onPointerUp);
	pagesElement.addEventListener("pointercancel", onPointerUp);
	pagesElement.addEventListener("dblclick", onDoubleClick);
	if (ime) {
		ime.addEventListener("keydown", onKeyDown);
		ime.addEventListener("beforeinput", onBeforeInput);
		ime.addEventListener("compositionstart", onCompositionStart);
		ime.addEventListener("compositionupdate", onCompositionUpdate);
		ime.addEventListener("compositionend", onCompositionEnd);
		ime.addEventListener("copy", onCopy);
		ime.addEventListener("cut", onCut);
		ime.addEventListener("paste", onPaste);
	}
	overlay = createOverlay({
		renderer,
		section
	});
	update({});
	return {
		update,
		destroy,
		focus: ensureFocus,
		getSelection: () => selection,
		setCaret,
		setSelection,
		selectAll(changed = true) {
			const range = editableRange();
			if (range) setSelection(range, { extend: false });
			else if (!changed) draw();
		},
		redraw: draw,
		/**
		* 给当前选区设置字符格式。
		* 返回 false 表示没有可用选区（调用方负责提示）。
		*/
		insertTable(rows, cols) {
			if (!selection) {
				options.onUnsupported?.("empty-selection");
				return false;
			}
			const caret = { ...selection.focus };
			runEdit("table", () => insertTableAt(doc, caret, rows, cols));
			return true;
		},
		formatSelection(format) {
			if (!selection || collapsed(selection)) {
				options.onUnsupported?.("empty-selection");
				return false;
			}
			const current = {
				anchor: { ...selection.anchor },
				focus: { ...selection.focus }
			};
			runEdit("format", () => applyRunFormat(doc, current, format));
			return true;
		},
		undo: undoEdit,
		redo: redoEdit,
		markSaved() {
			history.markSaved(serializeXml());
			doc.dirty = false;
			options.onDirtyChange?.(false);
		}
	};
}
//#endregion
//#region src/layout/atoms.js
/**
* 文本 → 排版原子。
*
* 原子是行排版的最小单位：
*
* * 中文按**单字**
* * 西文按**词**（`Calibri` 不拆）
* * 空格、制表符、图片各自一个原子
*
* 每个原子自带宽度与行高度量，行排版只做加法，不再回头碰字体。
*/
const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/u;
const WHITESPACE_RE = /\s/u;
const WORD_CHAR_RE = /[A-Za-z0-9_'’-]/;
/**
* 行首禁则：这些字符不能出现在一行的开头。
* 中西文混排时两边都要管，否则「，」跑到行首会被用户一眼看出来。
*/
const NO_START = new Set(Array.from("，。、；：？！）］｝〉》」』】〙〗〟’”｠»,.;:?!)]}»"));
/** 行尾禁则：这些字符不能留在一行的末尾。 */
const NO_END = new Set(Array.from("（［｛〔〈《「『【〘〖〝‘“｟«([{«"));
const LATIN_CLOSING = new Set(Array.from(",.;:?!)]}»"));
/** 数字后面的单位：`9月`、`2026年` 不能拆成两行。 */
const NUMBER_UNIT = new Set(Array.from("年月日时分秒点号个只件条页章节次人元角米克升度倍期届岁天周"));
/** 数字前面的常见提示字：`第1章`、`共3个` 尽量别拆。 */
const NUMBER_PREFIX = new Set(Array.from("第共约超近至每前后"));
function scaledStyle(style) {
	if (style.vertAlign !== "superscript" && style.vertAlign !== "subscript") return style;
	return {
		...style,
		sizeFactor: (style.sizeFactor ?? 1) * VERTICAL_SCALE
	};
}
/**
* 上下标的纵向度量。
*
* Word/WPS 把上下标画成 65% 字号，并相对**原字号**的基线抬升 / 压低；
* 但行高仍按原字号撑开（否则整段上下标会把行距压扁，C05 实测 WPS 19.92pt）。
* `baselineShift` 为正表示基线上移（上标），为负表示下移（下标）。
*/
const VERTICAL_SCALE = .65;
const SUPERSCRIPT_SHIFT = .33;
const SUBSCRIPT_SHIFT = .14;
function verticalShift(style, size) {
	if (style.vertAlign === "superscript") return size * SUPERSCRIPT_SHIFT;
	if (style.vertAlign === "subscript") return -size * SUBSCRIPT_SHIFT;
	return 0;
}
/**
* 原子的来源坐标。编辑层靠它把「点在第几个字」映射回 `block.items[itemIndex]`
* 的第 `offset` 个码点。`itemIndex = -1` 是编号标签，不可编辑。
*/
function makeSource(itemIndex, charStart, charEnd, item) {
	return {
		itemIndex,
		charStart,
		charEnd,
		editable: item?.editable !== false,
		synthetic: item?.synthetic ?? null
	};
}
function makeTextAtom(text, rawStyle, options, isSpace = false, alreadyScaled = false, source = null) {
	const style = isSpace || alreadyScaled ? rawStyle : scaledStyle(rawStyle);
	const isCJK = !isSpace && CJK_RE.test(text);
	const metrics = fontMetrics(style, isCJK, options);
	const vertical = isSpace ? metrics : fontMetrics(rawStyle, isCJK, options);
	const shift = isSpace ? 0 : verticalShift(rawStyle, vertical.size);
	const ascent = vertical.ascent - shift;
	return {
		kind: "text",
		text,
		style,
		isCJK,
		isSpace,
		width: measureText(text, style, isCJK, options),
		lineHeight: vertical.lineHeight,
		ascent,
		descent: Math.max(0, vertical.lineHeight - ascent),
		baselineShift: shift,
		size: effectiveSizePx(style, options),
		...source
	};
}
function makeTabAtom(style, options, source = null) {
	const metrics = fontMetrics(style, false, options);
	return {
		kind: "tab",
		style,
		isTab: true,
		width: 0,
		lineHeight: metrics.lineHeight,
		ascent: metrics.ascent,
		descent: metrics.descent,
		size: effectiveSizePx(style, options),
		...source
	};
}
function pushTextAtoms(atoms, item, itemIndex, options) {
	const text = item.text;
	const style = item.style;
	const chars = Array.from(text);
	let word = "";
	let wordStart = 0;
	const source = (start) => makeSource(itemIndex, start, start + 1, item);
	const flushWord = () => {
		if (!word) return;
		const length = Array.from(word).length;
		atoms.push(makeTextAtom(word, style, options, false, false, makeSource(itemIndex, wordStart, wordStart + length, item)));
		word = "";
	};
	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index];
		if (char === "\n") {
			flushWord();
			atoms.push({
				kind: "control",
				type: "lineBreak",
				...source(index)
			});
			continue;
		}
		if (char === "	") {
			flushWord();
			atoms.push(makeTabAtom(style, options, source(index)));
			continue;
		}
		if (WHITESPACE_RE.test(char)) {
			flushWord();
			atoms.push(makeTextAtom(char, style, options, true, false, source(index)));
			continue;
		}
		if (WORD_CHAR_RE.test(char)) {
			if ((char === "-" || char === "'" || char === "’") && !(WORD_CHAR_RE.test(chars[index - 1] ?? "") && WORD_CHAR_RE.test(chars[index + 1] ?? ""))) {
				flushWord();
				atoms.push(makeTextAtom(char, style, options, false, false, source(index)));
				continue;
			}
			if (!word) wordStart = index;
			word += char;
			continue;
		}
		flushWord();
		atoms.push(makeTextAtom(char, style, options, false, false, source(index)));
	}
	flushWord();
}
/**
* 一个段落 → 原子序列。
*
* `paragraph.defaultStyle` 是这一段的「空行样式」（没有 run 时用它算行高）。
*/
function atomize(paragraph, options) {
	const atoms = [];
	const pushItem = (item, itemIndex) => {
		if (item.kind === "text") {
			pushTextAtoms(atoms, item, itemIndex, options);
			return;
		}
		if (item.kind === "tab") {
			atoms.push(makeTabAtom(item.style, options, makeSource(itemIndex, 0, 0, item)));
			return;
		}
		if (item.kind === "lineBreak" || item.kind === "pageBreak") {
			atoms.push({
				kind: "control",
				type: item.kind,
				...makeSource(itemIndex, 0, 0, item)
			});
			return;
		}
		if (item.kind === "image") {
			const style = item.style ?? paragraph.defaultStyle ?? { sizePx: 14 };
			const metrics = fontMetrics(style, false, options);
			if (item.anchor) {
				atoms.push({
					kind: "image",
					floating: true,
					anchor: item.anchor,
					src: item.src,
					label: item.label,
					alt: item.alt ?? "",
					width: 0,
					height: 0,
					drawWidth: item.width,
					drawHeight: item.height,
					style: scaledStyle(style),
					lineHeight: 0,
					ascent: 0,
					descent: 0,
					size: 0,
					...makeSource(itemIndex, 0, 0, item)
				});
				return;
			}
			atoms.push({
				kind: "image",
				src: item.src,
				label: item.label,
				alt: item.alt ?? "",
				width: item.width,
				height: item.height,
				style: scaledStyle(style),
				lineHeight: Math.max(item.height, metrics.lineHeight),
				ascent: Math.max(item.height, metrics.ascent),
				descent: metrics.descent,
				size: effectiveSizePx(style, options),
				...makeSource(itemIndex, 0, 0, item)
			});
		}
	};
	for (const item of paragraph.labelItems ?? []) pushItem(item, -1);
	for (const [itemIndex, item] of paragraph.items.entries()) pushItem(item, itemIndex);
	return atoms;
}
/** 原子起点对应的光标；编号标签（itemIndex < 0）没有可落的光标。 */
function atomStartCaret(atom) {
	if (!atom || atom.itemIndex == null || atom.itemIndex < 0) return null;
	return {
		itemIndex: atom.itemIndex,
		offset: atom.kind === "text" ? atom.charStart ?? 0 : 0
	};
}
/** 原子终点对应的光标；图片 / 制表符 / 换行的“终点”是下一个 item 的开头。 */
function atomEndCaret(atom) {
	if (!atom || atom.itemIndex == null || atom.itemIndex < 0) return null;
	if (atom.kind === "text") return {
		itemIndex: atom.itemIndex,
		offset: atom.charEnd ?? (atom.charStart ?? 0) + Array.from(atom.text ?? "").length
	};
	return {
		itemIndex: atom.itemIndex + 1,
		offset: 0
	};
}
/**
* `index` 前能不能断行。
*
* 这是 UAX #14 的一个**务实子集**：空格后可以断；中文与中文、中文与西文之间可以断，
* 但要服从禁则；西文只在词与词之间断。
*/
function canBreakBefore(atoms, index, kinsoku = true) {
	if (index <= 0 || index >= atoms.length) return false;
	const previous = atoms[index - 1];
	const current = atoms[index];
	if (previous.kind === "control" || current.kind === "control") return true;
	if (previous.isSpace) return true;
	if (current.isSpace) return false;
	if (previous.isTab || current.isTab) return false;
	if (previous.kind === "image" || current.kind === "image") return true;
	const previousText = previous.text ?? "";
	const currentText = current.text ?? "";
	if (kinsoku) {
		if (NO_START.has(currentText)) return false;
		if (NO_END.has(previousText)) return false;
	}
	if (previous.isCJK && current.isCJK) return true;
	if (previous.isCJK !== current.isCJK) {
		if (/[0-9]$/.test(previousText) && current.isCJK && NUMBER_UNIT.has(currentText)) return false;
		if (previous.isCJK && NUMBER_PREFIX.has(previousText) && /^[0-9]/.test(currentText)) return false;
		return true;
	}
	if (!previous.isCJK && !current.isCJK) {
		if (LATIN_CLOSING.has(currentText)) return false;
		if (LATIN_CLOSING.has(previousText)) return true;
	}
	return false;
}
function countCharacters(atoms) {
	let count = 0;
	for (const atom of atoms) if (atom.kind === "text") count += Array.from(atom.text).length;
	return count;
}
/** 把超长西文词拆成单字原子（只有整行都放不下时才用）。 */
function splitTextAtom(atom, options) {
	let offset = atom.charStart ?? 0;
	return Array.from(atom.text).map((char) => {
		const piece = makeTextAtom(char, atom.style, options, false, true, {
			itemIndex: atom.itemIndex,
			charStart: offset,
			charEnd: offset + 1,
			editable: atom.editable,
			synthetic: atom.synthetic
		});
		offset += 1;
		return piece;
	});
}
//#endregion
//#region src/layout/lines.js
/**
* 段落 → 行。
*
* 这一层负责 Word 排版里最核心的几件事：
*
* * 逐原子装行（断点服从禁则）
* * 行高（`w:spacing` 的 auto / exact / atLeast + 文档网格）
* * 首行缩进 / 悬挂缩进 / 左右缩进
* * 两端对齐（最后一行不对齐）
* * 手动换行、分页符
*
* 行对象是渲染与分页之间唯一的契约，字段都尽量是笨数据。
*/
/**
* Word 的缩进常常**同时**写 `w:firstLine="640"` 与 `w:firstLineChars="200"`：
* 前者是 twips，后者是「百分之几个字符」。两者说的是同一件事，**不能相加**。
* 有 twips 就以 twips 为准（它没有字体歧义）；只有字符单位时才按字号折算。
*/
function indentPx(valueTwips, valueChars, charWidth) {
	if (valueTwips !== void 0 && valueTwips !== null) return twipsToPx(valueTwips);
	if (valueChars !== void 0 && valueChars !== null) return valueChars / 100 * charWidth;
	return 0;
}
function computeIndent(paragraph, options) {
	const ind = paragraph.props.ind ?? {};
	const runStyle = paragraph.items.find((item) => item.kind === "text")?.style ?? paragraph.defaultStyle ?? { sizePx: 14 };
	const defaultStyle = paragraph.defaultStyle ?? runStyle;
	const charWidth = effectiveSizePx(runStyle, options);
	const defaultCharWidth = effectiveSizePx(defaultStyle, options);
	const left = indentPx(ind.left, ind.leftChars, defaultCharWidth);
	const right = indentPx(ind.right, ind.rightChars, defaultCharWidth);
	const first = indentPx(ind.firstLine, ind.firstLineChars, charWidth);
	const hanging = indentPx(ind.hanging, ind.hangingChars, charWidth);
	return {
		left,
		right,
		firstLeft: Math.max(0, left + first - hanging)
	};
}
function lineSpacing(paragraph, context) {
	const { options } = context;
	const spacing = paragraph.props.spacing ?? {};
	let rule = spacing.lineRule ?? "auto";
	let value = spacing.line ?? 240;
	if (options.lineSpacingMode === "auto" && options.lineSpacingValue != null) {
		rule = "auto";
		value = options.lineSpacingValue * 240;
	} else if (options.lineSpacingMode === "exact" && options.lineSpacingValue != null) {
		rule = "exact";
		value = options.lineSpacingValue;
	} else if (options.lineSpacingMode === "atLeast" && options.lineSpacingValue != null) {
		rule = "atLeast";
		value = options.lineSpacingValue;
	}
	return {
		rule,
		value
	};
}
function lineHeightFor(atoms, paragraph, context) {
	const { section, options } = context;
	const style = paragraph.defaultStyle ?? { sizePx: 14 };
	let base = 0;
	for (const atom of atoms) if (atom.lineHeight && atom.lineHeight > base) base = atom.lineHeight;
	if (base === 0) base = fontMetrics(style, Boolean(style.fontEastAsia), options).lineHeight;
	const hasInlineImage = atoms.some((atom) => atom.kind === "image" && !atom.floating);
	const { rule, value } = lineSpacing(paragraph, context);
	let height;
	if (rule === "exact") height = options.lineSpacingMode === "exact" && options.lineSpacingValue != null ? ptToPx(options.lineSpacingValue) : twipsToPx(value);
	else if (rule === "atLeast") {
		const minimum = options.lineSpacingMode === "atLeast" && options.lineSpacingValue != null ? ptToPx(options.lineSpacingValue) : twipsToPx(value);
		height = Math.max(base, minimum);
	} else height = base * (value / 240);
	if (rule !== "exact" && section.docGrid.snapsLines && paragraph.props.snapToGrid !== false && section.docGrid.linePitch > 0) {
		const pitch = section.docGrid.linePitch;
		if (rule === "auto") height = pitch * Math.max(1, value / 240);
		else height = Math.max(pitch, Math.ceil((height - .01) / pitch) * pitch);
	}
	if (hasInlineImage && rule !== "exact") height = Math.max(height, base);
	return height;
}
/**
* 行盒内的基线位置（相对行顶）。
*
* Word 不是把文字贴着行顶放：
*
* * `exact`：基线固定在行高的 ~80% 处（S02：20pt 固定行距，WPS 基线在 16.01pt）。
*   字号再大也不外溢，这正是「固定值」裁切文字的来源。
* * `atLeast`：行高至少是给定值；多出来的空间全在文字上方，文字按底边的
*   descent 对齐（S02 第二段 24pt 最小值，WPS 基线 20.97pt ≈ 24 − descent）。
* * `auto`：就是字体的 ascent；网格吸附只加高行盒，基线不动。
*/
function baselineFor(atoms, paragraph, context, height) {
	const style = paragraph.defaultStyle ?? { sizePx: 14 };
	let ascent = 0;
	let descent = 0;
	for (const atom of atoms) {
		if (atom.isSpace) continue;
		if (atom.ascent && atom.ascent > ascent) ascent = atom.ascent;
		if (atom.descent && atom.descent > descent) descent = atom.descent;
	}
	if (ascent === 0) {
		const metrics = fontMetrics(style, Boolean(style.fontEastAsia), context.options);
		ascent = metrics.ascent;
		descent = metrics.descent;
	}
	const { section } = context;
	const { rule } = lineSpacing(paragraph, context);
	if (rule === "exact") return height * .8;
	if (rule === "atLeast" && height > ascent + descent) return Math.max(ascent, height - descent);
	if (rule === "auto" && section.docGrid.snapsLines && paragraph.props.snapToGrid !== false && section.docGrid.linePitch > 0 && height > section.docGrid.linePitch) return ascent + (height - section.docGrid.linePitch);
	return ascent;
}
function computeSpacing(paragraph, context, baseLineHeight) {
	const { options } = context;
	const spacing = paragraph.props.spacing ?? {};
	let before;
	if (options.spaceBeforePt != null) before = ptToPx(options.spaceBeforePt);
	else if (spacing.before !== void 0) before = twipsToPx(spacing.before);
	else if (spacing.beforeLines !== void 0) before = spacing.beforeLines / 100 * baseLineHeight;
	else before = 0;
	let after;
	if (options.spaceAfterPt != null) after = ptToPx(options.spaceAfterPt);
	else if (spacing.after !== void 0) after = twipsToPx(spacing.after);
	else if (spacing.afterLines !== void 0) after = spacing.afterLines / 100 * baseLineHeight;
	else after = 0;
	return {
		before: Math.max(0, before),
		after: Math.max(0, after)
	};
}
function computeTabWidth(currentWidth, paragraph, context) {
	const tabStop = context.settings.defaultTabStop || 28;
	const tabs = paragraph.props.tabs ?? [];
	let target = null;
	for (const tab of tabs) {
		const position = twipsToPx(tab.pos);
		if (position > currentWidth + .5) {
			target = position;
			break;
		}
	}
	if (target === null) target = (Math.floor(currentWidth / tabStop) + 1) * tabStop;
	const width = target - currentWidth;
	return width > .5 ? width : tabStop;
}
function makeLine(atoms, paragraph, context, lineIndex, fallbackCaret) {
	const indent = computeIndent(paragraph, context.options);
	const left = lineIndex === 0 ? indent.firstLeft : indent.left;
	const available = Math.max(1, context.section.contentWidth - left - indent.right);
	const naturalWidth = atoms.reduce((sum, atom) => sum + (atom.width ?? 0), 0);
	const alignment = context.options.alignOverride ?? paragraph.props.jc ?? "left";
	let labelWidth = 0;
	for (const atom of atoms) if (atom.itemIndex === -1) labelWidth += atom.width ?? 0;
	else break;
	const firstReal = atoms.find((atom) => atom.itemIndex != null && atom.itemIndex >= 0);
	let lastReal = null;
	for (let index = atoms.length - 1; index >= 0; index -= 1) {
		const atom = atoms[index];
		if (atom.itemIndex != null && atom.itemIndex >= 0) {
			lastReal = atom;
			break;
		}
	}
	const startCaret = atomStartCaret(firstReal) ?? fallbackCaret;
	const endCaret = atomEndCaret(lastReal) ?? startCaret;
	const height = lineHeightFor(atoms, paragraph, context);
	return {
		kind: "line",
		atoms,
		paragraphIndex: paragraph.index,
		paraNumber: paragraph.index + 1,
		lineIndex,
		height,
		baseline: baselineFor(atoms, paragraph, context, height),
		naturalWidth,
		availableWidth: available,
		paddingLeft: left,
		paddingRight: indent.right,
		labelWidth,
		startCaret,
		endCaret,
		alignment,
		letterSpacing: 0,
		justified: false,
		charCount: countCharacters(atoms),
		spaceBefore: 0,
		spaceAfter: 0,
		isFirstInParagraph: false,
		isLastInParagraph: false,
		manualBreak: false,
		pageBreakAfter: false,
		paragraphEnd: false,
		segmentEnd: false
	};
}
function finalizeSegment(lines, control, isFinalSegment) {
	if (lines.length === 0) return;
	const last = lines[lines.length - 1];
	last.segmentEnd = true;
	last.manualBreak = control === "lineBreak";
	last.pageBreakAfter = control === "pageBreak";
	last.paragraphEnd = isFinalSegment && control === null;
	for (const [index, line] of lines.entries()) {
		const isLast = index === lines.length - 1;
		if (!(line.alignment === "distribute" || line.alignment === "both" && !isLast) || line.charCount <= 1) continue;
		const extra = line.availableWidth - line.naturalWidth;
		if (extra > .01) {
			line.justified = true;
			line.letterSpacing = extra / (line.charCount - 1);
		}
	}
}
function layoutSegment(segmentAtoms, paragraph, context, startLineIndex, control, isFinalSegment, segmentStart) {
	const lines = [];
	const atoms = [...segmentAtoms];
	if (atoms.length === 0) {
		lines.push(makeLine([], paragraph, context, startLineIndex, segmentStart));
		finalizeSegment(lines, control, isFinalSegment);
		return lines;
	}
	let index = 0;
	while (index < atoms.length) {
		const lineIndex = startLineIndex + lines.length;
		const indent = computeIndent(paragraph, context.options);
		const left = lineIndex === 0 ? indent.firstLeft : indent.left;
		const available = Math.max(1, context.section.contentWidth - left - indent.right);
		let width = 0;
		let cursor = index;
		let lastBreak = index;
		while (cursor < atoms.length) {
			const atom = atoms[cursor];
			const atomWidth = atom.isTab ? computeTabWidth(width, paragraph, context) : atom.width ?? 0;
			if (width + atomWidth <= available + .5) {
				if (atom.isTab) atom.width = atomWidth;
				width += atomWidth;
				cursor += 1;
				if (canBreakBefore(atoms, cursor, paragraph.props.kinsoku !== false)) lastBreak = cursor;
			} else break;
		}
		if (cursor === index) {
			const atom = atoms[index];
			if (atom.kind === "text" && !atom.isSpace && Array.from(atom.text).length > 1) {
				atoms.splice(index, 1, ...splitTextAtom(atom, context.options));
				continue;
			}
			cursor = index + 1;
		}
		let takeEnd = cursor;
		if (cursor < atoms.length && lastBreak > index) takeEnd = lastBreak;
		if (takeEnd < atoms.length) {
			while (takeEnd > index && atoms[takeEnd - 1].isSpace) takeEnd -= 1;
			if (takeEnd === index) takeEnd = cursor;
		}
		const lineAtoms = atoms.slice(index, takeEnd);
		lines.push(makeLine(lineAtoms, paragraph, context, lineIndex, segmentStart));
		index = takeEnd;
		while (index < atoms.length && atoms[index].isSpace && takeEnd < atoms.length) index += 1;
	}
	finalizeSegment(lines, control, isFinalSegment);
	return lines;
}
/**
* 一个段落 → 行。
*
* 段落里的 `w:br` 会把原子序列切成多段；每一段单独装行，段尾标记手动换行 / 分页。
*/
function layoutParagraph(paragraph, context) {
	const atoms = atomize(paragraph, context.options);
	const segments = [];
	let current = [];
	let segmentStart = {
		itemIndex: 0,
		offset: 0
	};
	for (const atom of atoms) if (atom.kind === "control") {
		segments.push({
			atoms: current,
			control: atom.type,
			start: segmentStart
		});
		segmentStart = atomEndCaret(atom) ?? segmentStart;
		current = [];
	} else current.push(atom);
	segments.push({
		atoms: current,
		control: null,
		start: segmentStart
	});
	const lines = [];
	paragraph.pageBreakAfter = false;
	let previousControl = null;
	let pendingPageBreak = false;
	for (const [index, segment] of segments.entries()) {
		const isFinalSegment = index === segments.length - 1;
		if (segment.atoms.length === 0) {
			if (segment.control === "pageBreak") {
				if (lines.length > 0) lines[lines.length - 1].pageBreakAfter = true;
				else pendingPageBreak = true;
				previousControl = "pageBreak";
				continue;
			}
			if (segment.control === null && previousControl === "pageBreak") continue;
		}
		const produced = layoutSegment(segment.atoms, paragraph, context, lines.length, segment.control, isFinalSegment, segment.start);
		if (pendingPageBreak && produced.length > 0) {
			produced[0].pageBreakBefore = true;
			pendingPageBreak = false;
		}
		lines.push(...produced);
		previousControl = segment.control;
	}
	if (lines.length === 0) if (pendingPageBreak) paragraph.pageBreakAfter = true;
	else {
		lines.push(makeLine([], paragraph, context, 0, {
			itemIndex: 0,
			offset: 0
		}));
		finalizeSegment(lines, null, true);
	}
	const spacing = computeSpacing(paragraph, context, fontMetrics(paragraph.defaultStyle ?? { sizePx: 14 }, false, context.options).lineHeight);
	if (lines.length > 0) {
		lines[0].isFirstInParagraph = true;
		lines[0].spaceBefore = spacing.before;
		lines[lines.length - 1].isLastInParagraph = true;
		lines[lines.length - 1].spaceAfter = spacing.after;
	}
	return lines;
}
//#endregion
//#region src/layout/paginate.js
/**
* 行 → 页。
*
* 分页不是「排不下就换页」，而是一组约束：
*
* * `pageBreakBefore`：段前强制分页
* * `keepLines`：整段不拆页
* * `keepNext`：与下一段同页（标题最常见的用法）
* * 孤行控制：段首 / 段尾不能只剩一行
* * 手动分页符（`w:br type="page"`）
*
* 先把每个段落排成行，再按这些约束装箱。装箱时只记账、不画 DOM，
* 所以这一层可以完全用纯函数单测。
*/
function paginate(blocks, section) {
	const contentHeight = section.contentHeight;
	const pages = [];
	let page = {
		lines: [],
		items: [],
		used: 0
	};
	let lastAfter = 0;
	const newPage = () => {
		if (page.items.length > 0) {
			pages.push(page);
			page = {
				lines: [],
				items: [],
				used: 0
			};
		}
		lastAfter = 0;
	};
	const placeTable = (block) => {
		const headerRows = block.rows.filter((row) => row.tableHeader);
		for (const row of block.rows) {
			if (page.items.length > 0 && page.used + row.height > contentHeight + .01) {
				newPage();
				if (!row.tableHeader) for (const header of headerRows) {
					if (page.used + header.height > contentHeight + .01) break;
					const repeated = {
						...header,
						cells: header.cells.map((cell) => ({
							...cell,
							lines: (cell.lines ?? []).map((line) => ({ ...line }))
						}))
					};
					page.items.push({
						kind: "table-row",
						table: block,
						row: repeated,
						top: page.used,
						height: header.height
					});
					page.used += header.height;
				}
			}
			page.items.push({
				kind: "table-row",
				table: block,
				row,
				top: page.used,
				height: row.height
			});
			page.used += row.height;
		}
		lastAfter = 0;
	};
	for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
		const block = blocks[blockIndex];
		if (block.kind === "table") {
			placeTable(block);
			continue;
		}
		const lines = block.lines ?? [];
		if (lines.length === 0) {
			if (block.pageBreakAfter && page.items.length > 0) newPage();
			continue;
		}
		const props = block.props ?? {};
		if (lines[0].pageBreakBefore && page.items.length > 0) newPage();
		const before = lines[0].spaceBefore ?? 0;
		const after = lines[lines.length - 1].spaceAfter ?? 0;
		const linesHeight = lines.reduce((sum, line) => sum + line.height, 0);
		const blockHeight = before + linesHeight + after;
		if (props.pageBreakBefore && page.items.length > 0) newPage();
		if (props.keepLines && blockHeight <= contentHeight && page.items.length > 0 && page.used + before + linesHeight > contentHeight) newPage();
		if (props.keepNext && page.items.length > 0) {
			const next = blocks[blockIndex + 1];
			const nextFirst = next?.lines?.[0];
			if (nextFirst && !next?.props?.pageBreakBefore) {
				const need = before + linesHeight + after + (nextFirst.spaceBefore ?? 0) + nextFirst.height;
				if (page.used + need > contentHeight) newPage();
			}
		}
		let beforeApplied = page.items.length === 0 ? before : Math.max(0, before - lastAfter);
		if (page.items.length > 0 && page.used + beforeApplied + lines[0].height > contentHeight) {
			newPage();
			beforeApplied = before;
		}
		page.used += beforeApplied;
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const line = lines[lineIndex];
			line.spaceBeforeApplied = lineIndex === 0 ? beforeApplied : 0;
			if (lineIndex === 0 && lines.length >= 2 && props.widowControl !== false && page.items.length > 0 && linesHeight <= contentHeight && page.used + line.height + lines[1].height > contentHeight) {
				newPage();
				line.spaceBeforeApplied = 0;
			}
			if (lineIndex === lines.length - 2 && lineIndex > 0 && props.widowControl !== false && page.items.length > 0 && page.used + line.height + lines[lineIndex + 1].height > contentHeight) newPage();
			if (page.used + line.height > contentHeight + .01 && page.items.length > 0) {
				newPage();
				line.spaceBeforeApplied = 0;
			}
			line.top = page.used;
			page.lines.push(line);
			page.items.push({
				kind: "line",
				line
			});
			page.used += line.height;
			if (line.pageBreakAfter) newPage();
		}
		page.used += after;
		lastAfter = after;
	}
	if (page.items.length > 0) pages.push(page);
	if (pages.length === 0) pages.push({
		lines: [],
		items: [],
		used: 0
	});
	for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
		for (const line of pages[pageIndex].lines) line.pageIndex = pageIndex;
		for (const item of pages[pageIndex].items) {
			if (item.kind !== "table-row") continue;
			for (const cell of item.row.cells) {
				if (cell.hidden) continue;
				const originX = item.table.x + cell.x + (cell.margins?.left ?? 0);
				const originY = item.top + (cell.contentTop ?? 0);
				for (const line of cell.lines ?? []) {
					line.pageIndex = pageIndex;
					line.tableOriginX = originX;
					line.tableOriginY = originY;
				}
			}
		}
	}
	return pages;
}
//#endregion
//#region src/layout/tables.js
/**
* 表格排版。
*
* 表格不参与普通的「段落 → 行」装箱：一行表格的高度由**所有单元格内容的最大值**
* 决定，单元格内部仍然复用 `layoutParagraph`。分页器把每一行当作不可分割的块
* （`cantSplit` 目前只影响行是否允许拆，第一版统一不拆行）。
*/
/**
* 表格行在 WPS 里比同样文字的正文行多约 0.48pt（13.56 → 14.04）。
* 这是表格单元格自己的行距口径，不是段前/段后；不加上它，跨页表格
* 每 20 多行就会差出一整行的分页点（TB3）。
*/
const TABLE_CELL_LEADING_PX = .64;
/**
* 单元格里 Word 会把**段落标记**的字体也算进行高/基线（内容只有数字时尤其明显：
* 基线仍按正文宋体的 1em 落，不按 Times 的 ascent）。这里把默认样式的度量
* 并进每一行。
*/
function applyParagraphMark(line, paragraph, context) {
	const style = paragraph.defaultStyle;
	if (!style) return;
	const metrics = fontMetrics(style, Boolean(style.fontEastAsia), context.options);
	line.height = Math.max(line.height, metrics.lineHeight);
	line.baseline = Math.max(line.baseline ?? 0, metrics.ascent);
}
function layoutCellParagraphs(paragraphs, context) {
	const lines = [];
	let height = 0;
	for (const paragraph of paragraphs) {
		const cellLines = layoutParagraph(paragraph, context);
		paragraph.lines = cellLines;
		for (const line of cellLines) {
			applyParagraphMark(line, paragraph, context);
			line.blockKey = paragraph.key;
		}
		for (const [index, line] of cellLines.entries()) {
			const before = index === 0 ? line.spaceBefore ?? 0 : 0;
			line.top = height + before;
			height = line.top + line.height;
			if (index === cellLines.length - 1) height += line.spaceAfter ?? 0;
			lines.push(line);
		}
	}
	return {
		lines,
		height
	};
}
/**
* @returns {object} 带 `x` / `width` / `rows` 的表格块；`rows[].cells[].lines`
*   的行 `top` 是相对单元格内容区顶部的坐标。
*/
function layoutTable(block, context) {
	const { section } = context;
	const props = block.props ?? {};
	const tableWidth = props.width ?? section.contentWidth;
	let x = 0;
	if (props.alignment === "center") x = (section.contentWidth - tableWidth) / 2;
	else if (props.alignment === "right" || props.alignment === "end") x = section.contentWidth - tableWidth;
	const rows = [];
	for (const sourceRow of block.rows ?? []) {
		const row = {
			...sourceRow,
			cells: []
		};
		let contentHeight = 0;
		let cursor = 0;
		for (const sourceCell of sourceRow.cells) {
			const cell = { ...sourceCell };
			const margins = cell.margins ?? {
				left: 0,
				right: 0,
				top: 0,
				bottom: 0
			};
			const contentWidth = Math.max(1, cell.width - margins.left - margins.right);
			const cellContext = {
				...context,
				section: {
					...section,
					contentWidth
				}
			};
			if (cell.continuation) {
				cell.hidden = true;
				cell.lines = [];
				cell.contentHeight = 0;
			} else {
				const laidOut = layoutCellParagraphs(cell.blocks ?? [], cellContext);
				cell.lines = laidOut.lines;
				cell.contentHeight = laidOut.height;
				contentHeight = Math.max(contentHeight, laidOut.height + margins.top + margins.bottom);
			}
			cell.x = cursor;
			cursor += cell.width;
			for (const line of cell.lines) {
				line.tableCell = cell;
				line.tableKey = block.key;
			}
			row.cells.push(cell);
		}
		row.contentHeight = contentHeight;
		if (!(row.heightRule === "exact" && row.height > 0)) row.height = Math.max(row.height ?? 0, contentHeight + TABLE_CELL_LEADING_PX);
		rows.push(row);
	}
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) for (const cell of rows[rowIndex].cells) {
		if (!cell.rowSpan || cell.rowSpan <= 1) continue;
		let spanHeight = 0;
		for (let index = rowIndex; index < rowIndex + cell.rowSpan && index < rows.length; index += 1) spanHeight += rows[index].height;
		cell.spanHeight = spanHeight;
	}
	for (const row of rows) for (const cell of row.cells) {
		if (cell.hidden) continue;
		const margins = cell.margins ?? {
			left: 0,
			right: 0,
			top: 0,
			bottom: 0
		};
		const boxHeight = cell.spanHeight ?? row.height;
		let offset = margins.top;
		if (cell.verticalAlign === "center") offset = (boxHeight - cell.contentHeight) / 2;
		else if (cell.verticalAlign === "bottom") offset = boxHeight - cell.contentHeight - margins.bottom;
		cell.contentTop = Math.max(0, offset);
		cell.height = boxHeight;
	}
	return {
		...block,
		layout: "table",
		x,
		width: tableWidth,
		rows
	};
}
//#endregion
//#region src/layout/index.js
/**
* 排版入口：文档模型 → 行 → 页。
*/
function defaultLayoutOptions() {
	return {
		/** 阅读覆盖：空字符串 = 跟随文档。 */
		fontOverride: "",
		/** 阅读覆盖：pt；null = 跟随文档。 */
		sizeOverridePt: null,
		/**
		* 阅读覆盖：null = 跟随文档；否则：
		* * auto: value 是倍数（1.15）
		* * exact / atLeast: value 是 pt
		*/
		lineSpacingMode: null,
		lineSpacingValue: null,
		/** 阅读覆盖：pt；null = 跟随文档。 */
		spaceBeforePt: null,
		spaceAfterPt: null,
		/**
		* 阅读覆盖：null = 跟随文档；否则是 left / center / right / both / distribute。
		* 当前是整个视图的预览覆盖，按段落生效要等编辑模式（M5）。
		*/
		alignOverride: null
	};
}
/**
* @param {object} [runtime]
* @param {string[]} [runtime.dirtyKeys] 只重排这些段落；其余段落复用已有的 `lines`。
*   不传就是全量重排（改字号 / 对齐这类整篇覆盖必须全量）。
*/
function layoutDocument(model, options = defaultLayoutOptions(), runtime = {}) {
	const context = {
		section: model.section,
		settings: model.settings,
		options
	};
	const dirty = runtime.dirtyKeys ? new Set(runtime.dirtyKeys) : null;
	const reuse = Boolean(dirty);
	const blocks = [];
	let lineCount = 0;
	for (const block of model.blocks) {
		if (block.kind === "table") {
			const table = layoutTable(block, context);
			for (const row of table.rows) for (const cell of row.cells) lineCount += cell.lines?.length ?? 0;
			blocks.push(table);
			continue;
		}
		let lines;
		if (reuse && !dirty.has(block.key) && block.lines) lines = block.lines;
		else lines = layoutParagraph(block, context);
		lineCount += lines.length;
		for (const line of lines) line.blockKey = block.key;
		blocks.push({
			...block,
			lines
		});
	}
	const pages = paginate(blocks, model.section);
	const keyToBlock = new Map(model.keyToBlock ?? []);
	for (const block of blocks) {
		if (block.key) keyToBlock.set(block.key, block);
		if (block.kind !== "table") continue;
		for (const row of block.rows) for (const cell of row.cells) for (const paragraph of cell.blocks ?? []) keyToBlock.set(paragraph.key, paragraph);
	}
	return {
		...model,
		blocks,
		keyToBlock,
		pages,
		laidOut: {
			lineCount,
			pageCount: pages.length
		}
	};
}
//#endregion
//#region src/render/pages.js
/**
* 页面渲染。
*
* 行由排版引擎决定，渲染层只做两件事：
*
* 1. 把行 / 原子画成 DOM（字体、颜色、上下标、两端对齐、图片）；
* 2. 按页虚拟化 —— 先用固定高度的空页撑出滚动条，滚到附近才真正画内容。
*
* 段落标记（¶ / ↵ / → / ·）与段落序号是**显示开关**，不影响排版；打开时重画当前页即可。
*/
/** 页数不多时直接全画；超过这个数就按视口懒加载。 */
const ALL_AT_ONCE = 24;
function applyTextStyle(span, atom, line, options) {
	span.style.fontFamily = fontFamily(atom.style, atom.isCJK, options);
	span.style.fontSize = `${atom.size}px`;
	span.style.fontWeight = atom.style.bold ? "700" : "400";
	span.style.fontStyle = atom.style.italic ? "italic" : "normal";
	span.style.whiteSpace = "pre";
	if (atom.style.color) span.style.color = atom.style.color;
	if (atom.style.background) span.style.backgroundColor = atom.style.background;
	const decorations = [];
	if (atom.style.underline) decorations.push("underline");
	if (atom.style.strike || atom.style.doubleStrike) decorations.push("line-through");
	if (decorations.length > 0) span.style.textDecorationLine = decorations.join(" ");
	if (atom.style.caps) span.style.textTransform = "uppercase";
	else if (atom.style.smallCaps) span.style.fontVariantCaps = "small-caps";
	if (atom.style.vertAlign === "superscript") span.style.verticalAlign = "super";
	else if (atom.style.vertAlign === "subscript") span.style.verticalAlign = "sub";
	const letterSpacing = (atom.style.letterSpacingPx ?? 0) + (line.justified ? line.letterSpacing : 0);
	if (Math.abs(letterSpacing) > .001) span.style.letterSpacing = `${letterSpacing}px`;
}
function markElement(text) {
	const mark = document.createElement("span");
	mark.className = "fmt-mark";
	mark.textContent = text;
	return mark;
}
function renderTextAtom(atom, line, display, options) {
	const span = document.createElement("span");
	span.textContent = atom.text;
	applyTextStyle(span, atom, line, options);
	if (atom.isSpace && display.showMarks) {
		span.classList.add("space-atom");
		span.append(markElement("·"));
	}
	return span;
}
function renderTabAtom(atom, display) {
	const span = document.createElement("span");
	span.className = "tab-atom";
	span.style.display = "inline-block";
	span.style.width = `${Math.max(0, atom.width)}px`;
	span.style.height = "1px";
	span.style.verticalAlign = "baseline";
	if (display.showMarks) {
		span.style.position = "relative";
		span.append(markElement("→"));
	}
	return span;
}
function renderImageAtom(atom) {
	if (atom.src) {
		const image = document.createElement("img");
		image.src = atom.src;
		image.alt = atom.alt ?? "";
		image.style.width = `${atom.width}px`;
		image.style.height = `${atom.height}px`;
		image.style.verticalAlign = "baseline";
		image.draggable = false;
		return image;
	}
	const placeholder = document.createElement("span");
	placeholder.className = "image-placeholder";
	placeholder.textContent = atom.label ?? "[图片]";
	placeholder.style.width = `${atom.width}px`;
	placeholder.style.height = `${atom.height}px`;
	placeholder.style.lineHeight = `${Math.min(atom.height, 40)}px`;
	return placeholder;
}
/**
* 行盒基线在 CSS 里的落点。
*
* `line-height: 行高` 会让浏览器按字体自己的 ascent/descent 把文字垂直居中，
* 固定值 / 最小值行距下（Word 把基线固定在行盒的某个位置）会差好几个点。
* 这里改成「父盒子只定高度，内层按 `line.baseline` 摆」。
*
* 含上下标的行不套这一层：它们已经用 CSS `vertical-align` 定位，再叠一次会双重偏移。
*/
function lineContentOffset(line, options) {
	if (line.baseline == null || line.atoms.length === 0) return null;
	let ascent = 0;
	for (const atom of line.atoms) {
		if (atom.kind !== "text" || atom.isSpace) continue;
		if (atom.style?.vertAlign) return null;
		const metrics = browserFontMetrics(atom.style, atom.isCJK, options);
		if (metrics.ascent > ascent) ascent = metrics.ascent;
	}
	if (ascent === 0) return null;
	return line.baseline - ascent;
}
function renderLine(line, display) {
	const element = document.createElement("div");
	element.className = "line";
	element.style.top = `${line.top}px`;
	element.style.left = `${line.paddingLeft}px`;
	element.style.width = `${line.availableWidth}px`;
	element.style.height = `${line.height}px`;
	element.style.lineHeight = `${line.height}px`;
	if (line.alignment === "center") element.style.textAlign = "center";
	else if (line.alignment === "right" || line.alignment === "end") element.style.textAlign = "right";
	const options = display.layoutOptions;
	const offset = lineContentOffset(line, options);
	let content = element;
	if (offset != null) {
		content = document.createElement("div");
		content.className = "line-content";
		content.style.position = "absolute";
		content.style.left = "0";
		content.style.right = "0";
		content.style.top = `${offset}px`;
		content.style.lineHeight = "normal";
		element.append(content);
	}
	for (const atom of line.atoms) if (atom.kind === "text") content.append(renderTextAtom(atom, line, display, options));
	else if (atom.kind === "tab") content.append(renderTabAtom(atom, display));
	else if (atom.kind === "image" && !atom.floating) content.append(renderImageAtom(atom));
	if (display.showMarks) {
		if (line.manualBreak) content.append(markElement("↵"));
		if (line.pageBreakAfter) content.append(markElement("⤓"));
		if (line.paragraphEnd) content.append(markElement("¶"));
	}
	return element;
}
function cssBorder(border) {
	if (!border || border.style === "none") return "none";
	return `${Math.max(.5, border.widthPx ?? .5)}px solid #${border.color ?? "000000"}`;
}
function cellBorder(table, cell, edge) {
	const own = cell.borders?.[edge];
	if (own) return own;
	const tableEdge = edge === "insideH" ? "insideH" : edge === "insideV" ? "insideV" : edge;
	return table.props?.borders?.[tableEdge] ?? null;
}
function renderTableCell(table, cell, rowHeight, display) {
	const element = document.createElement("div");
	element.className = "table-cell";
	element.style.left = `${cell.x}px`;
	element.style.top = "0";
	element.style.width = `${cell.width}px`;
	element.style.height = `${rowHeight}px`;
	element.style.borderTop = cssBorder(cellBorder(table, cell, "top"));
	element.style.borderLeft = cssBorder(cellBorder(table, cell, "left"));
	element.style.borderBottom = cssBorder(cellBorder(table, cell, "bottom"));
	element.style.borderRight = cssBorder(cellBorder(table, cell, "right"));
	if (cell.fill && cell.fill !== "auto") element.style.backgroundColor = `#${cell.fill}`;
	if (cell.rowSpan > 1) element.style.zIndex = "2";
	const content = document.createElement("div");
	content.className = "cell-content";
	content.style.position = "absolute";
	content.style.left = `${cell.margins?.left ?? 0}px`;
	content.style.top = `${cell.contentTop ?? 0}px`;
	content.style.width = `${Math.max(1, cell.width - (cell.margins?.left ?? 0) - (cell.margins?.right ?? 0))}px`;
	for (const line of cell.lines ?? []) content.append(renderLine(line, display));
	element.append(content);
	return element;
}
function renderTableRow(item, display) {
	const { table, row, top } = item;
	const element = document.createElement("div");
	element.className = "table-row";
	element.style.left = `${table.x}px`;
	element.style.top = `${top}px`;
	element.style.width = `${table.width}px`;
	element.style.height = `${row.height}px`;
	for (const cell of row.cells) {
		if (cell.hidden) continue;
		element.append(renderTableCell(table, cell, cell.height ?? row.height, display));
	}
	return element;
}
function renderParagraphNumber(pageElement, line, section) {
	const number = document.createElement("span");
	number.className = "para-number";
	number.textContent = String(line.paraNumber);
	number.style.top = `${section.margin.top + line.top}px`;
	number.style.left = `${Math.max(4, section.margin.left - 38)}px`;
	number.style.width = "30px";
	number.style.height = `${line.height}px`;
	number.style.lineHeight = `${line.height}px`;
	pageElement.append(number);
}
/** 浮动图片：按锚点相对段落 / 栏 / 页面绝对定位，不参与行内排版。 */
function floatingImageElement(atom, x, y) {
	const image = renderImageAtom({
		...atom,
		width: atom.drawWidth ?? atom.width,
		height: atom.drawHeight ?? atom.height
	});
	image.classList.add("floating-image");
	image.style.position = "absolute";
	image.style.left = `${x}px`;
	image.style.top = `${y}px`;
	image.style.pointerEvents = "none";
	return image;
}
function floatingImages(page, section) {
	const behind = [];
	const front = [];
	const lines = page.lines ?? [];
	for (const line of lines) for (const atom of line.atoms ?? []) {
		if (!atom.floating) continue;
		const anchor = atom.anchor ?? {};
		const firstLine = lines.find((candidate) => candidate.paragraphIndex === line.paragraphIndex && candidate.isFirstInParagraph) ?? line;
		let x = anchor.x ?? 0;
		if (anchor.relativeH === "page") x -= section.margin.left;
		let y = firstLine.top + (anchor.y ?? 0);
		if (anchor.relativeV === "page") y -= section.margin.top;
		else if (anchor.relativeV === "margin") y = anchor.y ?? 0;
		const element = floatingImageElement(atom, x, y);
		element.style.zIndex = anchor.behindDoc ? "0" : "3";
		(anchor.behindDoc ? behind : front).push(element);
	}
	return {
		behind,
		front
	};
}
function renderPageContent(pageElement, page, doc, display) {
	const content = pageElement.querySelector(".page-content");
	content.replaceChildren();
	pageElement.querySelectorAll(".para-number").forEach((element) => element.remove());
	const items = page.items ?? page.lines.map((line) => ({
		kind: "line",
		line
	}));
	const { behind, front } = floatingImages(page, doc.section);
	for (const item of items) {
		if (item.kind === "table-row") {
			content.append(renderTableRow(item, display));
			continue;
		}
		const line = item.line;
		content.append(renderLine(line, display));
		if (display.showParagraphNumbers && line.isFirstInParagraph) renderParagraphNumber(pageElement, line, doc.section);
	}
	if (behind.length > 0) content.prepend(...behind);
	if (front.length > 0) content.append(...front);
	pageElement.dataset.rendered = "true";
}
function createPageElement(pageIndex, section) {
	const element = document.createElement("section");
	element.className = "page";
	element.dataset.index = String(pageIndex);
	element.style.width = `${section.pageWidth}px`;
	element.style.height = `${section.pageHeight}px`;
	const content = document.createElement("div");
	content.className = "page-content";
	content.style.left = `${section.margin.left}px`;
	content.style.top = `${section.margin.top}px`;
	content.style.width = `${section.contentWidth}px`;
	content.style.height = `${section.contentHeight}px`;
	element.append(content);
	return element;
}
/**
* 把整份文档画到 `container` 里。
*
* 返回一个句柄：`scrollToPage` / `currentPage` / `setDisplay` / `destroy`。
* 重新排版时调用方直接重新 `renderDocument`，不必自己清 DOM。
*/
function renderDocument(container, doc, display) {
	container.replaceChildren();
	const pageElements = [];
	const observer = doc.pages.length > ALL_AT_ONCE ? new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const index = Number(entry.target.dataset.index);
			if (entry.target.dataset.rendered === "true") continue;
			renderPageContent(entry.target, doc.pages[index], doc, display);
		}
	}, {
		root: container.closest(".viewport"),
		rootMargin: "900px 0px"
	}) : null;
	doc.pages.forEach((page, index) => {
		const element = createPageElement(index, doc.section);
		pageElements.push(element);
		container.append(element);
		if (!observer || index < 2) renderPageContent(element, page, doc, display);
		else observer.observe(element);
	});
	return {
		pageElements,
		observer,
		elementAt(index) {
			return pageElements[index] ?? null;
		},
		renderPage(index) {
			const element = pageElements[index];
			if (!element || element.dataset.rendered === "true") return;
			renderPageContent(element, doc.pages[index], doc, display);
		},
		destroy() {
			observer?.disconnect();
			container.replaceChildren();
		}
	};
}
//#endregion
//#region src/render/theme.js
/**
* 宿主主题 → 视图变量。
*
* 视图是独立文档，拿不到宿主的 CSS 变量；宿主在 `init` 与 `theme` 消息里把
* `--color-*` 的解析值递进来。这里只把它们接到视图自己的变量名上。
*/
const TOKEN_MAP = {
	"--bg": "--color-paper-warm",
	"--panel": "--color-paper",
	"--ink": "--color-ink",
	"--ink-soft": "--color-ink-soft",
	"--ink-ghost": "--color-ink-ghost",
	"--line": "--color-paper-deep",
	"--accent": "--color-bamboo",
	"--shadow": "--color-shadow-deep"
};
function applyTheme(message) {
	if (message.theme === "light" || message.theme === "dark") document.documentElement.dataset.theme = message.theme;
	const tokens = message.tokens;
	if (!tokens) return;
	for (const [target, source] of Object.entries(TOKEN_MAP)) {
		const value = tokens[source];
		if (typeof value === "string" && value.length > 0) document.documentElement.style.setProperty(target, value);
	}
}
//#endregion
//#region src/main.js
/**
* office-viewer 的视图入口。
*
* 流程：
*
*   init → requestDocument → parseDocx → layoutDocument → renderDocument
*
* 解析、排版、渲染三层各自独立；改字体 / 行距只是换一份 layoutOptions 重排，
* 不需要重新解析 DOCX。
*/
const MIN_ZOOM = .3;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.15;
const VIEWPORT_GUTTER = 48;
const PAGE_GAP = 12;
const OLE_MAGIC = [
	208,
	207,
	17,
	224,
	161,
	177,
	26,
	225
];
const viewport = document.getElementById("viewport");
const pagesElement = document.getElementById("pages");
const hint = document.getElementById("hint");
const hintText = document.getElementById("hint-text");
const statusLeft = document.getElementById("status-left");
const statusRight = document.getElementById("status-right");
const imeInput = document.getElementById("ime-input");
const state = {
	name: "",
	path: "",
	bytes: null,
	doc: null,
	layout: null,
	renderer: null,
	editor: null,
	busy: false,
	zoom: 1,
	fit: true,
	single: false,
	page: 1,
	total: 0,
	display: {
		showMarks: false,
		showParagraphNumbers: false
	},
	layoutOptions: defaultLayoutOptions()
};
function showHint(text, kind = "") {
	hintText.textContent = text;
	hint.className = kind ? `hint ${kind}` : "hint";
	hint.hidden = false;
}
function hideHint() {
	hint.hidden = true;
}
function setStatus(left, right) {
	statusLeft.textContent = left;
	statusRight.textContent = right;
}
function formatBytes(count) {
	if (!Number.isFinite(count) || count <= 0) return "0 B";
	if (count < 1024) return `${count} B`;
	if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
	return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}
function updateStatus() {
	if (!state.doc) {
		setStatus(state.name || "Word 文档", state.bytes ? formatBytes(state.bytes.length) : "");
		return;
	}
	const stats = state.doc.stats;
	const parts = [`${state.total} 页`];
	if (stats.chars > 0) parts.push(`${stats.chars} 字`);
	if (stats.images > 0) parts.push(`${stats.images} 张图`);
	if (stats.tables > 0) parts.push(`${stats.tables} 个表格`);
	if (state.doc.dirty) parts.push("未保存");
	if (state.doc.warnings.length > 0) parts.push(`${state.doc.warnings.length} 条兼容提示`);
	setStatus(state.name || "Word 文档", parts.join(" · "));
}
function pageWidth() {
	return state.layout?.section.pageWidth ?? 794;
}
function applyZoom() {
	if (state.fit) state.zoom = clamp(Math.max(1, viewport.clientWidth - VIEWPORT_GUTTER) / pageWidth(), MIN_ZOOM, MAX_ZOOM);
	else state.zoom = clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
	pagesElement.style.setProperty("--zoom", String(state.zoom));
	state.editor?.update({});
	updateState();
}
function zoomBy(factor) {
	state.fit = false;
	state.zoom = clamp(state.zoom * factor, MIN_ZOOM, MAX_ZOOM);
	pagesElement.style.setProperty("--zoom", String(state.zoom));
	state.editor?.update({});
	updateState();
	requestAnimationFrame(() => {
		if (!state.single) scrollToPage(state.page);
	});
}
function toggleFit() {
	state.fit = !state.fit;
	applyZoom();
	requestAnimationFrame(() => {
		if (!state.single) scrollToPage(state.page);
	});
}
function scrollToPage(pageNumber) {
	if (!state.renderer || state.single) return;
	const element = state.renderer.elementAt(pageNumber - 1);
	if (!element) return;
	const delta = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - PAGE_GAP;
	viewport.scrollTop += delta;
	state.renderer.renderPage(pageNumber - 1);
}
function goToPage(target) {
	if (state.total <= 0) return;
	const pageNumber = clamp(Math.round(target), 1, state.total);
	state.page = pageNumber;
	if (state.single) applySingleMode();
	else scrollToPage(pageNumber);
	updateState();
}
function applySingleMode() {
	pagesElement.classList.toggle("single", state.single);
	if (!state.renderer) return;
	state.renderer.pageElements.forEach((element, index) => {
		element.dataset.current = String(index + 1 === state.page);
	});
	if (state.single) {
		viewport.scrollTop = 0;
		state.renderer.renderPage(state.page - 1);
	}
}
function toggleSpread() {
	state.single = !state.single;
	applySingleMode();
	if (!state.single) requestAnimationFrame(() => scrollToPage(state.page));
	updateState();
}
function trackCurrentPage() {
	if (!state.renderer || state.single || state.total <= 0) return;
	const scrollHeight = viewport.scrollHeight;
	if (scrollHeight > viewport.clientHeight + 2 && viewport.scrollTop + viewport.clientHeight >= scrollHeight - 3) {
		if (state.page !== state.total) {
			state.page = state.total;
			updateState();
		}
		return;
	}
	const top = viewport.getBoundingClientRect().top;
	let current = 1;
	state.renderer.pageElements.forEach((element, index) => {
		if (element.getBoundingClientRect().top - top <= 12.5) current = index + 1;
	});
	if (current !== state.page) {
		state.page = current;
		updateState();
	}
}
function updateState() {
	const pressed = [];
	if (state.fit) pressed.push("fit-width");
	floralView.setState({
		zoom: `${Math.round(state.zoom * 100)}%`,
		page: state.total > 0 ? `${state.page} / ${state.total}` : "—",
		spread: state.single ? "单页" : "连续"
	}, pressed);
}
/**
* 渲染器换了之后，把编辑器接到新的页面 DOM 上。
*
* 编辑状态（光标 / 选区）由编辑器自己按 `blockKey` 保存；这里只递新数据，
* 不重置选区，所以改字号、切换标记不会把光标弄丢。
*/
function syncEditor() {
	if (!state.doc || !state.layout || !state.renderer) return;
	const options = {
		doc: state.doc,
		layout: state.layout,
		renderer: state.renderer,
		section: state.layout.section,
		pagesElement,
		viewport,
		ime: imeInput,
		getZoom: () => state.zoom,
		onEdited: (result) => {
			relayout({
				dirtyKeys: result.dirtyKeys,
				preserveScroll: true
			});
		},
		onEnter: () => {
			floralView.toast("分段与段合并还差最后一步，先继续输入文字。");
		},
		onMerge: () => {
			floralView.toast("跨段合并还没接上，先把光标移到段内再删。");
		},
		onUnsupported: (reason) => {
			floralView.toast({
				"cross-block": "跨段删除还没接上，先在同一段内删。",
				"paste-large": "粘贴内容太长，只保留了前 100 万个字符。",
				section: "这一段带分节符，暂时不能在这里分段。",
				nested: "超链接 / 修订里的内容暂时不能分段。",
				"not-adjacent": "中间隔着表格或其它结构，暂时不能合并。",
				"empty-selection": "先选中文字，再使用字符格式。",
				"no-format-range": "这段内容不能设置字符格式。",
				"nested-table": "请在正文里插入表格，表格里暂时不能嵌套表格。"
			}[reason] ?? "这一处暂时不能编辑。");
		},
		onError: (error) => {
			floralView.log("error", `编辑失败：${error?.message ?? error}`);
			floralView.toast("这一步编辑没有成功。");
		},
		onDirtyChange: () => updateStatus(),
		onSave: () => {
			saveAsDocx();
		}
	};
	if (state.editor) state.editor.update(options);
	else state.editor = createEditor(options);
}
function relayout({ keepPage = state.page, dirtyKeys = null, preserveScroll = false } = {}) {
	if (!state.doc) return;
	const scrollTop = viewport.scrollTop;
	const previousPage = clamp(keepPage, 1, Math.max(1, state.total));
	const laidOut = layoutDocument(state.doc, state.layoutOptions, dirtyKeys ? { dirtyKeys } : {});
	state.layout = laidOut;
	state.total = laidOut.pages.length;
	state.page = clamp(previousPage, 1, state.total);
	applyZoom();
	state.renderer?.destroy();
	state.renderer = renderDocument(pagesElement, laidOut, {
		...state.display,
		layoutOptions: state.layoutOptions
	});
	applySingleMode();
	syncEditor();
	requestAnimationFrame(() => {
		if (preserveScroll) {
			applySingleMode();
			viewport.scrollTop = scrollTop;
			state.renderer?.renderPage(state.page - 1);
			return;
		}
		if (state.single) applySingleMode();
		else scrollToPage(state.page);
		state.renderer?.renderPage(state.page - 1);
	});
	updateState();
	updateStatus();
}
function rerenderPages() {
	if (!state.layout) return;
	state.renderer?.destroy();
	state.renderer = renderDocument(pagesElement, state.layout, {
		...state.display,
		layoutOptions: state.layoutOptions
	});
	applySingleMode();
	syncEditor();
	requestAnimationFrame(() => {
		if (!state.single) scrollToPage(state.page);
		state.renderer?.renderPage(state.page - 1);
	});
}
function looksLikeZip(bytes) {
	return bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75;
}
function looksLikeOle(bytes) {
	if (bytes.length < OLE_MAGIC.length) return false;
	return OLE_MAGIC.every((value, index) => bytes[index] === value);
}
async function loadDocument(buffer) {
	if (state.busy) return;
	let bytes = new Uint8Array(buffer);
	if (state.doc && state.bytes && bytes.length === state.bytes.length) return;
	state.busy = true;
	showHint("正在解析文档…", "loading");
	setStatus(state.name || "Word 文档", "解析中…");
	await new Promise((resolve) => setTimeout(resolve, 0));
	try {
		if (looksLikeOle(bytes)) throw new Error("这是旧版 .doc 或者加了密码的文档（OLE 复合文档），当前版本打不开。请在 Word 里另存为不加密的 .docx 再试。");
		let recoveredText = null;
		if (bytes.length === 0) bytes = await blankDocxBytes();
		else if (!looksLikeZip(bytes)) try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			if (!/[\x00-\x08\x0e-\x1f]/.test(text)) {
				recoveredText = text;
				bytes = await blankDocxBytes(text);
			}
		} catch {}
		state.bytes = bytes;
		if (recoveredText != null) {
			const message = "这个 .docx 不是有效的 Word 文件，已按纯文本打开。";
			floralView.log("warn", message);
			floralView.toast(message);
		}
		const doc = await parseDocx(bytes);
		state.editor?.destroy();
		state.editor = null;
		state.doc = doc;
		state.doc.originalBytes = bytes;
		state.page = 1;
		relayout({ keepPage: 1 });
		hideHint();
		updateStatus();
		for (const warning of doc.warnings) floralView.log("warn", warning);
		if (doc.warnings.length > 0) floralView.toast(doc.warnings[0]);
	} catch (error) {
		state.editor?.destroy();
		state.editor = null;
		state.doc = null;
		state.layout = null;
		state.total = 0;
		state.renderer?.destroy();
		state.renderer = null;
		pagesElement.replaceChildren();
		showHint(`这个文件打不开：${error?.message ?? error}`, "error");
		setStatus("打不开这个文件", "");
		updateState();
	} finally {
		state.busy = false;
	}
}
/**
* 来自「开始」面板的格式命令。
*
* 面板跑在 Worker 里，视图跑在沙箱 iframe 里；`api.ui.sendToView()` 把这条消息原样送到
* `floralView.onCommand`，与 `view.toolbar` 的命令同一个形状。
*
* 字符格式（加粗 / 斜体 / 下划线 / 删除线 / 上下标）按选区写回 XML；
* 字体、字号、对齐、行距仍是**整篇预览**。命令只做参数校验。
*/
function applyFormatCommand(raw) {
	let payload;
	try {
		payload = JSON.parse(String(raw ?? ""));
	} catch {
		return;
	}
	if (!payload || typeof payload !== "object") return;
	switch (payload.type) {
		case "insert-table": {
			const rows = Math.round(Number(payload.rows));
			const cols = Math.round(Number(payload.cols));
			if (!(rows >= 1) || !(cols >= 1)) return;
			state.editor?.insertTable(rows, cols);
			return;
		}
		case "run-format": {
			const allowed = new Set([
				"bold",
				"italic",
				"underline",
				"strike",
				"vertAlign",
				"color"
			]);
			if (typeof payload.key !== "string" || !allowed.has(payload.key)) return;
			state.editor?.formatSelection({
				key: payload.key,
				value: payload.value
			});
			return;
		}
		case "font":
			state.layoutOptions.fontOverride = typeof payload.value === "string" ? payload.value : "";
			relayout({ keepPage: state.page });
			break;
		case "size":
			state.layoutOptions.sizeOverridePt = Number.isFinite(payload.value) ? clamp(payload.value, 6, 200) : null;
			relayout({ keepPage: state.page });
			break;
		case "size-adjust": {
			const delta = Number.isFinite(payload.delta) ? payload.delta : 0;
			const current = state.layoutOptions.sizeOverridePt ?? 12;
			state.layoutOptions.sizeOverridePt = clamp(current + delta, 6, 200);
			relayout({ keepPage: state.page });
			break;
		}
		case "line":
			if (payload.value == null) {
				state.layoutOptions.lineSpacingMode = null;
				state.layoutOptions.lineSpacingValue = null;
			} else if (Number.isFinite(payload.value)) {
				state.layoutOptions.lineSpacingMode = "auto";
				state.layoutOptions.lineSpacingValue = clamp(payload.value, .5, 5);
			}
			relayout({ keepPage: state.page });
			break;
		case "spacing":
			if ("before" in payload) state.layoutOptions.spaceBeforePt = Number.isFinite(payload.before) ? clamp(payload.before, 0, 500) : null;
			if ("after" in payload) state.layoutOptions.spaceAfterPt = Number.isFinite(payload.after) ? clamp(payload.after, 0, 500) : null;
			relayout({ keepPage: state.page });
			break;
		case "align": {
			const allowed = [
				"left",
				"center",
				"right",
				"both",
				"distribute"
			];
			state.layoutOptions.alignOverride = typeof payload.value === "string" && allowed.includes(payload.value) ? payload.value : null;
			relayout({ keepPage: state.page });
			break;
		}
		case "marks":
			state.display.showMarks = !state.display.showMarks;
			rerenderPages();
			break;
		case "numbers":
			state.display.showParagraphNumbers = !state.display.showParagraphNumbers;
			rerenderPages();
			break;
		case "reset":
			state.layoutOptions = defaultLayoutOptions();
			relayout({ keepPage: state.page });
			break;
		default: break;
	}
}
/**
* 另存为新的 `.docx`。
*
* 宿主只提供「弹出保存对话框」这一条写文件通道，而且没有结果回调 —— 所以这里
* 只能说「已打开保存对话框」，不能声称文件一定写成功了。
*/
async function saveAsDocx() {
	if (!state.doc) return;
	const name = savedFileName(state.name);
	try {
		const bytes = await buildSavedDocx(state.doc);
		const verification = await verifySavedDocx(bytes, state.doc);
		if (!verification.ok) {
			floralView.log("error", `另存校验失败：${verification.message}`);
			floralView.toast(`另存失败：${verification.message}`);
			return;
		}
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		floralView.saveFile(name, buffer);
		state.doc.originalBytes = bytes;
		state.editor?.markSaved();
		updateStatus();
		floralView.toast(`已打开保存对话框：${name}`);
	} catch (error) {
		floralView.log("error", `另存失败：${error?.message ?? error}`);
		floralView.toast(`另存失败：${error?.message ?? error}`);
	}
}
function handleCommand(message) {
	switch (message.id) {
		case "zoom-in":
			zoomBy(ZOOM_STEP);
			break;
		case "zoom-out":
			zoomBy(1 / ZOOM_STEP);
			break;
		case "fit-width":
			toggleFit();
			break;
		case "page-prev":
			goToPage(state.page - 1);
			break;
		case "page-next":
			goToPage(state.page + 1);
			break;
		case "goto": {
			const target = Number.parseInt(String(message.value ?? ""), 10);
			if (Number.isFinite(target)) goToPage(target);
			break;
		}
		case "spread":
			toggleSpread();
			break;
		case "office-format":
			applyFormatCommand(message.value);
			break;
		case "save-as":
			saveAsDocx();
			break;
		default: break;
	}
}
floralView.onCommand(handleCommand);
floralView.onMessage((message) => {
	if (!message || typeof message !== "object") return;
	if (message.t === "init") {
		applyTheme(message);
		state.name = typeof message.name === "string" ? message.name : "";
		state.path = typeof message.path === "string" ? message.path : "";
		setStatus(state.name || "Word 文档", "读取中…");
		floralView.requestDocument();
		return;
	}
	if (message.t === "theme") {
		applyTheme(message);
		return;
	}
	if (message.t === "document") {
		loadDocument(message.bytes);
		return;
	}
	if (message.t === "documentError") {
		showHint(`读不到这个文件：${message.message}`, "error");
		setStatus("打不开这个文件", "");
	}
});
viewport.addEventListener("scroll", trackCurrentPage, { passive: true });
new ResizeObserver(() => {
	if (state.fit) applyZoom();
}).observe(viewport);
viewport.addEventListener("wheel", (event) => {
	if (!event.ctrlKey && !event.metaKey) return;
	event.preventDefault();
	zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });
document.addEventListener("keydown", (event) => {
	const tag = event.target?.tagName;
	if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
	if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
	else if (event.key === "-") zoomBy(1 / ZOOM_STEP);
});
applyZoom();
floralView.ready();
//#endregion
