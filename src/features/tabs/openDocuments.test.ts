import { describe, expect, test } from "vitest";
import {
  closeDocument,
  documentTitleFromPath,
  findDocument,
  makeDocument,
  neighborKey,
  openDocumentKey,
  upsertDocument,
} from "./openDocuments";

describe("openDocumentKey", () => {
  test("笔记与文件使用不同的前缀", () => {
    expect(openDocumentKey("note", "abc")).toBe("note:abc");
    expect(openDocumentKey("file", "E:/a.md")).toBe("file:e:\\a.md");
  });

  test("Windows 路径不区分大小写与斜杠方向", () => {
    expect(openDocumentKey("file", "E:\\Projects\\A.md")).toBe(
      openDocumentKey("file", "e:/projects/a.md"),
    );
  });

  test("只读文档的键保持原样，不做路径归一化", () => {
    expect(openDocumentKey("doc", "custom-css.md")).toBe("doc:custom-css.md");
    expect(openDocumentKey("doc", "Guide.MD")).not.toBe(openDocumentKey("doc", "guide.md"));
  });
});

describe("upsertDocument", () => {
  const a = makeDocument("note", "a");
  const b = makeDocument("note", "b");
  const c = makeDocument("file", "E:/c.md");

  test("append 加到末尾", () => {
    expect(upsertDocument([a], b, "append", a.key).map((d) => d.id)).toEqual(["a", "b"]);
  });

  test("replace 顶掉活动标签但保持位置", () => {
    expect(upsertDocument([a, b], c, "replace", b.key).map((d) => d.id)).toEqual([
      "a",
      "E:/c.md",
    ]);
  });

  test("已经在列表里就不重复添加", () => {
    expect(upsertDocument([a, b], a, "append", b.key)).toHaveLength(2);
  });

  test("找不到活动标签时追加", () => {
    expect(upsertDocument([a], b, "replace", "note:missing")).toHaveLength(2);
  });

  test("路径大小写不同也认成同一个文件", () => {
    const lower = makeDocument("file", "E:/a.md");
    const upper = makeDocument("file", "e:\\A.MD");
    expect(upsertDocument([lower], upper, "append", lower.key)).toHaveLength(1);
    expect(findDocument([lower], "file", "e:\\A.MD")).not.toBeNull();
  });
});

describe("closeDocument / neighborKey", () => {
  const a = makeDocument("note", "a");
  const b = makeDocument("note", "b");
  const c = makeDocument("note", "c");

  test("关中间优先激活右邻，关最后一个激活左邻", () => {
    expect(neighborKey([a, b, c], b.key)).toBe(c.key);
    expect(neighborKey([a, b, c], c.key)).toBe(b.key);
  });

  test("列表清空后没有可激活的标签", () => {
    expect(neighborKey([a], a.key)).toBeNull();
    expect(closeDocument([b], b.key)).toEqual([]);
  });
});

describe("documentTitleFromPath", () => {
  test("取文件名并去掉常见后缀", () => {
    expect(documentTitleFromPath("E:/notes/todo.md")).toBe("todo");
    expect(documentTitleFromPath("E:\\a\\b.txt")).toBe("b");
    expect(documentTitleFromPath("E:/a/script.py")).toBe("script.py");
  });
});
