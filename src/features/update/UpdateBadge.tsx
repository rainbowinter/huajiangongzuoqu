import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
 */
export function UpdateBadge({ controller }: { controller: UpdateController }) {
  const { t } = useTranslation();
  const { state, download, install } = controller;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const visible = isUpdateVisible(state);

  // 点别处 / 按 Esc 收起气泡。只在开着的时候挂监听。
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // 下载完就把气泡自动推开，省得用户不知道已经下好了。
  useEffect(() => {
    if (state.stage === "ready") setOpen(true);
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
        onClick={() => setOpen((current) => !current)}
        className={`mx-1 px-2 h-6 rounded-md bg-cloud/90 backdrop-blur-sm border text-[10px] font-mono transition-colors cursor-pointer hover:bg-bamboo-mist/70 ${tone}`}
        title={t("update.badge.title", { defaultValue: "应用更新" })}
      >
        {label}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-[9998] w-72 rounded-lg bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 shadow-lg p-3 text-left">
          {renderBody()}
        </div>
      )}
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
                onClick={() => setOpen(false)}
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
                onClick={() => setOpen(false)}
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
                onClick={() => setOpen(false)}
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
