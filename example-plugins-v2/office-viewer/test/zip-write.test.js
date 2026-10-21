import { describe, expect, it } from "vitest";
import { ZipArchive, readLocalHeader, readRawCompressed } from "../src/zip.js";
import { crc32, writeZip } from "../src/zip-write.js";
import { savedFileName } from "../src/docx/save.js";

/**
 * ZIP 写入器的单元测试。
 *
 * 不依赖磁盘上的 .docx 样本：先用 `writeZip` 造一份最小 ZIP，再让读取器读回来。
 * 重点是验证「原样搬运」——未修改条目的压缩字节必须与原来一致，否则另存 docx
 * 会悄悄改掉图片、样式等部件。
 */

const encoder = new TextEncoder();

/** 从写出的 ZIP 里取回一个条目，拼成再次写入时需要的 meta。 */
function rawMetaOf(bytes, entry) {
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

describe("crc32", () => {
  it("匹配标准测试向量 123456789 → 0xCBF43926", () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
  });

  it("空输入为 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("writeZip", () => {
  it("写出两个存储条目，并能被 ZipArchive 读回", async () => {
    const dataA = Uint8Array.from([1, 2, 3, 4]);

    // 先单独写一次，拿到一段「原始压缩字节」，第二次写入时原样搬运。
    const first = await writeZip([
      {
        name: "文档.bin",
        data: Uint8Array.from([9, 8, 7, 6, 5]),
        meta: {
          dosTime: 0x4a2b,
          dosDate: 0x5a2c,
          // bit 3 是数据描述符位，写入器必须清掉；bit 11 是 UTF-8 文件名。
          flags: 0x0008 | 0x0800,
          internalAttrs: 1,
          externalAttrs: 0x81a40000,
          comment: "保留我",
        },
      },
    ]);
    const firstArchive = new ZipArchive(first);
    const firstEntry = firstArchive.entry("文档.bin");
    expect(firstEntry).not.toBeNull();
    expect(firstEntry.method).toBe(0);

    const bytes = await writeZip([
      {
        name: "a.bin",
        data: dataA,
        meta: { dosTime: 0x6000, dosDate: 0x5021, flags: 0 },
      },
      {
        name: "文档.bin",
        raw: readRawCompressed(first, firstEntry),
        meta: rawMetaOf(first, firstEntry),
      },
    ]);

    const archive = new ZipArchive(bytes);
    expect(archive.entries.map((entry) => entry.name)).toEqual(["a.bin", "文档.bin"]);

    const a = archive.entry("a.bin");
    expect(a.method).toBe(0); // 4 字节数据 deflate 后更大，应退回存储
    expect(a.uncompressed).toBe(dataA.length);
    expect(a.compressed).toBe(dataA.length);
    expect(a.crc32).toBe(crc32(dataA));
    expect(a.dosTime).toBe(0x6000);
    expect(a.dosDate).toBe(0x5021);
    expect(a.flags & 0x0008).toBe(0);
    expect(a.versionNeeded).toBe(20);
    expect(a.rawName).toBeInstanceOf(Uint8Array);
    expect(Array.from(await archive.read("a.bin"))).toEqual(Array.from(dataA));

    const b = archive.entry("文档.bin");
    expect(b.name).toBe("文档.bin");
    expect(b.comment).toBe("保留我");
    expect(b.internalAttrs).toBe(1);
    expect(b.externalAttrs).toBe(0x81a40000);
    expect(b.dosTime).toBe(0x4a2b);
    expect(b.dosDate).toBe(0x5a2c);
    expect(b.flags & 0x0008).toBe(0); // 数据描述符位被清掉
    expect(b.flags & 0x0800).toBe(0x0800); // UTF-8 文件名位保留
    expect(Array.from(await archive.read("文档.bin"))).toEqual([9, 8, 7, 6, 5]);
  });

  it("替换一个条目时，未修改条目的原始压缩字节逐字节一致", async () => {
    const originalData = encoder.encode("保持不变的图片字节".repeat(8));
    const original = await writeZip([
      { name: "word/document.xml", data: encoder.encode("<w:document/>") },
      { name: "word/media/image1.bin", data: originalData },
    ]);
    const before = new ZipArchive(original);
    const beforeImage = before.entry("word/media/image1.bin");
    const beforeRaw = readRawCompressed(original, beforeImage);

    const saved = await writeZip([
      { name: "word/document.xml", data: encoder.encode("<w:document>改过了</w:document>") },
      {
        name: "word/media/image1.bin",
        raw: beforeRaw,
        meta: rawMetaOf(original, beforeImage),
      },
    ]);
    const after = new ZipArchive(saved);
    const afterImage = after.entry("word/media/image1.bin");
    const afterRaw = readRawCompressed(saved, afterImage);

    expect(Array.from(afterRaw)).toEqual(Array.from(beforeRaw));
    expect(Array.from(await after.read("word/media/image1.bin"))).toEqual(Array.from(originalData));
    expect(await after.text("word/document.xml")).toBe("<w:document>改过了</w:document>");
  });
});

describe("savedFileName", () => {
  it("去掉 .docx（大小写不敏感）并追加后缀", () => {
    expect(savedFileName("报告.docx")).toBe("报告-已编辑.docx");
    expect(savedFileName("Report.DOCX")).toBe("Report-已编辑.docx");
    expect(savedFileName("a.b.docx")).toBe("a.b-已编辑.docx");
  });

  it("没有扩展名时直接追加后缀", () => {
    expect(savedFileName("notes")).toBe("notes-已编辑.docx");
  });

  it("空名字回退到 文档-已编辑.docx", () => {
    expect(savedFileName("")).toBe("文档-已编辑.docx");
    expect(savedFileName(".docx")).toBe("文档-已编辑.docx");
    expect(savedFileName("   ")).toBe("文档-已编辑.docx");
  });
});
