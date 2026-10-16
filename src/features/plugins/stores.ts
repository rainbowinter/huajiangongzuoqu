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

/**
 * 一个面板最多给多少个**文件**留内容。
 *
 * 缓存是「按文件各存一份」，不设上限的话开一整天下来就是「开过多少篇文章就留多少份
 * HTML」。超出时淘汰最久没用过的那个（LRU），**当前这个永远不淘汰**。
 */
const PANEL_BUCKET_LIMIT = 16;

/** 缓存键：面板 id × 文件。用 `\0` 而不是 `:` —— 面板 id 自己就带冒号（`插件:面板`）。 */
function panelKey(panelId: string, fileKey: string): string {
  return `${panelId}\u0000${fileKey}`;
}

/**
 * 面板分桶用的「这是哪份文件」。
 *
 * **写的一侧（`v2Host`）和读的一侧（`MainWindow`）必须调同一个函数** —— 两边各写一遍
 * `path ?? id` 的话，哪天有一边改了另一边的桶就再也读不到，症状是「面板一直空白」。
 *
 * **路径优先**：工作区里的外部文件两边都有值，但 `activeNoteId` 那时也被设成了路径
 * （宿主推镜像时就是这么填的），所以顺序反过来也能对；可笔记只有 id、外部文件只有路径，
 * 取「有哪个用哪个」才不会两类互相撞上。
 */
export function panelFileKeyOf(input: { path?: string | null; noteId?: string | null }): string {
  return input.path ?? input.noteId ?? "";
}

/**
 * 面板 HTML 是**按文件分开存的**，不是一个面板一份。
 *
 * 为什么：面板里的滚动位置、`<details>` 展开层级、还没提交的搜索词都活在 DOM 上，
 * 而 DOM 只在 `dangerouslySetInnerHTML` 的**字符串变了**时才被重建。一份面板只留一份
 * 内容的话，切到别的文件再切回来，拿到的是「照着新文件重渲染出来的那一份」，字符串必然
 * 不同 ⇒ 整棵子树重建 ⇒ 用户刚才展开到第三层的大纲没了、滚动条跳回顶部。
 * 按文件存之后，切回来拿到的还是原来那一串，React 不去碰它，状态就留住了。
 *
 * ⚠️ 这条约定依赖**插件 `render()` 是纯的**（同一个文件、同一份内容给出同样的字符串）。
 * 面板里别塞时间戳、随机 id、自增计数 —— 那会让每次切回来都判定成「变了」。
 */
export function setPanelHtml(panelId: string, fileKey: string, html: string): void {
  const key = panelKey(panelId, fileKey);
  if (panelHtml.get(key) === html) {
    // 内容没变也要记一次「刚用过」，否则常用的那篇会被当成最久没用的淘汰掉。
    panelHtml.delete(key);
    panelHtml.set(key, html);
    return;
  }
  panelHtml.delete(key);
  panelHtml.set(key, html);
  evictPanelBuckets(panelId);
  notify();
}

export function getPanelHtml(panelId: string, fileKey: string): string {
  return panelHtml.get(panelKey(panelId, fileKey)) ?? PANEL_HTML_PENDING;
}

/**
 * 清掉某个面板的全部文件桶。
 *
 * ⚠️ 是**按前缀**清，不是 `delete(panelId)` —— 键长成 `面板\u0000文件`，只删面板 id 一个
 * 都删不掉，插件卸载之后面板内容会留在缓存里等着串味。
 */
export function clearPanelHtml(panelId?: string): void {
  if (panelId === undefined) {
    if (panelHtml.size === 0) return;
    panelHtml.clear();
  } else {
    const prefix = `${panelId}\u0000`;
    let removed = false;
    // 边遍历边删是 Map 迭代器明确支持的事（不会像数组那样跳元素），不用先拷一份键。
    for (const key of panelHtml.keys()) {
      if (key.startsWith(prefix)) {
        panelHtml.delete(key);
        removed = true;
      }
    }
    if (!removed) return;
  }
  notify();
}

/** 淘汰到上限以内。迭代顺序就是插入顺序，所以从头删就是「最久没用过的」。 */
function evictPanelBuckets(panelId: string): void {
  const prefix = `${panelId}\u0000`;
  const keys = [...panelHtml.keys()].filter((key) => key.startsWith(prefix));
  for (const key of keys.slice(0, Math.max(0, keys.length - PANEL_BUCKET_LIMIT))) {
    // 刚写进来的那个排在最后（上面做了 delete + set），不可能落在要删的这段里。
    panelHtml.delete(key);
  }
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
