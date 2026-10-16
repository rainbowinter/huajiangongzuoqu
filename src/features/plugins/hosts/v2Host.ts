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

import { convertFileSrc } from "@tauri-apps/api/core";
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
import {
  deleteWorkspaceCache,
  readWorkspaceCache,
  writeWorkspaceCache,
} from "../../workspace/api";
import { getActiveContentAccessor } from "../activeContent";
import {
  listPluginAssets,
  listPluginFontAssets,
  readPluginAsset,
  settingsGet,
  storageClear,
  storageDelete,
  storageGet,
  storageKeys,
  storageSet,
} from "../api";
import { DisposableStore, toDisposable, type Disposable } from "../disposable";
import {
  isFilePreviewKind,
  registerFileType as registerHostFileType,
} from "../../workspace/fileTypes";
import { DEFAULT_FONT_DIR, deriveFontFaceSpecs } from "../../fonts/fontFace";
import { installPluginFonts } from "../../fonts/pluginFonts";
import { describeElement, markElementRef } from "../elementRef";
import { isFloralEventTopic, subscribeFloralEvent } from "../events";
import { scrollEditorTo, scrollPreviewTo } from "../jump";
import { appendPluginLog } from "../logs";
import {
  dispatchPluginCall,
  methodDescriptors,
  type CommandContribution,
  type MenuContribution,
  type GutterContribution,
  type DecorationContribution,
  type PanelContribution,
  type PluginCallContext,
  type PopoverContribution,
  type PluginHostBridge,
  type FileTypeContribution,
  type SelectionTransformerContribution,
  type StatusBarContribution,
  type StyleContribution,
  type ToolbarContribution,
  type ViewExtensionContribution,
} from "../methodTable";
import { isGranted, unknownPermissions } from "../permissions";
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
  registerEditorGutter,
  registerEditorMenuItem,
  registerNoteMenuItem,
  registerDecoration,
  registerPluginPanel,
  registerPopover,
  registerSelectionTransformer,
  registerToolbarButton,
  registerViewExtension,
} from "../registry";
import { clearViewDocumentCache } from "../viewAssets";
import {
  addStatusBarItemId,
  clearGutterLines,
  clearDecorationItems,
  clearPanelHtml,
  clearPopoverHtml,
  removeStatusBarItemId,
  setGutterLines,
  setDecorationItems,
  setPanelHtml,
  setPopoverHtml,
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

interface GutterRecord {
  contribution: GutterContribution;
  cacheKey: string;
  /** 注册表里那一条；重新注册同一 id 时要先把它撤掉。 */
  disposable: Disposable;
}

/**
 * 颜色块只认 `#rrggbb`。
 *
 * 不是宿主挑食：色块本体是 `<input type="color">`，它的 `value` 按规范只接受这个格式。
 * 换算（`rgb()` / `hsl()` / 三位缩写 → 六位）是**插件的事** —— 它本来就知道原文长什么样，
 * 顺手还能记住有没有 alpha。宿主拿到不合规的就丢掉这一条，不猜。
 */
const SWATCH_COLOR = /^#[0-9a-f]{6}$/i;

/** 校验一条插件送来的行内装饰；不合规返回 null（丢掉单条，而不是让整层失败）。 */
function parseDecorationItem(
  value: unknown,
): { offset: number; length: number; color: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const offset = record.offset;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;

  const color = record.color;
  if (typeof color !== "string" || !SWATCH_COLOR.test(color)) return null;

  const rawLength = record.length;
  const length =
    typeof rawLength === "number" && Number.isInteger(rawLength) && rawLength > 0 ? rawLength : 1;

  return { offset, length, color: color.toLowerCase() };
}

interface DecorationRecord {
  contribution: DecorationContribution;
  cacheKey: string;
  disposable: Disposable;
}

interface PopoverRecord {
  contribution: PopoverContribution;
  cacheKey: string;
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
  /** 用户在界面上改了这份插件的设置：重新读一次并推给沙箱。 */
  refreshSettings(): void;
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
  const gutters: GutterRecord[] = [];
  const popovers: PopoverRecord[] = [];
  const decorations: DecorationRecord[] = [];
  const statusBarItems: StatusBarRecord[] = [];
  const pendingInvocations = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();

  let invocationSeq = 0;
  let disposed = false;
  let contentEpoch = 0;
  const declared = manifest.permissions ?? [];
  const granted = manifest.grantedPermissions ?? [];
  /**
   * 能不能把正文下发到镜像里。
   *
   * ⚠️ 必须走 `isGranted`，**不能**写成 `granted.includes("editor:read")`：权限模型里
   * `editor:write` **蕴含** `editor:read`（见 `permissions.ts` 的 IMPLIES 与文档的权限表），
   * 而方法表的门（`checkPermission`）走的就是 `isGranted`。两处判据不一致的后果是：
   * 只声明 `editor:write` 的插件**调得动** `editor.getContent()`，镜像里却是一份被抹白的
   * 空正文与 `file: null` —— 表现为「插件拿得到数据，但看到的是空的」，极难查。
   */
  const canReadContent = isGranted(declared, granted, "editor:read");

  // 初始镜像必须**从当前编辑器状态播种**，不能留空。
  //
  // 只靠后续的变更回调填充是不够的：插件常常在笔记已经打开之后才加载
  // （启动时内容先就绪、插件稍后加载完），此后若用户不编辑，镜像就永远是空的，
  // 表现为「面板里同步读到的是空正文」——outline 这类插件会直接显示"请先选中一篇笔记"。
  const seedAccessor = canReadContent ? getActiveContentAccessor() : null;

  let mirror: EditorMirror = {
    content: seedAccessor?.getContent() ?? "",
    selection: seedAccessor?.getSelection() ?? null,
    cursor: seedAccessor?.getCursor()?.offset ?? 0,
    activeNoteId: null,
    contentEpoch: 0,
    // 播种源只有正文，没有文件身份 —— 只能等宿主第一次 updateMirror 推过来。
    // （宿主在窗口挂载时就会推，所以差不了几帧。）
    file: null,
  };

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

  /**
   * 重新问插件要一份浮层内容。
   *
   * 与面板不同，这个**不在正文变化时刷新**，只有用户点开时才由界面调一次
   * （见 registry 里 `PluginPopover.refresh`）—— 浮层是临时界面，没人开着的时候
   * 反复渲染纯属浪费。
   *
   * 失败时留一段错误 HTML 而不是空白：面板可以空着，浮层空着用户只会以为按钮坏了。
   */
  const refreshPopover = (record: PopoverRecord): void => {
    void invokeHandler(record.contribution.renderToken, [])
      .then((html) => {
        if (typeof html === "string") {
          setPopoverHtml(record.cacheKey, html);
        } else if (html != null) {
          log("warn", `浮层 ${record.contribution.id} 的 render() 没有返回字符串`);
          setPopoverHtml(record.cacheKey, "");
        }
      })
      .catch((error: unknown) => {
        const serialized = serializeError(error);
        log("error", `浮层渲染失败：${serialized.message}`);
        setPopoverHtml(
          record.cacheKey,
          `<p style="padding:12px;color:#b4552d;font-size:12px;">浮层渲染失败：${serialized.message}</p>`,
        );
      });
  };

  /**
   * 重新问插件要一份行旁注文字。
   *
   * 与面板不同的是，这里**没有失败占位**：行旁注是边栏装饰，渲染失败时最好的表现是
   * 那一栏干脆不出现，而不是在行号位置塞一句报错。失败只记日志。
   */
  const refreshGutter = (record: GutterRecord): void => {
    void invokeHandler(record.contribution.renderToken, [])
      .then((value) => {
        const lines = Array.isArray(value)
          ? value.map((line) => (typeof line === "string" ? line : ""))
          : [];
        setGutterLines(record.cacheKey, lines);
      })
      .catch((error: unknown) => {
        const serialized = serializeError(error);
        log("error", `行旁注 ${record.contribution.id} 渲染失败：${serialized.message}`);
      });
  };

  const refreshGutterList = (): void => {
    for (const record of gutters) refreshGutter(record);
  };

  /**
   * 重新问插件要一份行内装饰。
   *
   * 与行旁注同样是正文派生的，所以触发条件完全一致（见 `updateMirror`）。宿主对插件送来的
   * 条目做**基本校验**：偏移要是非负整数、颜色要长得像 `#rrggbb`（`<input type="color">`
   * 只认这个格式）。不合规的丢掉而不是整批失败 —— 一条坏数据不该让整层消失。
   */
  const refreshDecoration = (record: DecorationRecord): void => {
    void invokeHandler(record.contribution.renderToken, [])
      .then((value) => {
        const items = Array.isArray(value)
          ? value.map(parseDecorationItem).filter((item) => item !== null)
          : [];
        setDecorationItems(record.cacheKey, items);
      })
      .catch((error: unknown) => {
        const serialized = serializeError(error);
        log("error", `行内装饰 ${record.contribution.id} 渲染失败：${serialized.message}`);
      });
  };

  const refreshDecorationList = (): void => {
    for (const record of decorations) refreshDecoration(record);
  };

  const disposeDecoration = (record: DecorationRecord): void => {
    record.disposable.dispose();
    const index = decorations.indexOf(record);
    if (index >= 0) decorations.splice(index, 1);
    clearDecorationItems(record.cacheKey);
  };

  /** 撤掉一条已经登记的旁注：注册表条目、记录、缓存一起清掉。 */
  const disposeGutter = (record: GutterRecord): void => {
    record.disposable.dispose();
    const index = gutters.indexOf(record);
    if (index >= 0) gutters.splice(index, 1);
    clearGutterLines(record.cacheKey);
  };

  const doRefreshStatusBar = (selection: Selection | null): void => {
    for (const record of statusBarItems) {
      // 选区同属 editor:read 这一档，判据与镜像一致。
      const payload = canReadContent ? selection : null;
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
          // 打标记：Worker 里没法给参数挂方法（函数过不了结构化克隆），只能送裸对象
          // 过去，由沙箱还原成带 closestClass / data 的形态。
          void invokeHandler(contribution.onClickToken, [
            markElementRef(describeElement(target)),
          ]).catch((error: unknown) =>
            log("error", `面板点击处理失败：${serializeError(error).message}`),
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

    registerGutter(contribution: GutterContribution) {
      const cacheKey = `${owner}:${contribution.id}`;

      // 同一个 id 再注册一次是**替换**，不是叠加。插件改了自己的参数（比如行号栏
      // 的宽度）之后会重新注册一遍，不替换的话会留下一条僵尸记录：每次刷新都多跑
      // 一次 render、多占一栏宽度，而且旧宽度会把新宽度挤开。
      const existing = gutters.find((item) => item.cacheKey === cacheKey);
      if (existing) disposeGutter(existing);

      const record: GutterRecord = {
        contribution,
        cacheKey,
        disposable: registerEditorGutter(owner, {
          id: cacheKey,
          title: contribution.title,
          plugin: owner,
          width: contribution.width ?? 36,
        }),
      };
      gutters.push(record);

      const id = registrations.add(toDisposable(() => disposeGutter(record)));
      refreshGutter(record);
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
          // 把用户右键的那篇笔记 id 一并交给插件，否则它无从知道作用于哪一篇。
          run: (noteId) => invokeHandler(contribution.runToken, [noteId]).then(() => undefined),
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

    registerPopover(contribution: PopoverContribution) {
      const cacheKey = `${owner}:${contribution.id}`;
      const record: PopoverRecord = { contribution, cacheKey };
      popovers.push(record);

      const disposable = registerPopover({
        id: cacheKey,
        title: contribution.title,
        plugin: owner,
        markdownOnly: contribution.markdownOnly ?? false,
        closeOnClick: contribution.closeOnClick ?? false,
        ...(contribution.icon ? { icon: contribution.icon } : {}),
        ...(contribution.width !== undefined ? { width: contribution.width } : {}),
        refresh: () => refreshPopover(record),
        onClick: (target) => {
          if (!contribution.onClickToken) return;
          // 与面板同款：Worker 里没法给参数挂方法，只能送裸描述符过去。
          void invokeHandler(contribution.onClickToken, [markElementRef(describeElement(target))])
            .then((html) => {
              // 返回字符串 = 「用这段换掉当前内容」，分类切换 / 翻页靠它实现。
              if (typeof html === "string") setPopoverHtml(cacheKey, html);
            })
            .catch((error: unknown) =>
              log("error", `浮层点击处理失败：${serializeError(error).message}`),
            );
        },
      });

      return registrations.add(
        toDisposable(() => {
          disposable.dispose();
          const index = popovers.indexOf(record);
          if (index >= 0) popovers.splice(index, 1);
          clearPopoverHtml(cacheKey);
        }),
      );
    },

    registerDecorations(contribution: DecorationContribution) {
      const cacheKey = `${owner}:${contribution.id}`;

      // 同一个 id 再注册是**替换**（与行旁注一致）：插件改了自己的设置后重新注册一遍即可，
      // 宿主据此换掉旧的，不会叠成两层。
      const existing = decorations.find((item) => item.contribution.id === contribution.id);
      if (existing) disposeDecoration(existing);

      const record: DecorationRecord = {
        contribution,
        cacheKey,
        disposable: toDisposable(() => undefined),
      };
      decorations.push(record);

      const picked = registerDecoration({
        id: cacheKey,
        title: contribution.title,
        plugin: owner,
        refresh: () => refreshDecoration(record),
        ...(contribution.pickToken
          ? {
              pick: (offset: number, length: number, color: string) => {
                void invokeHandler(contribution.pickToken as string, [offset, length, color]).catch(
                  (error: unknown) =>
                    log("error", `行内装饰选色处理失败：${serializeError(error).message}`),
                );
              },
            }
          : {}),
      });
      record.disposable = picked;

      const id = registrations.add(toDisposable(() => disposeDecoration(record)));
      refreshDecoration(record);
      return id;
    },

    registerSelectionTransformer(contribution: SelectionTransformerContribution) {
      return registrations.add(
        registerSelectionTransformer(owner, async (text) => {
          const result = await invokeHandler(contribution.transformToken, [text]);
          return typeof result === "string" ? result : null;
        }),
      );
    },

    /**
     * 把插件声明的 CSS 注入当前窗口。
     *
     * **这里刻意不做消毒**，与面板 HTML 的处理不同 —— 因为 CSS 不具备脚本执行能力：
     * 面板 HTML 走 `dangerouslySetInnerHTML`，一句 `onerror` 就能在主世界拿到
     * `__TAURI_INTERNALS__`，所以必须清洗；而样式表最多只能做视觉改动与网络请求
     * （`url(...)`），到不了「执行代码」这一步。能力大小诚实地由清单里的
     * `ui:style` 权限表达，用户可以逐项撤销。
     *
     * `id` 只用于调试时定位是哪个插件注入的，不参与去重 —— 同名多次注册会叠加，
     * 与 CSS 的层叠语义一致。
     */
    /**
     * 声明一种可识别的文件类型。
     *
     * 插件只是「登记一条规则」，宿主据此决定工作文件夹里显示哪些文件、卡片长什么样。
     * 文件内容始终由宿主读取后交给插件，插件**拿不到路径**。
     *
     * `kind` 拼错时直接抛错而不是回落：静默回落会让插件作者以为注册成功了，却一直
     * 看不到期望的渲染结果。
     */
    registerFileType(contribution: FileTypeContribution) {
      if (!isFilePreviewKind(contribution.kind)) {
        throw Object.assign(new Error(`未知的文件预览方式：${contribution.kind}`), {
          code: "invalidArgument",
          details: { kind: contribution.kind },
        });
      }

      // 视图比「只登记一条扩展名规则」能力更强：插件交出来的代码会在宿主给的沙箱里
      // **真的跑起来**（能画 canvas）。所以除了 files:register，还要单独一道 files:view ——
      // 用户撤掉它就能让视图失效，而不必整个插件停用。沙箱边界见 Docs/plugin-view-sandbox.md。
      const view = contribution.view;
      if (contribution.kind === "view" && !view) {
        throw Object.assign(new Error("kind 为 view 时必须提供 view 声明（html 必填）"), {
          code: "invalidArgument",
          details: { kind: contribution.kind },
        });
      }
      if (view && !isGranted(declared, granted, "files:view")) {
        throw Object.assign(new Error("注册文件视图需要 files:view 权限"), {
          code: "permissionDenied",
          details: { permission: "files:view" },
        });
      }

      const renderToken = contribution.renderToken;
      const dispose = registerHostFileType(
        {
          id: `${owner}:${contribution.id}`,
          extensions: contribution.extensions,
          label: contribution.label,
          badge: contribution.badge,
          color: contribution.color,
          kind: contribution.kind,
          ...(contribution.language ? { language: contribution.language } : {}),
          ...(contribution.font ? { font: contribution.font } : {}),
          ...(contribution.highlightTheme ? { highlightTheme: contribution.highlightTheme } : {}),
          ...(view ? { view } : {}),
        },
        renderToken
          ? async (file) => {
              // 插件侧的回调是异步的，且内容由宿主读好后随 payload 递过去 —— 插件
              // 全程拿不到路径，也没有任何读盘能力。
              const result = await invokeHandler(renderToken, [file]);
              return typeof result === "string" ? result : "";
            }
          : undefined,
      );

      return registrations.add(toDisposable(dispose));
    },

    registerStyle(contribution: StyleContribution) {
      const element = document.createElement("style");
      element.dataset.pluginStyle = `${owner}:${contribution.id}`;
      element.textContent = contribution.css;
      document.head.appendChild(element);

      return registrations.add(toDisposable(() => element.remove()));
    },

    registerViewExtension(extension: ViewExtensionContribution) {
      // 与「提供视图」同一道门：并进去的 js 会在沙箱里真的跑起来，能力同一量级。
      // 视图那边 `files:view` 是这么判的，这里照抄，两处对不上的话会留下一个绕过口。
      if (!isGranted(declared, granted, "files:view")) {
        throw Object.assign(new Error("扩展别人的视图需要 files:view 权限"), {
          code: "permissionDenied",
          details: { permission: "files:view" },
        });
      }

      const dispose = registerViewExtension({
        typeId: extension.typeId,
        plugin: owner,
        css: extension.css ?? [],
        js: extension.js ?? [],
        toolbar: extension.toolbar ?? [],
      });

      // 视图文档是按类型 id 缓存的，扩展一变就得让它重拼 —— 否则「装了批注插件但界面
      // 还是老的」要等下次重启。这里只清这一种类型，实在没有别的办法知道谁在读它。
      clearViewDocumentCache();
      return registrations.add(dispose);
    },

    readPluginAsset: (relativePath) => readPluginAsset(owner, relativePath),

    listPluginAssets: (relativeDir) => listPluginAssets(owner, relativeDir),

    async registerFonts(options) {
      const dir = options.dir?.trim() || DEFAULT_FONT_DIR;
      const assets = await listPluginFontAssets(owner, dir);

      // 绝对路径在这里就被 `convertFileSrc` 吃掉了：往下走的只有 file 与 url，
      // 没有任何一个字段能让插件反推出自己的目录在哪。
      const specs = deriveFontFaceSpecs(
        assets.map((asset) => ({
          file: asset.file,
          url: convertFileSrc(asset.path),
          family: asset.family,
          weight: asset.weight,
          style: asset.style,
        })),
        options.overrides,
      );

      // 走 registrations：插件卸载 / 重载时 `<style>` 与族名一起撤掉，不会残留。
      registrations.add(toDisposable(installPluginFonts(owner, specs)));

      return {
        families: [...new Set(specs.map((spec) => spec.family))],
        count: specs.length,
      };
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
    editorReplaceRange: (start, end, text) => accessor()?.replaceRange(start, end, text) ?? false,
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

    // ---- 工作区缓存：跟着文件走的那份数据（批注这类）
    //
    // 位置由**宿主**算（文件在哪个工作区里就用那个工作区的 `__floral-notepaper__/`，
    // 不在任何工作区里就用文件自己所在的目录），插件只说「我是谁」——`owner` 那一层
    // 就是它的命名空间，与 `storage` 同一条规矩。插件因此既不知道也不需要知道路径。
    cacheGet: (filePath) => readWorkspaceCache(filePath, owner),
    cacheSet: (filePath, value) => writeWorkspaceCache(filePath, owner, value),
    cacheDelete: (filePath) => deleteWorkspaceCache(filePath, owner),

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

  /**
   * 把插件自己的设置**随 init 一起**发下去。
   *
   * 之前这里是空对象，而 `api.settings.get()` 读的正是这一份 —— 于是插件永远看到 `{}`：
   * 用户在界面上改的值确实存进了 `plugin-data/<name>/settings.json`，插件却一无所知，
   * 表现为「改了没反应，重启才好」。设置是插件自己的声明字段，读它不需要权限门。
   */
  const initialSettings = await settingsGet(owner).catch(() => ({}));

  post({
    t: "init",
    // 只有拿到 editor:read 才下发内容，否则镜像里不含正文。
    // 否则未授权的插件可以直接用 getContentSync() 绕过权限门读到全文。
    mirror: canReadContent ? mirror : { ...mirror, content: "", selection: null, file: null },
    settings: initialSettings,
    plugin: pluginInfo,
    code,
    methods: methodDescriptors(),
  });

  await loaded;

  return {
    name: owner,

    /**
     * 接收宿主推来的编辑器状态。
     *
     * 刷新时机刻意分开：**内容或文件变了才重渲染面板**（面板渲染要跨线程往返，
     * 每次按键都刷会很吵）；选区变化只更新状态栏。两者都依赖 `editor.mirror`
     * 这条推送，因此镜像更新一定发生在对应回调之前（同一传输通道，顺序有序）。
     */
    updateMirror(next) {
      const contentChanged = next.content !== undefined && next.content !== mirror.content;
      if (contentChanged) contentEpoch += 1;

      // 文件身份要**按值**比：调用方每次渲染都构造一个新对象，比引用必然为真，
      // 那样每帧都会刷面板。
      //
      // 为什么身份变了也得刷：目录这类面板渲染的是「这份内容的骨架」，而骨架由
      // 文件类型决定 —— 从笔记切到 .py 时如果正文恰好没变（两个同内容的文件），
      // 只看内容就会漏刷。
      const fileChanged =
        next.file !== undefined &&
        (next.file?.path !== mirror.file?.path || next.file?.typeId !== mirror.file?.typeId);

      mirror = { ...mirror, ...next, contentEpoch };
      emitToPlugin(
        "editor.mirror",
        canReadContent ? mirror : { ...mirror, content: "", selection: null, file: null },
      );

      if (contentChanged || fileChanged) {
        refreshPanelList();
        // 行号这类旁注是正文的行数 / 行内容派生的，必须跟着一起重算。
        refreshGutterList();
        // 行内装饰同理：颜色块的位置与颜色都来自正文，错一拍就会指到别的地方。
        refreshDecorationList();
      }
      doRefreshStatusBar(mirror.selection);
    },

    refreshPanels: refreshPanelList,

    /**
     * 用户在界面上改了这份插件的设置。
     *
     * 除了把新值推给沙箱，还**必须让订阅者收到** —— 插件常常要靠这个事件重做点什么
     * （行号插件就是把栏宽重新注册一遍）。
     */
    refreshSettings() {
      void settingsGet(owner)
        .then((values) => {
          emitToPlugin("settings.changed", values);
        })
        .catch((error: unknown) => {
          const serialized = serializeError(error);
          log("error", `读取插件设置失败：${serialized.message}`);
        });
    },

    refreshStatusBar: doRefreshStatusBar,

    async dispose(reason: UnloadReason = "unload") {
      if (disposed) return;
      disposed = true;

      // 先请插件跑 onUnload 并回执，给一个上限；超时就直接 terminate。
      //
      // ⚠️ 这里必须直接走 `transport.post` 而不是 `post()`：上面刚把 `disposed`
      // 置为 true，而 `post()` 开头就是 `if (disposed) return`，用它会**静默丢掉**
      // 这条 dispose 消息，于是每次卸载都要白等满 5 秒超时才收场。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TIMEOUTS.lifecycle);
        const unsubscribe = transport.subscribe((incoming) => {
          if (incoming.t === "disposed") {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
        transport.post({ t: "dispose", reason });
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
