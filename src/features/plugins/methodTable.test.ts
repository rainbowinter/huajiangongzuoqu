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
    registerEditorMenuItem: vi.fn(() => "reg-4"),
    registerNoteMenuItem: vi.fn(() => "reg-5"),
    registerToolbarButton: vi.fn(() => "reg-6"),
    registerSelectionTransformer: vi.fn(() => "reg-7"),
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
    expect([...NO_PERMISSION_METHODS].sort()).toEqual(["plugin.info", "ui.dispose"]);
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
      dispatchPluginCall(context([], ["editor:write"], fakeBridge()), "editor.setContent", [
        "x",
      ]),
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
