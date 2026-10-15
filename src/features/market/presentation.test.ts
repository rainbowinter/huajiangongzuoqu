import { describe, expect, it } from "vitest";
import {
  blockedText,
  catalogSummary,
  compareVersions,
  defaultRelease,
  findInstalled,
  formatSize,
  isInstallable,
  isMarketVisible,
  permissionsRequiringReview,
  releaseRelation,
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

describe("compareVersions", () => {
  it("按数字段比，不是按字符串", () => {
    // 字符串比较会说 "1.10.0" < "1.9.0"，那就全错了。
    expect(compareVersions("1.10.0", "1.9.0")!).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.99.99")!).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("1.0 与 1.0.0 是同一版", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions(" 1.0.0 ", "1.0.0")).toBe(0);
  });

  it("预发布后缀不参与比较（与 Rust 侧同一个决定）", () => {
    // 「宁可判成相同也不能判成更新」—— 见 sync.rs 的 version_is_newer。
    expect(compareVersions("1.0.0-beta1", "1.0.0")).toBe(0);
    expect(compareVersions("1.1.0-beta.2", "1.1.0")).toBe(0);
    expect(compareVersions("1.0.0+build7", "1.0.0")).toBe(0);
  });

  it("拆不出来就说比不了，而不是当成相等", () => {
    // 这是最要紧的一条：把「比不了」当成「一样」会让界面说「已是最新」，
    // 而它其实什么都不知道。
    expect(compareVersions("nightly", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", "dev")).toBeNull();
    expect(compareVersions("", "1.0.0")).toBeNull();
    // 整段必须是数字（与 Rust 严格一致）：`v1.0`、`1_2`、空段都拆不出来。
    expect(compareVersions("v1.0", "1.0.0")).toBeNull();
    expect(compareVersions("1_2", "1.2")).toBeNull();
    expect(compareVersions("1..0", "1.0.0")).toBeNull();
  });

  it("后缀里有非数字段也不影响：先切掉 - 之后的部分再看", () => {
    // `1.0-beta.1` 的主版本是 `1.0`，所以与 `1.0.0` 同版。
    expect(compareVersions("1.0-beta.1", "1.0.0")).toBe(0);
  });
});

describe("releaseRelation", () => {
  it("没装过就是安装", () => {
    expect(releaseRelation(undefined, "1.0.0")).toBe("install");
    expect(releaseRelation(null, "1.0.0")).toBe("install");
    // 装了但版本号是空的，也当没装过（清单里版本号缺失是常态）。
    expect(releaseRelation("", "1.0.0")).toBe("install");
  });

  it("区分更新、重装与降级", () => {
    expect(releaseRelation("1.0.0", "1.1.0")).toBe("newer");
    expect(releaseRelation("1.0.0", "1.0.0")).toBe("same");
    // 降级是允许的（历史版本），但界面上要说清楚，不能让人以为装的是最新版。
    expect(releaseRelation("1.1.0", "1.0.0")).toBe("older");
  });

  it("比不了的时候给 unknown，不猜", () => {
    expect(releaseRelation("nightly", "1.0.0")).toBe("unknown");
  });
});

describe("findInstalled", () => {
  it("按名字找", () => {
    const installed = [{ name: "a" }, { name: "b" }];
    expect(findInstalled(installed, "b")).toEqual({ name: "b" });
    expect(findInstalled(installed, "c")).toBeUndefined();
  });
});

describe("permissionsRequiringReview", () => {
  it("只挑出「新版本要、现在没授权」的那几个", () => {
    const granted = ["editor:read", "ui:panel"];
    const needed = ["editor:read", "ui:panel", "workspace:write", "storage"];

    expect(permissionsRequiringReview(granted, needed)).toEqual(["workspace:write", "storage"]);
  });

  it("权限没变时是空表 —— 界面据此说「权限没有变化」", () => {
    expect(permissionsRequiringReview(["editor:read"], ["editor:read"])).toEqual([]);
  });

  it("少了权限也算没有需要确认的（收紧不算风险）", () => {
    expect(permissionsRequiringReview(["editor:read", "storage"], ["editor:read"])).toEqual([]);
  });
});
