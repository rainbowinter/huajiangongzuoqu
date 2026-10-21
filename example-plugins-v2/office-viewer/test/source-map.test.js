import { describe, expect, it } from "vitest";
import {
  blockPlainText,
  rebuildBlockIndices,
  refreshNumbering,
} from "../src/docx/parse.js";
import {
  blockOffsetCaret,
  blockTextOffset,
  stepCaret,
} from "../src/edit/source-map.js";

/**
 * 源映射里与 DOM 无关的那一半：编号标签与块索引。
 *
 * 排版/命中测试要 Canvas，只能在浏览器验证台里跑；这里验的是纯数据部分。
 */

function paragraph(key, text, numPr = null, propsBase = {}) {
  const props = numPr ? { ...propsBase, numPr } : { ...propsBase };
  return {
    kind: "paragraph",
    key,
    index: 0,
    props,
    propsBase: props,
    items: text
      ? [{ kind: "text", text, style: { sizePx: 16 }, node: null, runNode: null }]
      : [],
    labelItems: [],
    numbering: null,
    editable: true,
    synthetic: null,
    styleChain: [],
  };
}

const styles = {
  defaults: { rPr: {}, pPr: {} },
  byId: new Map(),
  defaultsByType: {},
};

const theme = { major: {}, minor: {} };

function numbering() {
  return {
    abstractNums: new Map([
      [
        "0",
        {
          id: "0",
          levels: new Map([
            [
              0,
              {
                ilvl: 0,
                start: 1,
                numFmt: "decimal",
                lvlText: "%1.",
                suff: "tab",
                pPr: { ind: { left: 720 } },
                rPr: {},
              },
            ],
          ]),
        },
      ],
    ]),
    nums: new Map([["1", { id: "1", abstractNumId: "0", overrides: new Map() }]]),
  };
}

function docWith(blocks) {
  const doc = {
    blocks,
    styles,
    theme,
    numbering: numbering(),
    keyToIndex: new Map(),
  };
  refreshNumbering(doc);
  rebuildBlockIndices(doc);
  return doc;
}

describe("refreshNumbering", () => {
  it("按文档顺序生成标签，且不写进 items", () => {
    const doc = docWith([
      paragraph("p0", "第一项", { numId: 1, ilvl: 0 }),
      paragraph("p1", "第二项", { numId: 1, ilvl: 0 }),
    ]);

    expect(doc.blocks[0].labelItems.map((item) => item.text ?? "\t")).toEqual(["1.", "\t"]);
    expect(doc.blocks[1].labelItems.map((item) => item.text ?? "\t")).toEqual(["2.", "\t"]);
    expect(doc.blocks[0].labelItems[0].synthetic).toBe("numbering");
    expect(doc.blocks[0].labelItems[0].editable).toBe(false);
    expect(doc.blocks[0].items.map((item) => item.text)).toEqual(["第一项"]);
    expect(doc.blocks[1].items.map((item) => item.text)).toEqual(["第二项"]);
    // 编号自带的缩进合并进段落属性，但原 propsBase 不被改写。
    expect(doc.blocks[0].props.ind.left).toBe(720);
    expect(doc.blocks[0].propsBase.ind).toBeUndefined();
  });

  it("重新编号是幂等的，不累加缩进", () => {
    const doc = docWith([paragraph("p0", "一", { numId: 1, ilvl: 0 })]);
    refreshNumbering(doc);
    refreshNumbering(doc);
    expect(doc.blocks[0].labelItems[0].text).toBe("1.");
    expect(doc.blocks[0].props.ind.left).toBe(720);
  });

  it("没有编号的段落清空标签", () => {
    const doc = docWith([paragraph("p0", "正文")]);
    expect(doc.blocks[0].labelItems).toEqual([]);
    expect(doc.blocks[0].numbering).toBeNull();
  });
});

describe("光标与文本偏移", () => {
  const block = {
    key: "p0",
    index: 0,
    editable: true,
    synthetic: null,
    items: [
      { kind: "text", text: "甲" },
      { kind: "tab" },
      { kind: "text", text: "乙丙" },
    ],
  };

  it("原子 item 的两侧分别是 index 与 index+1", () => {
    expect(blockOffsetCaret(block, 1)).toEqual({ blockKey: "p0", itemIndex: 0, offset: 1 });
    expect(blockOffsetCaret(block, 2)).toEqual({ blockKey: "p0", itemIndex: 2, offset: 0 });
    expect(blockOffsetCaret(block, 3)).toEqual({ blockKey: "p0", itemIndex: 2, offset: 1 });
  });

  it("文本偏移与光标可以互相换算", () => {
    const caret = blockOffsetCaret(block, 3);
    expect(blockTextOffset(block, caret)).toBe(3);
  });

  it("左右移动跨过制表符", () => {
    const afterTab = { blockKey: "p0", itemIndex: 2, offset: 0 };
    expect(stepCaret({ keyToIndex: new Map([["p0", 0]]), blocks: [block] }, afterTab, -1)).toEqual({
      blockKey: "p0",
      itemIndex: 1,
      offset: 0,
    });
  });
});

describe("blockPlainText / rebuildBlockIndices", () => {
  it("拼出段落文本（tab / 换行也算）", () => {
    const block = {
      items: [
        { kind: "text", text: "甲" },
        { kind: "tab" },
        { kind: "text", text: "乙" },
        { kind: "lineBreak" },
        { kind: "image" },
      ],
    };
    expect(blockPlainText(block)).toBe("甲\t乙\n");
  });

  it("分段合并后重排 index 与 keyToIndex", () => {
    const doc = {
      blocks: [paragraph("p0", "甲"), paragraph("p1", "乙"), paragraph("p2", "丙")],
      keyToIndex: new Map(),
    };
    rebuildBlockIndices(doc);
    expect(doc.blocks.map((block) => block.index)).toEqual([0, 1, 2]);
    expect(doc.keyToIndex.get("p2")).toBe(2);
  });
});
