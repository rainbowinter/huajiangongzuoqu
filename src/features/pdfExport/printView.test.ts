import { describe, expect, test } from "vitest";
import { toGrayColor } from "./printView";

/**
 * 「黑白」档靠它把每个颜色换成同明度的灰。
 *
 * ⚠️ 这里**不自己算灰度**（第一版就是，结果漏了一整类颜色，见 `toGrayColor` 的说明）。
 * 输出的是 CSS 相对颜色语法，真正的换算交给浏览器 —— 所以这一组测的是
 * 「喂进去什么、吐出来什么」，不是「灰值算得对不对」（那个在 `printbg.html` 里读像素验）。
 */
describe("把颜色换成同明度的灰", () => {
  test("rgb 包成 oklch 相对色，取明度、彩度归零", () => {
    expect(toGrayColor("rgb(255, 0, 0)")).toBe("oklch(from rgb(255, 0, 0) l 0 h)");
    expect(toGrayColor("rgb(0, 0, 0)")).toBe("oklch(from rgb(0, 0, 0) l 0 h)");
  });

  test("⚠️ color-mix 算出来的 oklab 也要能处理 —— 这正是漏掉过的那一类", () => {
    // Tailwind 4 的 `/透明度` 修饰符全都会编译成 color-mix(in oklab, …)，
    // 计算样式给的就是这个形状。
    expect(toGrayColor("oklab(0.627966 0.22488 0.125859 / 0.7)")).toBe(
      "oklch(from oklab(0.627966 0.22488 0.125859 / 0.7) l 0 h)",
    );
    expect(toGrayColor("color(srgb 1 0 0 / 0.5)")).toBe("oklch(from color(srgb 1 0 0 / 0.5) l 0 h)");
    expect(toGrayColor("hsl(0 100% 50%)")).toBe("oklch(from hsl(0 100% 50%) l 0 h)");
  });

  test("透明度由相对颜色语法自己保留，不用我们操心", () => {
    // 外层不写 alpha ⇒ 沿用 `from` 那个颜色的 —— 所以 0.35 原样留在里面。
    expect(toGrayColor("rgba(255, 0, 0, 0.35)")).toBe("oklch(from rgba(255, 0, 0, 0.35) l 0 h)");
  });

  test("⚠️ transparent 不能动 —— 一动就成了实心黑方块", () => {
    expect(toGrayColor("transparent")).toBeNull();
  });

  test("不是颜色的原样返回 null", () => {
    expect(toGrayColor("currentColor")).toBeNull();
    expect(toGrayColor("none")).toBeNull();
    expect(toGrayColor("")).toBeNull();
    expect(toGrayColor("   ")).toBeNull();
  });
});
