import { describe, expect, it } from "vitest";
import { visibleButtonText } from "./toolbarText";

describe("visibleButtonText", () => {
  it("没有图标时，label 就是按钮上的字", () => {
    expect(visibleButtonText({ label: "适应宽度", hasIcon: false })).toBe("适应宽度");
    expect(visibleButtonText({ label: "›", hasIcon: false })).toBe("›");
  });

  it("有图标时，单字符 label 让位 —— 它替代的就是图标本身", () => {
    // 这一条就是「一个按钮里两个 >」那个 bug 的回归测试。
    expect(visibleButtonText({ label: "›", hasIcon: true })).toBe("");
    expect(visibleButtonText({ label: "‹", hasIcon: true })).toBe("");
    expect(visibleButtonText({ label: "+", hasIcon: true })).toBe("");
    expect(visibleButtonText({ label: "⟳", hasIcon: true })).toBe("");
  });

  it("有图标时，多字符 label 照旧显示 —— 那是文案不是替身", () => {
    expect(visibleButtonText({ label: "适应宽度", hasIcon: true })).toBe("适应宽度");
    expect(visibleButtonText({ label: "连续", hasIcon: true })).toBe("连续");
  });

  it("视图报了值就一律用值，图标与 label 都不参与", () => {
    expect(visibleButtonText({ label: "连续", value: "单页", hasIcon: true })).toBe("单页");
    expect(visibleButtonText({ label: "›", value: "12", hasIcon: true })).toBe("12");
    // 空串是**一个真实的值**（视图明确说「什么都不显示」），不能被 ?? 吞掉。
    expect(visibleButtonText({ label: "连续", value: "", hasIcon: true })).toBe("");
    expect(visibleButtonText({ label: "›", value: "", hasIcon: false })).toBe("");
  });

  it("代理对按字符数算，不按 UTF-16 长度算", () => {
    // 一个 emoji 是 2 个 code unit，但只有 1 个字符 —— 仍然属于「字形替身」。
    expect(visibleButtonText({ label: "🔍", hasIcon: true })).toBe("");
    expect(visibleButtonText({ label: "🔍🔍", hasIcon: true })).toBe("🔍🔍");
  });
});
