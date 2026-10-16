import { describe, expect, test } from "vitest";
import { sidePanelModeOf } from "./sidePanelMode";

describe("侧栏层映射", () => {
  test("没有打开的面板时返回 null", () => {
    expect(sidePanelModeOf(null)).toBeNull();
    expect(sidePanelModeOf("")).toBeNull();
  });

  test("内建面板各归各的层", () => {
    expect(sidePanelModeOf("settings")).toBe("settings");
    expect(sidePanelModeOf("plugins")).toBe("plugins");
    expect(sidePanelModeOf("about")).toBe("about");
    // ⚠️ 漏进 `BUILT_IN` 的后果是「按钮亮了、侧栏开了、里面空的」——不报错，
    // 所以每加一个内建面板都必须在这里钉一条。
    expect(sidePanelModeOf("styles")).toBe("styles");
  });

  test("插件贡献的面板（standalone:<id>）统一落到 standalone 那一层", () => {
    expect(sidePanelModeOf("standalone:math-symbols")).toBe("standalone");
    expect(sidePanelModeOf("standalone:outline")).toBe("standalone");
  });

  test("认不出来的 id 也不崩 —— 当插件面板处理", () => {
    expect(sidePanelModeOf("whatever")).toBe("standalone");
  });
});
