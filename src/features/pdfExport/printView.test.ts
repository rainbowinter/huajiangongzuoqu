import { describe, expect, test } from "vitest";
import { toGrayColor } from "./printView";

/**
 * 「黑白」档靠它把每个颜色换成同明度的灰。
 *
 * 加权系数写错、或者把 `transparent` 也一起处理了，表现都很隐蔽（纸上只是「哪儿有点
 * 不对」），所以这里把边界钉死。
 */
describe("把颜色换成同明度的灰", () => {
  test("纯色按 Rec.709 加权，不是简单取平均", () => {
    // 0.2126 × 255 ≈ 54.2 —— 取平均的话会是 85，红纸会明显偏亮。
    expect(toGrayColor("rgb(255, 0, 0)")).toBe("rgb(54, 54, 54)");
    // 0.7152 × 255 ≈ 182.4 —— 同一亮度感受下，绿比红亮得多。
    expect(toGrayColor("rgb(0, 255, 0)")).toBe("rgb(182, 182, 182)");
    expect(toGrayColor("rgb(0, 0, 255)")).toBe("rgb(18, 18, 18)");
  });

  test("黑与白原样不动", () => {
    expect(toGrayColor("rgb(0, 0, 0)")).toBe("rgb(0, 0, 0)");
    expect(toGrayColor("rgb(255, 255, 255)")).toBe("rgb(255, 255, 255)");
  });

  test("本来就是灰的照旧", () => {
    expect(toGrayColor("rgb(128, 128, 128)")).toBe("rgb(128, 128, 128)");
  });

  test("带透明度的保留透明度，只换 RGB", () => {
    expect(toGrayColor("rgba(255, 0, 0, 0.35)")).toBe("rgba(54, 54, 54, 0.35)");
  });

  test("⚠️ 全透明的不能动 —— 一动就成了实心黑方块", () => {
    // `transparent` 在计算样式里就是 rgba(0,0,0,0)。
    expect(toGrayColor("rgba(0, 0, 0, 0)")).toBeNull();
  });

  test("认不出来的原样返回 null，交给它自己去解析", () => {
    expect(toGrayColor("currentColor")).toBeNull();
    expect(toGrayColor("none")).toBeNull();
    expect(toGrayColor("color(display-p3 1 0 0)")).toBeNull();
    expect(toGrayColor("")).toBeNull();
  });

  test("空格分隔的新写法也认（rgb(255 0 0) / rgb(255 0 0 / 50%)）", () => {
    expect(toGrayColor("rgb(255 0 0)")).toBe("rgb(54, 54, 54)");
    expect(toGrayColor("rgb(255 0 0 / 0.5)")).toBe("rgba(54, 54, 54, 0.5)");
  });
});
