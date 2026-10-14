/**
 * v2 插件宿主：一个插件一个传输通道（生产环境是 Web Worker），走权限门。
 *
 * 职责：
 * - 生命周期：init → 等 `loaded` → 运行 → dispose
 * - 把 `PluginHostBridge` 的实现接到宿主的注册表 / 编辑器桥 / 笔记 API 上
 * - 贡献点刷新：面板 HTML 与状态栏文本是**拉取并缓存**的，不在 React 渲染期同步取
 * - 事件：订阅宿主事件总线并转发给插件
 *
 * 关于降级：拿不到 Worker 时**不会**退回主线程裸跑，而是把插件标记为失败。
 * 悄悄降级等于悄悄放弃隔离，不能接受。
 */

import { confirm, message as nativeMessage } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

import { showToast } from "../../../components/Toast";
import {
  createCategory,
  createNote,
  deleteNote,
  getNote,
  listCategories,
  listNotes,
  moveNoteCategory,
  updateNote,
} from "../../notes/api";
import { openNoteInEditor } from "../../windows/api";
import { getActiveContentAccessor } from "../activeContent";
import {
  settingsGet,
  storageClear,
  storageDelete,
  storageGet,
  storageKeys,
  storageSet,
} from "../api";
import { DisposableStore, toDisposable, type Disposable } from "../disposable";
import { describeElement } from "../elementRef";
import { isFloralEventTopic, subscribeFloralEvent } from "../events";
import { scrollEditorTo, scrollPreviewTo } from "../jump";
import { appendPluginLog } from "../logs";
import {
  dispatchPluginCall,
  methodDescriptors,
  type CommandContribution,
  type MenuContribution,
  type PanelContribution,
  type PluginCallContext,
  type PluginHostBridge,
  type SelectionTransformerContribution,
  type StatusBarContribution,
  type ToolbarContribution,
} from "../methodTable";
import { unknownPermissions } from "../permissions";
import {
  serializeError,
  TIMEOUTS,
  type EditorMirror,
  type HostToWorker,
  type PluginInfo,
  type UnloadReason,
  type WorkerToHost,
} from "../protocol";
import {
  addPluginCommand,
  registerEditorMenuItem,
  registerNoteMenuItem,
  registerPluginPanel,
  registerSelectionTransformer,
  registerToolbarButton,
  subscribeContentChange,
} from "../registry";
import {
  addStatusBarItemId,
  clearPanelHtml,
  removeStatusBarItemId,
  setPanelHtml,
  setStatusBarText,
} from "../stores";
import { createLoopbackPair, type HostSideTransport } from "../transport";
import type { PluginManifest, Selection } from "../types";
import { runPluginSandbox } from "../workerBootstrap";
import { createSandboxWorker } from "./workerFactory";

/** 单个插件的注册项背包：`ui.dispose(id)` 与整体卸载共用。 */
class RegistrationBag {
  private entries = new Map<string, Disposable>();
  private seq = 0;

  add(disposable: Disposable): string {
    const id = `reg-${this.seq++}`;
    this.entries.set(id, disposable);
    return id;
  }

  remove(id: string): void {
    const disposable = this.entries.get(id);
    if (!disposable) return;
    this.entries.delete(id);
    disposable.dispose();
  }

  disposeAll(): void {
    const items = [...this.entries.values()];
    this.entries.clear();
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        console.error("[plugins] 释放注册项失败", error);
      }
    }
  }
}

interface PanelRecord {
  contribution: PanelContribution;
  cacheKey: string;
}

interface StatusBarRecord {
  contribution: StatusBarContribution;
  itemId: string;
}

export interface V2HostOptions {
  manifest: PluginManifest;
  code: string;
  /** 仅测试用：允许在进程内运行（无隔离）。生产环境必须为 false。 */
  allowInProcess?: boolean;
}

export interface V2PluginHost {
  readonly name: string;
  dispose(reason?: UnloadReason): Promise<void>;
  updateMirror(mirror: Partial<EditorMirror>): void;
  refreshPanels(): void;
  refreshStatusBar(selection: Selection | null): void;
}

let promptProvider:
  | ((message: string, options?: Record<string, unknown>) => Promise<string | null>)
  | null = null;

/**
 * 注册一个 prompt 弹窗实现。
 *
 * 原生对话框没有 prompt，而 `capabilities/default.json` 也没有授予
 * `dialog:allow-ask`；这里留一个注入点，由界面层用一个 React 模态实现。
 */
export function setPluginPromptProvider(
  provider: ((message: string, options?: Record<string, unknown>) => Promise<string | null>) | null,
): void {
  promptProvider = provider;
}

export async function createV2PluginHost(options: V2HostOptions): Promise<V2PluginHost> {
  const { manifest, code } = options;
  const owner = manifest.name;

  const worker = options.allowInProcess ? null : createSandboxWorker();
  let transport: HostSideTransport;
  let terminate: () => void;
  let loopbackDispose: (() => void) | null = null;

  if (worker) {
    transport = worker.transport;
    terminate = worker.terminate;
  } else if (options.allowInProcess) {
    const pair = createLoopbackPair();
    loopbackDispose = pair.dispose;
    transport = pair.host;
    // 进程内也要跑同一份沙箱引导，保证协议路径一致（只是没有隔离）。
    void runPluginSandbox(pair.worker);
    terminate = pair.dispose;
  } else {
    throw new Error(
      "当前环境不支持 Web Worker，无法运行 v2 插件。出于安全考虑不会退回主线程执行。",
    );
  }

  const store = new DisposableStore();
  const registrations = new RegistrationBag();
  const panels: PanelRecord[] = [];
  const statusBarItems: StatusBarRecord[] = [];
  const pendingInvocations = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();

  let invocationSeq = 0;
  let disposed = false;
  let contentEpoch = 0;
  let mirror: EditorMirror = {
    content: "",
    selection: null,
    cursor: 0,
    activeNoteId: null,
    contentEpoch: 0,
  };

  const declared = manifest.permissions ?? [];
  const granted = manifest.grantedPermissions ?? [];
  const canReadEditor = granted.includes("editor:read");
  const canReadContent = canReadEditor;

  const pluginInfo: PluginInfo = {
    id: owner,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    permissions: declared,
    grantedPermissions: granted,
    locale: typeof navigator !== "undefined" ? navigator.language : "zh-CN",
  };

  const log = (level: "debug" | "info" | "warn" | "error", text: string, stack?: string) =>
    appendPluginLog(owner, level, text, stack);

  // ------------------------------------------------------------ 传输收发

  const post = (message: HostToWorker): void => {
    if (disposed) return;
    transport.post(message);
  };

  const invokeHandler = (handler: string, args: unknown[]): Promise<unknown> => {
    const id = invocationSeq++;
    return new Promise<unknown>((resolve, reject) => {
      pendingInvocations.set(id, { resolve, reject });
      post({ t: "invoke", id, handler, args });

      setTimeout(() => {
        const entry = pendingInvocations.get(id);
        if (!entry) return;
        pendingInvocations.delete(id);
        entry.reject(
          Object.assign(new Error(`插件回调超时（${handler}）`), {
            code: "pluginTimeout",
            details: { handler },
          }),
        );
      }, TIMEOUTS.callback);
    });
  };

  /** 宿主主动推送事件给插件。 */
  const emitToPlugin = (topic: string, payload: unknown): void => {
    post({ t: "event", topic, payload });
  };

  // ------------------------------------------------------------- 贡献点

  const refreshPanel = (record: PanelRecord): void => {
    void invokeHandler(record.contribution.renderToken, [])
      .then((html) => {
        if (typeof html === "string") {
          setPanelHtml(record.cacheKey, html);
        } else if (html != null) {
          log("warn", `面板 ${record.contribution.id} 的 render() 没有返回字符串`);
          setPanelHtml(record.cacheKey, "");
        }
      })
      .catch((error: unknown) => {
        const serialized = serializeError(error);
        log("error", `面板渲染失败：${serialized.message}`);
        setPanelHtml(
          record.cacheKey,
          `<p style="padding:12px;color:#b4552d;font-size:12px;">面板渲染失败：${serialized.message}</p>`,
        );
      });
  };

  const refreshPanelList = (): void => {
    for (const record of panels) refreshPanel(record);
  };

  const doRefreshStatusBar = (selection: Selection | null): void => {
    for (const record of statusBarItems) {
      const payload = canReadEditor ? selection : null;
      void invokeHandler(record.contribution.renderToken, [payload])
        .then((text) => {
          setStatusBarText(record.itemId, typeof text === "string" && text ? text : null);
        })
        .catch(() => {
          setStatusBarText(record.itemId, null);
        });
    }
  };

  // ---------------------------------------------------------------- 桥

  const accessor = () => getActiveContentAccessor();

  const bridge: PluginHostBridge = {
    showToast(text, type) {
      const allowed = ["info", "warning", "error"] as const;
      const normalized = allowed.find((candidate) => candidate === type) ?? "info";
      showToast(text, normalized);
    },

    registerCommand(contribution: CommandContribution) {
      return registrations.add(
        addPluginCommand({
          id: `${owner}:${contribution.id}`,
          title: contribution.title,
          plugin: owner,
          ...(contribution.keybinding ? { keybinding: contribution.keybinding } : {}),
          run: () => invokeHandler(contribution.runToken, []).then(() => undefined),
        }),
      );
    },

    registerPanel(contribution: PanelContribution) {
      const cacheKey = `${owner}:${contribution.id}`;
      const record: PanelRecord = { contribution, cacheKey };
      panels.push(record);

      const disposable = registerPluginPanel(owner, {
        id: cacheKey,
        title: contribution.title,
        plugin: owner,
        standalone: contribution.standalone ?? false,
        sandboxed: true,
        ...(contribution.width !== undefined ? { width: contribution.width } : {}),
        // 渲染期只读缓存，真正的拉取由 refreshPanel 异步完成。
        render: () => "",
        onClick: (target) => {
          if (!contribution.onClickToken) return;
          void invokeHandler(contribution.onClickToken, [describeElement(target)]).catch(
            (error: unknown) => log("error", `面板点击处理失败：${serializeError(error).message}`),
          );
        },
      });

      const id = registrations.add(
        toDisposable(() => {
          disposable.dispose();
          const index = panels.indexOf(record);
          if (index >= 0) panels.splice(index, 1);
          clearPanelHtml(cacheKey);
        }),
      );

      refreshPanel(record);
      return id;
    },

    registerStatusBarItem(contribution: StatusBarContribution) {
      // v2 的状态栏项不走 `registerStatusBarRenderer`：那个接口是同步的，而插件
      // 在 Worker 里只能异步回话。改为把 id 登记进 store，由 `usePluginStatusBar`
      // 读缓存文本。
      const itemKey = `${owner}:${contribution.id}`;
      const record: StatusBarRecord = { contribution, itemId: itemKey };
      statusBarItems.push(record);
      addStatusBarItemId(itemKey);

      const id = registrations.add(
        toDisposable(() => {
          const index = statusBarItems.indexOf(record);
          if (index >= 0) statusBarItems.splice(index, 1);
          removeStatusBarItemId(itemKey);
        }),
      );

      doRefreshStatusBar(mirror.selection);
      return id;
    },

    registerEditorMenuItem(contribution: MenuContribution) {
      return registrations.add(
        registerEditorMenuItem({
          id: `${owner}:${contribution.id}`,
          title: contribution.title,
          plugin: owner,
          run: () => invokeHandler(contribution.runToken, []).then(() => undefined),
        }),
      );
    },

    registerNoteMenuItem(contribution: MenuContribution) {
      return registrations.add(
        registerNoteMenuItem({
          id: `${owner}:${contribution.id}`,
          title: contribution.title,
          plugin: owner,
          run: () => invokeHandler(contribution.runToken, []).then(() => undefined),
        }),
      );
    },

    registerToolbarButton(contribution: ToolbarContribution) {
      return registrations.add(
        registerToolbarButton({
          id: `${owner}:${contribution.id}`,
          title: contribution.title,
          plugin: owner,
          ...(contribution.icon ? { icon: contribution.icon } : {}),
          run: () => invokeHandler(contribution.runToken, []).then(() => undefined),
        }),
      );
    },

    registerSelectionTransformer(contribution: SelectionTransformerContribution) {
      return registrations.add(
        registerSelectionTransformer(owner, async (text) => {
          const result = await invokeHandler(contribution.transformToken, [text]);
          return typeof result === "string" ? result : null;
        }),
      );
    },

    openPanel(panelId: string) {
      emitToPlugin("ui.openPanel.request", { panelId });
      showToast(`插件请求打开面板：${panelId}`, "info");
    },

    // ---- editor：全部落到当前窗口的活动编辑器桥
    editorGetContent: () => accessor()?.getContent() ?? "",
    editorSetContent: (content) => accessor()?.setContent(content),
    editorGetSelection: () => accessor()?.getSelection() ?? null,
    editorReplaceSelection: (replacement) => accessor()?.replaceSelection(replacement) ?? false,
    editorInsertText: (text, at) => accessor()?.insertText(text, at) ?? false,
    editorWrapSelection: (before, after) => accessor()?.wrapSelection(before, after) ?? false,
    editorReplaceRange: (start, end, text) =>
      accessor()?.replaceRange(start, end, text) ?? false,
    editorSetSelection: (start, end) => accessor()?.setSelection(start, end),
    editorFocus: () => accessor()?.focus(),
    editorGetCursor: () => accessor()?.getCursor() ?? null,
    editorScrollTo: scrollEditorTo,
    editorScrollPreviewTo: scrollPreviewTo,

    // ---- workspace
    workspaceListNotes: () => listNotes(),
    workspaceGetNote: (id) => getNote(id),
    workspaceCreateNote: (request) => createNote(request as never),
    workspaceUpdateNote: (id, request) => updateNote(id, request as never),
    workspaceDeleteNote: (id) => deleteNote(id),
    workspaceMoveNoteCategory: (id, category) => moveNoteCategory(id, category),
    workspaceOpenNote: (id) => openNoteInEditor(id),
    workspaceGetActiveNote: async () => {
      const id = mirror.activeNoteId;
      if (!id) return null;
      return getNote(id);
    },
    categoriesList: () => listCategories(),
    categoriesCreate: (name) => createCategory(name),

    // ---- storage / settings / events
    storageGet: (key) => storageGet(owner, key),
    storageSet: (key, value) => storageSet(owner, key, value),
    storageDelete: (key) => storageDelete(owner, key),
    storageKeys: () => storageKeys(owner),
    storageClear: () => storageClear(owner),
    settingsGet: () => settingsGet(owner),
    subscribeEvent: (topic) => {
      if (!isFloralEventTopic(topic)) {
        throw Object.assign(new Error(`未知事件：${topic}`), {
          code: "unknownEventTopic",
          details: { topic },
        });
      }
      const unsubscribe = subscribeFloralEvent(topic, (payload) => {
        emitToPlugin(topic, payload);
      });
      store.addFn(unsubscribe);
    },
    unsubscribeEvent: () => {
      // 订阅的释放统一由 store 管理，这里无需按 topic 精细退订。
    },

    // ---- system
    clipboardRead: () => readText(),
    clipboardWrite: (text) => writeText(text),
    openExternal: async (url) => {
      const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url.trim())?.[1]?.toLowerCase();
      if (!scheme || !["http", "https", "mailto"].includes(scheme)) {
        throw Object.assign(new Error(`不允许打开的链接协议：${scheme ?? "(无)"}`), {
          code: "unsupportedUrlScheme",
          details: { url },
        });
      }
      await openUrl(url);
    },
    dialogMessage: async (text, dialogOptions) => {
      await nativeMessage(text, dialogOptions as Parameters<typeof nativeMessage>[1]);
    },
    dialogConfirm: (text, dialogOptions) =>
      confirm(text, dialogOptions as Parameters<typeof confirm>[1]),
    dialogPrompt: async (text, dialogOptions) => {
      if (!promptProvider) {
        throw Object.assign(new Error("当前环境未提供 prompt 弹窗"), {
          code: "dialogPromptUnavailable",
        });
      }
      return promptProvider(text, dialogOptions);
    },

    disposeRegistration: (id) => registrations.remove(id),
  };

  const context: PluginCallContext = { plugin: pluginInfo, declared, granted, bridge };

  // ------------------------------------------------------------ 消息处理

  const handleMessage = (incoming: WorkerToHost): void => {
    switch (incoming.t) {
      case "call":
        void dispatchPluginCall(context, incoming.method, incoming.args).then(
          (value) => post({ t: "reply", id: incoming.id, ok: true, value }),
          (error: unknown) => {
            const serialized = serializeError(error);
            if (serialized.code === "permissionDenied") {
              log(
                "warn",
                `拒绝越权调用 ${incoming.method}：缺少权限 ${serialized.details?.permission ?? "?"}`,
              );
            }
            post({ t: "reply", id: incoming.id, ok: false, error: serialized });
          },
        );
        break;

      case "invokeReply": {
        const entry = pendingInvocations.get(incoming.id);
        if (!entry) break;
        pendingInvocations.delete(incoming.id);
        if (incoming.ok) {
          entry.resolve(incoming.value);
        } else {
          entry.reject(
            Object.assign(new Error(incoming.error.message), {
              code: incoming.error.code,
              details: incoming.error.details,
            }),
          );
        }
        break;
      }

      case "log":
        log(incoming.level, incoming.message, incoming.stack);
        break;

      case "ready":
        break;

      case "loaded": {
        const unknown = unknownPermissions(declared);
        for (const permission of unknown) {
          log("warn", `清单声明了宿主不认识的权限：${permission}`);
        }
        break;
      }

      case "loadFailed":
        log("error", `插件加载失败：${incoming.error.message}`, incoming.error.stack);
        break;

      case "disposed":
        break;

      default:
        break;
    }
  };

  const unsubscribeTransport = transport.subscribe(handleMessage);

  // 内容变化时刷新贡献点。复用既有的内容广播，无需改动窗口代码。
  store.addFn(subscribeContentChange(() => {
    contentEpoch += 1;
    refreshPanelList();
  }));

  // --------------------------------------------------------------- 启动

  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("插件初始化超时"));
    }, TIMEOUTS.lifecycle);

    const unsubscribe = transport.subscribe((incoming) => {
      if (incoming.t === "loaded") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      } else if (incoming.t === "loadFailed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(incoming.error.message));
      }
    });
  });

  post({
    t: "init",
    // 只有拿到 editor:read 才下发内容，否则镜像里不含正文。
    // 否则未授权的插件可以直接用 getContentSync() 绕过权限门读到全文。
    mirror: canReadContent ? mirror : { ...mirror, content: "", selection: null },
    settings: {},
    plugin: pluginInfo,
    code,
    methods: methodDescriptors(),
  });

  await loaded;

  return {
    name: owner,

    updateMirror(next) {
      mirror = { ...mirror, ...next, contentEpoch };
      emitToPlugin("editor.mirror", canReadContent ? mirror : { ...mirror, content: "", selection: null });
    },

    refreshPanels: refreshPanelList,

    refreshStatusBar: doRefreshStatusBar,

    async dispose(reason: UnloadReason = "unload") {
      if (disposed) return;
      disposed = true;

      // 先请插件跑 onUnload 并回执，给一个上限；超时就直接 terminate。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TIMEOUTS.lifecycle);
        const unsubscribe = transport.subscribe((incoming) => {
          if (incoming.t === "disposed") {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
        post({ t: "dispose", reason });
      });

      unsubscribeTransport();
      terminate();
      loopbackDispose?.();
      registrations.disposeAll();
      store.dispose();

      for (const record of panels) clearPanelHtml(record.cacheKey);
      for (const record of statusBarItems) removeStatusBarItemId(record.itemId);
      panels.length = 0;
      statusBarItems.length = 0;

      for (const entry of pendingInvocations.values()) {
        entry.reject(Object.assign(new Error("插件已卸载"), { code: "transportClosed" }));
      }
      pendingInvocations.clear();
    },
  };
}
