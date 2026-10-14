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

  register(owner: string, def: T, onRemove?: (def: T) => void): Disposable {
    const entry: Owned<T> = { def, owner };
    this.entries.push(entry);
    this.notify();

    return toDisposable(() => {
      const index = this.entries.indexOf(entry);
      if (index < 0) return;
      this.entries.splice(index, 1);
      onRemove?.(def);
      this.notify();
    });
  }

  list(): T[] {
    return this.entries.map((entry) => entry.def);
  }

  /** 就地改写某个归属下的条目（用于更新运行状态）。 */
  update(owner: string, transform: (def: T) => T): void {
    let changed = false;
    this.entries = this.entries.map((entry) => {
      if (entry.owner !== owner) return entry;
      changed = true;
      return { ...entry, def: transform(entry.def) };
    });
    if (changed) this.notify();
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
    this.notify();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
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

export function listPluginCommands(): PluginCommand[] {
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

export function registerStatusBarRenderer(
  owner: string,
  renderer: StatusBarRenderer,
): Disposable {
  return statusBarRenderers.register(owner, renderer);
}

export function getStatusBarRenderers(): StatusBarRenderer[] {
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

export function listPluginPanels(): PluginPanelDef[] {
  return panels.list();
}

export function subscribePluginPanels(listener: () => void): () => void {
  return panels.subscribe(listener);
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

const editorMenuItems = new OwnedRegistry<PluginMenuItem>();
const noteMenuItems = new OwnedRegistry<PluginNoteMenuItem>();
const toolbarButtons = new OwnedRegistry<PluginToolbarButton>();

export function registerEditorMenuItem(item: PluginMenuItem): Disposable {
  return editorMenuItems.register(item.plugin, item);
}

export function listEditorMenuItems(): PluginMenuItem[] {
  return editorMenuItems.list();
}

export function subscribeEditorMenuItems(listener: () => void): () => void {
  return editorMenuItems.subscribe(listener);
}

export function registerNoteMenuItem(item: PluginNoteMenuItem): Disposable {
  return noteMenuItems.register(item.plugin, item);
}

export function listNoteMenuItems(): PluginNoteMenuItem[] {
  return noteMenuItems.list();
}

export function subscribeNoteMenuItems(listener: () => void): () => void {
  return noteMenuItems.subscribe(listener);
}

export function registerToolbarButton(button: PluginToolbarButton): Disposable {
  return toolbarButtons.register(button.plugin, button);
}

export function listToolbarButtons(): PluginToolbarButton[] {
  return toolbarButtons.list();
}

export function subscribeToolbarButtons(listener: () => void): () => void {
  return toolbarButtons.subscribe(listener);
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
export function updatePluginStatus(
  name: string,
  status: PluginStatus,
  error?: string,
): void {
  plugins.update(name, (record) => ({ ...record, status, error }));
}

export function listLoadedPlugins(): PluginRuntimeRecord[] {
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
    plugins: plugins.size,
  };
}
