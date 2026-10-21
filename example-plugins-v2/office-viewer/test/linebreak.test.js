import { describe, expect, it } from "vitest";
import { canBreakBefore } from "../src/layout/atoms.js";

function textAtom(text, isCJK, extra = {}) {
  return {
    kind: "text",
    text,
    isCJK,
    isSpace: false,
    isTab: false,
    width: 10,
    lineHeight: 20,
    ...extra,
  };
}

describe("canBreakBefore", () => {
  it("中文与中文之间可以断行", () => {
    const atoms = [textAtom("中", true), textAtom("文", true)];
    expect(canBreakBefore(atoms, 1)).toBe(true);
  });

  it("行首禁则：逗号不能出现在行首", () => {
    const atoms = [textAtom("中", true), textAtom("，", true)];
    expect(canBreakBefore(atoms, 1)).toBe(false);
  });

  it("行尾禁则：左括号不能留在一行末尾", () => {
    const atoms = [textAtom("（", true), textAtom("中", true)];
    expect(canBreakBefore(atoms, 1)).toBe(false);
  });

  it("空格之后可以断，空格之前不能断", () => {
    const atoms = [textAtom("A", false), textAtom(" ", false, { isSpace: true }), textAtom("中", true)];
    expect(canBreakBefore(atoms, 1)).toBe(false);
    expect(canBreakBefore(atoms, 2)).toBe(true);
  });

  it("数字和单位不拆开：2026年 / 9月", () => {
    expect(canBreakBefore([textAtom("2026", false), textAtom("年", true)], 1)).toBe(false);
    expect(canBreakBefore([textAtom("9", false), textAtom("月", true)], 1)).toBe(false);
  });

  it("数字前面的提示字不拆：第1章", () => {
    expect(canBreakBefore([textAtom("第", true), textAtom("1", false)], 1)).toBe(false);
  });

  it("中文与数字之间可以断（年 / 9）", () => {
    expect(canBreakBefore([textAtom("年", true), textAtom("9", false)], 1)).toBe(true);
  });

  it("西文词之间没有空格就不能断", () => {
    const atoms = [textAtom("foo", false), textAtom("bar", false)];
    expect(canBreakBefore(atoms, 1)).toBe(false);
  });

  it("标点后面可以断，标点前面不能断", () => {
    expect(canBreakBefore([textAtom("foo", false), textAtom(",", false)], 1)).toBe(false);
    expect(canBreakBefore([textAtom(",", false), textAtom("bar", false)], 1)).toBe(true);
  });

  it("图片两侧可以断", () => {
    const atoms = [textAtom("中", true), { kind: "image", width: 100, height: 100 }];
    expect(canBreakBefore(atoms, 1)).toBe(true);
  });
});
