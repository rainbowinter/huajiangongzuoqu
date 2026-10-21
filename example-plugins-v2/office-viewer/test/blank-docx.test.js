import { describe, expect, it } from "vitest";
import PLUGIN_SOURCE from "../index.js?raw";
import { blankDocxBytes } from "../src/docx/blank.js";
import { ZipArchive } from "../src/zip.js";

describe("blankDocxBytes", () => {
  it("生成一份结构完整的空白 DOCX", async () => {
    const bytes = await blankDocxBytes();
    const zip = new ZipArchive(bytes);

    expect(zip.has("[Content_Types].xml")).toBe(true);
    expect(zip.has("_rels/.rels")).toBe(true);
    expect(zip.has("word/document.xml")).toBe(true);
    expect(zip.has("word/styles.xml")).toBe(true);
    expect(zip.has("word/_rels/document.xml.rels")).toBe(true);

    const documentXml = await zip.text("word/document.xml");
    expect(documentXml).toContain("<w:body>");
    expect(documentXml).toContain("<w:sectPr>");
    expect(documentXml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
  });

  /**
   * 插件注册文件类型时交出去的那份 `newFile` 模板，就是宿主新建 .docx 时写盘的内容。
   * 它必须和生成器产出的结构一致 —— 两边各写一份 base64 而不校验的话，改模板时
   * 很容易只改了一边。
   */
  it("注册给宿主的 newFile 模板是一份完整的 DOCX", async () => {
    const match = /const BLANK_DOCX_BASE64 =\s*"([^"]+)"/.exec(PLUGIN_SOURCE);
    expect(match).not.toBeNull();
    const bytes = Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0));
    const zip = new ZipArchive(bytes);

    expect(zip.has("[Content_Types].xml")).toBe(true);
    expect(zip.has("word/document.xml")).toBe(true);
    expect(zip.has("word/styles.xml")).toBe(true);

    const xml = await zip.text("word/document.xml");
    expect(xml).toContain("<w:body>");
    expect(xml).toContain("<w:sectPr>");
  });

  it("把纯文本包进空白 DOCX", async () => {
    const bytes = await blankDocxBytes("甲 & 乙" + String.fromCharCode(10) + "第二行");
    const documentXml = await new ZipArchive(bytes).text("word/document.xml");

    expect(documentXml).toContain("甲 &amp; 乙");
    expect(documentXml).toContain("第二行");
    expect(documentXml.match(/<w:p>/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
