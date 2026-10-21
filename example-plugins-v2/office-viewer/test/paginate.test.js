import { describe, expect, it } from "vitest";
import { paginate } from "../src/layout/paginate.js";

const section = { contentHeight: 100 };

function line(height, extra = {}) {
  return {
    height,
    spaceBefore: 0,
    spaceAfter: 0,
    pageBreakAfter: false,
    ...extra,
  };
}

function block(lines, props = {}) {
  return { lines, props };
}

describe("paginate", () => {
  it("按内容高度装箱", () => {
    const pages = paginate(
      [block([line(30), line(30), line(30), line(30)], { widowControl: false })],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([3, 1]);
  });

  it("默认的孤行控制会把倒数第二行也带到下一页", () => {
    const pages = paginate(
      [block([line(30), line(30), line(30), line(30)])],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([2, 2]);
  });

  it("pageBreakBefore 强制换页", () => {
    const pages = paginate(
      [
        block([line(20)]),
        block([line(20)], { pageBreakBefore: true }),
      ],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([1, 1]);
  });

  it("keepLines：整段放不下就整段挪走", () => {
    const pages = paginate(
      [
        block([line(80)]),
        block([line(20), line(20), line(20)], { keepLines: true }),
      ],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([1, 3]);
  });

  it("孤行控制：段首不能只剩一行", () => {
    const pages = paginate(
      [
        block([line(90)]),
        block([line(10), line(10), line(10), line(10)]),
      ],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([1, 4]);
  });

  it("孤行控制：段尾不能只剩一行", () => {
    const pages = paginate(
      [
        block([line(60)]),
        block([line(10), line(10), line(10), line(10), line(10)]),
      ],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([4, 2]);
  });

  it("关掉 widowControl 后允许 4 + 1", () => {
    const pages = paginate(
      [
        block([line(60)]),
        block(
          [line(10), line(10), line(10), line(10), line(10)],
          { widowControl: false },
        ),
      ],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([5, 1]);
  });

  it("手动分页符在行后换页", () => {
    const pages = paginate(
      [block([line(20, { pageBreakAfter: true }), line(20)])],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([1, 1]);
  });

  it("keepNext：放不下时把带标题的一段一起挪走", () => {
    const pages = paginate(
      [
        block([line(50)]),
        block([line(30)], { keepNext: true }),
        block([line(30)]),
      ],
      section,
    );
    expect(pages.map((page) => page.lines.length)).toEqual([1, 2]);
  });
});
