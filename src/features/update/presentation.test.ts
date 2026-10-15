import { describe, expect, test } from "vitest";
import { downloadPercent, isUpdateVisible, type UpdateState } from "./presentation";

/**
 * 更新提示的显示判据。
 *
 * 这两条规则定的是「用户看到什么」，而 `useUpdate` 拖着 Tauri 插件、`UpdateBadge` 拖着
 * React —— 本仓库没有 @testing-library，两者都测不了。所以判据被抽到这个没有依赖的
 * 模块里，在这里钉住。
 */

describe("什么时候露出「有新版」提示", () => {
  test("没事可做时完全不出现", () => {
    // 这两条决定了这个功能在**大多数时候是完全隐形的** —— 启动检查在跑的时候也不该闪一下。
    expect(isUpdateVisible({ stage: "idle" })).toBe(false);
    expect(isUpdateVisible({ stage: "checking" })).toBe(false);
  });

  test("有事可做的每个阶段都出现", () => {
    const states: UpdateState[] = [
      { stage: "available", version: "2.0.1", notes: "" },
      { stage: "downloading", version: "2.0.1", notes: "", downloaded: 0, total: null },
      { stage: "ready", version: "2.0.1", notes: "" },
      { stage: "installing", version: "2.0.1", notes: "" },
      { stage: "error", message: "网络不通" },
    ];

    for (const state of states) {
      expect(isUpdateVisible(state), `${state.stage} 应当露出提示`).toBe(true);
    }
  });

  test("下载完那一刻仍然可见 —— 用户还得点一下才会装", () => {
    // ready 是「点了才下载」这条规则里最关键的一站：东西下好了但没装，
    // 提示要是消失，用户就再也找不到那个按钮了。
    expect(isUpdateVisible({ stage: "ready", version: "2.0.1", notes: "" })).toBe(true);
  });
});

describe("下载进度百分比", () => {
  test("正常算得出来", () => {
    expect(downloadPercent(0, 200)).toBe(0);
    expect(downloadPercent(50, 200)).toBe(25);
    expect(downloadPercent(199, 200)).toBe(99);
    expect(downloadPercent(200, 200)).toBe(100);
  });

  test("还不知道总量时返回 null，而不是 0", () => {
    // 端点没给 Content-Length 时总量是 null。当成 0% 会画出一条一直不动的进度条，
    // 比不显示进度更像卡死。界面据此换成「下载中」三个字。
    expect(downloadPercent(1234, null)).toBeNull();
  });

  test("总量为 0 或负数时也返回 null，不做除零", () => {
    expect(downloadPercent(10, 0)).toBeNull();
    expect(downloadPercent(10, -5)).toBeNull();
  });

  test("夹在 0..100 之间", () => {
    // 分块累加偶尔会超出总量一点点（服务端 chunks 与 Content-Length 不完全一致），
    // 进度条宽度不能因此变成负数或者超过容器。
    expect(downloadPercent(250, 200)).toBe(100);
    expect(downloadPercent(-10, 200)).toBe(0);
  });
});
