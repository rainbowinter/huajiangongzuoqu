import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("app font stacks", () => {
  test("uses HarmonyOS Sans SC as the CJK fallback for monospace UI text", () => {
    const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

    expect(css).toMatch(/--font-mono:[\s\S]*"HarmonyOS Sans SC"[\s\S]*monospace;/);
  });

  /**
   * 这条是**防手贱**的：那个 `unicode-range` 单看很像笔误（为什么要把一段区间挖掉一个
   * 码位？），很容易被后来的人当成多余的声明删掉。删掉的后果是行内代码 `` `m` `` 又会
   * 变成「m 头上顶着一道重音」—— 一个不会报错、只是显示不对的问题，最难被发现。
   */
  test("把反引号 U+0060 排除在自带中文字体之外（否则它会压在左边那个字头上）", () => {
    const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

    expect(css).toMatch(/unicode-range:\s*U\+0000-005F,\s*U\+0061-10FFFF\s*;/);
  });
});
