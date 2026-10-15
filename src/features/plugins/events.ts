/**
 * 宿主事件总线。
 *
 * 插件在 v1 下**收不到任何宿主变化**——只有一个 `notifyContentChanged` 广播，而且
 * 只有面板订阅它。这里补上一条有类型的事件通道，由 `methodTable` 暴露成
 * `api.events.on(topic, handler)`。
 *
 * 语义上要注意两点（会写进文档）：
 *
 * * 事件是**窗口内**的。多窗口应用里每个窗口各有自己的总线实例，`editor:*` 只反映
 *   本窗口的活动编辑器。
 * * `note:*` 这类全局变化由 Rust 侧的 `notes-changed` 事件扇出，因此每个窗口都会
 *   收到，插件可能因此被调用多次。
 */

import { listen } from "@tauri-apps/api/event";
import type { Selection } from "./types";

export interface FloralEvents {
  "workspace:ready": undefined;
  "note:opened": { id: string };
  "note:changed": { id?: string };
  "note:saved": { id: string };
  "note:deleted": { id: string };
  "editor:contentChanged": { content: string };
  "editor:selectionChanged": Selection | null;
  "config:changed": { theme?: string; accentColor?: string; locale?: string };
  "theme:changed": { theme: string; accentColor: string };
  "window:focus": undefined;
  "window:blur": undefined;
  /**
   * 插件**自己**的设置被改了，载荷就是当前的完整设置。
   *
   * 与上面那些应用级事件不同，这一条不是从 Tauri 转发过来的，而是插件运行时直接推
   * 给该插件的（见 v2Host.refreshSettings）—— 列在这里是为了让 `api.events.on` 认它。
   */
  "settings.changed": Record<string, unknown>;
  /**
   * 插件**自己目录**里的文件被保存了。
   *
   * 典型场景：用户在花笺里打开插件的样式表改完保存，宿主据此通知那个插件「你的资源
   * 变了」，插件重新读一遍就立刻生效 —— 不必再点「重新加载」。
   *
   * 广播给所有订阅者，载荷里带 `plugin` 名字，插件比对自己的名字过滤即可。
   * ⚠️ 只有**在花笺里保存**才会触发；用外部编辑器改的不会（那需要一个文件监视器）。
   */
  "plugin:assetsChanged": { plugin: string; path: string };
}

export type FloralEventTopic = keyof FloralEvents;

export const FLORAL_EVENT_TOPICS: readonly FloralEventTopic[] = [
  "workspace:ready",
  "note:opened",
  "note:changed",
  "note:saved",
  "note:deleted",
  "editor:contentChanged",
  "editor:selectionChanged",
  "config:changed",
  // 插件**自己**的设置被改了。与上面那些应用级事件不同，这一条由插件运行时直接推送
  // （见 v2Host.refreshSettings），列在这里只是为了让 api.events.on 认它。
  "settings.changed",
  "theme:changed",
  "window:focus",
  "window:blur",
  "plugin:assetsChanged",
];

type Handler = (payload: unknown) => void;

const handlers = new Map<FloralEventTopic, Set<Handler>>();

export function isFloralEventTopic(value: string): value is FloralEventTopic {
  return (FLORAL_EVENT_TOPICS as readonly string[]).includes(value);
}

export function subscribeFloralEvent(topic: FloralEventTopic, handler: Handler): () => void {
  let set = handlers.get(topic);
  if (!set) {
    set = new Set();
    handlers.set(topic, set);
  }
  set.add(handler);

  return () => {
    set.delete(handler);
  };
}

/**
 * 广播一个事件。
 *
 * 逐个回调包了 try/catch：某个订阅者抛错不应该让其余订阅者收不到事件——沙箱
 * 场景下订阅者最终会走到 RPC 投递，一个坏掉的通道不能拖垮整条总线。
 */
export function emitFloralEvent<K extends FloralEventTopic>(
  topic: K,
  payload: FloralEvents[K],
): void {
  const set = handlers.get(topic);
  if (!set || set.size === 0) return;

  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[plugins] 事件 ${topic} 的订阅回调抛错`, error);
    }
  }
}

/** 仅供测试：清空所有订阅。 */
export function clearFloralEventHandlers(): void {
  handlers.clear();
}

/** 事件内容变化的高频节流间隔。 */
const CONTENT_EVENT_THROTTLE_MS = 150;

let lastContentEmit = 0;
let pendingContent: string | null = null;
let contentTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 内容变化是逐键触发的，直接广播会把插件淹没。这里做 150ms 尾部节流：
 * 首次立即发出，窗口期内的后续调用只更新待发内容，**共用一个定时器**。
 */
export function emitContentChanged(content: string): void {
  const now = Date.now();
  const elapsed = now - lastContentEmit;

  if (contentTimer === null && elapsed >= CONTENT_EVENT_THROTTLE_MS) {
    lastContentEmit = now;
    emitFloralEvent("editor:contentChanged", { content });
    return;
  }

  pendingContent = content;
  // 已经有待发的定时器就只更新内容，不再新建——否则窗口期内每次按键都会排一个定时器。
  if (contentTimer !== null) return;

  contentTimer = setTimeout(
    () => {
      contentTimer = null;
      if (pendingContent === null) return;
      const latest = pendingContent;
      pendingContent = null;
      lastContentEmit = Date.now();
      emitFloralEvent("editor:contentChanged", { content: latest });
    },
    Math.max(0, CONTENT_EVENT_THROTTLE_MS - elapsed),
  );
}

/** 仅供测试：重置节流状态。 */
export function resetContentEventThrottle(): void {
  lastContentEmit = 0;
  pendingContent = null;
  if (contentTimer !== null) {
    clearTimeout(contentTimer);
    contentTimer = null;
  }
}

/**
 * 把 Tauri 侧与浏览器侧的事件源接到总线上。
 *
 * 返回一个 `Disposable`，由调用方（主窗口 / 小窗）在卸载时释放。之所以做成一次性
 * 安装而不是散在各处 `listen()`，是为了避免同一个窗口重复注册监听。
 */
export function installFloralEventBridge(): () => void {
  const disposers: Array<() => void> = [];
  let disposed = false;

  const track = (promise: Promise<() => void>) => {
    void promise
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          disposers.push(unlisten);
        }
      })
      .catch(() => undefined);
  };

  track(listen<unknown>("notes-changed", () => emitFloralEvent("note:changed", {})));
  track(
    listen<string>("open-note", (event) => emitFloralEvent("note:opened", { id: event.payload })),
  );
  track(
    listen<{ theme?: string; accentColor?: string; locale?: string }>("config-changed", (event) => {
      emitFloralEvent("config:changed", event.payload ?? {});
      emitFloralEvent("theme:changed", {
        theme: event.payload?.theme ?? "system",
        accentColor: event.payload?.accentColor ?? "green",
      });
    }),
  );

  if (typeof window !== "undefined") {
    const onFocus = () => emitFloralEvent("window:focus", undefined);
    const onBlur = () => emitFloralEvent("window:blur", undefined);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    disposers.push(() => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    });
  }

  return () => {
    disposed = true;
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  };
}
