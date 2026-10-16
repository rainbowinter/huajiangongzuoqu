import { describe, expect, test } from "vitest";
import { documentActionVisible, documentContextOf } from "./documentContext";

describe("当前文档属于哪一类", () => {
  test("笔记：没有文件类型", () => {
    expect(documentContextOf({ docView: false, isNoteDocument: true, fileKind: null })).toBe("note");
  });

  test("外部文件按它注册的 kind", () => {
    for (const kind of ["markdown", "code", "text", "table", "image", "media", "view"] as const) {
      expect(documentContextOf({ docView: false, isNoteDocument: false, fileKind: kind })).toBe(
        kind,
      );
    }
  });

  test("⚠️ 只读说明文档优先 —— 它没有外部文件，isNoteDocument 是 true", () => {
    // 不先判 doc，说明文档会被当成笔记，顶上一排「插入图片 / 删除笔记」全冒出来。
    expect(documentContextOf({ docView: true, isNoteDocument: true, fileKind: null })).toBe("doc");
    // 就算底下还留着文件类型，也仍然是文档。
    expect(documentContextOf({ docView: true, isNoteDocument: false, fileKind: "view" })).toBe("doc");
  });

  test("什么都没选：既不是外部文件也不是文档 ⇒ 笔记", () => {
    // 空状态那会儿 selectedId 是 null，isNoteDocument 也是 true。
    expect(documentContextOf({ docView: false, isNoteDocument: true, fileKind: null })).toBe("note");
  });
});

describe("插件文档动作的可见性", () => {
  const note = { context: "note", typeId: null } as const;
  const pdf = { context: "view", typeId: "pdf-viewer:pdf" } as const;

  test("两个过滤器都不填 = 所有文档里都显示", () => {
    expect(documentActionVisible({}, note)).toBe(true);
    expect(documentActionVisible({}, pdf)).toBe(true);
    expect(documentActionVisible({ contexts: [], typeIds: [] }, pdf)).toBe(true);
  });

  test("只填 contexts", () => {
    const filter = { contexts: ["note", "markdown"] } as const;
    expect(documentActionVisible(filter, note)).toBe(true);
    expect(documentActionVisible(filter, { context: "markdown", typeId: "m" })).toBe(true);
    expect(documentActionVisible(filter, pdf)).toBe(false);
  });

  test("只填 typeIds —— 笔记拿不到 typeId，一律不显示", () => {
    const filter = { typeIds: ["pdf-viewer:pdf"] } as const;
    expect(documentActionVisible(filter, pdf)).toBe(true);
    expect(documentActionVisible(filter, { context: "view", typeId: "other:thing" })).toBe(false);
    expect(documentActionVisible(filter, note)).toBe(false);
  });

  test("两个都填 = 取与", () => {
    const filter = { contexts: ["view"], typeIds: ["pdf-viewer:pdf"] } as const;
    expect(documentActionVisible(filter, pdf)).toBe(true);
    // 上下文对、类型不对
    expect(documentActionVisible(filter, { context: "view", typeId: "other:view" })).toBe(false);
    // 类型对、上下文不对
    expect(documentActionVisible(filter, { context: "markdown", typeId: "pdf-viewer:pdf" })).toBe(
      false,
    );
  });
});
