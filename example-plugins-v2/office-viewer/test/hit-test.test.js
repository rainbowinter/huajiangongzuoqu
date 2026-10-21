import { describe, expect, it } from "vitest";
import {
  caretRect,
  hitTest,
  selectionRects,
  verticalCaret,
} from "../src/edit/hit-test.js";

/**
 * 命中测试是纯几何：把测量函数注入成「每个码点 10px」，就能在 Node 里验偏移。
 */

const measure = (text) => Array.from(text ?? "").length * 10;

function textAtoms(text, itemIndex = 0, width = 10) {
  return Array.from(text).map((char, index) => ({
    kind: "text",
    text: char,
    itemIndex,
    charStart: index,
    charEnd: index + 1,
    width,
    editable: true,
  }));
}

function line(extra = {}) {
  const atoms = extra.atoms ?? textAtoms("中文字符");
  return {
    kind: "line",
    atoms,
    paragraphIndex: 0,
    lineIndex: 0,
    height: 20,
    top: extra.top ?? 0,
    naturalWidth: atoms.reduce((sum, atom) => sum + (atom.width ?? 0), 0),
    availableWidth: 100,
    paddingLeft: 0,
    paddingRight: 0,
    labelWidth: extra.labelWidth ?? 0,
    alignment: extra.alignment ?? "left",
    letterSpacing: 0,
    charCount: atoms.reduce((sum, atom) => sum + (atom.itemIndex >= 0 ? 1 : 0), 0),
    startCaret: extra.startCaret ?? { itemIndex: 0, offset: 0 },
    endCaret: extra.endCaret ?? { itemIndex: 0, offset: 4 },
    pageIndex: 0,
    ...extra,
  };
}

function block(lines, extra = {}) {
  return {
    kind: "paragraph",
    key: "p0",
    index: 0,
    editable: true,
    synthetic: null,
    items: [{ kind: "text", text: "中文字符" }],
    lines,
    ...extra,
  };
}

function layout(lines = [line()], blocks = [block(lines)]) {
  return {
    blocks,
    pages: [{ lines }],
    keyToIndex: new Map(blocks.map((entry, index) => [entry.key, index])),
  };
}

describe("hitTest", () => {
  it("行内按码点找最近的边界", () => {
    const doc = layout();
    expect(hitTest(doc, 0, 0, 5, measure)).toEqual({ blockKey: "p0", itemIndex: 0, offset: 0 });
    expect(hitTest(doc, 0, 19, 5, measure).offset).toBe(2);
    expect(hitTest(doc, 0, 39, 5, measure).offset).toBe(4);
    expect(hitTest(doc, 0, 200, 5, measure).offset).toBe(4);
  });

  it("居中 / 右对齐要把起点算进去", () => {
    const centered = layout([line({ alignment: "center" })]);
    // 可用 100、内容 40 → 起点 30。
    expect(caretRect(centered, { blockKey: "p0", itemIndex: 0, offset: 0 }, measure).x).toBe(30);
    expect(hitTest(centered, 0, 36, 5, measure).offset).toBe(1);

    const right = layout([line({ alignment: "right" })]);
    expect(caretRect(right, { blockKey: "p0", itemIndex: 0, offset: 4 }, measure).x).toBe(100);
  });

  it("编号标签占宽度，光标落在标签后面", () => {
    const atoms = [
      { kind: "text", text: "1.", itemIndex: -1, charStart: 0, charEnd: 2, width: 20 },
      ...textAtoms("中文", 0, 10),
    ];
    const numbered = line({ atoms, labelWidth: 20, endCaret: { itemIndex: 0, offset: 2 } });
    const doc = layout([numbered]);
    expect(caretRect(doc, { blockKey: "p0", itemIndex: 0, offset: 0 }, measure).x).toBe(20);
    expect(hitTest(doc, 0, 4, 5, measure).offset).toBe(0);
    expect(hitTest(doc, 0, 25, 5, measure).offset).toBe(0);
    expect(hitTest(doc, 0, 35, 5, measure).offset).toBe(1);
  });

  it("选区矩形跨行 / 跨页各自给出", () => {
    const first = line({ top: 0 });
    const second = line({
      top: 20,
      startCaret: { itemIndex: 0, offset: 4 },
      endCaret: { itemIndex: 0, offset: 4 },
      pageIndex: 1,
    });
    const doc = layout([first], [block([first])]);
    // 第二页单独有一个段（同 key 会冲突，这里换一个块）。
    const secondBlock = block([second], { key: "p1", index: 1, items: [{ kind: "text", text: "后面" }] });
    second.startCaret = { itemIndex: 0, offset: 0 };
    second.endCaret = { itemIndex: 0, offset: 2 };
    second.atoms = textAtoms("后面");
    second.paragraphIndex = 1;
    doc.blocks.push(secondBlock);
    doc.pages.push({ lines: [second] });
    doc.keyToIndex.set("p1", 1);

    const rects = selectionRects(
      doc,
      { blockKey: "p0", itemIndex: 0, offset: 1 },
      { blockKey: "p1", itemIndex: 0, offset: 1 },
      measure,
    );
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ pageIndex: 0, x: 10, y: 0, width: 30 });
    expect(rects[1]).toMatchObject({ pageIndex: 1, x: 0, y: 20, width: 10 });
  });
});

describe("verticalCaret", () => {
  it("上下移动保持目标列，落在短行时贴到行尾", () => {
    const first = line({ top: 0 });
    const second = line({
      top: 20,
      atoms: textAtoms("短"),
      naturalWidth: 10,
      startCaret: { itemIndex: 0, offset: 0 },
      endCaret: { itemIndex: 0, offset: 1 },
    });
    const doc = layout([first, second]);
    const target = verticalCaret(doc, { blockKey: "p0", itemIndex: 0, offset: 3 }, 1, 35, measure);
    expect(target).toEqual({ blockKey: "p0", itemIndex: 0, offset: 1 });
  });
});
