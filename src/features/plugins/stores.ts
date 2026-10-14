/**
 * 插件界面产物的缓存存储。
 *
 * 为什么需要它：现状是 `MainWindow.tsx` 在 JSX 里直接调 `panel.render()`
 * （每次 React 渲染都调一次），`usePluginStatusBar` 也在渲染期调 renderer。
 * 这带来三个问题：
 *
 * 1. 性能——插件面板 HTML 每次重渲染都重算一遍。
 * 2. 正确性——沙箱插件的 `render()` 必须跨线程往返，渲染期**不可能**拿到结果。
 * 3. 一致性——面板内容刷新与 React 渲染周期耦合在一起，无法主动失效。
 *
 * 改为「宿主按需拉取 → 写入 store → React 通过 `useSyncExternalStore` 订阅」。
 * v1 插件也一起走这条路，顺带修掉第 1 个既有问题。
 */

const panelHtml = new Map<string, string>();
const statusBarText = new Map<string, string | null>();
const listeners = new Set<() => void>();

/** 全局单调修订号，作为 `useSyncExternalStore` 的快照。 */
let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[plugins] store 订阅回调抛错", error);
    }
  }
}

export function subscribePluginStores(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pluginStoresRevision(): number {
  return revision;
}

// ------------------------------------------------------------ 面板 HTML

export const PANEL_HTML_PENDING = "";

export function setPanelHtml(panelId: string, html: string): void {
  if (panelHtml.get(panelId) === html) return;
  panelHtml.set(panelId, html);
  notify();
}

export function getPanelHtml(panelId: string): string {
  return panelHtml.get(panelId) ?? PANEL_HTML_PENDING;
}

export function clearPanelHtml(panelId?: string): void {
  if (panelId === undefined) {
    if (panelHtml.size === 0) return;
    panelHtml.clear();
  } else {
    if (!panelHtml.delete(panelId)) return;
  }
  notify();
}

// ---------------------------------------------------------- 状态栏文本

/**
 * v2 状态栏项的注册顺序。
 *
 * v1 的 renderer 是同步函数，直接由 `usePluginStatusBar` 调用；v2 的必须跨线程，
 * 只能读缓存文本。顺序单独记在这里，是为了让两类条目在界面上保持稳定次序。
 */
const statusBarOrder: string[] = [];

export function addStatusBarItemId(itemId: string): void {
  if (statusBarOrder.includes(itemId)) return;
  statusBarOrder.push(itemId);
  notify();
}

export function removeStatusBarItemId(itemId: string): void {
  const index = statusBarOrder.indexOf(itemId);
  if (index < 0) return;
  statusBarOrder.splice(index, 1);
  statusBarText.delete(itemId);
  notify();
}

export function setStatusBarText(itemId: string, text: string | null): void {
  if (statusBarText.get(itemId) === text) return;
  statusBarText.set(itemId, text);
  notify();
}

export function getStatusBarText(itemId: string): string | null {
  return statusBarText.get(itemId) ?? null;
}

/** 当前所有非空的 v2 状态栏文本，按注册顺序。 */
export function listStatusBarTexts(): string[] {
  const out: string[] = [];
  for (const id of statusBarOrder) {
    const text = statusBarText.get(id);
    if (text) out.push(text);
  }
  return out;
}

export function clearStatusBarText(itemId?: string): void {
  if (itemId === undefined) {
    if (statusBarText.size === 0) return;
    statusBarText.clear();
  } else {
    if (!statusBarText.delete(itemId)) return;
  }
  notify();
}

/** 仅供测试与整插件卸载时清空。 */
export function resetPluginStores(): void {
  panelHtml.clear();
  statusBarText.clear();
  statusBarOrder.length = 0;
  notify();
}
