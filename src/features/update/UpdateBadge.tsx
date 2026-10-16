import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  POPUP_VIEWPORT_MARGIN,
  useViewportPopupPosition,
  type PopupPosition,
} from "../../components/popupPosition";
import { downloadPercent, isUpdateVisible } from "./presentation";
import type { UpdateController } from "./useUpdate";

/**
 * 标题栏右上角那颗「有新版」的胶囊。
 *
 * 只在**真的有更新可做**的时候出现：`idle` / `checking` 一律渲染成 `null`。启动时那次
 * 检查是静默的，界面不该因为它在查而闪一下东西 —— 没配更新地址时更是连一次请求都不会发。
 *
 * 位置由调用方（`MainWindow` 的标题栏）决定：它是一个普通按钮，不自己定位。
 * 标题栏里按钮天然免于窗口拖拽（`handleTitleBarMouseDown` 会跳过 button）。
 *
 * ## 面为什么是 `createPortal` 到 `body` 的（别改回 `absolute`）
 *
 * 面板**不能**照普通下拉那样写成挂在按钮下面的 `absolute` —— 那样它**点不到**（用户报过）。
 *
 * 标题栏是 `relative z-10`，**自己就是一个层叠上下文**；`main-body` 同样 `relative z-10`，
 * 而且是它的**后一个兄弟** —— 同层同分按 DOM 顺序，于是 **main-body 整个盖在标题栏那层之上**。
 * 面板写在标题栏里，`z` 标多大都只在那层**内部**有效、出不去；而 main-body 的盒子恰好从
 * 标题栏下沿铺满整个窗口，面板一垂下来就整块落进它的地盘，**鼠标事件全被 main-body 接走**。
 * （胶囊本身点得到，是因为它还在标题栏自己那 44px 里。）
 *
 * 还有第二条更隐蔽的：`handleTitleBarMouseDown` 只放过 `closest("button")`，所以按在面板的
 * 空白处会**拖着窗口跑**。
 *
 * portal 到 `body` 一次解决两条 —— 出了标题栏那层，也出了那个 mousedown 处理器。定位交给
 * `useViewportPopupPosition`（应用里其它浮层都是这一套，见 `components/popupPosition.ts`）。
 */
export function UpdateBadge({ controller }: { controller: UpdateController }) {
  const { t } = useTranslation();
  const { state, download, install } = controller;
  /** 面板的锚点。`null` = 收起来了 —— 用锚点而不是布尔量，是因为面板要自己算位置。 */
  const [anchor, setAnchor] = useState<PopupPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const { popupRef, popupPosition } = useViewportPopupPosition(anchor);

  const open = anchor !== null;
  const visible = isUpdateVisible(state);

  // 点别处 / 按 Esc 收起气泡。只在开着的时候挂监听。
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      // ⚠️ 面板 portal 出去了，**不在 `rootRef` 里** —— 少了这一句，点面板内部会被当成
      // 「点了别处」，面板当场关掉，里面按钮的 click 也就永远发不出来。
      if (popupRef.current?.contains(target)) return;
      setAnchor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAnchor(null);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, popupRef]);

  // 下载完就把气泡自动推开，省得用户不知道已经下好了。
  useEffect(() => {
    if (state.stage !== "ready") return;
    if (buttonRef.current) setAnchor(anchorFromButton(buttonRef.current));
  }, [state.stage]);

  if (!visible) return null;

  const label = (() => {
    switch (state.stage) {
      case "available":
        return t("update.badge.available", { defaultValue: "有新版" });
      case "downloading": {
        const percent = downloadPercent(state.downloaded, state.total);
        return percent === null
          ? t("update.badge.downloading", { defaultValue: "下载中" })
          : t("update.badge.downloadingPercent", {
              defaultValue: "下载中 {{percent}}%",
              percent,
            });
      }
      case "ready":
        return t("update.badge.ready", { defaultValue: "重启并更新" });
      case "installing":
        return t("update.badge.installing", { defaultValue: "安装中" });
      default:
        return t("update.badge.failed", { defaultValue: "更新失败" });
    }
  })();

  const tone =
    state.stage === "error"
      ? "text-red-400 border-red-400/30"
      : "text-bamboo border-bamboo/30";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        onClick={(event) => {
          if (open) {
            setAnchor(null);
            return;
          }
          setAnchor(anchorFromButton(event.currentTarget));
        }}
        className={`mx-1 px-2 h-6 rounded-md bg-cloud/90 backdrop-blur-sm border text-[10px] font-mono transition-colors cursor-pointer hover:bg-bamboo-mist/70 ${tone}`}
        title={t("update.badge.title", { defaultValue: "应用更新" })}
      >
        {label}
      </button>

      {open
        ? createPortal(
            <div
              ref={popupRef}
              className="popup-menu fixed z-[9999] w-72 rounded-lg bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 shadow-lg p-3 text-left"
              style={{ left: popupPosition?.x ?? anchor.x, top: popupPosition?.y ?? anchor.y }}
            >
              {renderBody()}
            </div>,
            // portal 到 `body`：见上面那段注释 —— 留在标题栏里就点不到。
            document.body,
          )
        : null}
    </div>
  );

  function renderBody() {
    switch (state.stage) {
      case "available":
        return (
          <>
            <div className="text-[11px] font-body text-ink mb-1">
              {t("update.panel.availableTitle", {
                defaultValue: "新版本 {{version}}",
                version: state.version,
              })}
            </div>
            {state.notes && (
              <p className="text-[10px] leading-relaxed text-ink-ghost whitespace-pre-wrap max-h-40 overflow-y-auto mb-2">
                {state.notes}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setAnchor(null)}
                className="px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-ink-soft transition-colors cursor-pointer"
              >
                {t("update.panel.later", { defaultValue: "稍后" })}
              </button>
              <button
                onClick={() => void download()}
                className="px-3 h-6 rounded-md text-[10px] bg-bamboo/15 text-bamboo hover:bg-bamboo/25 transition-colors cursor-pointer"
              >
                {t("update.panel.download", { defaultValue: "下载" })}
              </button>
            </div>
          </>
        );

      case "downloading": {
        const percent = downloadPercent(state.downloaded, state.total);
        return (
          <>
            <div className="text-[11px] font-body text-ink mb-2">
              {t("update.panel.downloadingTitle", {
                defaultValue: "正在下载 {{version}}…",
                version: state.version,
              })}
            </div>
            <div className="h-1 rounded-full bg-paper-deep/30 overflow-hidden">
              <div
                className="h-full bg-bamboo/70 transition-[width] duration-200"
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
            <div className="mt-1.5 text-[10px] text-ink-ghost font-mono tabular-nums text-right">
              {percent === null ? "" : `${Math.floor(percent)}%`}
            </div>
          </>
        );
      }

      case "ready":
        return (
          <>
            <div className="text-[11px] font-body text-ink mb-1">
              {t("update.panel.readyTitle", {
                defaultValue: "{{version}} 已下载完成",
                version: state.version,
              })}
            </div>
            <p className="text-[10px] leading-relaxed text-ink-ghost mb-2">
              {t("update.panel.readyHint", {
                defaultValue: "点下面的按钮会关闭应用、安装新版本，然后自动重新打开。",
              })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setAnchor(null)}
                className="px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-ink-soft transition-colors cursor-pointer"
              >
                {t("update.panel.later", { defaultValue: "稍后" })}
              </button>
              <button
                onClick={() => void install()}
                className="px-3 h-6 rounded-md text-[10px] bg-bamboo/15 text-bamboo hover:bg-bamboo/25 transition-colors cursor-pointer"
              >
                {t("update.panel.restart", { defaultValue: "重启并安装" })}
              </button>
            </div>
          </>
        );

      case "installing":
        return (
          <div className="text-[11px] font-body text-ink">
            {t("update.panel.installingTitle", {
              defaultValue: "正在安装 {{version}}，应用即将重启…",
              version: state.version,
            })}
          </div>
        );

      default: {
        // `default` 同时兜住 idle / checking —— 它们在上面就被 `visible` 挡掉了，
        // 但类型上仍然可能走到这儿，所以先收窄再用 `message`。
        if (state.stage !== "error") return null;
        return (
          <>
            <div className="text-[11px] font-body text-ink mb-1">
              {t("update.panel.failedTitle", { defaultValue: "更新没有完成" })}
            </div>
            <p className="text-[10px] leading-relaxed text-ink-ghost break-words mb-2">
              {state.message}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setAnchor(null)}
                className="px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-ink-soft transition-colors cursor-pointer"
              >
                {t("update.panel.later", { defaultValue: "稍后" })}
              </button>
              <button
                onClick={() => void download()}
                className="px-3 h-6 rounded-md text-[10px] bg-bamboo/15 text-bamboo hover:bg-bamboo/25 transition-colors cursor-pointer"
              >
                {t("update.panel.retry", { defaultValue: "重试" })}
              </button>
            </div>
          </>
        );
      }
    }
  }
}

/**
 * 面板挂在按钮**右沿**下方。
 *
 * 锚点取右沿（而不是左沿）是故意的：`getViewportPopupPosition` 发现「锚点 + 面板宽」会
 * 越过右边界时，会往左挪**一个面板宽** —— 于是面板的右边正好对齐按钮的右边，也就是原来
 * `absolute right-0` 的那个效果。按钮贴着窗口右边，这个条件恒成立。
 */
function anchorFromButton(button: HTMLElement): PopupPosition {
  const rect = button.getBoundingClientRect();
  return { x: rect.right, y: rect.bottom + POPUP_VIEWPORT_MARGIN };
}
