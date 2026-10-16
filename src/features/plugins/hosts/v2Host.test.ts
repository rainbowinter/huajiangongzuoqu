import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLoopbackPair } from "../transport";
import { clearPluginLogs, listPluginLogs } from "../logs";
import {
  clearAllPlugins,
  listDecorations,
  listDocumentActions,
  listEditorGutters,
  listPluginCommands,
  listPopovers,
  pluginRegistrySizes,
} from "../registry";
import {
  getDecorationItems,
  getGutterLines,
  getPanelHtml,
  getPopoverHtml,
  listStatusBarTexts,
  resetPluginStores,
} from "../stores";
import type { PluginManifest } from "../types";
import { matchFileType, resetFileTypes } from "../../workspace/fileTypes";

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

// 插件设置的读写要走 Rust。测试里换成一只可改的桩，用来模拟「用户在界面上改了值」。
const settingsStub = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    settingsGet: vi.fn(async () => settingsStub.value),
    settingsSet: vi.fn(async () => settingsStub.value),
  };
});

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
    requires: [],
    autoUpdate: false,
    valid: true,
    warnings: [],
    dirPath: "/plugins/demo",
    ...overrides,
  };
}

/**
 * 等到断言成立为止。
 *
 * 面板要走一趟 worker 往返才落到 store 里，睡固定毫秒不是慢就是脆。
 */
async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

beforeEach(() => {
  clearAllPlugins();
  resetPluginStores();
  clearPluginLogs();
  resetFileTypes();
});

afterEach(() => {
  clearAllPlugins();
  resetPluginStores();
  clearPluginLogs();
  resetFileTypes();
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
      manifest: manifest({
        permissions: ["ui:command", "ui:toast"],
        grantedPermissions: ["ui:command", "ui:toast"],
      }),
      code,
      allowInProcess: true,
    });

    expect(listPluginCommands().map((c) => c.id)).toEqual(["demo:demo.hello"]);
    expect(listPluginCommands()[0].title).toBe("打个招呼");
    expect(listPluginLogs("demo").some((entry) => entry.message.includes("loaded-ok"))).toBe(true);

    await host.dispose();
  });

  /**
   * 回归测试：`buildApi` 里本地的 `plugin` 字面量（id / version / permissions 等）与
   * 方法表下发的 `plugin.*`（readAsset / listAssets）在同一个命名空间上，早先的写法
   * 让前者把后者**整体覆盖**掉，插件侧看到 `api.plugin.readAsset` 是 undefined。
   */
  test("api.plugin 同时暴露静态信息与方法表下发的方法", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.log.info(typeof api.plugin.readAsset === "function" ? "has-readAsset" : "missing-readAsset");
          api.log.info(typeof api.plugin.listAssets === "function" ? "has-listAssets" : "missing-listAssets");
          api.log.info(typeof api.plugin.id === "string" ? "has-id" : "missing-id");
        },
      });
    `;

    const host = await createV2PluginHost({ manifest: manifest(), code, allowInProcess: true });

    const messages = listPluginLogs("demo").map((entry) => entry.message);
    expect(messages).toContain("has-readAsset");
    expect(messages).toContain("has-listAssets");
    expect(messages).toContain("has-id");

    await host.dispose();
  });

  /**
   * 端到端：插件声明文件类型 → 进入宿主注册表 → 卸载时消失。
   *
   * onLoad 里刻意 `await` 这次注册：不 await 的话 `loaded` 会先到，
   * `createV2PluginHost` 在注册落库之前就返回了，断言会随机失败。
   */
  test("插件声明的文件类型进入宿主注册表，卸载后消失", async () => {
    const code = `
      floral.register({
        async onLoad(api) {
          await api.files.registerType({
            id: "python",
            extensions: ["py", "PYW"],
            label: "Python",
            badge: "PY",
            color: "#3572a5",
            kind: "code",
            language: "python",
          });
        },
      });
    `;

    const host = await createV2PluginHost({
      manifest: manifest({
        permissions: ["files:register"],
        grantedPermissions: ["files:register"],
      }),
      code,
      allowInProcess: true,
    });

    // id 带上插件前缀，避免两个插件声明同名类型时互相覆盖。
    expect(matchFileType("py")?.id).toBe("demo:python");
    expect(matchFileType("PYW")?.id).toBe("demo:python");
    expect(matchFileType("py")?.kind).toBe("code");

    await host.dispose();

    expect(matchFileType("py")).toBeNull();
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
      expect(
        listPluginLogs("demo").some((e) => e.message.includes("DENIED:permissionDenied")),
      ).toBe(true);
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
      createV2PluginHost({
        manifest: manifest(),
        code: "这不是 JavaScript {{",
        allowInProcess: true,
      }),
    ).rejects.toThrow(/加载失败|语法|Unexpected/i);
  });
});

/**
 * 探针插件：把文件身份**和渲染次数**一起渲进面板。
 *
 * 用面板而不是在 `onLoad` 里打日志，是因为这条链路要验的正是
 * 「文件身份 → 触发重渲染 → 面板里拿到新值」。渲染次数写在插件自己的闭包里，
 * 所以「面板 HTML 变没变」就等于「重渲染有没有发生」。
 */
const PROBE_PLUGIN = `
  let renders = 0;
  floral.register({
    onLoad(api) {
      api.ui.registerPanel({
        id: "probe",
        title: "探针",
        render() {
          renders += 1;
          const file = api.editor.getFileSync();
          const label = file ? file.typeId + "/" + (file.language ?? "none") : "none";
          return "<p>FILE=" + label + " R=" + renders + "</p>";
        },
      });
    },
  });
`;

const PROBE_PERMISSIONS = ["ui:panel", "editor:read"];

async function createProbeHost(permissions: string[] = PROBE_PERMISSIONS) {
  const host = await createV2PluginHost({
    manifest: manifest({ permissions, grantedPermissions: permissions }),
    code: PROBE_PLUGIN,
    allowInProcess: true,
  });
  return host;
}

describe("镜像里的文件身份", () => {
  test("推过去的文件身份能同步读到 getFileSync()", async () => {
    const host = await createProbeHost();

    host.updateMirror({
      content: "x = 1",
      file: { path: "/tmp/a.py", typeId: "python", kind: "code", language: "python" },
    });

    await waitFor(() => expect(getPanelHtml("demo:probe", "/tmp/a.py")).toContain("FILE=python/python"));
    await host.dispose();
  });

  test("正文没变、只换了文件，面板也要重渲染", async () => {
    // 这条路径是这次新加的：面板刷新原先只认「内容变了」。两个同内容的文件互切
    // （比如一段相同的样例代码）时，只看内容就会漏刷，目录停在旧格式上。
    const host = await createProbeHost();

    host.updateMirror({
      content: "同样的正文",
      file: { path: "/tmp/a.md", typeId: "markdown", kind: "markdown", language: null },
    });
    await waitFor(() => expect(getPanelHtml("demo:probe", "/tmp/a.md")).toContain("FILE=markdown/none"));

    // **内容一字不改**，只把文件换掉。
    host.updateMirror({
      file: { path: "/tmp/b.py", typeId: "python", kind: "code", language: "python" },
    });
    await waitFor(() => expect(getPanelHtml("demo:probe", "/tmp/b.py")).toContain("FILE=python/python"));

    await host.dispose();
  });

  test("面板内容按文件分开存，切回来还是原来那一份", async () => {
    // 这是「切文件不丢面板状态」的地基：右侧栏里展开的层级、滚动位置、没提交的搜索词
    // 都活在 DOM 上，而 DOM 只在字符串**变了**的时候才被重建。切回来如果拿到的是
    // 「照着这篇重渲染出来的新串」，那些状态就全没了。
    //
    // ⚠️ 这条约定建立在「插件 render() 是纯的」上面，所以这里**不能**用上面那个
    // `PROBE_PLUGIN`：它故意往 HTML 里编了渲染次数（`R=n`），天生不纯。用一个只报
    // 文件身份的探针才量得准。
    const PURE_PROBE = `
      floral.register({
        onLoad(api) {
          api.ui.registerPanel({
            id: "pure",
            title: "纯探针",
            render() {
              const file = api.editor.getFileSync();
              return "<p>FILE=" + (file ? file.typeId + "/" + (file.language ?? "none") : "none") + "</p>";
            },
          });
        },
      });
    `;
    const host = await createV2PluginHost({
      manifest: manifest({ permissions: PROBE_PERMISSIONS, grantedPermissions: PROBE_PERMISSIONS }),
      code: PURE_PROBE,
      allowInProcess: true,
    });

    host.updateMirror({
      content: "甲",
      file: { path: "/tmp/a.md", typeId: "markdown", kind: "markdown", language: null },
    });
    await waitFor(() => expect(getPanelHtml("demo:pure", "/tmp/a.md")).toContain("FILE=markdown"));
    const aFirst = getPanelHtml("demo:pure", "/tmp/a.md");

    host.updateMirror({
      content: "乙",
      file: { path: "/tmp/b.py", typeId: "python", kind: "code", language: "python" },
    });
    await waitFor(() => expect(getPanelHtml("demo:pure", "/tmp/b.py")).toContain("FILE=python"));
    // 写 B 不该把 A 那份挤掉。
    expect(getPanelHtml("demo:pure", "/tmp/a.md")).toBe(aFirst);

    host.updateMirror({
      content: "甲",
      file: { path: "/tmp/a.md", typeId: "markdown", kind: "markdown", language: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // 同一份内容 ⇒ 重渲染出同一串 ⇒ React 不会碰那棵 DOM。
    expect(getPanelHtml("demo:pure", "/tmp/a.md")).toBe(aFirst);

    await host.dispose();
  });

  test("桶数有上限，超了淘汰最久没用的那份", async () => {
    // 不设上限的话，开一整天就是「开过多少篇就留多少份 HTML」。
    const PURE_PROBE = `
      floral.register({
        onLoad(api) {
          api.ui.registerPanel({
            id: "pure",
            title: "纯探针",
            render() { return "<p>X</p>"; },
          });
        },
      });
    `;
    const host = await createV2PluginHost({
      manifest: manifest({ permissions: PROBE_PERMISSIONS, grantedPermissions: PROBE_PERMISSIONS }),
      code: PURE_PROBE,
      allowInProcess: true,
    });

    // 上限 16：开 18 篇，最早那两篇该被挤掉。
    for (let i = 0; i < 18; i += 1) {
      host.updateMirror({
        content: `第 ${i} 篇`,
        file: { path: `/tmp/f${i}.md`, typeId: "markdown", kind: "markdown", language: null },
      });
      await waitFor(() => expect(getPanelHtml("demo:pure", `/tmp/f${i}.md`)).toBe("<p>X</p>"));
    }

    expect(getPanelHtml("demo:pure", "/tmp/f0.md")).toBe("");
    expect(getPanelHtml("demo:pure", "/tmp/f1.md")).toBe("");
    // 最近用过的还在 —— 淘汰的是最久没用的，不是最新的。
    expect(getPanelHtml("demo:pure", "/tmp/f17.md")).toBe("<p>X</p>");

    await host.dispose();
  });

  test("同一个文件再推一次不会空刷面板", async () => {
    // 身份是按值比的：调用方每次渲染都构造新对象，比引用的话这里会每帧都刷。
    const host = await createProbeHost();

    const identity = {
      path: "/tmp/a.py",
      typeId: "python",
      kind: "code" as const,
      language: "python",
    };
    host.updateMirror({ content: "x = 1", file: { ...identity } });
    await waitFor(() => expect(getPanelHtml("demo:probe", "/tmp/a.py")).toContain("FILE=python/python"));

    // 换个内容等价的新对象。渲染次数编码在 HTML 里，所以「HTML 没变」就等于
    // 「没有重渲染」—— 不必知道次数的具体值。
    const before = getPanelHtml("demo:probe", "/tmp/a.py");
    host.updateMirror({ file: { ...identity } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getPanelHtml("demo:probe", "/tmp/a.py")).toBe(before);

    await host.dispose();
  });

  test("没有 editor:read 时，文件身份一并抹白", async () => {
    const host = await createProbeHost(["ui:panel"]);

    host.updateMirror({
      content: "x = 1",
      file: { path: "/tmp/secret.py", typeId: "python", kind: "code", language: "python" },
    });

    // 路径与正文同级：未授权就不该看到任何一个。
    await waitFor(() => expect(getPanelHtml("demo:probe", "/tmp/secret.py")).toContain("FILE=none"));
    expect(getPanelHtml("demo:probe", "/tmp/secret.py")).not.toContain("secret.py");

    await host.dispose();
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

describe("插件设置的热更新", () => {
  /** 把设置里的 width 用在旁注栏上，收到 settings.changed 就重注册一次。 */
  const SETTINGS_PLUGIN = `
    floral.register({
      onLoad(api) {
        let width = 36;
        const register = () => {
          api.ui.registerGutter({ id: "nums", title: "行号", width, render() { return []; } });
        };
        register();
        api.settings.get().then((values) => {
          if (values && values.width) { width = values.width; register(); }
        });
        api.events.on("settings.changed", (values) => {
          if (values && values.width) { width = values.width; register(); }
        });
      },
    });
  `;

  const PERMISSIONS = ["ui:gutter", "editor:read", "events"];

  beforeEach(() => {
    settingsStub.value = {};
  });

  test("宿主会把插件自己的设置随 init 发下去", async () => {
    // 设置里配的是 48，插件注册时就应该照这个值来 —— 而不是清单里的 default。
    settingsStub.value = { width: 48 };

    const host = await createV2PluginHost({
      manifest: manifest({ permissions: PERMISSIONS, grantedPermissions: PERMISSIONS }),
      code: SETTINGS_PLUGIN,
      allowInProcess: true,
    });

    await waitFor(() => expect(listEditorGutters()[0]?.width).toBe(48));
    await host.dispose();
  });

  test("改设置之后插件重注册，栏目换成新宽度且不叠加", async () => {
    settingsStub.value = { width: 36 };
    const host = await createV2PluginHost({
      manifest: manifest({ permissions: PERMISSIONS, grantedPermissions: PERMISSIONS }),
      code: SETTINGS_PLUGIN,
      allowInProcess: true,
    });
    await waitFor(() => expect(listEditorGutters()[0]?.width).toBe(36));

    // 用户在插件面板里把宽度改成 60
    settingsStub.value = { width: 60 };
    host.refreshSettings();

    await waitFor(() => expect(listEditorGutters()[0]?.width).toBe(60));
    // 同一个 id 是**替换**：留下两条的话会多占一栏宽度，而且旧的会把新的挤开。
    expect(listEditorGutters()).toHaveLength(1);

    await host.dispose();
  });
});

describe("编辑器行旁注", () => {
  const GUTTER_PLUGIN = `
    floral.register({
      onLoad(api) {
        api.ui.registerGutter({
          id: "nums",
          title: "行号",
          width: 40,
          render() {
            return api.editor.getContentSync().split("\\n").map((_, i) => String(i + 1));
          },
        });
      },
    });
  `;

  const GUTTER_PERMISSIONS = ["ui:gutter", "editor:read"];

  // 用数组拼行，而不是在字符串里写转义 —— 这个文件里已经嵌了一层模板字符串，
  // 再加一层 `\n` 只会让转义层级变得没法读。
  const NL = String.fromCharCode(10);
  const threeLines = ["甲", "乙", "丙"].join(NL);
  const twoLines = ["甲", "乙"].join(NL);

  test("注册后逐行文字会落进 store，内容变化时跟着重算", async () => {
    const host = await createV2PluginHost({
      manifest: manifest({
        permissions: GUTTER_PERMISSIONS,
        grantedPermissions: GUTTER_PERMISSIONS,
      }),
      code: GUTTER_PLUGIN,
      allowInProcess: true,
    });

    host.updateMirror({ content: threeLines });
    await waitFor(() => expect(getGutterLines("demo:nums")).toEqual(["1", "2", "3"]));

    // 行旁注是正文派生的，必须和面板一样跟内容走 —— 否则加一行之后行号就少一个。
    host.updateMirror({ content: twoLines });
    await waitFor(() => expect(getGutterLines("demo:nums")).toEqual(["1", "2"]));

    await host.dispose();
  });

  test("声明进注册表，栏宽取插件给的值", async () => {
    const host = await createV2PluginHost({
      manifest: manifest({
        permissions: GUTTER_PERMISSIONS,
        grantedPermissions: GUTTER_PERMISSIONS,
      }),
      code: GUTTER_PLUGIN,
      allowInProcess: true,
    });

    const gutters = listEditorGutters();
    expect(gutters).toHaveLength(1);
    expect(gutters[0]).toMatchObject({ id: "demo:nums", title: "行号", plugin: "demo", width: 40 });

    await host.dispose();
    expect(listEditorGutters()).toHaveLength(0);
  });

  test("没有 ui:gutter 权限时注册不了", async () => {
    const host = await createV2PluginHost({
      manifest: manifest({
        permissions: ["editor:read"],
        grantedPermissions: ["editor:read"],
      }),
      code: GUTTER_PLUGIN,
      allowInProcess: true,
    });

    // 权限门在宿主侧，调用会被拒 —— 注册表里不该出现任何东西。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listEditorGutters()).toHaveLength(0);

    await host.dispose();
  });

  test("render 返回的不是字符串数组时按空处理，而不是崩溃", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerGutter({ id: "bad", title: "坏的", render() { return 42; } });
        },
      });
    `;
    const host = await createV2PluginHost({
      manifest: manifest({
        permissions: GUTTER_PERMISSIONS,
        grantedPermissions: GUTTER_PERMISSIONS,
      }),
      code,
      allowInProcess: true,
    });

    host.updateMirror({ content: "x" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getGutterLines("demo:bad")).toEqual([]);

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

describe("工具栏浮层", () => {
  const POPOVER_PLUGIN = `
    floral.register({
      onLoad(api) {
        api.ui.registerPopover({
          id: "symbols",
          title: "符号",
          icon: "Σ",
          width: 360,
          markdownOnly: true,
          closeOnClick: true,
          render() {
            return '<button class="sym" data-value="ALPHA">甲</button>';
          },
          onClick(ref) {
            const cell = ref.closestClass("sym");
            if (!cell) return;
            return "<p>已选 " + cell.attrs["data-value"] + "</p>";
          },
        });
      },
    });
  `;

  const POPOVER_PERMISSIONS = ["ui:popover"];

  /**
   * 够 `describeElement` 用的最小元素桩。
   *
   * 它只读 `tagName` / `id` / `attributes` / `classList` / `parentElement` /
   * `textContent` 六样，不碰任何 DOM 方法，所以不必起 jsdom。
   */
  const cellStub = () =>
    ({
      tagName: "BUTTON",
      id: "",
      attributes: [{ name: "data-value", value: "ALPHA" }],
      classList: ["sym"],
      parentElement: null,
      textContent: "甲",
    }) as unknown as HTMLElement;

  const startHost = (permissions: string[] = POPOVER_PERMISSIONS) =>
    createV2PluginHost({
      manifest: manifest({ permissions, grantedPermissions: permissions }),
      code: POPOVER_PLUGIN,
      allowInProcess: true,
    });

  test("注册进注册表，但**不**在注册时就要内容 —— 点开才拉", async () => {
    const host = await startHost();

    await waitFor(() => expect(listPopovers()).toHaveLength(1));
    expect(listPopovers()[0]).toMatchObject({
      id: "demo:symbols",
      title: "符号",
      icon: "Σ",
      width: 360,
      markdownOnly: true,
      closeOnClick: true,
      plugin: "demo",
    });

    // 懒加载：注册完先什么都不拉。浮层是临时界面，没人开着就不该反复渲染。
    expect(getPopoverHtml("demo:symbols")).toBe("");

    listPopovers()[0].refresh();
    await waitFor(() => expect(getPopoverHtml("demo:symbols")).toContain('data-value="ALPHA"'));

    await host.dispose();
  });

  test("点击内容交给插件，返回的字符串换掉当前内容", async () => {
    const host = await startHost();

    await waitFor(() => expect(listPopovers()).toHaveLength(1));
    listPopovers()[0].refresh();
    await waitFor(() => expect(getPopoverHtml("demo:symbols")).toContain("data-value"));

    // 描述符跨线程往返后，插件侧拿到的 ref 应当带 closestClass / attrs。
    listPopovers()[0].onClick?.(cellStub());
    await waitFor(() => expect(getPopoverHtml("demo:symbols")).toBe("<p>已选 ALPHA</p>"));

    await host.dispose();
  });

  test("未声明 ui:popover 时注册被拒绝，界面上一项也不会出现", async () => {
    // 权限门的拒绝是**回给插件的一次调用失败**，宿主不替它写日志 —— 得插件自己上报。
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerPopover({
            id: "symbols",
            title: "符号",
            render() { return "<p>x</p>"; },
          }).catch((error) => api.log.warn("DENIED:" + error.code));
        },
      });
    `;
    const host = await createV2PluginHost({
      manifest: manifest(),
      code,
      allowInProcess: true,
    });

    await vi.waitFor(() => {
      expect(
        listPluginLogs("demo").some((entry) => entry.message.includes("DENIED:permissionDenied")),
      ).toBe(true);
    });
    expect(listPopovers()).toEqual([]);

    await host.dispose();
  });

  test("卸载后浮层与它的缓存一起清掉", async () => {
    const host = await startHost();

    await waitFor(() => expect(listPopovers()).toHaveLength(1));
    listPopovers()[0].refresh();
    await waitFor(() => expect(getPopoverHtml("demo:symbols")).not.toBe(""));

    await host.dispose();

    expect(listPopovers()).toEqual([]);
    expect(getPopoverHtml("demo:symbols")).toBe("");
  });
});

describe("行内装饰", () => {
  const DECORATION_PLUGIN = `
    floral.register({
      onLoad(api) {
        api.ui.registerDecorations({
          id: "colors",
          title: "颜色块",
          render() {
            return [{ offset: 0, length: 7, color: "#AABBCC" }];
          },
          pick(offset, length, color) {
            api.log.warn("PICKED:" + offset + "/" + length + "/" + color);
          },
        });
      },
    });
  `;

  // 要带上 editor:read：插件靠 `getContentSync()` 读正文，没这个权限镜像会被抹白，
  // render() 永远只能看到空串。
  const DECORATION_PERMISSIONS = ["ui:decorations", "editor:read"];

  // 与行旁注那节同款：这个文件里已经嵌了一层模板字符串，再手写 `\n` 转义只会让层级乱掉。
  const NL = String.fromCharCode(10);

  const startHost = (permissions: string[] = DECORATION_PERMISSIONS, code = DECORATION_PLUGIN) =>
    createV2PluginHost({
      manifest: manifest({ permissions, grantedPermissions: permissions }),
      code,
      allowInProcess: true,
    });

  test("注册后条目落进 store，颜色统一成小写", async () => {
    const host = await startHost();

    await waitFor(() => expect(listDecorations()).toHaveLength(1));
    await waitFor(() =>
      expect(getDecorationItems("demo:colors")).toEqual([
        { offset: 0, length: 7, color: "#aabbcc" },
      ]),
    );

    await host.dispose();
  });

  test("正文变化时跟着重算", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerDecorations({
            id: "colors",
            title: "颜色块",
            render() {
              // 条数跟着正文长度走，好断言
              return api.editor.getContentSync().split(String.fromCharCode(10)).map((line, index) => ({
                offset: index,
                length: 1,
                color: "#000000",
              }));
            },
          });
        },
      });
    `;
    const host = await startHost(DECORATION_PERMISSIONS, code);

    host.updateMirror({ content: ["a", "b"].join(NL) });
    await waitFor(() => expect(getDecorationItems("demo:colors")).toHaveLength(2));

    host.updateMirror({ content: "a" });
    await waitFor(() => expect(getDecorationItems("demo:colors")).toHaveLength(1));

    await host.dispose();
  });

  test("不合规的条目被丢掉，而不是让整层失败", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerDecorations({
            id: "colors",
            title: "颜色块",
            render() {
              return [
                { offset: 0, length: 1, color: "#112233" },
                { offset: 5, length: 1, color: "rgb(1,2,3)" },   // 不是 #rrggbb
                { offset: -2, length: 1, color: "#445566" },      // 偏移为负
                { offset: 9, length: 1, color: "#zzzzzz" },       // 不是十六进制
                { offset: 12, color: "#778899" },                 // 缺 length，补 1
              ];
            },
          });
        },
      });
    `;
    const host = await startHost(DECORATION_PERMISSIONS, code);

    await waitFor(() =>
      expect(getDecorationItems("demo:colors")).toEqual([
        { offset: 0, length: 1, color: "#112233" },
        { offset: 12, length: 1, color: "#778899" },
      ]),
    );

    await host.dispose();
  });

  test("选色回传给插件", async () => {
    const host = await startHost();

    await waitFor(() => expect(listDecorations()).toHaveLength(1));
    listDecorations()[0].pick?.(3, 7, "#123456");

    await vi.waitFor(() => {
      expect(
        listPluginLogs("demo").some((entry) => entry.message.includes("PICKED:3/7/#123456")),
      ).toBe(true);
    });

    await host.dispose();
  });

  test("未声明 ui:decorations 时注册被拒绝", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerDecorations({
            id: "colors",
            title: "颜色块",
            render() { return []; },
          }).catch((error) => api.log.warn("DENIED:" + error.code));
        },
      });
    `;
    const host = await startHost([], code);

    await vi.waitFor(() => {
      expect(
        listPluginLogs("demo").some((entry) => entry.message.includes("DENIED:permissionDenied")),
      ).toBe(true);
    });
    expect(listDecorations()).toEqual([]);

    await host.dispose();
  });

  test("卸载后注册项与缓存一起清掉", async () => {
    const host = await startHost();

    await waitFor(() => expect(listDecorations()).toHaveLength(1));
    await waitFor(() => expect(getDecorationItems("demo:colors")).not.toEqual([]));

    await host.dispose();

    expect(listDecorations()).toEqual([]);
    expect(getDecorationItems("demo:colors")).toEqual([]);
  });
});

describe("镜像的下发门槛", () => {
  const MIRROR_PLUGIN = `
    floral.register({
      onLoad(api) {
        api.ui.registerPanel({
          id: "probe",
          title: "探针",
          render() {
            const file = api.editor.getFileSync();
            return "MIRROR:" + api.editor.getContentSync() + "|" + (file ? file.kind : "null");
          },
        });
      },
    });
  `;

  test("只声明 editor:write 也能读到镜像 —— 写蕴含读，两处判据必须一致", async () => {
    const permissions = ["editor:write", "ui:panel"];
    const host = await createV2PluginHost({
      manifest: manifest({ permissions, grantedPermissions: permissions }),
      code: MIRROR_PLUGIN,
      allowInProcess: true,
    });

    host.updateMirror({
      content: "正文",
      file: { path: "/tmp/a.css", typeId: "css", kind: "code", language: "css" },
    });

    // 方法表的门走 isGranted（认蕴含），镜像下发这里**也必须**走它。早先这里是裸的
    // `granted.includes("editor:read")`，于是只声明 editor:write 的插件调得动
    // editor.getContent()，镜像里却是空正文 + file: null，症状是「插件看得见接口、
    // 看到的却是空的」。
    await waitFor(() => expect(getPanelHtml("demo:probe", "/tmp/a.css")).toBe("MIRROR:正文|code"));

    await host.dispose();
  });

  test("一条编辑器权限都没有时，镜像仍被抹白", async () => {
    const permissions = ["ui:panel"];
    const host = await createV2PluginHost({
      manifest: manifest({ permissions, grantedPermissions: permissions }),
      code: MIRROR_PLUGIN,
      allowInProcess: true,
    });

    host.updateMirror({
      content: "正文",
      file: { path: "/tmp/a.css", typeId: "css", kind: "code", language: "css" },
    });

    await waitFor(() => expect(getPanelHtml("demo:probe", "/tmp/a.css")).toBe("MIRROR:|null"));

    await host.dispose();
  });
});

describe("插件文档动作（顶上那一行）", () => {
  const ACTION_PLUGIN = `
    floral.register({
      onLoad(api) {
        api.ui.registerDocumentAction({
          id: "export-annotations",
          title: "导出批注",
          icon: "导出",
          viewCommand: "export-pdf",
          contexts: ["view"],
          typeIds: ["pdf-viewer:pdf"],
        });
        api.ui.registerDocumentAction({
          id: "everywhere",
          title: "哪儿都在",
          run() {},
        });
      },
    });
  `;

  const ACTION_PERMISSIONS = ["ui:document-action"];

  test("注册后带归属 id，两个回调与过滤器都落到宿主侧", async () => {
    const host = await createV2PluginHost({
      manifest: manifest({ permissions: ACTION_PERMISSIONS, grantedPermissions: ACTION_PERMISSIONS }),
      code: ACTION_PLUGIN,
      allowInProcess: true,
    });

    await waitFor(() => expect(listDocumentActions()).toHaveLength(2));
    // 注册顺序即显示顺序。
    expect(listDocumentActions()[0]).toMatchObject({
      id: "demo:export-annotations",
      title: "导出批注",
      icon: "导出",
      plugin: "demo",
      contexts: ["view"],
      typeIds: ["pdf-viewer:pdf"],
      viewCommand: "export-pdf",
    });
    // 只给 run 的那条不该被硬塞一个 viewCommand 进去。
    expect(listDocumentActions()[1]).toMatchObject({ id: "demo:everywhere", plugin: "demo" });
    expect(listDocumentActions()[1]?.viewCommand).toBeUndefined();

    await host.dispose();
    // 卸载要连带清干净 —— 留着的话顶上那一行会多出一个点了没反应的按钮。
    expect(listDocumentActions()).toHaveLength(0);
  });

  test("没有 ui:document-action 权限时注册不了", async () => {
    const host = await createV2PluginHost({
      manifest: manifest({ permissions: [], grantedPermissions: [] }),
      code: ACTION_PLUGIN,
      allowInProcess: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listDocumentActions()).toHaveLength(0);

    await host.dispose();
  });

  test("run() 会真的被调用，抛错不炸宿主", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerDocumentAction({
            id: "boom",
            title: "炸",
            run() { throw new Error("炸了"); },
          });
        },
      });
    `;
    const host = await createV2PluginHost({
      manifest: manifest({ permissions: ACTION_PERMISSIONS, grantedPermissions: ACTION_PERMISSIONS }),
      code,
      allowInProcess: true,
    });

    await waitFor(() => expect(listDocumentActions()).toHaveLength(1));
    // 宿主侧拿到的是**活闭包**，直接调就行（界面就是这么调的）。
    await expect(listDocumentActions()[0]?.run?.()).rejects.toThrow();

    await host.dispose();
  });

  test("下拉形态：每一项自己带闭包，顶层那两个回调被丢掉", async () => {
    const code = `
      floral.register({
        onLoad(api) {
          api.ui.registerDocumentAction({
            id: "export",
            title: "导出",
            icon: "icons/export.svg",
            typeIds: ["pdf-viewer:pdf"],
            viewCommand: "顶层的不该被调用",
            run() {},
            items: [
              { id: "original", title: "导出原始 PDF", viewCommand: "export-original-pdf" },
              { id: "annotated", title: "导出带批注的 PDF", viewCommand: "export-annotated-pdf" },
              { id: "native", title: "在 worker 里跑", run() {} },
            ],
          });
        },
      });
    `;
    const host = await createV2PluginHost({
      manifest: manifest({ permissions: ACTION_PERMISSIONS, grantedPermissions: ACTION_PERMISSIONS }),
      code,
      allowInProcess: true,
    });

    await waitFor(() => expect(listDocumentActions()).toHaveLength(1));
    const action = listDocumentActions()[0]!;

    expect(action.items?.map((item) => item.id)).toEqual(["original", "annotated", "native"]);
    expect(action.items?.[0]?.viewCommand).toBe("export-original-pdf");
    expect(action.items?.[2]?.run).toBeTypeOf("function");
    // ⚠️ 有下拉就不该再有顶层回调：留着它们，界面点按钮本身时也会发一条命令出去。
    expect(action.viewCommand).toBeUndefined();
    expect(action.run).toBeUndefined();

    await host.dispose();
    expect(listDocumentActions()).toHaveLength(0);
  });
});
