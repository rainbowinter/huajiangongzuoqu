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
  planAutoUpdates,
  releaseRelation,
  reportText,
  skipText,
  sortCatalogPlugins,
  filterCatalogPlugins,
  updateAvailable,
  type AutoUpdateCandidate,
  type MarketState,
} from "./presentation";
import type { MarketCatalog, MarketPlugin, MarketRelease } from "./types";

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

describe("updateAvailable", () => {
  function catalogWith(version: string | undefined): MarketCatalog {
    return {
      schema: 1,
      catalogVersion: 1,
      plugins: [
        {
          name: "demo",
          description: "",
          ...(version ? { latest: version } : {}),
          releases: [],
        },
      ],
    };
  }

  it("清单里的版本更新时才给出版本号", () => {
    expect(updateAvailable({ name: "demo", version: "1.0.0" }, catalogWith("1.1.0"))).toBe("1.1.0");
    expect(updateAvailable({ name: "demo", version: "1.0.0" }, catalogWith("1.0.0"))).toBeNull();
    expect(updateAvailable({ name: "demo", version: "1.1.0" }, catalogWith("1.0.0"))).toBeNull();
  });

  it("比不了大小的版本号不提示更新", () => {
    // 猜不出来就别提示 —— 用户点过去发现是降级，比不提示更糟。
    expect(updateAvailable({ name: "demo", version: "nightly" }, catalogWith("1.0.0"))).toBeNull();
  });

  it("没有市场、清单里没有这个插件、清单里没有可装版本 —— 都是不提示", () => {
    expect(updateAvailable({ name: "demo", version: "1.0.0" }, null)).toBeNull();
    expect(updateAvailable({ name: "other", version: "1.0.0" }, catalogWith("1.1.0"))).toBeNull();
    expect(updateAvailable({ name: "demo", version: "1.0.0" }, catalogWith(undefined))).toBeNull();
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

// ---------------------------------------------------------------- 列表的呈现顺序

describe("清单的排序与搜索", () => {
  const list = [
    { name: "alpha", description: "看图" },
    { name: "beta", description: "", author: "张三" },
    { name: "gamma", description: "PDF 阅读器" },
  ];

  it("装过的沉到后面，两半各自保持清单原来的顺序", () => {
    const sorted = sortCatalogPlugins(list, [{ name: "beta" }]);

    expect(sorted.map((item) => item.name)).toEqual(["alpha", "gamma", "beta"]);
  });

  it("一个都没装时顺序原样不动", () => {
    expect(sortCatalogPlugins(list, []).map((item) => item.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("「装了」看的是名字，与已装列表里还有什么字段无关", () => {
    const sorted = sortCatalogPlugins(list, [{ name: "alpha" }, { name: "gamma" }]);

    expect(sorted.map((item) => item.name)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("搜索匹配名字、说明、作者，都忽略大小写", () => {
    expect(filterCatalogPlugins(list, "GAM").map((i) => i.name)).toEqual(["gamma"]);
    expect(filterCatalogPlugins(list, "pdF").map((i) => i.name)).toEqual(["gamma"]);
    expect(filterCatalogPlugins(list, "张三").map((i) => i.name)).toEqual(["beta"]);
  });

  it("空串或全是空白 → 原样返回（不是「一个都不匹配」）", () => {
    expect(filterCatalogPlugins(list, "")).toHaveLength(3);
    expect(filterCatalogPlugins(list, "   ")).toHaveLength(3);
  });

  it("搜不到就是空列表，调用方据此说「没有匹配的」", () => {
    expect(filterCatalogPlugins(list, "没有这个东西")).toEqual([]);
  });
});

// ---------------------------------------------------------------- 自动更新

function candidate(overrides: Partial<AutoUpdateCandidate> = {}): AutoUpdateCandidate {
  return {
    name: "demo",
    version: "1.0.0",
    enabled: true,
    autoUpdate: true,
    origin: "market",
    grantedPermissions: ["workspace:read"],
    ...overrides,
  };
}

function catalog(overrides: Partial<MarketPlugin> = {}): MarketCatalog {
  return {
    schema: 1,
    catalogVersion: 1,
    plugins: [
      {
        name: "demo",
        description: "",
        latest: "2.0.0",
        releases: [release({ version: "2.0.0", permissions: ["workspace:read"] })],
        ...overrides,
      },
    ],
  };
}

describe("自动更新的计划", () => {
  it("开了自动更新、市场里有新版 → 装，授权集合就是那一版要的那些", () => {
    const plan = planAutoUpdates([candidate()], catalog());

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      name: "demo",
      action: "update",
      permissions: ["workspace:read"],
    });
  });

  it("⚠️ 新版要多一个权限 → **不装**，只报「要重新确认」", () => {
    // 这是这条路上最要紧的一条：静默把新权限装上，等于「第一次确认就永久放行」。
    const plan = planAutoUpdates(
      [candidate()],
      catalog({
        releases: [
          release({ version: "2.0.0", permissions: ["workspace:read", "editor:write"] }),
        ],
      }),
    );

    expect(plan).toEqual([
      { name: "demo", action: "skip", reason: "needs-review", version: "2.0.0" },
    ]);
  });

  it("授权集合取交集：清单里多写的权限一个都不给出去", () => {
    const plan = planAutoUpdates(
      [candidate({ grantedPermissions: ["workspace:read", "ui:panel"] })],
      catalog({
        releases: [release({ version: "2.0.0", permissions: ["workspace:read"] })],
      }),
    );

    expect(plan[0]).toMatchObject({ action: "update", permissions: ["workspace:read"] });
  });

  it("没开自动更新 / 不是市场装的 / 已停用的，一条都不进计划", () => {
    expect(planAutoUpdates([candidate({ autoUpdate: false })], catalog())).toEqual([]);
    expect(planAutoUpdates([candidate({ origin: "bundled" })], catalog())).toEqual([]);
    expect(planAutoUpdates([candidate({ enabled: false })], catalog())).toEqual([]);
  });

  it("已经是最新、或市场里没有它 —— 都是正常状态，不汇报", () => {
    expect(planAutoUpdates([candidate({ version: "2.0.0" })], catalog())).toEqual([]);
    expect(planAutoUpdates([candidate()], { schema: 1, catalogVersion: 1, plugins: [] })).toEqual(
      [],
    );
  });

  it("这一版装不了 → skip 并说明是「装不了」而不是「要权限」", () => {
    const plan = planAutoUpdates(
      [candidate()],
      catalog({ releases: [release({ version: "2.0.0", blocked: "apiVersionUnsupported:3" })] }),
    );

    expect(plan).toEqual([{ name: "demo", action: "skip", reason: "blocked", version: "2.0.0" }]);
  });

  it("版本号没法比较时不动手（与 releaseRelation 同一条判据）", () => {
    expect(planAutoUpdates([candidate({ version: "看心情" })], catalog())).toEqual([]);
  });
});

describe("自动更新的说法", () => {
  it("跳过的那条要说清楚为什么", () => {
    expect(skipText("needs-review", "2.0.0")).toContain("权限");
    expect(skipText("blocked", "2.0.0")).toContain("装不了");
  });

  it("什么都没发生时不说话", () => {
    expect(reportText(null)).toBeNull();
    expect(reportText({ updated: [], skipped: [] })).toBeNull();
  });

  it("更新成功与跳过合成一句话", () => {
    const text = reportText({
      updated: ["demo → v2.0.0"],
      skipped: [skipText("needs-review", "3.0.0")],
    });

    expect(text).toContain("已自动更新：demo → v2.0.0");
    expect(text).toContain("权限");
  });
});
