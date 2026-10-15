import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../notes/api";
import { fetchMarketCatalog, getMarketEndpoint } from "./api";
import type { MarketState } from "./presentation";

export type { MarketState };

/**
 * 只问「市场配了吗」，**不取清单**。`null` = 还没问出来。
 *
 * 用来决定要不要露出市场那个 tab：没配市场时界面上一点痕迹都不该有。取清单是另一件事
 * （见 `useMarket`），要等用户真的打开那个 tab 再做。
 */
export function useMarketEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const endpoint = await getMarketEndpoint();
        if (!cancelled) setEnabled(endpoint !== null);
      } catch (error) {
        // 问不出来就当没配 —— 宁可不显示，也不要露出一个点开就报错的功能。
        console.error("[market] 取市场端点失败", error);
        if (!cancelled) setEnabled(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}

export interface MarketController {
  state: MarketState;
  /**
   * 是否配了市场。`null` 表示还没问出来（刚挂载的一瞬间）。
   *
   * `false` 时整个功能不该在界面上露出任何痕迹 —— 与 `useUpdate` 的处理一致。
   */
  enabled: boolean | null;
  /** 重新取一次清单。用户点了「刷新」，或者装/卸完插件之后要重算状态。 */
  refresh: () => Promise<void>;
}

/**
 * 市场清单的取回。
 *
 * **挂载时取一次**（前提是配了市场）：这个 hook 只被市场那个 tab 用，所以「打开 tab
 * 才发请求」，启动路径上一个网络请求都不多。取回来之后停在 `ready`，不再自动刷新 ——
 * 清单是静态文件，没必要反复拉。
 *
 * 这里**没有**自动重试，也没有缓存：失败就如实显示错误，让用户自己点刷新。
 */
export function useMarket(): MarketController {
  const [state, setState] = useState<MarketState>({ stage: "unknown" });
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setState({ stage: "loading" });
    try {
      const catalog = await fetchMarketCatalog();
      setState({ stage: "ready", catalog });
    } catch (error) {
      console.warn("[market] 取插件清单失败", error);
      setState({ stage: "error", message: getErrorMessage(error) });
    }
  }, []);

  // 与 `useUpdate` 一样**不用**「已启动」标志防 StrictMode 的双调用：那种做法会让第一次
  // 挂载排的活儿被 cleanup 清掉、第二次又因标志置位直接返回，于是永远不发生。
  // 正确做法就是让 cleanup 正常取消，第二次挂载自然重来一次。
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let endpoint: string | null = null;
      try {
        endpoint = await getMarketEndpoint();
      } catch (error) {
        console.error("[market] 取市场端点失败", error);
      }
      if (cancelled) return;

      setEnabled(endpoint !== null);
      if (!endpoint) {
        setState({ stage: "unavailable" });
        return;
      }

      // 这里不必再查 `cancelled`：即便组件已经卸载，`load` 里的 setState 也只是空操作
      // （React 18 起不会报警告）。真正要防的是**发起**之前那次卸载 —— 上面已经查过。
      await load();
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  return { state, enabled, refresh: load };
}
