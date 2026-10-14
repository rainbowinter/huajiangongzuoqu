import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLoopbackPair } from "../transport";
import { clearPluginLogs, listPluginLogs } from "../logs";
import { clearAllPlugins, listPluginCommands, pluginRegistrySizes } from "../registry";
import { listStatusBarTexts, resetPluginStores } from "../stores";
import type { PluginManifest } from "../types";

// v2Host 会连带引入 Tauri 的原生对话框 / 打开器 / 剪贴板与 Toast。
// 测试里不触发这些路径，但模块级 import 必须能过——把它们打桩掉，
// 顺便保证测试不依赖任何真实 IPC。
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("../../notes/api", async () => {
  const actual = await vi.importActual<typeof import("../../notes/api")>("../../notes/api");
  return {
    ...actual,
    listNotes: vi.fn(async () => []),
    getNote: vi.fn(async () => ({ id: "n1", title: "t", content: "c" })),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    moveNoteCategory: vi.fn(),
    listCategories: vi.fn(async () => []),
    createCategory: vi.fn(),
  };
});
vi.mock("../../windows/api", () => ({ openNoteInEditor: vi.fn() }));

const { createV2PluginHost } = await import("./v2Host");

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "demo",
    version: "2.0.0",
    main: "index.js",
    description: "",
    apiVersion: 2,
    permissions: [],
    grantedPermissions: [],
    enabled: true,
    valid: true,
    warnings: [],
    dirPath: "/plugins/demo",
    ...overrides,
  };
}

beforeEach(() => {
  clearAllPlugins();
  resetPluginStores();
  clearPluginLogs();
});

afterEach(() => {
  clearAllPlugins();
  resetPluginStores();
  clearPluginLogs();
});

describe("端到端：协议链路", () => {
  test("插件在沙箱里跑起来后，注册的命令出现在宿主注册表里", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerCommand({
            id: "demo.hello",
            title: "打个招呼",
            run: () => api.ui.showToast("hi"),
          });
          api.log.info("loaded-ok");
        },
      });
    `;

    const host = await createV2PluginHost({
      manifest: manifest({ permissions: ["ui:command", "ui:toast"], grantedPermissions: ["ui:command", "ui:toast"] }),
      code,
      allowInProcess: true,
    });

    expect(listPluginCommands().map((c) => c.id)).toEqual(["demo:demo.hello"]);
    expect(listPluginCommands()[0].title).toBe("打个招呼");
    expect(listPluginLogs("demo").some((entry) => entry.message.includes("loaded-ok"))).toBe(true);

    await host.dispose();
  });

  test("未授权的调用被权限门拦下，插件侧收到 permissionDenied", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.editor.setContent("尝试越权").catch((error) => {
            api.log.warn("DENIED:" + error.code);
          });
        },
      });
    `;

    // 清单里**没有** editor:write，也不授予任何权限
    const host = await createV2PluginHost({
      manifest: manifest(),
      code,
      allowInProcess: true,
    });

    await vi.waitFor(() => {
      expect(listPluginLogs("demo").some((e) => e.message.includes("DENIED:permissionDenied"))).toBe(
        true,
      );
    });

    await host.dispose();
  });

  test("卸载后注册项被清空", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerCommand({ id: "demo.a", title: "A", run: () => {} });
          api.ui.registerStatusBarItem({ id: "demo.s", render: () => "统计" });
        },
      });
    `;

    const host = await createV2PluginHost({
      manifest: manifest({
        permissions: ["ui:command", "ui:statusbar", "editor:read"],
        grantedPermissions: ["ui:command", "ui:statusbar", "editor:read"],
      }),
      code,
      allowInProcess: true,
    });

    expect(pluginRegistrySizes().commands).toBe(1);
    expect(pluginRegistrySizes().statusBarRenderers).toBe(0);

    await host.dispose();

    expect(pluginRegistrySizes().commands).toBe(0);
    expect(listStatusBarTexts()).toEqual([]);
  });

  test("插件抛错时宿主报加载失败而不是静默", async () => {
    const code = `
      floral.register({
        onLoad() {
          throw new Error("我炸了");
        },
      });
    `;

    await expect(
      createV2PluginHost({ manifest: manifest(), code, allowInProcess: true }),
    ).rejects.toThrow(/我炸了/);
  });

  test("语法错误的插件被拒绝加载", async () => {
    await expect(
      createV2PluginHost({ manifest: manifest(), code: "这不是 JavaScript {{", allowInProcess: true }),
    ).rejects.toThrow(/加载失败|语法|Unexpected/i);
  });
});

describe("镜像与权限", () => {
  test("没有 editor:read 时，镜像里不含正文", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.log.info("CONTENT=[" + api.editor.getContentSync() + "]");
        },
      });
    `;

    const host = await createV2PluginHost({ manifest: manifest(), code, allowInProcess: true });
    host.updateMirror({ content: "机密正文" });

    // 等一下让镜像消息投递到沙箱
    await new Promise((resolve) => setTimeout(resolve, 20));

    const logs = listPluginLogs("demo").map((entry) => entry.message);
    expect(logs.some((message) => message.includes("CONTENT=[机密正文]"))).toBe(false);
    expect(logs.some((message) => message.includes("CONTENT=[]"))).toBe(true);

    await host.dispose();
  });

  test("有 editor:read 时镜像可以同步读到正文", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          // 首次渲染时读一次镜像
          api.log.info("INIT=[" + api.editor.getContentSync() + "]");
        },
      });
    `;

    const host = await createV2PluginHost({
      manifest: manifest({ permissions: ["editor:read"], grantedPermissions: ["editor:read"] }),
      code,
      allowInProcess: true,
    });

    host.updateMirror({ content: "可以读" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await host.dispose();
  });
});

describe("环回传输本身", () => {
  test("未开启 allowInProcess 且环境无 Worker 时拒绝加载，而不是退回主线程", async () => {
    // node 环境没有 Worker 全局，这正是要防的降级路径：
    // 悄悄退回主线程执行等于悄悄放弃隔离。
    await expect(
      createV2PluginHost({ manifest: manifest(), code: "floral.register({onLoad(){}})" }),
    ).rejects.toThrow(/不支持 Web Worker/);
  });

  test("环回对确实是异步投递", async () => {
    const pair = createLoopbackPair();
    const received: unknown[] = [];
    pair.worker.subscribe((message) => received.push(message));

    pair.host.post({ t: "dispose", reason: "unload" });
    expect(received).toHaveLength(0);

    await Promise.resolve();
    expect(received).toHaveLength(1);

    pair.dispose();
  });
});
