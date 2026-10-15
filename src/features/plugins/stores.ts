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

/**
 * ⚠️ **本模块持有全局状态，改动它必须整页刷新，不能做局部热替换。**
 *
 * 下面的缓存是**模块级单例**。HMR 重新求值本模块时它们会被换成一份全新的空实例，
 * 而别处（各组件）手里的引用不一定跟着换 —— 表现是「改一下这个文件，面板/行旁注
 * 就空了」，而且不报任何错。
 *
 * 试过 `hot.invalidate()`，**不够**：它只是把更新往上传，而 `loader.ts` 与各组件那几层
 * 里总有 React 组件（Fast Refresh）接住，传播就停在那儿，`loader.ts` 拿不到新实例。
 * 所以要的是**整页重载**：本模块自接受，然后在回调里直接刷新。
 * 代价是改这几个文件会重载一次页面 —— 对持有全局状态的模块，这比悄悄少一半状态强。
 */
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}

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

/**
 * 行旁注的逐行文字。
 *
 * 和面板 HTML 一样是**异步**产物：插件在 worker 里算，宿主拿到的只是一串字符串。
 * 空字符串表示「这一行没有标注」—— 与面板不同，空内容是这里的常态（多数行本来就
 * 没有标注），所以不需要 PENDING 哨兵。
 */
const gutterLines = new Map<string, readonly string[]>();
const NO_LINES: readonly string[] = Object.freeze([]);

export function setGutterLines(id: string, lines: readonly string[]): void {
  const frozen = Object.freeze(lines);
  // 引用相同就不通知 —— 否则每次内容变化都会把整棵树重渲一遍。
  if (gutterLines.get(id) === frozen) return;
  gutterLines.set(id, frozen);
  notify();
}

export function getGutterLines(id: string): readonly string[] {
  return gutterLines.get(id) ?? NO_LINES;
}

export function clearGutterLines(id?: string): void {
  if (id === undefined) {
    if (gutterLines.size === 0) return;
    gutterLines.clear();
  } else if (!gutterLines.delete(id)) {
    return;
  }
  notify();
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

// ------------------------------------------------------------ 浮层 HTML

/**
 * 工具栏浮层的内容 HTML。
 *
 * 与面板同样是**异步产物**，区别在时机：面板随正文变化后台刷新，浮层只在**点开时**
 * 拉一次 —— 它是个临时界面，没人开着的时候没必要反复渲染。
 *
 * 空串既表示「还没拉到」也表示「插件渲染失败」（失败时 `v2Host` 会写入一段错误 HTML，
 * 不会留空），所以这里不需要 PENDING 哨兵，直接当内容用。
 */
const popoverHtml = new Map<string, string>();

export function setPopoverHtml(popoverId: string, html: string): void {
  if (popoverHtml.get(popoverId) === html) return;
  popoverHtml.set(popoverId, html);
  notify();
}

export function getPopoverHtml(popoverId: string): string {
  return popoverHtml.get(popoverId) ?? "";
}

export function clearPopoverHtml(popoverId?: string): void {
  if (popoverId === undefined) {
    if (popoverHtml.size === 0) return;
    popoverHtml.clear();
  } else {
    if (!popoverHtml.delete(popoverId)) return;
  }
  notify();
}

// ---------------------------------------------------------- 行内装饰

/**
 * 行内装饰的条目缓存：`{ offset, length, color }`，由「行内装饰」贡献点产出。
 * 与行旁注一样是**派生数据**，正文或文件一变就要重算。
 */
export interface DecorationItem {
  offset: number;
  length: number;
  color: string;
}

const decorationItems = new Map<string, readonly DecorationItem[]>();
const NO_DECORATIONS: readonly DecorationItem[] = Object.freeze([]);

export function setDecorationItems(id: string, items: readonly DecorationItem[]): void {
  const frozen = Object.freeze(items.map((item) => Object.freeze({ ...item })));
  if (decorationItems.get(id) === frozen) return;
  decorationItems.set(id, frozen);
  notify();
}

export function getDecorationItems(id: string): readonly DecorationItem[] {
  return decorationItems.get(id) ?? NO_DECORATIONS;
}

export function clearDecorationItems(id?: string): void {
  if (id === undefined) {
    if (decorationItems.size === 0) return;
    decorationItems.clear();
  } else {
    if (!decorationItems.delete(id)) return;
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
  popoverHtml.clear();
  gutterLines.clear();
  decorationItems.clear();
  statusBarText.clear();
  statusBarOrder.length = 0;
  notify();
}
