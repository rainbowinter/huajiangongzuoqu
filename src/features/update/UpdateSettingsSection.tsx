import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import type { UpdateController } from "./useUpdate";

/**
 * 设置面板里的「应用更新」一节。
 *
 * 自包含、无内部状态依赖，照 `src/components/CodeFontSection.tsx` 的样子写：
 * 一个 `<section className="space-y-3">`，由 `SettingsPanel` 直接挂上去。
 *
 * **控制器是外面传进来的**（`MainWindow` 已经 `useUpdate()` 过一次）。这里绝不能再调一次
 * 那个 hook —— 那会造出第二个控制器，连带多排一次启动检查、多持一份下载中的句柄。
 *
 * 没配更新端点时（`enabled === false`）只显示版本号加一句说明：这个功能整体是关着的，
 * 不该给用户一个点了会报错的按钮。
 */
export function UpdateSettingsSection({ controller }: { controller: UpdateController }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getVersion().then(
      (value) => {
        if (!cancelled) setVersion(value);
      },
      () => {
        // 拿不到版本号不影响这一节的意义，静默即可。
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const { state, enabled, check } = controller;
  const busy = state.stage === "checking" || state.stage === "downloading" || state.stage === "installing";

  const status = (() => {
    switch (state.stage) {
      case "checking":
        return t("settings.update.checking", { defaultValue: "正在检查…" });
      case "available":
        return t("settings.update.available", {
          defaultValue: "发现新版本 {{version}}",
          version: state.version,
        });
      case "downloading":
        return t("settings.update.downloading", { defaultValue: "正在下载…" });
      case "ready":
        return t("settings.update.ready", {
          defaultValue: "{{version}} 已下载完成，点标题栏的提示即可安装",
          version: state.version,
        });
      case "installing":
        return t("settings.update.installing", { defaultValue: "正在安装…" });
      case "error":
        return state.message;
      default:
        return t("settings.update.upToDate", { defaultValue: "已是最新版本" });
    }
  })();

  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-body text-ink-faint">
        {t("settings.update.title", { defaultValue: "应用更新" })}
      </h3>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] leading-relaxed text-ink-ghost/75">
          {t("settings.update.currentVersion", {
            defaultValue: "当前版本 {{version}}",
            version: version ?? "—",
          })}
        </span>
        {enabled === true && (
          <button
            onClick={() => void check()}
            disabled={busy}
            className="shrink-0 px-2.5 h-6 rounded-md text-[10px] border border-paper-deep/40 text-ink-soft hover:text-bamboo hover:border-bamboo/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            {t("settings.update.check", { defaultValue: "检查更新" })}
          </button>
        )}
      </div>

      {enabled === false && (
        <p className="text-[10px] leading-relaxed text-ink-ghost/75">
          {t("settings.update.notConfigured", {
            defaultValue: "未配置更新地址，自动更新未启用。",
          })}
        </p>
      )}

      {enabled === true && (
        <p
          className={`text-[10px] leading-relaxed ${
            state.stage === "error" ? "text-red-400" : "text-ink-ghost/75"
          }`}
        >
          {status}
        </p>
      )}
    </section>
  );
}
