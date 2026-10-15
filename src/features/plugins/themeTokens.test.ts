import { describe, expect, test } from "vitest";
import { VIEW_THEME_TOKENS, pickThemeTokens } from "./themeTokens";

/** 一份「像样」的取值器：认得几个 token，其余空串 —— 与真实 DOM 里没定义时一致。 */
function reader(values: Record<string, string>) {
  return (name: string) => values[name] ?? "";
}

describe("递给插件视图的调色板", () => {
  test("只挑清单里那几个，别的变量一个都不外泄", () => {
    const tokens = pickThemeTokens(
      reader({ "--color-paper": "#fbf9f4", "--tab-indent-size": "2", "--color-ink": "#1a1a18" }),
    );

    expect(tokens).toEqual({ "--color-paper": "#fbf9f4", "--color-ink": "#1a1a18" });
    expect(Object.keys(tokens)).not.toContain("--tab-indent-size");
  });

  test("空值一个都不发 —— 空串会让视图那边的 var() 整条声明失效", () => {
    const tokens = pickThemeTokens(reader({ "--color-paper": "   ", "--color-ink": "#000" }));

    expect(tokens).toEqual({ "--color-ink": "#000" });
  });

  test("值两边的空白剪掉", () => {
    expect(pickThemeTokens(reader({ "--color-paper": " #fff " }))).toEqual({
      "--color-paper": "#fff",
    });
  });

  test("超长的值截断 —— 那是别人的样式表，不该被当成一整张图搬过来", () => {
    const tokens = pickThemeTokens(reader({ "--color-paper": "x".repeat(500) }));

    expect(tokens["--color-paper"]).toHaveLength(64);
  });

  test("清单里不许出现 --color-ink-faint", () => {
    // 这一版里它是**荧光笔的黄**（选区标记用的），不是「次级正文灰」。谁把它当成小字色
    // 接进插件视图，浅色主题下就会糊成一片黄 —— 钉一条测试，省得以后有人顺手加进来。
    expect(VIEW_THEME_TOKENS).not.toContain("--color-ink-faint");
  });
});
