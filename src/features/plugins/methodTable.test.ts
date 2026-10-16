import { afterEach, describe, expect, test, vi } from "vitest";
import {
  dispatchPluginCall,
  METHOD_TABLE,
  methodDescriptors,
  methodsByNamespace,
  NO_PERMISSION_METHODS,
  type PluginCallContext,
  type PluginHostBridge,
} from "./methodTable";
import { PermissionError } from "./permissions";
import { isPermission } from "./permissions";
import type { PluginApiError } from "./protocol";

function fakeBridge(overrides: Partial<PluginHostBridge> = {}): PluginHostBridge {
  return {
    showToast: vi.fn(),
    registerCommand: vi.fn(() => "reg-1"),
    registerPanel: vi.fn(() => "reg-2"),
    registerStatusBarItem: vi.fn(() => "reg-3"),
    registerGutter: vi.fn(() => "reg-gutter"),
    registerEditorMenuItem: vi.fn(() => "reg-4"),
    registerNoteMenuItem: vi.fn(() => "reg-5"),
    registerToolbarButton: vi.fn(() => "reg-6"),
    registerPopover: vi.fn(() => "reg-popover"),
    registerDecorations: vi.fn(() => "reg-decorations"),
    registerSelectionTransformer: vi.fn(() => "reg-7"),
    registerStyle: vi.fn(() => "reg-8"),
    registerFileType: vi.fn(() => "reg-9"),
    readPluginAsset: vi.fn(async () => ""),
    listPluginAssets: vi.fn(async () => []),
    registerFonts: vi.fn(async () => ({ families: [], count: 0 })),
    openPanel: vi.fn(),
    editorGetContent: vi.fn(() => "正文"),
    editorSetContent: vi.fn(),
    editorGetSelection: vi.fn(() => null),
    editorReplaceSelection: vi.fn(() => true),
    editorInsertText: vi.fn(() => true),
    editorWrapSelection: vi.fn(() => true),
    editorReplaceRange: vi.fn(() => true),
    editorSetSelection: vi.fn(),
    editorFocus: vi.fn(),
    editorGetCursor: vi.fn(() => ({ line: 0, column: 0, offset: 0 })),
    editorScrollTo: vi.fn(),
    editorScrollPreviewTo: vi.fn(),
    workspaceListNotes: vi.fn(async () => []),
    workspaceGetNote: vi.fn(async () => ({})),
    workspaceCreateNote: vi.fn(async () => ({})),
    workspaceUpdateNote: vi.fn(async () => ({})),
    workspaceDeleteNote: vi.fn(async () => undefined),
    workspaceMoveNoteCategory: vi.fn(async () => ({})),
    workspaceOpenNote: vi.fn(async () => undefined),
    workspaceGetActiveNote: vi.fn(async () => null),
    categoriesList: vi.fn(async () => []),
    categoriesCreate: vi.fn(async () => undefined),
    cacheGet: vi.fn(async () => null),
    cacheSet: vi.fn(async () => undefined),
    cacheDelete: vi.fn(async () => false),
    storageGet: vi.fn(async () => null),
    storageSet: vi.fn(async () => undefined),
    storageDelete: vi.fn(async () => undefined),
    storageKeys: vi.fn(async () => []),
    storageClear: vi.fn(async () => undefined),
    settingsGet: vi.fn(async () => ({})),
    subscribeEvent: vi.fn(),
    unsubscribeEvent: vi.fn(),
    clipboardRead: vi.fn(async () => ""),
    clipboardWrite: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    dialogMessage: vi.fn(async () => undefined),
    dialogConfirm: vi.fn(async () => true),
    dialogPrompt: vi.fn(async () => null),
    disposeRegistration: vi.fn(),
    ...overrides,
  };
}

function context(
  declared: string[],
  granted: string[],
  bridge: PluginHostBridge = fakeBridge(),
): PluginCallContext {
  return {
    plugin: {
      id: "demo",
      name: "demo",
      version: "2.0.0",
      apiVersion: 2,
      permissions: declared,
      grantedPermissions: granted,
      locale: "zh-CN",
    },
    declared,
    granted,
    bridge,
  };
}

describe("方法表的完整性", () => {
  test("每个方法要么声明权限，要么被显式登记为「无需权限」", () => {
    const unguarded = Object.entries(METHOD_TABLE)
      .filter(([name, entry]) => !entry.permission && !NO_PERMISSION_METHODS.has(name))
      .map(([name]) => name);

    expect(
      unguarded,
      "新增方法时容易忘记加权限门。要么补 permission，要么显式加进 NO_PERMISSION_METHODS。",
    ).toEqual([]);
  });

  test("声明的权限都在词汇表里（拼错权限名会导致永远拒绝）", () => {
    const bad = Object.entries(METHOD_TABLE)
      .filter(([, entry]) => entry.permission && !isPermission(entry.permission))
      .map(([name, entry]) => `${name}: ${entry.permission}`);

    expect(bad).toEqual([]);
  });

  test("无需权限的方法确实是纯函数/自省类", () => {
    // 这个断言刻意写成硬编码清单：往 NO_PERMISSION_METHODS 里加东西必须改这里，
    // 于是每次都要停下来确认「它真的不触碰任何受保护能力」。
    //
    // plugin.readAsset / plugin.listAssets 在列：它们只能读插件**自己目录**下的文本
    // 资源与文件名，而插件代码本来就是从那个目录加载的，读自己的样式表不构成新增能力。
    // 跨目录由后端 paths::safe_join_file / safe_join_dir 拒绝。
    //
    // fonts.register 在列：插件只说"字体放在哪个文件夹"，列文件、生成 asset URL、
    // 拼 `@font-face`、注入样式全由宿主做 —— 插件既拿不到路径，也塞不进任意 CSS，
    // 能力严格弱于需要 ui:style 的 ui.registerStyle。
    expect([...NO_PERMISSION_METHODS].sort()).toEqual([
      "fonts.register",
      "plugin.info",
      "plugin.listAssets",
      "plugin.readAsset",
      "ui.dispose",
    ]);
  });

  test("描述符与分组可用", () => {
    const descriptors = methodDescriptors();
    expect(descriptors.length).toBe(Object.keys(METHOD_TABLE).length);
    expect(descriptors.find((d) => d.name === "editor.setContent")?.permission).toBe(
      "editor:write",
    );

    const grouped = methodsByNamespace();
    expect(grouped.editor).toContain("editor.getContent");
    expect(grouped.workspace.length).toBeGreaterThan(0);
    expect(grouped.storage).toContain("storage.clear");
  });
});

describe("权限门", () => {
  test("未授权的调用被拒绝，且不会触达 bridge", async () => {
    const bridge = fakeBridge();
    await expect(
      dispatchPluginCall(context(["ui:toast"], [], bridge), "editor.setContent", ["x"]),
    ).rejects.toBeInstanceOf(PermissionError);

    expect(bridge.editorSetContent).not.toHaveBeenCalled();
  });

  test("清单未声明即无权，即便状态里给了", async () => {
    await expect(
      dispatchPluginCall(context([], ["editor:write"], fakeBridge()), "editor.setContent", ["x"]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("声明且授予时放行", async () => {
    const bridge = fakeBridge();
    await dispatchPluginCall(
      context(["editor:write"], ["editor:write"], bridge),
      "editor.setContent",
      ["新正文"],
    );

    expect(bridge.editorSetContent).toHaveBeenCalledWith("新正文");
  });

  test("写权限蕴含读权限", async () => {
    const bridge = fakeBridge();
    await dispatchPluginCall(
      context(["editor:write"], ["editor:write"], bridge),
      "editor.getContent",
      [],
    );

    expect(bridge.editorGetContent).toHaveBeenCalled();
  });

  test("plugin.info 不需要权限", async () => {
    const result = await dispatchPluginCall(context([], []), "plugin.info", []);
    expect(result).toMatchObject({ name: "demo", apiVersion: 2 });
  });

  test("ui.registerStyle 受 ui:style 门控", async () => {
    const denied = fakeBridge();
    await expect(
      dispatchPluginCall(context([], [], denied), "ui.registerStyle", [{ id: "s", css: "body{}" }]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(denied.registerStyle).not.toHaveBeenCalled();

    const allowed = fakeBridge();
    await dispatchPluginCall(context(["ui:style"], ["ui:style"], allowed), "ui.registerStyle", [
      { id: "s", css: "body{color:red}" },
    ]);
    expect(allowed.registerStyle).toHaveBeenCalledWith({ id: "s", css: "body{color:red}" });
  });

  test("ui.registerPopover 受 ui:popover 门控", async () => {
    // 入参用**插件侧的字段名**（`render` 是函数，沙箱会把它换成令牌）；
    // 出参才叫 `renderToken` —— 两层名字不同是既有约定。
    const contribution = {
      id: "symbols",
      title: "符号",
      icon: "∑",
      render: "\u0000h:0",
    };
    const parsed = {
      id: "symbols",
      title: "符号",
      icon: "∑",
      renderToken: "\u0000h:0",
    };

    const denied = fakeBridge();
    await expect(
      dispatchPluginCall(context([], [], denied), "ui.registerPopover", [contribution]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(denied.registerPopover).not.toHaveBeenCalled();

    const allowed = fakeBridge();
    await dispatchPluginCall(
      context(["ui:popover"], ["ui:popover"], allowed),
      "ui.registerPopover",
      [contribution],
    );
    expect(allowed.registerPopover).toHaveBeenCalledWith(parsed);
  });

  test("ui.registerPopover 透传可选字段，缺省的不硬塞", async () => {
    const bridge = fakeBridge();
    const ctx = context(["ui:popover"], ["ui:popover"], bridge);

    await dispatchPluginCall(ctx, "ui.registerPopover", [
      {
        id: "full",
        title: "全字段",
        icon: "Ω",
        width: 420,
        markdownOnly: true,
        closeOnClick: true,
        render: "\u0000h:0",
        onClick: "\u0000h:1",
      },
    ]);
    expect(bridge.registerPopover).toHaveBeenLastCalledWith({
      id: "full",
      title: "全字段",
      icon: "Ω",
      width: 420,
      markdownOnly: true,
      closeOnClick: true,
      renderToken: "\u0000h:0",
      onClickToken: "\u0000h:1",
    });

    await dispatchPluginCall(ctx, "ui.registerPopover", [
      { id: "bare", title: "最小", render: "\u0000h:2" },
    ]);
    expect(bridge.registerPopover).toHaveBeenLastCalledWith({
      id: "bare",
      title: "最小",
      renderToken: "\u0000h:2",
    });
  });

  test("ui.registerDecorations 受 ui:decorations 门控", async () => {
    // 入参用插件侧字段名（render / pick 是函数，沙箱换成令牌），出参才是 *Token。
    const contribution = {
      id: "colors",
      title: "颜色块",
      render: "\u0000h:0",
      pick: "\u0000h:1",
    };

    const denied = fakeBridge();
    await expect(
      dispatchPluginCall(context([], [], denied), "ui.registerDecorations", [contribution]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(denied.registerDecorations).not.toHaveBeenCalled();

    const allowed = fakeBridge();
    await dispatchPluginCall(
      context(["ui:decorations"], ["ui:decorations"], allowed),
      "ui.registerDecorations",
      [contribution],
    );
    expect(allowed.registerDecorations).toHaveBeenCalledWith({
      id: "colors",
      title: "颜色块",
      renderToken: "\u0000h:0",
      pickToken: "\u0000h:1",
    });
  });

  test("ui.registerDecorations 不传 pick 时不硬塞", async () => {
    const bridge = fakeBridge();
    await dispatchPluginCall(
      context(["ui:decorations"], ["ui:decorations"], bridge),
      "ui.registerDecorations",
      [{ id: "views", title: "只看不点", render: "\u0000h:0" }],
    );

    expect(bridge.registerDecorations).toHaveBeenCalledWith({
      id: "views",
      title: "只看不点",
      renderToken: "\u0000h:0",
    });
  });

  test("files.registerType 受 files:register 门控", async () => {
    const contribution = {
      id: "python",
      extensions: ["py"],
      label: "Python",
      badge: "PY",
      color: "#3572a5",
      kind: "code",
      language: "python",
    };

    const denied = fakeBridge();
    await expect(
      dispatchPluginCall(context([], [], denied), "files.registerType", [contribution]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(denied.registerFileType).not.toHaveBeenCalled();

    const allowed = fakeBridge();
    await dispatchPluginCall(
      context(["files:register"], ["files:register"], allowed),
      "files.registerType",
      [contribution],
    );
    expect(allowed.registerFileType).toHaveBeenCalledWith(contribution);
  });

  test("files.registerType 拒绝空的 extensions", async () => {
    const error = (await dispatchPluginCall(
      context(["files:register"], ["files:register"]),
      "files.registerType",
      [{ id: "x", extensions: [], label: "X", badge: "X", color: "#000", kind: "text" }],
    ).catch((value: unknown) => value)) as PluginApiError;

    expect(error.code).toBe("invalidArgument");
  });

  test("plugin.readAsset 不需要权限，路径由后端 safe_join_file 把关", async () => {
    const bridge = fakeBridge();
    await dispatchPluginCall(context([], [], bridge), "plugin.readAsset", ["styles/theme.css"]);

    expect(bridge.readPluginAsset).toHaveBeenCalledWith("styles/theme.css");
  });
});

describe("参数校验与错误形状", () => {
  test("未知方法报 methodNotFound", async () => {
    const error = (await dispatchPluginCall(context([], []), "nope.method", []).catch(
      (value: unknown) => value,
    )) as PluginApiError;

    expect(error.code).toBe("methodNotFound");
  });

  test("参数类型不对报 invalidArgument", async () => {
    const error = (await dispatchPluginCall(
      context(["editor:write"], ["editor:write"]),
      "editor.setContent",
      [123],
    ).catch((value: unknown) => value)) as PluginApiError;

    expect(error.code).toBe("invalidArgument");
    expect(error.details?.method).toBe("editor.setContent");
  });

  test("缺少回调令牌时报错，而不是把 undefined 传给 bridge", async () => {
    const error = (await dispatchPluginCall(
      context(["ui:command"], ["ui:command"]),
      "ui.registerCommand",
      [{ id: "c", title: "命令" }],
    ).catch((value: unknown) => value)) as PluginApiError;

    expect(error.code).toBe("invalidArgument");
  });
});

describe("超时", () => {
  afterEach(() => {
    delete METHOD_TABLE["__test.hang"];
  });

  test("挂起的调用按超时拒绝，不会永久占用", async () => {
    METHOD_TABLE["__test.hang"] = {
      timeoutMs: 20,
      handler: () => new Promise(() => {}),
    };

    const error = (await dispatchPluginCall(context([], []), "__test.hang", []).catch(
      (value: unknown) => value,
    )) as PluginApiError;

    expect(error.code).toBe("pluginTimeout");
    expect(error.details?.method).toBe("__test.hang");
  });
});
