import { describe, expect, test } from "vitest";
import { sliceBlockSource } from "./blockSource";

const CONTENT = ["前言", "", "| 表头 | 头2 |", "| --- | --- |", "| 1 | 2 |", "", "结尾"].join("\n");

describe("切出块的编辑区原文", () => {
  test("按偏移切出表格源码本身", () => {
    const start = CONTENT.indexOf("| 表头");
    const end = start + "| 表头 | 头2 |\n| --- | --- |\n| 1 | 2 |".length;

    expect(sliceBlockSource(CONTENT, { start: { offset: start }, end: { offset: end } })).toBe(
      "| 表头 | 头2 |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  test("首尾的空行与空白一并去掉", () => {
    // 块在源码里往往前后贴着空行，复制出来不该带一串换行。
    const start = CONTENT.indexOf("\n| 表头");
    const end = CONTENT.indexOf("\n\n结尾");

    expect(sliceBlockSource(CONTENT, { start: { offset: start }, end: { offset: end } })).toBe(
      "| 表头 | 头2 |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  test("没有位置信息时不猜 —— 返回 null，调用方就不显示复制按钮", () => {
    expect(sliceBlockSource(CONTENT, null)).toBeNull();
    expect(sliceBlockSource(CONTENT, undefined)).toBeNull();
    expect(sliceBlockSource(CONTENT, {})).toBeNull();
    expect(sliceBlockSource(CONTENT, { start: { offset: 3 }, end: {} })).toBeNull();
  });

  test("偏移越界或顺序反了也不切 —— 那种情况切出来的东西一定是错的", () => {
    expect(sliceBlockSource(CONTENT, { start: { offset: -1 }, end: { offset: 5 } })).toBeNull();
    expect(
      sliceBlockSource(CONTENT, { start: { offset: 10 }, end: { offset: CONTENT.length + 1 } }),
    ).toBeNull();
    expect(sliceBlockSource(CONTENT, { start: { offset: 10 }, end: { offset: 10 } })).toBeNull();
    expect(sliceBlockSource(CONTENT, { start: { offset: 10 }, end: { offset: 3 } })).toBeNull();
  });

  test("切出来是空的（比如只有空行）也当拿不到", () => {
    expect(sliceBlockSource(CONTENT, { start: { offset: 0 }, end: { offset: 0 } })).toBeNull();
    expect(
      sliceBlockSource("   \n\n  ", { start: { offset: 0 }, end: { offset: 7 } }),
    ).toBeNull();
  });

  test("小数偏移（理论上不该出现）一律拒绝", () => {
    expect(sliceBlockSource(CONTENT, { start: { offset: 1.5 }, end: { offset: 4 } })).toBeNull();
  });
});
