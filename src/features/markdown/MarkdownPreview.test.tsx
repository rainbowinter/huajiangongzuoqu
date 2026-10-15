import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

/**
 * 预览区渲染的**接线**测试。
 *
 * 这里只跑 `react-dom/server`，不需要 jsdom —— 这个仓库没有 DOM 测试库，而「渲染出什么
 * HTML」服务端渲染就能答。点击行为（真的复制走了什么）在 `blockSource.test.ts` 里以纯函数
 * 覆盖，两边合起来正好把这条链路盖住。
 */
describe("MarkdownPreview", () => {
  test("marks rendered Markdown content as selectable", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="# 花笺\n\n正文" />);

    expect(markup).toContain("markdown-selectable");
    expect(markup).toContain("<h1");
    expect(markup).toContain("花笺");
    expect(markup).toContain("正文");
  });

  test("keeps code block controls outside the horizontally scrollable pre", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview content={"```text\nvery long code line\n```"} />,
    );

    const preCloseIndex = markup.indexOf("</pre>");
    const buttonIndex = markup.indexOf("<button");

    expect(markup).toContain("markdown-code-block");
    expect(markup).toContain("markdown-code-scroll");
    expect(preCloseIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeGreaterThan(preCloseIndex);
  });
});

/**
 * 表格上的复制按钮。
 *
 * 为什么值得单独盖：按钮能不能出现，取决于 react-markdown 有没有把 hast 节点的 `position`
 * （源码偏移）传到组件里。那是**外部契约**，一旦上游换实现、或者我们多加一个会丢 position
 * 的 rehype 插件，按钮就会悄悄消失 —— 用户看到的只是「说好的按钮没了」，没有任何报错。
 * 所以这里把「有表格就该有按钮」钉死。
 */

/** 文档里**没有代码块**，所以「复制」这个词只可能来自表格那个按钮。 */
const WITH_TABLE = ["前言", "", "| 表头 | 头2 |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
const WITHOUT_TABLE = ["前言", "", "一段普通文字。", ""].join("\n");

describe("表格的复制按钮", () => {
  test("有表格就有按钮", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={WITH_TABLE} />);

    expect(markup).toContain("<table");
    expect(markup).toContain("复制");
  });

  test("没有表格就没有按钮 —— 免得按钮变成「到处都有一点」", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={WITHOUT_TABLE} />);

    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("复制");
  });

  test("开着 HTML 渲染（多走 rehype-raw + 消毒）时按钮还在", () => {
    // 那条管线会先由 rehype-raw 重排整棵树，再由 rehype-sanitize 按白名单裁剪节点。
    // position 或 table 只要被其中任何一步弄丢，按钮就没了 —— 而这是最容易在改动里
    // 悄悄发生的一种。
    const markup = renderToStaticMarkup(<MarkdownPreview content={WITH_TABLE} renderHtml />);

    expect(markup).toContain("<table");
    expect(markup).toContain("复制");
  });

  test("按钮在表格的横向滚动区之外（跟代码块一样，滚走了也还看得见）", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={WITH_TABLE} />);

    const tableClose = markup.indexOf("</table>");
    const scrollClose = markup.indexOf("</div>", tableClose);
    const buttonIndex = markup.indexOf("<button");

    expect(markup).toMatch(/class="my-3 relative group"/);
    expect(tableClose).toBeGreaterThan(-1);
    // 关掉 overflow-x-auto 那层之后才轮到按钮 —— 在滚动区里面的话，横向一拖就看不见了。
    expect(scrollClose).toBeGreaterThan(tableClose);
    expect(buttonIndex).toBeGreaterThan(scrollClose);
    expect(markup).toContain("group-hover:opacity-100");
  });
});
