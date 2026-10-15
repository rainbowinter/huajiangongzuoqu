import { describe, expect, test } from "vitest";
import { splitHighlightedHtml } from "./highlight";
import { renderMarkdownLines } from "./syntaxHighlight";

/** 剥掉全部标签，只留文字 —— 用来断言「切行没有改变内容」。 */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

describe("splitHighlightedHtml", () => {
  test("没有换行时就只有一行", () => {
    expect(splitHighlightedHtml('<span class="hljs-keyword">def</span>')).toEqual([
      '<span class="hljs-keyword">def</span>',
    ]);
  });

  test("**跨行的 span 不会被从中间劈开**", () => {
    // 这是这个函数存在的唯一理由：hljs 的多行字符串 / 块注释就是一个 span 横跨好几行，
    // 直接 split("\n") 会切出半个标签。
    const lines = splitHighlightedHtml('<span class="hljs-string">甲\n乙</span>丙');

    expect(lines).toHaveLength(2);
    // 每行都必须是**完整、自洽**的 HTML：标签配平，不能有落单的 `<` 或 `>`。
    expect(lines[0]).toBe('<span class="hljs-string">甲</span>');
    expect(lines[1]).toBe('<span class="hljs-string">乙</span>丙');
  });

  test("切完的文字与原文完全一致", () => {
    const html = [
      '<span class="hljs-comment">/* 甲',
      "乙",
      '丙 */</span><span class="hljs-keyword">const</span> a = 1;',
    ].join("\n");

    const lines = splitHighlightedHtml(html);

    expect(lines).toHaveLength(3);
    expect(lines.map(textOf).join("\n")).toBe(textOf(html));
  });

  test("嵌套标签跨行时逐层补上再重新打开", () => {
    const html =
      '<span class="a"><span class="b">甲\n乙</span></span>\n<span class="c">丙</span>';

    const lines = splitHighlightedHtml(html);

    expect(textOf(lines[0])).toBe("甲");
    expect(textOf(lines[1])).toBe("乙");
    expect(textOf(lines[2])).toBe("丙");
    // 第二行结尾那个 span 由外层补上，第三行不应再背着它。
    expect(lines[2]).toBe('<span class="c">丙</span>');
  });

  test("空文档给一行空串，而不是空数组", () => {
    // 行数必须与 content.split("\n") 对齐，否则高亮层与 textarea 会错行。
    expect(splitHighlightedHtml("")).toEqual([""]);
  });

  test("以换行结尾时保留末尾的空行", () => {
    expect(splitHighlightedHtml("甲\n")).toEqual(["甲", ""]);
  });
});

describe("renderMarkdownLines", () => {
  test("逐行输出，条数与正文行数一致", () => {
    const lines = renderMarkdownLines("# 标题\n正文\n\n- 列表");

    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe(""); // 空行就是空串，由渲染层补零宽空格撑行高
  });

  test("行数与 split 一致 —— 这是与 textarea 对齐的前提", () => {
    const content = "甲\n\n乙\n";
    expect(renderMarkdownLines(content)).toHaveLength(content.split("\n").length);
  });

  test("同一行在不同文档里得到相同结果（缓存不会串味）", () => {
    const a = renderMarkdownLines("## 标题\n正文");
    const b = renderMarkdownLines("别的\n## 标题");

    expect(a[0]).toBe(b[1]);
  });
});
