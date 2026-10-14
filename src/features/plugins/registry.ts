import type { PluginCommand, PluginManifest, PluginPanelDef, Selection } from "./types";

// 命令（插件面板里可点击的操作）
const commands: PluginCommand[] = [];
const commandListeners = new Set<() => void>();

export function addPluginCommand(command: PluginCommand): void {
  commands.push(command);
  commandListeners.forEach((listener) => listener());
}

export function listPluginCommands(): PluginCommand[] {
  return [...commands];
}

export function subscribePluginCommands(listener: () => void): () => void {
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}

// 选区转换器（如 Ctrl+\ 把选中文本转成表格）
export type SelectionTransformer = (text: string) => string | null;
const selectionTransformers: SelectionTransformer[] = [];

export function registerSelectionTransformer(transformer: SelectionTransformer): void {
  selectionTransformers.push(transformer);
}

export function transformSelection(text: string): string | null {
  for (const transformer of selectionTransformers) {
    const result = transformer(text);
    if (result != null) return result;
  }
  return null;
}

// 状态栏项（在编辑器底部实时显示，如选中字数）
export type StatusBarRenderer = (selection: Selection | null) => string | null;
const statusBarRenderers: StatusBarRenderer[] = [];
const statusBarListeners = new Set<() => void>();

export function registerStatusBarRenderer(renderer: StatusBarRenderer): void {
  statusBarRenderers.push(renderer);
  statusBarListeners.forEach((listener) => listener());
}

export function getStatusBarRenderers(): StatusBarRenderer[] {
  return [...statusBarRenderers];
}

export function subscribeStatusBar(listener: () => void): () => void {
  statusBarListeners.add(listener);
  return () => {
    statusBarListeners.delete(listener);
  };
}

// 已加载插件列表（用于插件面板列举）
const loadedPlugins: PluginManifest[] = [];
const loadedPluginListeners = new Set<() => void>();

export function registerLoadedPlugin(manifest: PluginManifest): void {
  loadedPlugins.push(manifest);
  loadedPluginListeners.forEach((listener) => listener());
}

export function listLoadedPlugins(): PluginManifest[] {
  return [...loadedPlugins];
}

export function subscribeLoadedPlugins(listener: () => void): () => void {
  loadedPluginListeners.add(listener);
  return () => {
    loadedPluginListeners.delete(listener);
  };
}

// 面板（插件注册的侧边栏面板）
const panels: PluginPanelDef[] = [];
const panelListeners = new Set<() => void>();

export function registerPluginPanel(panel: PluginPanelDef): void {
  panels.push(panel);
  panelListeners.forEach((listener) => listener());
}

export function listPluginPanels(): PluginPanelDef[] {
  return [...panels];
}

export function subscribePluginPanels(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => {
    panelListeners.delete(listener);
  };
}

// 内容变化通知（插件面板实时更新）
const contentListeners = new Set<() => void>();

export function notifyContentChanged(): void {
  contentListeners.forEach((listener) => listener());
}

export function subscribeContentChange(listener: () => void): () => void {
  contentListeners.add(listener);
  return () => {
    contentListeners.delete(listener);
  };
}

export function clearAllPlugins(): void {
  commands.length = 0;
  selectionTransformers.length = 0;
  statusBarRenderers.length = 0;
  loadedPlugins.length = 0;
  panels.length = 0;
  commandListeners.forEach((listener) => listener());
  statusBarListeners.forEach((listener) => listener());
  loadedPluginListeners.forEach((listener) => listener());
  panelListeners.forEach((listener) => listener());
}
