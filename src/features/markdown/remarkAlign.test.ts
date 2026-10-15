import { describe, expect, test } from "vitest";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { extractAlignBlocks } from "./remarkAlign";

/**
 * 直接吃**真的 mdast** —— 用手写的假树来测，就等于在测自己对「`:::` 会被解析成什么」的
 * 猜测，而那个猜测恰恰是这个插件里最容易错的地方（标记行会和相邻段落粘在同一个文本节点
 * 里，收尾那行还可能被列表 / 表格 / 引用当成续行吃掉）。
 */
function transform(markdown: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  return extractAlignBlocks(tree.children);
}

/** 把树压成好断言的形状。分隔符用 `=`，免得 `paragraph:` 撞上文本里的 `:::`。 */
function shape(nodes: ReturnType<typeof transform>): string[] {
  const lines: string[] = [];
  const walk = (list: ReturnType<typeof transform>, depth: number) => {
    for (const node of list) {
      const pad = "  ".repeat(depth);
      if (node.type === "alignBlock") {
        lines.push(`${pad}div(${node.data.hProperties.className.join(" ")})`);
        walk(node.children, depth + 1);
        continue;
      }
      lines.push(
        node.type === "paragraph"
          ? `${pad}paragraph=${node.children.map((child) => ("value" in child ? child.value : "")).join("")}`
          : `${pad}<${node.type}>`,
      );
    }
  };
  walk(nodes, 0);
  return lines;
}

describe("单段容器", () => {
  test("标记行与收尾都在同一个段落里", () => {
    // 最容易写错的一种：`:::` 不是 Markdown 语法，整块就是**一个**段落，
    // 标记行混在文本里，行与行之间是字面量的 \n。
    expect(shape(transform("::: center\n这段居中\n:::"))).toEqual([
      "div(md-align md-align-center)",
      "  paragraph=这段居中",
    ]);
  });

  test("三种对齐各有各的类名", () => {
    for (const kind of ["left", "center", "right"]) {
      expect(shape(transform(`::: ${kind}\n正文\n:::`))[0]).toBe(`div(md-align md-align-${kind})`);
    }
  });

  test("不写空格也认（:::center）", () => {
    expect(shape(transform(":::center\n正文\n:::"))[0]).toBe("div(md-align md-align-center)");
  });
});

describe("多段容器", () => {
  test("空行分隔的几段都收进来", () => {
    expect(shape(transform("::: center\n第一段\n\n第二段\n:::"))).toEqual([
      "div(md-align md-align-center)",
      "  paragraph=第一段",
      "  paragraph=第二段",
    ]);
  });

  test("围栏与上下文各就各位", () => {
    expect(shape(transform("前言\n\n::: right\n靠右\n:::\n\n后记"))).toEqual([
      "paragraph=前言",
      "div(md-align md-align-right)",
      "  paragraph=靠右",
      "paragraph=后记",
    ]);
  });

  test("围栏代码块、缩进代码块、标题放进容器都没问题", () => {
    // 这几种遇到 `:::` 会正常结束、让 `:::` 自成一段，所以不需要额外空行。
    expect(shape(transform("::: center\n```js\nlet a = 1;\n```\n:::"))).toEqual([
      "div(md-align md-align-center)",
      "  <code>",
    ]);
    expect(shape(transform("::: center\n## 标题\n:::"))).toEqual([
      "div(md-align md-align-center)",
      "  <heading>",
    ]);
  });
});

describe("认不出来就原样留着", () => {
  test("只有开头没有收尾：不吞内容，按普通文字渲染", () => {
    // 写了一半的时候（用户正打字），宁可显示得难看，也不要默默吃掉正文。
    expect(shape(transform("::: center\n这段还没收尾"))).toEqual([
      "paragraph=::: center\n这段还没收尾",
    ]);
  });

  test("不是三种对齐之一的不算标记", () => {
    expect(shape(transform("::: middle\n正文\n:::"))).toEqual(["paragraph=::: middle\n正文\n:::"]);
  });

  test("单独的 ::: 不成容器", () => {
    expect(shape(transform("正文\n\n:::\n\n更多"))).toEqual([
      "paragraph=正文",
      "paragraph=:::",
      "paragraph=更多",
    ]);
  });

  test("普通文档一个字都不动", () => {
    const lines = shape(transform("# 标题\n\n一段话，带 `代码` 和 $x$。"));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("<heading>");
    // 行内代码在 mdast 里是独立节点，这里只关心「没被包进容器」，正文本身不较真。
    expect(lines[1]).toMatch(/^paragraph=一段话，带 /);
  });
});

describe("收尾标记被吞的情况（惰性续行）", () => {
  // 跟在列表项 / 表格行 / 引用后面的那一行，Markdown 会把它当成前一行的续行。
  // 这时收尾的 `:::` 前面**必须空一行**，`applyAlign` 会自动补上（见 alignText.test.ts）。
  // 手工写的人如果漏了那个空行，这里就不认容器 —— 但**一个字都不吞**，原文照旧渲染，
  // 用户能直接看出自己少写了什么。

  test("列表结尾 + 空行：认", () => {
    expect(shape(transform("::: center\n- 甲\n- 乙\n\n:::"))).toEqual([
      "div(md-align md-align-center)",
      "  <list>",
    ]);
  });

  test("表格结尾 + 空行：认", () => {
    expect(shape(transform("::: center\n| a | b |\n| --- | --- |\n\n:::"))).toEqual([
      "div(md-align md-align-center)",
      "  <table>",
    ]);
  });

  test("列表结尾但**没空行**：不认，原样留着（收尾那行会被并进列表项）", () => {
    const lines = shape(transform("::: center\n- 甲\n- 乙\n:::"));

    expect(lines[0]).toBe("paragraph=::: center");
    expect(lines).toContain("<list>");
  });
});

describe("连着两个容器", () => {
  test("各归各的，不会一个吃到另一个", () => {
    expect(shape(transform("::: center\n甲\n:::\n\n::: right\n乙\n:::"))).toEqual([
      "div(md-align md-align-center)",
      "  paragraph=甲",
      "div(md-align md-align-right)",
      "  paragraph=乙",
    ]);
  });
});
