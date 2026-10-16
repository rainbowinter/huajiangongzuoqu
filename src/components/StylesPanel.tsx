import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  listGlobalStyles,
  openStylesDir,
  refreshGlobalStyles,
  stylesDirPath,
  subscribeGlobalStyles,
} from "../features/styles/globalStyles";
import { showToast } from "./Toast";

/**
 * 右侧栏的「样式」面板 —— 全局样式表（`<数据目录>/styles/*.css`）的只读视图。
 *
 * **没有开关**：目录里有哪几份，就有哪几份生效。所以这里只干三件事 —— 告诉你文件
 * 放哪儿、现在生效的是哪几份、以及一个「重新加载」当兜底（正常情况下不用点：
 * Rust 那边每两秒轮询一次，改完保存就自己生效了）。
 *
 * 完整的说明与例子在「设置 → 外观 → 界面样式」，以及 `<样式目录>/custom.css` 的注释里。
 */
export function StylesPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const sheets = useSyncExternalStore(subscribeGlobalStyles, listGlobalStyles);
  const [dir, setDir] = useState("");

  useEffect(() => {
    stylesDirPath()
      .then(setDir)
      .catch(() => {});
  }, []);

  const handleOpen = useCallback(() => {
    openStylesDir()
      .then(setDir)
      .catch((error: unknown) => showToast(String(error)));
  }, []);

  return (
    <div className="styles-panel w-full h-full flex flex-col bg-cloud/92 backdrop-blur-sm">
      <div className="side-panel-header px-4 pt-3 pb-2 flex items-center justify-between shrink-0 border-b border-paper-deep/20">
        <span className="side-panel-title text-[13px] font-medium text-ink">
          {t("main.styles.title", { defaultValue: "样式" })}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="side-panel-close w-6 h-6 flex items-center justify-center rounded-md text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
          title={t("common.close", { defaultValue: "关闭" })}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="side-panel-body flex-1 overflow-y-auto px-4 py-3">
        <p className="text-[10px] leading-relaxed text-ink-ghost/75">
          {t("settings.styles.hint", {
            defaultValue:
              "下面这个文件夹里的每一份 .css 都生效，没有开关。改完保存约两秒后自动套用。",
          })}
        </p>

        <div className="flex gap-2 mt-3">
          <input
            type="text"
            value={dir}
            readOnly
            title={dir}
            className="min-w-0 flex-1 h-7 px-2 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[10px] font-mono text-ink-faint truncate"
          />
          <button
            type="button"
            onClick={handleOpen}
            className="shrink-0 h-7 px-2.5 rounded-lg border border-paper-deep/45 text-[10px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
          >
            {t("settings.styles.openFolder", { defaultValue: "打开文件夹" })}
          </button>
          <button
            type="button"
            onClick={() => void refreshGlobalStyles(true)}
            className="shrink-0 h-7 px-2.5 rounded-lg border border-paper-deep/45 text-[10px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
          >
            {t("settings.styles.reload", { defaultValue: "重新加载" })}
          </button>
        </div>

        <div className="mt-4 text-[10.5px] font-mono uppercase tracking-wider text-ink-ghost/80 mb-1.5">
          {t("settings.styles.active", {
            count: sheets.length,
            defaultValue: "当前生效 {{count}} 份",
          })}
        </div>

        {sheets.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-ink-ghost/70">
            {t("settings.styles.empty", {
              defaultValue: "文件夹里还没有样式表。丢一份 .css 进去就会生效。",
            })}
          </p>
        ) : (
          <ul className="rounded-lg bg-paper-warm/50 divide-y divide-paper-deep/25">
            {sheets.map((sheet) => (
              <li key={sheet.name} className="flex items-center gap-3 px-3 py-2" title={sheet.name}>
                <span className="text-[11px] font-mono text-ink-soft truncate">{sheet.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
