import { describe, expect, test } from "vitest";
import { describeSyncReport, loadOrder, missingDependencies } from "./loader";
import type { PluginManifest, PluginSyncReport } from "./types";

/**
 * 只测「校正报告该怎么说给人听」。
 *
 * 这一层值得单独钉住，是因为它决定了**什么时候不该出声**：校正每次启动都会跑，绝大多数
 * 时候什么都不用做，此时弹一个「插件版本校正完成」只会让人以为出了什么事。真正的判据
 * 全在 `describeSyncReport` 里，接 Toast 的那一步没有分支。
 */
function report(overrides: Partial<PluginSyncReport> = {}): PluginSyncReport {
  return { updated: [], skipped: [], backedUp: [], migrated: false, ...overrides };
}

describe("版本校正报告的说辞", () => {
  test("什么都没发生就一个字都不说", () => {
    expect(describeSyncReport(report())).toBeNull();
  });

  test("更新了插件就报数量和名字", () => {
    const message = describeSyncReport(report({ updated: ["outline", "line-numbers"] }));

    expect(message).toContain("2 个插件");
    expect(message).toContain("outline");
    expect(message).toContain("line-numbers");
  });

  test("用户改过的插件单独说一句 —— 那是他需要知道的事", () => {
    const message = describeSyncReport(
      report({ updated: ["outline"], skipped: ["line-numbers"] }),
    );

    expect(message).toContain("已更新 1 个插件");
    expect(message).toContain("跳过");
  });

  test("备份过原件也要说", () => {
    const message = describeSyncReport(report({ updated: ["outline"], backedUp: ["outline"] }));

    expect(message).toContain("备份");
  });

  test("状态文件单独的迁移只在没别的事时说一句", () => {
    // 它没有任何用户可见的后果，混在别的消息里只会让人去找「哪里变了」。
    expect(describeSyncReport(report({ migrated: true }))).toBe("插件状态文件已升级");

    const withUpdates = describeSyncReport(report({ migrated: true, updated: ["outline"] }));
    expect(withUpdates).toContain("已更新 1 个插件");
    expect(withUpdates).not.toContain("状态文件");
  });
});

// ---------------------------------------------------------------- 插件依赖

function manifest(name: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name,
    version: "1.0.0",
    main: "index.js",
    description: "",
    apiVersion: 2,
    permissions: [],
    grantedPermissions: [],
    requires: [],
    enabled: true,
    autoUpdate: false,
    valid: true,
    warnings: [],
    dirPath: `/plugins/${name}`,
    ...overrides,
  };
}

/**
 * 加载顺序：**被依赖的先加载**。
 *
 * 之前是按名字的字母序 for 循环，于是 `pdf-annotations`（字母序在前）会先于它依赖的
 * `pdf-viewer` 加载 —— 前者要去扩展后者的视图，而后者还没注册任何东西。
 */
describe("按依赖排加载顺序", () => {
  test("被依赖的排在前面，与字母序无关", () => {
    const order = loadOrder([
      manifest("pdf-annotations", { requires: ["pdf-viewer"] }),
      manifest("pdf-viewer"),
    ]);

    expect(order.map((item) => item.name)).toEqual(["pdf-viewer", "pdf-annotations"]);
  });

  test("依赖链有多层也排得对", () => {
    const order = loadOrder([
      manifest("c", { requires: ["b"] }),
      manifest("b", { requires: ["a"] }),
      manifest("a"),
    ]);

    expect(order.map((item) => item.name)).toEqual(["a", "b", "c"]);
  });

  test("互相依赖不会死循环 —— 两个都留在那儿，让「缺依赖」那道门去说清楚", () => {
    const a = manifest("a", { requires: ["b"] });
    const b = manifest("b", { requires: ["a"] });

    const order = loadOrder([a, b]);
    expect(order).toHaveLength(2);
    // 谁先谁后没有正确答案，但**不能卡住**、也不能丢东西。
    expect(new Set(order.map((item) => item.name))).toEqual(new Set(["a", "b"]));
  });

  test("依赖一个不存在的名字不报错（那条「它坏了」该由坏插件自己说）", () => {
    const order = loadOrder([manifest("a", { requires: ["查无此插件"] })]);

    expect(order.map((item) => item.name)).toEqual(["a"]);
  });

  test("没写 requires 的照旧按传进来的次序", () => {
    const order = loadOrder([manifest("zebra"), manifest("alpha")]);

    expect(order.map((item) => item.name)).toEqual(["zebra", "alpha"]);
  });
});

describe("依赖有没有被满足", () => {
  const target = manifest("pdf-annotations", { requires: ["pdf-viewer"] });

  test("装了、也启用着 → 满足", () => {
    expect(missingDependencies(target, [manifest("pdf-viewer")])).toEqual([]);
  });

  test("没装 → 缺", () => {
    expect(missingDependencies(target, [])).toEqual(["pdf-viewer"]);
  });

  test("装了但**被停用** → 也算缺", () => {
    // 停掉 pdf-viewer 之后，批注插件对着一个什么都没注册的宿主只会报一堆看不懂的错。
    expect(missingDependencies(target, [manifest("pdf-viewer", { enabled: false })])).toEqual([
      "pdf-viewer",
    ]);
  });

  test("装了但清单是坏的 → 也算缺（它根本没加载）", () => {
    expect(missingDependencies(target, [manifest("pdf-viewer", { valid: false })])).toEqual([
      "pdf-viewer",
    ]);
  });

  test("没声明依赖的插件永远不缺", () => {
    expect(missingDependencies(manifest("demo"), [])).toEqual([]);
  });
});
