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

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

// 通用位标记：bit 3 表示大小与 CRC 写在数据描述符里（本地头先填 0）；
// bit 11 表示文件名按 UTF-8 编码。两者在重写本地头时都必须处理好。
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

// 本地头与中央目录都用 2.0 版本：支持存储与 deflate，足够 DOCX 使用。
const VERSION_NEEDED = 20;
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const MAX_OUTPUT = 256 * 1024 * 1024;

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

/** 标准 CRC-32（IEEE 802.3）查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** 表驱动 CRC-32；结果是无符号 32 位整数（`"123456789"` → `0xCBF43926`）。 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 用浏览器 / Node 自带的 `CompressionStream("deflate-raw")` 压缩。
 *
 * 环境不支持，或者压缩流本身出错时返回 `null` —— 调用方退回到「存储」，
 * 另存不应该因为压缩不可用而失败。
 */
export async function deflateRaw(bytes) {
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
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label} 必须是 Uint8Array 或 ArrayBuffer。`);
}

function toCommentBytes(comment) {
  if (comment === undefined || comment === null || comment === "") return EMPTY;
  if (typeof comment === "string") return encoder.encode(comment);
  return toBytes(comment, "ZIP 注释");
}

function assertUint32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error(`${label} 超出 ZIP 32 位范围（${value}）。`);
  }
}

function assertUint16(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${label} 超出 ZIP 16 位范围（${value}）。`);
  }
}

/** 当前时间的 DOS 时间戳；没给元数据时用它，至少不会写出 1980 年的怪日期。 */
function dosDateTime(date = new Date()) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    dosTime:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 重建通用位标记：数据描述符位必须清掉（我们会在本地头里直接写大小与 CRC），
 * UTF-8 位在文件名含非 ASCII 字节时补上。其余位原样保留。
 */
function normalizeFlags(flags, nameBytes) {
  let result = (flags ?? 0) & ~FLAG_DATA_DESCRIPTOR;
  const hasNonAscii = nameBytes.some((byte) => byte >= 0x80);
  if (hasNonAscii || (flags ?? 0) & FLAG_UTF8) result |= FLAG_UTF8;
  return result;
}

async function prepareEntry(entry) {
  if (!entry || typeof entry.name !== "string" || entry.name === "") {
    throw new Error("ZIP 条目缺少 name。");
  }

  const name = entry.name;
  const nameBytes = encoder.encode(name);
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

  if (entry.raw !== undefined) {
    // 原样搬运：压缩字节一个都不能动，否则未修改部件的 round-trip 就对不上了。
    compressedBytes = toBytes(entry.raw, `ZIP 条目 ${name} 的 raw`);
    method = meta.method;
    if (method === undefined) throw new Error(`ZIP 条目 ${name} 的 raw 数据缺少 meta.method。`);

    uncompressedSize = meta.uncompressed;
    if (uncompressedSize === undefined) {
      if (method !== 0) throw new Error(`ZIP 条目 ${name} 的 raw 数据缺少 meta.uncompressed。`);
      uncompressedSize = compressedBytes.length;
    }

    crc = meta.crc32;
    if (crc === undefined) {
      if (method !== 0) throw new Error(`ZIP 条目 ${name} 的 raw 数据缺少 meta.crc32。`);
      crc = crc32(compressedBytes);
    }
  } else {
    const data = toBytes(entry.data ?? EMPTY, `ZIP 条目 ${name} 的 data`);
    method = 0;
    compressedBytes = data;
    uncompressedSize = data.length;
    crc = crc32(data);

    // 只有确实更小才用 deflate；小文件压缩后往往反而更大。
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
    localOffset: 0,
  };
}

function makeLocalHeader(entry) {
  const bytes = new Uint8Array(30 + entry.nameBytes.length + entry.localExtra.length);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, LOCAL_SIGNATURE, true);
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
  const bytes = new Uint8Array(
    46 + entry.nameBytes.length + entry.centralExtra.length + entry.commentBytes.length,
  );
  const view = new DataView(bytes.buffer);

  view.setUint32(0, CENTRAL_SIGNATURE, true);
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
  view.setUint16(34, 0, true); // 磁盘号
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
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(4, 0, true); // 当前磁盘号
  view.setUint16(6, 0, true); // 中央目录所在磁盘号
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true); // ZIP 注释长度
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
export async function writeZip(entries) {
  if (!Array.isArray(entries)) throw new Error("writeZip 需要条目数组。");
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP 条目太多（${entries.length}），当前写入器不支持超过 65535 个。`);
  }

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
