import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRenderColors, type RenderColorConfig } from "./renderColors";

/**
 * `applyRenderColors` 直接操作 `document.documentElement.style`，而 vitest 跑在 node
 * 环境里没有 DOM。这里用一只最小的假 style 对象替代，只实现真正用到的两个方法。
 */
const applied = new Map<string, string>();

beforeEach(() => {
  applied.clear();
  (globalThis as { document?: unknown }).document = {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => {
          applied.set(name, value);
        },
        removeProperty: (name: string) => {
          applied.delete(name);
        },
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("applyRenderColors", () => {
  it("把配置项写成对应的 CSS 变量", () => {
    // 正文颜色不在这里 —— 它跟随主题，见 renderColors.ts 的说明。
    applyRenderColors({ tableColor: "#123456", quoteColor: "#abcdef" });

    expect(applied.get("--md-table-color")).toBe("#123456");
    expect(applied.get("--md-quote-color")).toBe("#abcdef");
  });

  it("未配置的项不写入变量，以免覆盖主题回退值", () => {
    applyRenderColors({ tableColor: "#123456" });

    expect(applied.has("--md-quote-color")).toBe(false);
    expect(applied.has("--md-caption-color")).toBe(false);
  });

  it("清空某项时移除变量而不是写空串", () => {
    // 写空串会让 `var(--md-x, fallback)` 拿到空值、整条声明失效；只有变量
    // **不存在**时才会取回退值。
    applyRenderColors({ quoteColor: "#123456" });
    expect(applied.get("--md-quote-color")).toBe("#123456");

    applyRenderColors({ quoteColor: "" });
    expect(applied.has("--md-quote-color")).toBe(false);
  });

  it("把纯空白也当作未配置", () => {
    applyRenderColors({ dividerColor: "   " });

    expect(applied.has("--md-divider-color")).toBe(false);
  });

  it("传入 null 时清掉全部变量", () => {
    applyRenderColors({ quoteColor: "#111111", tableColor: "#222222" });

    applyRenderColors(null);

    for (const value of applied.values()) {
      expect(value).toBeUndefined();
    }
    expect(applied.size).toBe(0);
  });

  it("没有 document 时静默返回", () => {
    delete (globalThis as { document?: unknown }).document;

    expect(() => applyRenderColors({ quoteColor: "#123456" } as RenderColorConfig)).not.toThrow();
  });
});
