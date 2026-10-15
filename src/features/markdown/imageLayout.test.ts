import { describe, expect, it } from "vitest";
import { parseImageLayout } from "./imageLayout";

describe("parseImageLayout", () => {
  it("没有参数时原样返回说明文字", () => {
    expect(parseImageLayout("一张插图")).toEqual({
      alt: "一张插图",
      width: null,
      height: null,
      align: null,
    });
  });

  it("解析纯数字宽度，缺省单位为 px", () => {
    expect(parseImageLayout("插图|300")).toMatchObject({ alt: "插图", width: "300px" });
  });

  it("保留显式单位", () => {
    expect(parseImageLayout("插图|50%")).toMatchObject({ alt: "插图", width: "50%" });
  });

  it("解析宽 x 高", () => {
    expect(parseImageLayout("插图|300x200")).toMatchObject({
      alt: "插图",
      width: "300px",
      height: "200px",
    });
  });

  it("解析对齐关键字", () => {
    expect(parseImageLayout("插图|left")).toMatchObject({ alt: "插图", align: "left" });
    expect(parseImageLayout("插图|RIGHT")).toMatchObject({ alt: "插图", align: "right" });
  });

  it("同时支持尺寸与对齐，顺序不限", () => {
    expect(parseImageLayout("插图|300|center")).toMatchObject({
      alt: "插图",
      width: "300px",
      align: "center",
    });
    expect(parseImageLayout("插图|center|300")).toMatchObject({
      alt: "插图",
      width: "300px",
      align: "center",
    });
  });

  it("普通文本里的竖线不会被误吃", () => {
    // 「乙」既不是尺寸也不是对齐关键字，整段都应保留为说明文字。
    expect(parseImageLayout("甲|乙")).toEqual({
      alt: "甲|乙",
      width: null,
      height: null,
      align: null,
    });
  });

  it("只剥尾部连续匹配的参数，中间的不动", () => {
    expect(parseImageLayout("甲|乙|300")).toMatchObject({ alt: "甲|乙", width: "300px" });
  });

  it("没有竖线时整段都算说明文字", () => {
    // 「300」单独出现是说明文字而不是宽度——避免和「正文就是一个数字」撞车。
    expect(parseImageLayout("300")).toMatchObject({ alt: "300", width: null });
  });

  it("允许省略说明文字，只写宽度", () => {
    expect(parseImageLayout("|300")).toMatchObject({ alt: "", width: "300px" });
  });

  it("容忍参数两侧的空白", () => {
    expect(parseImageLayout("插图 | 300")).toMatchObject({ alt: "插图", width: "300px" });
  });

  it("空输入不抛错", () => {
    expect(parseImageLayout(undefined)).toEqual({
      alt: "",
      width: null,
      height: null,
      align: null,
    });
    expect(parseImageLayout("")).toMatchObject({ alt: "" });
  });
});
