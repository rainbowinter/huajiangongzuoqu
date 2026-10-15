import { describe, expect, test } from "vitest";
import { renderMarkdownLines } from "./syntaxHighlight";

/**
 * 编辑区高亮层对段落对齐标记行的处理。
 *
 * 这两行在预览里**不产生任何位置**，所以在正文里尤其需要一点提示色 ——
 * 不然用户会盯着一个「看起来没生效」的 `:::` 发呆。
 */
describe("段落对齐的标记行", () => {
  test("开头与收尾都上色", () => {
    const [open, close] = renderMarkdownLines("::: center\n:::");

    expect(open).toContain("#c084fc");
    expect(close).toContain("#c084fc");
    // 上色归上色，原文一个字都不能动（高亮层与 textarea 是逐字叠在一起的）。
    expect(open).toContain("::: center");
  });

  test("三种对齐都认", () => {
    for (const kind of ["left", "center", "right"]) {
      expect(renderMarkdownLines(`::: ${kind}`)[0]).toContain("#c084fc");
    }
  });

  test("普通正文、以及 `:::` 后面还有别的字样的行都不上色", () => {
    expect(renderMarkdownLines("一段普通的话")[0]).not.toContain("#c084fc");
    expect(renderMarkdownLines("::: middle")[0]).not.toContain("#c084fc");
    expect(renderMarkdownLines(":::center 后面还有字")[0]).not.toContain("#c084fc");
  });
});
