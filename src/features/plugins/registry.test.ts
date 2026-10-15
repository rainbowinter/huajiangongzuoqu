import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  addPluginCommand,
  clearAllPlugins,
  getStatusBarRenderers,
  listDecorations,
  listEditorGutters,
  listLoadedPlugins,
  listPluginCommands,
  listPluginPanels,
  pluginRegistrySizes,
  registerDecoration,
  registerEditorGutter,
  registerLoadedPlugin,
  registerPluginPanel,
  registerSelectionTransformer,
  registerStatusBarRenderer,
  subscribePluginCommands,
  transformSelection,
  unregisterPlugin,
  updatePluginStatus,
} from "./registry";
import type { PluginManifest } from "./types";

function manifest(name: string, apiVersion = 2): PluginManifest {
  return {
    name,
    version: "1.0.0",
    main: "index.js",
    description: "",
    apiVersion,
    permissions: [],
    grantedPermissions: [],
    enabled: true,
    autoUpdate: false,
    valid: true,
    warnings: [],
    dirPath: `/plugins/${name}`,
  };
}

beforeEach(() => {
  clearAllPlugins();
});

describe("归属与卸载", () => {
  test("注册项带归属，可按插件粒度卸载", () => {
    addPluginCommand({ id: "a:1", title: "A", plugin: "alpha", run: () => {} });
    addPluginCommand({ id: "b:1", title: "B", plugin: "beta", run: () => {} });
    registerPluginPanel("alpha", { id: "panel-a", title: "A", render: () => "" });

    expect(pluginRegistrySizes()).toMatchObject({
      commands: 2,
      panels: 1,
    });

    unregisterPlugin("alpha");

    expect(listPluginCommands().map((c) => c.plugin)).toEqual(["beta"]);
    expect(listPluginPanels()).toEqual([]);
    expect(pluginRegistrySizes().commands).toBe(1);
  });

  test("卸载一个插件不影响另一个插件的注册项", () => {
    registerStatusBarRenderer("alpha", () => "α");
    registerStatusBarRenderer("beta", () => "β");

    unregisterPlugin("alpha");

    expect(getStatusBarRenderers()).toHaveLength(1);
    expect(getStatusBarRenderers()[0](null)).toBe("β");
  });

  test("注册返回的 Disposable 可以单独撤销", () => {
    const disposable = addPluginCommand({
      id: "a:1",
      title: "A",
      plugin: "alpha",
      run: () => {},
    });

    expect(listPluginCommands()).toHaveLength(1);
    disposable.dispose();
    expect(listPluginCommands()).toHaveLength(0);
    // 幂等
    disposable.dispose();
    expect(listPluginCommands()).toHaveLength(0);
  });

  test("未注册任何东西的插件名卸载是无害的", () => {
    expect(() => unregisterPlugin("nobody")).not.toThrow();
  });
});

describe("订阅", () => {
  test("注册与卸载都会通知订阅者", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePluginCommands(listener);

    const disposable = addPluginCommand({
      id: "a:1",
      title: "A",
      plugin: "alpha",
      run: () => {},
    });
    expect(listener).toHaveBeenCalledTimes(1);

    disposable.dispose();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    addPluginCommand({ id: "a:2", title: "A2", plugin: "alpha", run: () => {} });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("某个订阅者抛错不影响其他订阅者", () => {
    const good = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    subscribePluginCommands(() => {
      throw new Error("bad listener");
    });
    subscribePluginCommands(good);

    expect(() =>
      addPluginCommand({ id: "a:1", title: "A", plugin: "alpha", run: () => {} }),
    ).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });
});

describe("选区转换器", () => {
  test("返回第一个非空结果", async () => {
    registerSelectionTransformer("alpha", () => null);
    registerSelectionTransformer("beta", () => "b 的结果");
    registerSelectionTransformer("gamma", () => "g 的结果");

    await expect(transformSelection("x")).resolves.toBe("b 的结果");
  });

  test("支持异步转换器（v2 插件在 Worker 里只能异步回话）", async () => {
    registerSelectionTransformer("alpha", async (text) => `[${text}]`);

    await expect(transformSelection("hi")).resolves.toBe("[hi]");
  });

  test("全部返回 null 时结果为 null", async () => {
    registerSelectionTransformer("alpha", () => null);
    await expect(transformSelection("x")).resolves.toBeNull();
  });

  test("卸载后转换器不再参与", async () => {
    registerSelectionTransformer("alpha", () => "a");
    unregisterPlugin("alpha");
    await expect(transformSelection("x")).resolves.toBeNull();
  });

  test("空字符串结果视为有效结果（不是 null）", async () => {
    registerSelectionTransformer("alpha", () => "");
    await expect(transformSelection("x")).resolves.toBe("");
  });
});

describe("已加载插件状态", () => {
  test("记录状态与沙箱标记", () => {
    registerLoadedPlugin(manifest("v2plugin", 2), "loaded");
    registerLoadedPlugin(manifest("v1plugin", 1), "legacy");

    const records = listLoadedPlugins();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ sandboxed: true, status: "loaded" });
    expect(records[1]).toMatchObject({ sandboxed: false, status: "legacy" });
  });

  test("可以更新运行状态（例如被看门狗暂停）", () => {
    registerLoadedPlugin(manifest("demo"), "loaded");
    updatePluginStatus("demo", "suspended", "连续超时");

    const record = listLoadedPlugins()[0];
    expect(record.status).toBe("suspended");
    expect(record.error).toBe("连续超时");
  });

  test("无效清单也会出现在列表里", () => {
    registerLoadedPlugin(manifest("broken"), "invalid", "pluginManifestInvalid");
    expect(listLoadedPlugins()[0]).toMatchObject({
      status: "invalid",
      error: "pluginManifestInvalid",
    });
  });
});

describe("重载时的兜底清理", () => {
  /**
   * 行旁注与行内装饰是「带活闭包」的注册项，正常卸载由宿主的 disposable 负责。
   * 这里盯的是另一条路：Vite HMR 重新求值 `loader.ts` 时，旧宿主实例再也没人去
   * dispose —— 条目会留在注册表里，插件重新加载一遍就有两条。
   * 后果：行旁注多出一栏，行内装饰在同一位置画两个色块（React 报重复 key）。
   */
  test("clearAllPlugins 会把行旁注与行内装饰一并清掉", () => {
    registerEditorGutter("alpha", { id: "g", title: "行号", plugin: "alpha", width: 40 });
    registerDecoration({ id: "d", title: "颜色块", plugin: "alpha", refresh: () => {} });

    expect(listEditorGutters()).toHaveLength(1);
    expect(listDecorations()).toHaveLength(1);

    clearAllPlugins();

    expect(listEditorGutters()).toHaveLength(0);
    expect(listDecorations()).toHaveLength(0);
  });

  test("unregisterPlugin 只带走该插件的那些条目", () => {
    registerDecoration({ id: "a", title: "A", plugin: "alpha", refresh: () => {} });
    registerDecoration({ id: "b", title: "B", plugin: "beta", refresh: () => {} });

    unregisterPlugin("alpha");

    expect(listDecorations().map((item) => item.plugin)).toEqual(["beta"]);
  });
});
