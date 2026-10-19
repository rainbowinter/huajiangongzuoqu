/**
 * 插件贡献点注册表。
 *
 * 相对原实现的两点结构变化：
 *
 * 1. **每个条目带归属（owner）**。原来是一堆裸数组，无法回答"这条是谁注册的"，
 *    因此只能整体 `clearAllPlugins()`。现在可以按插件粒度卸载。
 * 2. **注册返回 `Disposable`**。原来返回 `void`，注册了就撤不回来。
 *
 * 保持不变的是 `subscribe*` 订阅语义 —— `usePluginStatusBar` 与 `MainWindow` 的
 * 面板订阅都依赖它，改成事件总线会牵动一大片 React 代码。
 */

import type { ViewToolbarItem } from "../workspace/fileTypes";
import type { DocumentContext } from "../workspace/documentContext";

/**
 * ⚠️ **本模块持有全局状态，改动它必须整页刷新，不能做局部热替换。**
 *
 * 下面的%s是**模块级单例**。HMR 重新求值本模块时它们会被换成一份全新的空实例，
 * 而别处（`loader.ts`、各组件）手里的引用不一定跟着换 —— 表现是「改一下这个文件，
 * 插件列表就空了 / 行旁注没了」，而且不报任何错。
 *
 * 试过 `hot.invalidate()`，**不够**：它只是把更新往上传，而 `loader.ts` 与各组件那几层
 * 里总有 React 组件（Fast Refresh）接住，传播就停在那儿，`loader.ts` 拿不到新实例。
 * 所以要的是**整页重载**：本模块自接受，然后在回调里直接刷新。
 * 代价是改这几个文件会重载一次页面 —— 对持有全局状态的模块，这比悄悄少一半状态强。
 */
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}

import { toDisposable, type Disposable } from "./disposable";
import type {
  PluginCommand,
  PluginManifest,
  PluginPanelDef,
  PluginRuntimeRecord,
  PluginStatus,
  Selection,
} from "./types";

interface Owned<T> {
  def: T;
  owner: string;
}

/**
 * 带归属与订阅的注册表。所有贡献点共用这一套语义，避免每加一个贡献点就重写一遍
 * "数组 + 监听器集合"。
 */
class OwnedRegistry<T> {
  private entries: Owned<T>[] = [];
  private listeners = new Set<() => void>();

  /**
   * `list()` 的快照缓存。
   *
   * ⚠️ 这不是微优化，是**正确性要求**：`list()` 会直接喂给
   * `useSyncExternalStore(subscribe, getSnapshot)`。React 用 `Object.is` 比较快照，
   * 若每次调用都新建数组，快照就永远"变了"，组件会陷入无限重渲染
   * （表现为 `Maximum update depth exceeded`）。
   *
   * 因此这里只在注册表**真正变化**时重建快照，并冻结以防调用方改写。
   */
  private snapshot: readonly T[] = Object.freeze([]);

  private rebuildSnapshot(): void {
    this.snapshot = Object.freeze(this.entries.map((entry) => entry.def));
  }

  register(owner: string, def: T, onRemove?: (def: T) => void): Disposable {
    const entry: Owned<T> = { def, owner };
    this.entries.push(entry);
    this.rebuildSnapshot();
    this.notify();

    return toDisposable(() => {
      const index = this.entries.indexOf(entry);
      if (index < 0) return;
      this.entries.splice(index, 1);
      onRemove?.(def);
      this.rebuildSnapshot();
      this.notify();
    });
  }

  /** 返回稳定引用的快照；仅在注册表变化时才会换新数组。 */
  list(): readonly T[] {
    return this.snapshot;
  }

  /** 就地改写某个归属下的条目（用于更新运行状态）。 */
  update(owner: string, transform: (def: T) => T): void {
    let changed = false;
    this.entries = this.entries.map((entry) => {
      if (entry.owner !== owner) return entry;
      changed = true;
      return { ...entry, def: transform(entry.def) };
    });
    if (changed) {
      this.rebuildSnapshot();
      this.notify();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 移除某个插件注册的全部条目。条目自身若带清理回调会一并触发。 */
  removeOwner(owner: string): void {
    const kept: Owned<T>[] = [];
    let removed = false;
    for (const entry of this.entries) {
      if (entry.owner === owner) {
        removed = true;
      } else {
        kept.push(entry);
      }
    }
    if (!removed) return;
    this.entries = kept;
    this.rebuildSnapshot();
    this.notify();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.rebuildSnapshot();
    this.notify();
  }

  get size(): number {
    return this.entries.length;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[plugins] 注册表订阅回调抛错", error);
      }
    }
  }
}

// ---------------------------------------------------------------- 命令

const commands = new OwnedRegistry<PluginCommand>();

export function addPluginCommand(command: PluginCommand): Disposable {
  return commands.register(command.plugin, command);
}

export function listPluginCommands(): readonly PluginCommand[] {
  return commands.list();
}

export function subscribePluginCommands(listener: () => void): () => void {
  return commands.subscribe(listener);
}

// -------------------------------------------------- 选区转换器（Ctrl+\）

export type SelectionTransformer = (text: string) => string | null | Promise<string | null>;

const selectionTransformers = new OwnedRegistry<SelectionTransformer>();

export function registerSelectionTransformer(
  owner: string,
  transformer: SelectionTransformer,
): Disposable {
  return selectionTransformers.register(owner, transformer);
}

/**
 * 依次询问每个转换器，返回第一个非空结果。
 *
 * **现在是异步的。** 原实现是同步的，但 v2 插件跑在 Worker 里、转换必须跨线程往返，
 * 同步签名无法维持。调用方（`markdownShortcuts.ts`）需要相应改造：先同步
 * `preventDefault()`，再在续体里写回结果，且**必须重新读取 textarea 的实时值**，
 * 因为一个 microtask 加一次 RPC 之后捕获的选区偏移可能已经失效。
 */
export async function transformSelection(text: string): Promise<string | null> {
  for (const transformer of selectionTransformers.list()) {
    const result = await transformer(text);
    if (result != null) return result;
  }
  return null;
}

// ---------------------------------------------------------------- 状态栏

export type StatusBarRenderer = (selection: Selection | null) => string | null;

const statusBarRenderers = new OwnedRegistry<StatusBarRenderer>();

export function registerStatusBarRenderer(owner: string, renderer: StatusBarRenderer): Disposable {
  return statusBarRenderers.register(owner, renderer);
}

export function getStatusBarRenderers(): readonly StatusBarRenderer[] {
  return statusBarRenderers.list();
}

export function subscribeStatusBar(listener: () => void): () => void {
  return statusBarRenderers.subscribe(listener);
}

// ------------------------------------------------------------ 独立面板

const panels = new OwnedRegistry<PluginPanelDef>();

export function registerPluginPanel(owner: string, panel: PluginPanelDef): Disposable {
  return panels.register(owner, panel);
}

export function listPluginPanels(): readonly PluginPanelDef[] {
  return panels.list();
}

export function subscribePluginPanels(listener: () => void): () => void {
  return panels.subscribe(listener);
}

// ------------------------------------------------------------ 编辑器行旁注

/** 宿主侧的行旁注声明。逐行文字在 stores 里（异步渲染，见 v2Host）。 */
export interface PluginEditorGutter {
  id: string;
  title: string;
  plugin: string;
  /** 栏宽（px）。 */
  width: number;
}

const editorGutters = new OwnedRegistry<PluginEditorGutter>();

export function registerEditorGutter(owner: string, gutter: PluginEditorGutter): Disposable {
  return editorGutters.register(owner, gutter);
}

/**
 * 往**别人的**视图里加东西的那一份声明（`files.extendView`）。
 *
 * 与别的注册表不同，它不是「宿主照着渲染一个控件」，而是「视图拼装时把这些资源并进去」——
 * 所以没有 `subscribe` 的消费者，只有 `viewAssets` 在拼 srcdoc 时读一次。
 */
export interface PluginViewExtension {
  /** 目标视图的类型 id，**带插件名前缀**（`pdf-viewer:pdf`）。 */
  typeId: string;
  /** 谁扩展的。数据通道按它归属，卸载时也按它清。 */
  plugin: string;
  /** 相对插件目录的样式表 / 脚本。 */
  css: string[];
  js: string[];
  /** 追加到那一排的控件（id 与基础插件的撞了的话，**基础插件赢**）。 */
  toolbar: ViewToolbarItem[];
  /** 这个插件要不要一条私有数据通道（`floralView.extension("<插件名>")`）。 */
  data: boolean;
}

const viewExtensions = new OwnedRegistry<PluginViewExtension>();

export function registerViewExtension(extension: PluginViewExtension): Disposable {
  return viewExtensions.register(extension.plugin, extension);
}

/** 所有扩展声明。调用方（`viewAssets`）自己按 `typeId` 过滤。 */
export function listViewExtensions(): readonly PluginViewExtension[] {
  return viewExtensions.list();
}

export function listEditorGutters(): readonly PluginEditorGutter[] {
  return editorGutters.list();
}

export function subscribeEditorGutters(listener: () => void): () => void {
  return editorGutters.subscribe(listener);
}

// ------------------------------------------------- 右键菜单 / 工具栏贡献

export interface PluginMenuItem {
  id: string;
  title: string;
  plugin: string;
  run: () => void | Promise<void>;
}

/**
 * 笔记列表右键菜单项。
 *
 * 与编辑器菜单项的区别：`run` 需要知道用户右键的是哪一篇笔记，因此带一个 noteId。
 */
export interface PluginNoteMenuItem {
  id: string;
  title: string;
  plugin: string;
  run: (noteId: string) => void | Promise<void>;
}

export interface PluginToolbarButton {
  id: string;
  title: string;
  icon?: string;
  plugin: string;
  run: () => void | Promise<void>;
}

/**
 * 宿主侧的一条**文档动作** —— 主窗口顶上那一行的一个按钮。
 *
 * 与 `PluginToolbarButton` 的区别不在于长相，而在于**它出现在哪儿、什么时候出现**：
 * 那个是编辑器格式按钮那一排（只在笔记里），这个是文档级那一行，而且要按当前文档
 * 过滤 —— 给 PDF 做的动作不该在打开一篇笔记时冒出来。
 *
 * `contexts` / `typeIds` 都是**空数组 = 不限**（不是「哪都不显示」）。判定在
 * `documentActionVisible`（`features/workspace/documentContext.ts`）。
 */
export interface PluginDocumentAction {
  id: string;
  title: string;
  icon?: string;
  plugin: string;
  contexts: readonly DocumentContext[];
  typeIds: readonly string[];
  /** 在插件的 worker 沙箱里跑。与 `viewCommand` 二选一（或都给）。给了 `items` 就不调用。 */
  run?: () => void | Promise<void>;
  /** 转发给当前那个沙箱视图的命令 id。给了 `items` 就不调用。 */
  viewCommand?: string;
  /** 下拉里的项。非空时这个动作渲染成一个下拉，点开选一项。 */
  items?: readonly PluginDocumentActionItem[];
}

/** 文档动作下拉里的一项 —— 与 `PluginDocumentAction` 一样带**活的闭包**。 */
export interface PluginDocumentActionItem {
  id: string;
  title: string;
  run?: () => void | Promise<void>;
  viewCommand?: string;
}

/**
 * 宿主侧的一条**插件行内动作** —— 插件列表里、这个插件那一行展开后的一颗按钮。
 *
 * 为什么要有它：有些按钮只对**某一个插件**有意义（例如把插件自己的数据文件夹加进
 * 工作区），而插件列表每一行的展开区是宿主画的。没有这个口子，作者只能把入口塞进
 * 自己的面板里，或者永远等宿主替它开一个特例。
 *
 * 与 `PluginDocumentAction` 一样，条目里带的是**活的闭包**（`run`），界面直接调。
 */
export interface PluginRowAction {
  id: string;
  title: string;
  icon?: string;
  plugin: string;
  /** 在插件的 worker 沙箱里跑。 */
  run: () => void | Promise<void>;
}

/**
 * 工具栏浮层在宿主侧的形态。
 *
 * 与 `PluginToolbarButton` 一样，条目里带的是**活的闭包**（`refresh` / `onClick`），
 * 界面直接调，不需要再拿一份宿主引用 —— v1 与 v2 的差异全在闭包里面（v2 的闭包内部
 * 是跨线程往返）。
 */
export interface PluginPopover {
  id: string;
  title: string;
  icon?: string;
  /** 下拉宽度（px）。 */
  width?: number;
  markdownOnly: boolean;
  closeOnClick: boolean;
  plugin: string;
  /** 重新问插件要一份内容 HTML（点开时调一次）。 */
  refresh: () => void;
  /** 点击内容的回调；插件返回字符串时由实现方写回缓存。 */
  onClick?: (target: HTMLElement) => void;
}

/**
 * 行内装饰在宿主侧的形态。
 *
 * 与工具栏按钮、浮层一样，条目里带的是**活的闭包**：`refresh` 重新问插件要一份条目，
 * `pick` 把「用户在哪个区间选了什么颜色」回传给插件。v1 / v2 的差异全在闭包内部。
 */
export interface PluginDecoration {
  id: string;
  title: string;
  plugin: string;
  /** 重新问插件要一份条目（正文 / 文件变化时调）。 */
  refresh: () => void;
  /** 用户选完颜色。区间与颜色都由宿主校验过。 */
  pick?: (offset: number, length: number, color: string) => void;
}

const editorMenuItems = new OwnedRegistry<PluginMenuItem>();
const noteMenuItems = new OwnedRegistry<PluginNoteMenuItem>();
const toolbarButtons = new OwnedRegistry<PluginToolbarButton>();
const documentActions = new OwnedRegistry<PluginDocumentAction>();
const rowActions = new OwnedRegistry<PluginRowAction>();
const popovers = new OwnedRegistry<PluginPopover>();
const decorations = new OwnedRegistry<PluginDecoration>();

export function registerEditorMenuItem(item: PluginMenuItem): Disposable {
  return editorMenuItems.register(item.plugin, item);
}

export function listEditorMenuItems(): readonly PluginMenuItem[] {
  return editorMenuItems.list();
}

export function subscribeEditorMenuItems(listener: () => void): () => void {
  return editorMenuItems.subscribe(listener);
}

export function registerNoteMenuItem(item: PluginNoteMenuItem): Disposable {
  return noteMenuItems.register(item.plugin, item);
}

export function listNoteMenuItems(): readonly PluginNoteMenuItem[] {
  return noteMenuItems.list();
}

export function subscribeNoteMenuItems(listener: () => void): () => void {
  return noteMenuItems.subscribe(listener);
}

export function registerToolbarButton(button: PluginToolbarButton): Disposable {
  return toolbarButtons.register(button.plugin, button);
}

export function listToolbarButtons(): readonly PluginToolbarButton[] {
  return toolbarButtons.list();
}

export function subscribeToolbarButtons(listener: () => void): () => void {
  return toolbarButtons.subscribe(listener);
}

export function registerDocumentAction(action: PluginDocumentAction): Disposable {
  return documentActions.register(action.plugin, action);
}

export function listDocumentActions(): readonly PluginDocumentAction[] {
  return documentActions.list();
}

export function subscribeDocumentActions(listener: () => void): () => void {
  return documentActions.subscribe(listener);
}

export function registerRowAction(action: PluginRowAction): Disposable {
  return rowActions.register(action.plugin, action);
}

export function listRowActions(): readonly PluginRowAction[] {
  return rowActions.list();
}

export function subscribeRowActions(listener: () => void): () => void {
  return rowActions.subscribe(listener);
}

export function registerDecoration(decoration: PluginDecoration): Disposable {
  return decorations.register(decoration.plugin, decoration);
}

export function listDecorations(): readonly PluginDecoration[] {
  return decorations.list();
}

export function subscribeDecorations(listener: () => void): () => void {
  return decorations.subscribe(listener);
}

export function registerPopover(popover: PluginPopover): Disposable {
  return popovers.register(popover.plugin, popover);
}

export function listPopovers(): readonly PluginPopover[] {
  return popovers.list();
}

export function subscribePopovers(listener: () => void): () => void {
  return popovers.subscribe(listener);
}

// ---------------------------------------------------------- 已加载插件

const plugins = new OwnedRegistry<PluginRuntimeRecord>();

export function registerLoadedPlugin(
  manifest: PluginManifest,
  status: PluginStatus = "loaded",
  error?: string,
): Disposable {
  return plugins.register(manifest.name, {
    manifest,
    status,
    error,
    sandboxed: manifest.apiVersion >= 2,
  });
}

/** 更新某个插件的运行状态（例如被看门狗暂停）。 */
export function updatePluginStatus(name: string, status: PluginStatus, error?: string): void {
  plugins.update(name, (record) => ({ ...record, status, error }));
}

export function listLoadedPlugins(): readonly PluginRuntimeRecord[] {
  return plugins.list();
}

export function subscribeLoadedPlugins(listener: () => void): () => void {
  return plugins.subscribe(listener);
}

// -------------------------------------------------------- 内容变化广播

// 这不是注册项，而是纯广播，保持原样。
const contentListeners = new Set<() => void>();

export function notifyContentChanged(): void {
  for (const listener of contentListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[plugins] 内容变化订阅回调抛错", error);
    }
  }
}

export function subscribeContentChange(listener: () => void): () => void {
  contentListeners.add(listener);
  return () => {
    contentListeners.delete(listener);
  };
}

// ------------------------------------------------------------ 卸载清理

/** 卸载单个插件的全部注册项。 */
export function unregisterPlugin(name: string): void {
  commands.removeOwner(name);
  selectionTransformers.removeOwner(name);
  statusBarRenderers.removeOwner(name);
  panels.removeOwner(name);
  editorMenuItems.removeOwner(name);
  noteMenuItems.removeOwner(name);
  toolbarButtons.removeOwner(name);
  documentActions.removeOwner(name);
  rowActions.removeOwner(name);
  popovers.removeOwner(name);
  editorGutters.removeOwner(name);
  decorations.removeOwner(name);
  viewExtensions.removeOwner(name);
  plugins.removeOwner(name);
}

/** 清空全部插件注册项（重载时使用）。 */
export function clearAllPlugins(): void {
  commands.clear();
  selectionTransformers.clear();
  statusBarRenderers.clear();
  panels.clear();
  editorMenuItems.clear();
  noteMenuItems.clear();
  toolbarButtons.clear();
  documentActions.clear();
  rowActions.clear();
  popovers.clear();
  // ⚠️ 行旁注与行内装饰**必须在这里清**。
  //
  // 它们是「带活闭包」的注册项，宿主卸载时会各自 dispose（正常路径没问题）。但这里还
  // 兜着另一条路：Vite HMR 重新求值 `loader.ts` 时，那个模块的 `running` 表会归零，
  // **旧的宿主实例再也没人会去 dispose 它** —— 它登记的条目就留在注册表里。于是插件
  // 重新加载一遍，同一个 id 就有了两条：行旁注会多出一栏，行内装饰会在同一个位置画两个
  // 色块（React 报 "two children with the same key"）。
  editorGutters.clear();
  decorations.clear();
  viewExtensions.clear();
  plugins.clear();
}

/** 仅供测试与调试：当前各注册表的条目数。 */
export function pluginRegistrySizes(): Record<string, number> {
  return {
    commands: commands.size,
    selectionTransformers: selectionTransformers.size,
    statusBarRenderers: statusBarRenderers.size,
    panels: panels.size,
    editorMenuItems: editorMenuItems.size,
    noteMenuItems: noteMenuItems.size,
    toolbarButtons: toolbarButtons.size,
    documentActions: documentActions.size,
    rowActions: rowActions.size,
    popovers: popovers.size,
    viewExtensions: viewExtensions.size,
    plugins: plugins.size,
  };
}
