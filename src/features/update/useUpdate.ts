import { useCallback, useEffect, useRef, useState } from "react";
import { showToast } from "../../components/Toast";
import { getErrorMessage } from "../notes/api";
import { checkForUpdate, getUpdateEndpoint, type Update } from "./api";
import type { UpdateState } from "./presentation";

/**
 * 更新流程的状态机。**「点了才下载」**是刻意的：检查是静默的，但下载与安装都要用户点 ——
 * 这里没有任何自动下载的路径，状态停在 `available` 就不动了，直到界面上的按钮被按下。
 *
 * 状态类型定义在 `presentation.ts`（那里没有 Tauri 依赖，能被测试导入）。
 */
export type { UpdateState };

/** 启动后多久去查。躲开首屏那堆活儿（配置、笔记、插件）再发网络请求。 */
const AUTO_CHECK_DELAY_MS = 3000;

/**
 * 之后每隔多久**再查一次**。
 *
 * 原来只在启动 3 秒后查一次 —— 而这台电脑常年开着、应用一直挂在那儿，于是永远停在
 * 「启动时那个版本」，新版本发出去也收不到提示（用户报的）。4 小时是个折中：一天最多
 * 6 次请求，对端点几乎没压力，又不会让「开着不管」的机器错过太久。
 */
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** 窗口重新可见时（合盖唤醒、从托盘切回来），距上次检查超过这么久就补查一次。 */
const RESUME_CHECK_AFTER_MS = 30 * 60 * 1000;

export interface UpdateController {
  state: UpdateState;
  /**
   * 是否配置了更新端点。`false` 时整个功能不该在界面上露出任何痕迹。
   * `null` 表示还没问出来（刚挂载的一瞬间）。
   */
  enabled: boolean | null;
  /** 手动检查（设置面板里那个按钮）。**不静默**：失败要说出来。 */
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

export function useUpdate(): UpdateController {
  const [state, setState] = useState<UpdateState>({ stage: "idle" });
  const [enabled, setEnabled] = useState<boolean | null>(null);

  /**
   * 当前这次更新的句柄。**必须留着。**
   *
   * `Update` 是个 Rust 侧的 Resource（`rid`），下载下来的字节挂在它身上；下载与安装
   * 之间把它丢了，`install()` 就没东西可装了。
   */
  const updateRef = useRef<Update | null>(null);

  /**
   * 当前阶段（给定时器读的）。
   *
   * 轮询是**静默**的，但它一进来就会把状态改成 `checking` —— 如果用户正在下载、或者
   * 已经下载好了等着装，那一改就把进度和已下载的句柄冲掉了。所以这几种阶段直接跳过。
   */
  const stageRef = useRef<UpdateState["stage"]>("idle");
  stageRef.current = state.stage;
  const canPoll = () =>
    stageRef.current !== "downloading" &&
    stageRef.current !== "installing" &&
    stageRef.current !== "ready";

  const runCheck = useCallback(async ({ quiet }: { quiet: boolean }) => {
    setState({ stage: "checking" });
    try {
      const found = await checkForUpdate();
      if (!found?.available) {
        updateRef.current = null;
        // 没有新版 = 界面上什么都不该出现，回到 idle。
        setState({ stage: "idle" });
        return;
      }
      updateRef.current = found;
      setState({ stage: "available", version: found.version, notes: (found.body ?? "").trim() });
    } catch (error) {
      updateRef.current = null;
      if (quiet) {
        // 启动时那次检查是**静默**的：断网、端点没起来、公司代理拦了 —— 都不该弹提示
        // 吓用户。他们没主动做任何事。
        console.warn("[update] 启动检查更新失败（已静默）", error);
        setState({ stage: "idle" });
        return;
      }
      setState({ stage: "error", message: getErrorMessage(error) });
    }
  }, []);

  // 挂载时问一次端点，配了才排定那次静默检查。
  //
  // 这里**不用**「已启动」标志去防 StrictMode 的双调用 —— 那样反而会卡死：第一次挂载
  // 排的计时器会被 cleanup 清掉，而第二次挂载一看标志已经置位就直接返回，检查永远不会
  // 发生。正确做法就是让 cleanup 正常清理，第二次挂载自然重排一次。
  useEffect(() => {
    let cancelled = false;
    let firstTimer: number | undefined;
    let pollTimer: number | undefined;
    /** 上一次真正发起检查的时间。窗口可见性那条路用它做节流。 */
    let lastCheckAt = Date.now();

    const checkNow = () => {
      if (cancelled || !canPoll()) return;
      lastCheckAt = Date.now();
      void runCheck({ quiet: true });
    };

    /** 从后台切回来时补查一次（合盖唤醒的情况定时器多半被节流了）。 */
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheckAt < RESUME_CHECK_AFTER_MS) return;
      checkNow();
    };

    void (async () => {
      let endpoint: string | null = null;
      try {
        endpoint = await getUpdateEndpoint();
      } catch (error) {
        console.error("[update] 取更新端点失败", error);
      }
      if (cancelled) return;

      setEnabled(endpoint !== null);
      if (!endpoint) return;

      firstTimer = window.setTimeout(checkNow, AUTO_CHECK_DELAY_MS);
      // 之后一直轮询：应用常年开着也不会停在「启动时那个版本」。
      pollTimer = window.setInterval(checkNow, POLL_INTERVAL_MS);
      document.addEventListener("visibilitychange", onVisibility);
    })();

    return () => {
      cancelled = true;
      if (firstTimer !== undefined) window.clearTimeout(firstTimer);
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [runCheck]);

  const download = useCallback(async () => {
    const target = updateRef.current;
    if (!target) return;

    const version = target.version;
    const notes = (target.body ?? "").trim();
    setState({ stage: "downloading", version, notes, downloaded: 0, total: null });

    try {
      await target.download((event) => {
        setState((current) => {
          // 已经切到别的阶段（用户关掉了、或者出错了）就别再改。
          if (current.stage !== "downloading") return current;
          if (event.event === "Started") {
            return { ...current, total: event.data.contentLength ?? null };
          }
          if (event.event === "Progress") {
            return { ...current, downloaded: current.downloaded + event.data.chunkLength };
          }
          return current;
        });
      });
      setState({ stage: "ready", version, notes });
    } catch (error) {
      const message = getErrorMessage(error);
      setState({ stage: "error", message });
      showToast(`更新下载失败：${message}`);
    }
  }, []);

  const install = useCallback(async () => {
    const target = updateRef.current;
    if (!target) return;

    const version = target.version;
    const notes = (target.body ?? "").trim();
    setState({ stage: "installing", version, notes });

    try {
      // `restartAfterInstall` 由 process 插件接管收尾：装完自己重启到新版本。
      await target.install({ restartAfterInstall: true });
    } catch (error) {
      const message = getErrorMessage(error);
      setState({ stage: "error", message });
      showToast(`更新安装失败：${message}`);
    }
  }, []);

  const check = useCallback(async () => {
    await runCheck({ quiet: false });
  }, [runCheck]);

  return { state, enabled, check, download, install };
}
