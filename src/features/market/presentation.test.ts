import { describe, expect, it } from "vitest";
import {
  blockedText,
  catalogSummary,
  defaultRelease,
  formatSize,
  isInstallable,
  isMarketVisible,
  type MarketState,
} from "./presentation";
import type { MarketPlugin, MarketRelease } from "./types";

function release(overrides: Partial<MarketRelease> = {}): MarketRelease {
  return {
    version: "1.0.0",
    apiVersion: 2,
    url: "https://example.com/a.zip",
    sha256: "a".repeat(64),
    permissions: [],
    ...overrides,
  };
}

function plugin(overrides: Partial<MarketPlugin> = {}): MarketPlugin {
  return {
    name: "demo",
    description: "",
    releases: [release()],
    ...overrides,
  };
}

describe("isMarketVisible", () => {
  it("没配市场时一点痕迹都不留", () => {
    expect(isMarketVisible({ stage: "unavailable" })).toBe(false);
    // 还没问出来时也不出现 —— 露一下再收起比不出现更难看。
    expect(isMarketVisible({ stage: "unknown" })).toBe(false);
  });

  it("配了之后才出现，出错也要出现（否则用户以为市场没了）", () => {
    const visible: MarketState[] = [
      { stage: "loading" },
      { stage: "error", message: "网络不通" },
      {
        stage: "ready",
        catalog: { schema: 1, catalogVersion: 1, plugins: [] },
      },
    ];

    for (const state of visible) {
      expect(isMarketVisible(state)).toBe(true);
    }
  });
});

describe("blockedText", () => {
  it("没有原因码就是 null（这一版可以装）", () => {
    expect(blockedText(undefined)).toBeNull();
    expect(blockedText(null)).toBeNull();
    expect(blockedText("")).toBeNull();
  });

  it("把带参数的原因码解释成人话", () => {
    const noSandbox = blockedText("marketReleaseNoSandbox:1");
    expect(noSandbox).toContain("apiVersion 1");
    expect(noSandbox).toContain("沙箱");

    expect(blockedText("marketReleaseApiTooNew:3")).toContain("apiVersion 3");
    expect(blockedText("marketReleaseAppTooOld:9.0.0")).toContain("花笺 9.0.0");
  });

  it("认不出来的码原样显示，不说「未知错误」", () => {
    // 用户截图给作者时，原样的码才有用。
    expect(blockedText("marketNewReason")).toBe("marketNewReason");
    expect(blockedText("someFutureCode:42")).toBe("someFutureCode:42");
  });

  it("参数的冒号不会把码切错", () => {
    // 只按**第一个**冒号切：参数里再出现冒号不该影响辨认。
    expect(blockedText("marketReleaseAppTooOld:1:2")).toContain("花笺 1:2");
  });
});

describe("isInstallable", () => {
  it("只看 blocked 这一个字段", () => {
    expect(isInstallable(release())).toBe(true);
    expect(isInstallable(release({ blocked: "marketReleaseMissingUrl" }))).toBe(false);
  });
});

describe("defaultRelease", () => {
  it("拿到清单里指定的那一版", () => {
    const selected = defaultRelease(
      plugin({
        latest: "1.1.0",
        releases: [release({ version: "1.2.0", blocked: "marketReleaseApiTooNew:9" }), release({ version: "1.1.0" })],
      }),
    );
    expect(selected?.version).toBe("1.1.0");
  });

  it("没有可装版本时返回 null，而不是硬挑一个", () => {
    // 挑一个装不了的版本会让界面显示一个点了就失败的按钮。
    expect(defaultRelease(plugin({ latest: undefined }))).toBeNull();
    // `latest` 指向一个不存在的版本（清单自相矛盾）时也不能乱来。
    expect(defaultRelease(plugin({ latest: "9.9.9" }))).toBeNull();
  });
});

describe("formatSize", () => {
  it("按量级换单位", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("没写大小时给空串（界面上就是什么都不显示）", () => {
    expect(formatSize(undefined)).toBe("");
    expect(formatSize(0)).toBe("");
  });
});

describe("catalogSummary", () => {
  it("带上插件数与清单版本号", () => {
    expect(
      catalogSummary({ schema: 1, catalogVersion: 7, plugins: [plugin(), plugin({ name: "b" })] }),
    ).toBe("共 2 个插件 · 清单 v7");
  });
});
