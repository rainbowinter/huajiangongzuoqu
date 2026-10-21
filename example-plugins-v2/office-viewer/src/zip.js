/**
 * 只读 ZIP。
 *
 * DOCX 就是一个 ZIP。这里不引第三方解压库：
 * WebView2（Chromium）与 Node 都支持 `DecompressionStream("deflate-raw")`，
 * 而 DOCX 的条目只有「存储」和「deflate」两种压缩方式。
 *
 * 这样插件可以完全自包含，不必把 fflate 之类的库再打进来。
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;
const ZIP64 = 0xffffffff;

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
  const minOffset = Math.max(0, bytes.length - (MAX_COMMENT + 22));
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("找不到 ZIP 目录：这不是一份 DOCX。");

  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === ZIP64) {
    throw new Error("这份文档用了 ZIP64 结构，当前版本还不支持。");
  }
  if (directoryOffset >= bytes.length) throw new Error("ZIP 目录偏移越界，文件可能已损坏。");

  const decoder = new TextDecoder("utf-8");
  const entries = [];
  const directories = [];
  let offset = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length) throw new Error("ZIP 目录被截断了。");
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error("ZIP 目录项格式不对，文件可能已损坏。");
    }

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
      // 中央目录里的顺序：写回时把目录项和文件项按它重新拼起来，保持原顺序。
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
      commentLength,
    };

    // 目录项（`word/` 这种）不是部件，别把它算进「N 个部件」里。
    if (name.endsWith("/")) {
      directories.push(entry);
    } else {
      if (compressed === ZIP64 || uncompressed === ZIP64 || localOffset === ZIP64) {
        throw new Error("这份文档用了 ZIP64 结构，当前版本还不支持。");
      }
      entries.push(entry);
    }

    offset = commentEnd;
  }

  return { entries, directories, hasDirectories: directories.length > 0 };
}

/** 只读中央目录，返回部件条目（目录项已排除）。保留给既有调用方。 */
export function readZipDirectory(bytes) {
  return scanCentralDirectory(bytes).entries;
}

/**
 * 中央目录的完整扫描结果：`{ entries, directories, hasDirectories }`。
 * 需要知道原文件里有没有目录项时用它；写回时不要求重新生成目录项。
 */
export function readZipEntriesRaw(bytes) {
  return scanCentralDirectory(bytes);
}

/**
 * 读本地文件头。中央目录里没有本地 extra 字段（两者可以不同），
 * 所以原样搬运压缩数据时要先到这里取一次。
 */
export function readLocalHeader(bytes, entry) {
  const view = dataViewOf(bytes);
  if (entry.localOffset + 30 > bytes.length) throw new Error("ZIP 条目偏移越界。");
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
    throw new Error(`ZIP 条目 ${entry.name} 的本地头损坏。`);
  }

  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  if (dataStart > bytes.length) throw new Error(`ZIP 条目 ${entry.name} 的本地头被截断了。`);

  return {
    nameLength,
    extraLength,
    dataStart,
    localExtra: bytes.subarray(dataStart - extraLength, dataStart),
  };
}

/** 取一个条目的原始压缩字节（不解压）。 */
export function readRawCompressed(bytes, entry) {
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
export async function readZipEntry(bytes, entry) {
  const compressed = readRawCompressed(bytes, entry);
  let output;
  if (entry.method === 0) {
    output = compressed;
  } else if (entry.method === 8) {
    output = await inflateRaw(compressed);
  } else {
    throw new Error(`ZIP 条目 ${entry.name} 用了不支持的压缩方式（${entry.method}）。`);
  }

  if (entry.uncompressed > 0 && output.length !== entry.uncompressed) {
    throw new Error(`ZIP 条目 ${entry.name} 解压后的大小对不上。`);
  }
  return output;
}

export class ZipArchive {
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
}
