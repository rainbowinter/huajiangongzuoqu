import { useEffect, useState, useSyncExternalStore } from "react";
import { getStatusBarRenderers, subscribeStatusBar } from "./registry";
import { listStatusBarTexts, pluginStoresRevision, subscribePluginStores } from "./stores";
import type { Selection } from "./types";

/**
 * 汇总状态栏上来自插件的文本。
 *
 * 两类来源合流：
 *
 * * **v1 插件**：同步 renderer，在这里直接调用（保持原有行为）。
 * * **v2 插件**：跑在 Worker 里，不可能同步出结果；文本由宿主的拉取循环写进 store，
 *   这里只读缓存。刷新时机是选区变化（见 `refreshPluginStatusBar`）。
 */
export function usePluginStatusBar(selection: Selection | null): string[] {
  const [renderers, setRenderers] = useState(() => getStatusBarRenderers());

  useEffect(() => subscribeStatusBar(() => setRenderers(getStatusBarRenderers())), []);

  // 订阅 store 的修订号，v2 文本更新时触发重渲染。
  useSyncExternalStore(subscribePluginStores, pluginStoresRevision, pluginStoresRevision);

  const v1Texts = renderers
    .map((renderer) => {
      try {
        return renderer(selection);
      } catch (error) {
        console.error("[plugins] 状态栏渲染函数抛错", error);
        return null;
      }
    })
    .filter((text): text is string => Boolean(text));

  return [...v1Texts, ...listStatusBarTexts()];
}
