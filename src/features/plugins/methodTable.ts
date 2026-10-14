/**
 * 插件可调用的方法表（宿主侧实现）。
 *
 * 三个刻意的设计决定：
 *
 * 1. **权限门只在这一处**。`dispatchPluginCall` 是插件调用的唯一入口，先查方法表、
 *    再做权限检查、最后带超时执行。这样不可能出现「加了新方法忘了加门」。
 *    配套单测会断言：凡是需要能力的方法都必须声明 `permission`。
 * 2. **宿主侧不做业务逻辑**，只做参数校验与转发，真正的操作由 `PluginHostBridge`
 *    实现（见 `hosts/v2Host.ts`）。这样方法表可以脱离 React 单独测试。
 * 3. **超时分档**：读 5s、磁盘 IO 15s、插件回调 10s。超时由调用方 terminate/失败处理。
 */

import type { Disposable } from "./disposable";
import type { PluginApiError } from "./protocol";
import { TIMEOUTS, type MethodDescriptor, type PluginInfo } from "./protocol";
import { PermissionError, checkPermission, type Permission } from "./permissions";

export interface CommandContribution {
  id: string;
  title: string;
  keybinding?: string;
  runToken: string;
}

export interface PanelContribution {
  id: string;
  title: string;
  width?: number;
  standalone?: boolean;
  renderToken: string;
  onClickToken?: string;
}

export interface StatusBarContribution {
  id: string;
  renderToken: string;
}

export interface MenuContribution {
  id: string;
  title: string;
  runToken: string;
}

export interface ToolbarContribution {
  id: string;
  title: string;
  icon?: string;
  runToken: string;
}

export interface SelectionTransformerContribution {
  id: string;
  transformToken: string;
}

/**
 * 宿主能力桥。方法表只依赖这个接口，不直接碰 React / Tauri / 注册表，
 * 因此可以用一个假的 bridge 做完整的方法表测试。
 */
export interface PluginHostBridge {
  // ---- ui
  showToast(message: string, type?: string): void;
  registerCommand(contribution: CommandContribution): string;
  registerPanel(contribution: PanelContribution): string;
  registerStatusBarItem(contribution: StatusBarContribution): string;
  registerEditorMenuItem(contribution: MenuContribution): string;
  registerNoteMenuItem(contribution: MenuContribution): string;
  registerToolbarButton(contribution: ToolbarContribution): string;
  registerSelectionTransformer(contribution: SelectionTransformerContribution): string;
  openPanel(panelId: string): void;

  // ---- editor
  editorGetContent(): string;
  editorSetContent(content: string): void;
  editorGetSelection(): { text: string; start: number; end: number } | null;
  editorReplaceSelection(replacement: string): boolean;
  editorInsertText(text: string, at: "cursor" | "docEnd"): boolean;
  editorWrapSelection(before: string, after: string): boolean;
  editorReplaceRange(start: number, end: number, text: string): boolean;
  editorSetSelection(start: number, end: number): void;
  editorFocus(): void;
  editorGetCursor(): { line: number; column: number; offset: number } | null;
  editorScrollTo(offset: number): void;
  editorScrollPreviewTo(offset: number): void;

  // ---- workspace / categories
  workspaceListNotes(): Promise<unknown>;
  workspaceGetNote(id: string): Promise<unknown>;
  workspaceCreateNote(request: unknown): Promise<unknown>;
  workspaceUpdateNote(id: string, request: unknown): Promise<unknown>;
  workspaceDeleteNote(id: string): Promise<void>;
  workspaceMoveNoteCategory(id: string, category: string): Promise<unknown>;
  workspaceOpenNote(id: string): Promise<void>;
  workspaceGetActiveNote(): Promise<unknown>;
  categoriesList(): Promise<string[]>;
  categoriesCreate(name: string): Promise<void>;

  // ---- storage / settings / events
  storageGet(key: string): Promise<unknown>;
  storageSet(key: string, value: unknown): Promise<void>;
  storageDelete(key: string): Promise<void>;
  storageKeys(): Promise<string[]>;
  storageClear(): Promise<void>;
  settingsGet(): Promise<Record<string, unknown>>;
  subscribeEvent(topic: string): void;
  unsubscribeEvent(topic: string): void;

  // ---- system
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  dialogMessage(message: string, options?: Record<string, unknown>): Promise<void>;
  dialogConfirm(message: string, options?: Record<string, unknown>): Promise<boolean>;
  dialogPrompt(message: string, options?: Record<string, unknown>): Promise<string | null>;

  /** 释放一个注册项（`ui.dispose` / 返回的 Disposable 调用）。 */
  disposeRegistration(id: string): void;
}

export interface PluginCallContext {
  plugin: PluginInfo;
  declared: readonly string[];
  granted: readonly string[];
  bridge: PluginHostBridge;
}

interface MethodEntry {
  /** 需要的能力。省略表示该方法不触碰受保护能力（必须登记在 NO_PERMISSION_METHODS 里）。 */
  permission?: Permission;
  timeoutMs?: number;
  handler: (ctx: PluginCallContext, args: unknown[]) => unknown | Promise<unknown>;
}

// --------------------------------------------------------------- 参数工具

function asRecord(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidArgument(method, "参数必须是对象");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, method: string, field: string): string {
  if (typeof value !== "string") {
    throw invalidArgument(method, `${field} 必须是字符串`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown, method: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidArgument(method, `${field} 必须是有限数字`);
  }
  return value;
}

function invalidArgument(method: string, message: string): PluginApiError {
  const error = new Error(`${method}：${message}`) as PluginApiError;
  Object.assign(error, { name: "PluginApiError", code: "invalidArgument", details: { method } });
  return error;
}

/**
 * 从参数对象里取一个回调令牌，缺失即报错。
 *
 * `field` 用的是**插件侧的字段名**（`run` / `render` / `onClick` / `transform`）：
 * 沙箱侧的 `serializeArg` 会把函数就地替换成令牌，但**保留原字段名**。
 * 所以插件写 `{ id, title, run() {...} }`，宿主看到的是 `{ id, title, run: "\0h:0" }`。
 */
function requireToken(record: Record<string, unknown>, field: string, method: string): string {
  const token = record[field];
  if (typeof token !== "string" || token.length === 0) {
    throw invalidArgument(method, `${field} 必须是一个回调函数`);
  }
  return token;
}

// ---------------------------------------------------------------- 方法表

export const METHOD_TABLE: Record<string, MethodEntry> = {
  // ---- plugin（无权限：只回显插件自身的身份信息）
  "plugin.info": {
    handler: (ctx) => ctx.plugin,
  },

  // ---- ui
  "ui.showToast": {
    permission: "ui:toast",
    handler: (ctx, args) => {
      const message = asString(args[0], "ui.showToast", "message");
      const type = asOptionalString(args[1]);
      ctx.bridge.showToast(message, type);
      return undefined;
    },
  },
  "ui.registerCommand": {
    permission: "ui:command",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerCommand");
      const id = asString(record.id, "ui.registerCommand", "id");
      const title = asString(record.title, "ui.registerCommand", "title");
      const runToken = requireToken(record, "run", "ui.registerCommand");
      return ctx.bridge.registerCommand({
        id,
        title,
        runToken,
        ...(asOptionalString(record.keybinding)
          ? { keybinding: record.keybinding as string }
          : {}),
      });
    },
  },
  "ui.registerPanel": {
    permission: "ui:panel",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerPanel");
      const id = asString(record.id, "ui.registerPanel", "id");
      const title = asString(record.title, "ui.registerPanel", "title");
      const renderToken = requireToken(record, "render", "ui.registerPanel");
      const onClickToken = asOptionalString(record.onClick);
      return ctx.bridge.registerPanel({
        id,
        title,
        renderToken,
        ...(onClickToken ? { onClickToken } : {}),
        ...(typeof record.width === "number" ? { width: record.width } : {}),
        ...(typeof record.standalone === "boolean" ? { standalone: record.standalone } : {}),
      });
    },
  },
  "ui.registerStatusBarItem": {
    permission: "ui:statusbar",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerStatusBarItem");
      return ctx.bridge.registerStatusBarItem({
        id: asString(record.id, "ui.registerStatusBarItem", "id"),
        renderToken: requireToken(record, "render", "ui.registerStatusBarItem"),
      });
    },
  },
  "ui.registerEditorMenuItem": {
    permission: "ui:menus",
    handler: (ctx, args) => ctx.bridge.registerEditorMenuItem(menuContribution(args, "ui.registerEditorMenuItem")),
  },
  "ui.registerNoteMenuItem": {
    permission: "ui:menus",
    handler: (ctx, args) => ctx.bridge.registerNoteMenuItem(menuContribution(args, "ui.registerNoteMenuItem")),
  },
  "ui.registerToolbarButton": {
    permission: "ui:toolbar",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerToolbarButton");
      const icon = asOptionalString(record.icon);
      return ctx.bridge.registerToolbarButton({
        id: asString(record.id, "ui.registerToolbarButton", "id"),
        title: asString(record.title, "ui.registerToolbarButton", "title"),
        runToken: requireToken(record, "run", "ui.registerToolbarButton"),
        ...(icon ? { icon } : {}),
      });
    },
  },
  "ui.openPanel": {
    permission: "ui:open-panel",
    handler: (ctx, args) => {
      ctx.bridge.openPanel(asString(args[0], "ui.openPanel", "panelId"));
      return undefined;
    },
  },
  "ui.dispose": {
    handler: (ctx, args) => {
      ctx.bridge.disposeRegistration(asString(args[0], "ui.dispose", "id"));
      return undefined;
    },
  },

  // ---- editor
  "editor.getContent": {
    permission: "editor:read",
    handler: (ctx) => ctx.bridge.editorGetContent(),
  },
  "editor.setContent": {
    permission: "editor:write",
    handler: (ctx, args) => {
      ctx.bridge.editorSetContent(asString(args[0], "editor.setContent", "content"));
      return true;
    },
  },
  "editor.getSelection": {
    permission: "editor:read",
    handler: (ctx) => ctx.bridge.editorGetSelection(),
  },
  "editor.replaceSelection": {
    permission: "editor:write",
    handler: (ctx, args) =>
      ctx.bridge.editorReplaceSelection(asString(args[0], "editor.replaceSelection", "text")),
  },
  "editor.insertText": {
    permission: "editor:write",
    handler: (ctx, args) => {
      const text = asString(args[0], "editor.insertText", "text");
      const at = args[1] === "docEnd" ? "docEnd" : "cursor";
      return ctx.bridge.editorInsertText(text, at);
    },
  },
  "editor.wrapSelection": {
    permission: "editor:write",
    handler: (ctx, args) => {
      const before = asString(args[0], "editor.wrapSelection", "before");
      const after = asOptionalString(args[1]) ?? before;
      return ctx.bridge.editorWrapSelection(before, after);
    },
  },
  "editor.replaceRange": {
    permission: "editor:write",
    handler: (ctx, args) => {
      const start = asNumber(args[0], "editor.replaceRange", "start");
      const end = asNumber(args[1], "editor.replaceRange", "end");
      const text = asString(args[2], "editor.replaceRange", "text");
      return ctx.bridge.editorReplaceRange(start, end, text);
    },
  },
  "editor.setSelection": {
    permission: "editor:write",
    handler: (ctx, args) => {
      const start = asNumber(args[0], "editor.setSelection", "start");
      const end = typeof args[1] === "number" ? args[1] : start;
      ctx.bridge.editorSetSelection(start, end);
      return undefined;
    },
  },
  "editor.getCursor": {
    permission: "editor:read",
    handler: (ctx) => ctx.bridge.editorGetCursor(),
  },
  "editor.focus": {
    permission: "editor:write",
    handler: (ctx) => {
      ctx.bridge.editorFocus();
      return undefined;
    },
  },
  "editor.scrollTo": {
    permission: "editor:read",
    handler: (ctx, args) => {
      ctx.bridge.editorScrollTo(asNumber(args[0], "editor.scrollTo", "offset"));
      return undefined;
    },
  },
  "editor.scrollPreviewTo": {
    permission: "editor:read",
    handler: (ctx, args) => {
      ctx.bridge.editorScrollPreviewTo(asNumber(args[0], "editor.scrollPreviewTo", "offset"));
      return undefined;
    },
  },
  "editor.registerSelectionTransformer": {
    permission: "editor:read",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "editor.registerSelectionTransformer");
      return ctx.bridge.registerSelectionTransformer({
        id: asString(record.id, "editor.registerSelectionTransformer", "id"),
        transformToken: requireToken(
          record,
          "transform",
          "editor.registerSelectionTransformer",
        ),
      });
    },
  },

  // ---- workspace
  "workspace.listNotes": {
    permission: "workspace:read",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.workspaceListNotes(),
  },
  "workspace.getNote": {
    permission: "workspace:read",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.workspaceGetNote(asString(args[0], "workspace.getNote", "id")),
  },
  "workspace.createNote": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) => ctx.bridge.workspaceCreateNote(args[0]),
  },
  "workspace.updateNote": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.workspaceUpdateNote(
        asString(args[0], "workspace.updateNote", "id"),
        args[1],
      ),
  },
  "workspace.deleteNote": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.workspaceDeleteNote(asString(args[0], "workspace.deleteNote", "id"));
      return undefined;
    },
  },
  "workspace.moveNoteCategory": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.workspaceMoveNoteCategory(
        asString(args[0], "workspace.moveNoteCategory", "id"),
        asString(args[1], "workspace.moveNoteCategory", "category"),
      ),
  },
  "workspace.openNote": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.workspaceOpenNote(asString(args[0], "workspace.openNote", "id"));
      return undefined;
    },
  },
  "workspace.getActiveNote": {
    permission: "workspace:read",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.workspaceGetActiveNote(),
  },
  "categories.list": {
    permission: "categories:read",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.categoriesList(),
  },
  "categories.create": {
    permission: "categories:write",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.categoriesCreate(asString(args[0], "categories.create", "name"));
      return undefined;
    },
  },

  // ---- storage
  "storage.get": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) => ctx.bridge.storageGet(asString(args[0], "storage.get", "key")),
  },
  "storage.set": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.storageSet(
        asString(args[0], "storage.set", "key"),
        args[1] ?? null,
      );
      return undefined;
    },
  },
  "storage.delete": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.storageDelete(asString(args[0], "storage.delete", "key"));
      return undefined;
    },
  },
  "storage.keys": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.storageKeys(),
  },
  "storage.clear": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx) => {
      await ctx.bridge.storageClear();
      return undefined;
    },
  },

  // ---- settings
  "settings.get": {
    permission: "settings",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.settingsGet(),
  },

  // ---- events
  "events.subscribe": {
    permission: "events",
    handler: (ctx, args) => {
      ctx.bridge.subscribeEvent(asString(args[0], "events.subscribe", "topic"));
      return undefined;
    },
  },
  "events.unsubscribe": {
    permission: "events",
    handler: (ctx, args) => {
      ctx.bridge.unsubscribeEvent(asString(args[0], "events.unsubscribe", "topic"));
      return undefined;
    },
  },

  // ---- system
  "system.clipboard.read": {
    permission: "system:clipboard:read",
    handler: (ctx) => ctx.bridge.clipboardRead(),
  },
  "system.clipboard.write": {
    permission: "system:clipboard:write",
    handler: async (ctx, args) => {
      await ctx.bridge.clipboardWrite(asString(args[0], "system.clipboard.write", "text"));
      return undefined;
    },
  },
  "system.openExternal": {
    permission: "system:open-external",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.openExternal(asString(args[0], "system.openExternal", "url"));
      return undefined;
    },
  },
  "system.dialog.message": {
    permission: "system:dialog",
    handler: async (ctx, args) => {
      await ctx.bridge.dialogMessage(
        asString(args[0], "system.dialog.message", "message"),
        asDialogOptions(args[1]),
      );
      return undefined;
    },
  },
  "system.dialog.confirm": {
    permission: "system:dialog",
    handler: (ctx, args) =>
      ctx.bridge.dialogConfirm(
        asString(args[0], "system.dialog.confirm", "message"),
        asDialogOptions(args[1]),
      ),
  },
  "system.dialog.prompt": {
    permission: "system:dialog",
    handler: (ctx, args) =>
      ctx.bridge.dialogPrompt(
        asString(args[0], "system.dialog.prompt", "message"),
        asDialogOptions(args[1]),
      ),
  },
};

function menuContribution(args: unknown[], method: string): MenuContribution {
  const record = asRecord(args[0], method);
  return {
    id: asString(record.id, method, "id"),
    title: asString(record.title, method, "title"),
    runToken: requireToken(record, "run", method),
  };
}

function asDialogOptions(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

// ------------------------------------------------------------ 调度与超时

/**
 * 明确登记「不需要权限」的方法。
 *
 * 单测会断言：方法表里每个条目要么声明了 `permission`，要么在这个集合里。
 * 这样新增方法时忘记加门会直接测试失败，而不是静默放行。
 */
export const NO_PERMISSION_METHODS: ReadonlySet<string> = new Set([
  "plugin.info",
  "ui.dispose",
]);

export function methodDescriptors(): MethodDescriptor[] {
  return Object.entries(METHOD_TABLE).map(([name, entry]) => ({
    name,
    ...(entry.permission ? { permission: entry.permission } : {}),
    ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
  }));
}

function methodNotFoundError(method: string): PluginApiError {
  const error = new Error(`插件 API 不存在：${method}`) as PluginApiError;
  Object.assign(error, {
    name: "PluginApiError",
    code: "methodNotFound",
    details: { method },
  });
  return error;
}

function timeoutError(method: string, ms: number): PluginApiError {
  const error = new Error(`插件调用超时：${method}（${ms}ms）`) as PluginApiError;
  Object.assign(error, {
    name: "PluginApiError",
    code: "pluginTimeout",
    details: { method, timeoutMs: String(ms) },
  });
  return error;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(method, ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 插件调用的唯一入口：查表 → 权限门 → 带超时执行。
 */
export async function dispatchPluginCall(
  ctx: PluginCallContext,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const entry = METHOD_TABLE[method];
  if (!entry) {
    throw methodNotFoundError(method);
  }

  if (entry.permission) {
    checkPermission(ctx.declared, ctx.granted, entry.permission, method, ctx.plugin.name);
  }

  const timeoutMs = entry.timeoutMs ?? TIMEOUTS.read;
  return withTimeout(
    Promise.resolve(entry.handler(ctx, args ?? [])),
    timeoutMs,
    method,
  );
}

/** 供测试与文档列举：按命名空间分组的方法名。 */
export function methodsByNamespace(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const name of Object.keys(METHOD_TABLE)) {
    const [namespace] = name.split(".");
    (grouped[namespace] ??= []).push(name);
  }
  return grouped;
}

/** 类型出口，避免内部实现细节泄漏。 */
export type { Disposable };
export { PermissionError };
