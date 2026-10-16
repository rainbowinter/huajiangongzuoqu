import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  listGlobalStyles,
  openStylesDir,
  refreshGlobalStyles,
  stylesDirPath,
  subscribeGlobalStyles,
  type StyleSheet,
} from "../features/styles/globalStyles";
import { showToast } from "./Toast";

/** 把字节数缩成一眼能读的大小。样式表都很小，KB 就够。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 「设置 → 外观 → 界面样式」那一节。
 *
 * 这里**刻意没有任何开关**：目录里的每一份 `.css` 都生效，想让它不生效就把文件移走。
 * 于是这一节要回答的问题只剩两个 —— 「文件放哪儿」和「现在生效的是哪几份」。
 *
 * ⚠️ 清单走 `useSyncExternalStore`：`listGlobalStyles` 的快照是**稳定引用**，
 * 只有内容真的变了才换（见 `globalStyles.ts` 的说明）。直接 `useState` + 挂载时读一次
 * 是不行的 —— 用户在外部编辑器里加了一份文件、Rust 轮询广播过来时，这里就看不到。
 */
export function GlobalStylesSection() {
  const { t } = useTranslation();
  const sheets = useSyncExternalStore(subscribeGlobalStyles, listGlobalStyles);
  const [dir, setDir] = useState("");
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    stylesDirPath()
      .then(setDir)
      // 拿不到路径不是致命问题：清单与按钮都还在，只是那一行显示为空。
      .catch(() => {});
  }, []);

  const handleOpen = useCallback(() => {
    openStylesDir()
      .then(setDir)
      .catch((error: unknown) => showToast(String(error)));
  }, []);

  const handleReload = useCallback(() => {
    setReloading(true);
    // `force = true`：内容其实没动时也重注入一遍，好让这个按钮点下去有反馈。
    void refreshGlobalStyles(true).finally(() => {
      // 留一小会儿再恢复，否则按钮字还没看清就变回去了。
      window.setTimeout(() => setReloading(false), 1200);
    });
  }, []);

  return (
    <section className="settings-section space-y-2">
      <label className="block text-[11px] font-body text-ink-faint">
        {t("settings.styles.title", { defaultValue: "界面样式" })}
      </label>
      <p className="text-[10px] leading-relaxed text-ink-ghost/75">
        {t("settings.styles.hint", {
          defaultValue:
            "这个文件夹里的每一份 .css 都会套用到花笺的每个窗口，没有开关 —— 不想让它生效就把文件移走。改完保存，约两秒后自动生效。",
        })}
      </p>

      <div className="flex gap-2">
        <input
          type="text"
          value={dir}
          readOnly
          title={dir}
          className="min-w-0 flex-1 h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-faint truncate"
        />
        <button
          type="button"
          onClick={handleOpen}
          className="shrink-0 h-8 px-3 rounded-lg border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
        >
          {t("settings.styles.openFolder", { defaultValue: "打开文件夹" })}
        </button>
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-[10px] text-ink-ghost font-mono">
          {t("settings.styles.active", {
            count: sheets.length,
            defaultValue: "当前生效 {{count}} 份",
          })}
        </span>
        <button
          type="button"
          onClick={handleReload}
          className="text-[10px] text-ink-ghost hover:text-bamboo transition-colors cursor-pointer"
        >
          {reloading
            ? t("settings.styles.reloaded", { defaultValue: "已重新加载" })
            : t("settings.styles.reload", { defaultValue: "重新加载" })}
        </button>
      </div>

      {sheets.length === 0 ? (
        <p className="text-[10px] leading-relaxed text-ink-ghost/70">
          {t("settings.styles.empty", {
            defaultValue: "文件夹里还没有样式表。丢一份 .css 进去，两秒后它就生效了。",
          })}
        </p>
      ) : (
        <ul className="space-y-1">
          {sheets.map((sheet: StyleSheet) => (
            <li
              key={sheet.name}
              className="settings-row flex items-center justify-between gap-2 px-2.5 h-7 rounded-lg bg-paper-warm/60"
              title={sheet.name}
            >
              <span className="min-w-0 truncate text-[11px] font-body text-ink-soft">
                {sheet.name}
              </span>
              <span className="shrink-0 text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                {formatSize(sheet.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
