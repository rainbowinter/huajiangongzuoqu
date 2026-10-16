import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  listGlobalStyles,
  openStylesDir,
  refreshGlobalStyles,
  stylesDirPath,
  subscribeGlobalStyles,
  toggleStyleForFile,
  toggleStyleGlobal,
  type StyleSheet,
} from "../features/styles/globalStyles";
import { showToast } from "./Toast";
import { Switch } from "./Switch";

/**
 * 右侧栏的「样式」面板 —— 全局样式表（`<数据目录>/styles/`）的**主控台**。
 *
 * 三件事，正好对上文件的那三种状态：
 *
 * 1. 告诉你文件夹在哪（「打开文件夹」）；
 * 2. **每份样式表一个「全局」开关** —— `custom.css` 那颗钉死常开，别的默认关着；
 * 3. **当前打开的文件**可以单独挂几份（换个文件就换一套），配完立刻生效。
 *
 * 判据全在 Rust（`styles::applied_names`），这里只画开关 —— 前端**不再算第二遍**，
 * 两套规则迟早不一致。所以清单里的 `applied` / `global` / `locked` 都是后端给的。
 *
 * 正常情况下不用点「重新加载」：Rust 每两秒轮询一次，改完保存自己就生效了。
 */
interface StylesPanelProps {
  onClose: () => void;
  /**
   * 当前打开的文件标识（外部文件绝对路径 / 笔记 id），没打开就传 `null`。
   *
   * 与插件面板、工作区缓存同一个 key —— 由 `MainWindow` 算好传进来，这里不自己猜：
   * 「现在打开的是谁」只有它知道。
   */
  fileKey: string | null;
  /** 给用户看的文件名（当前文件那一节的标题）。`fileKey` 有值时才有意义。 */
  fileLabel: string | null;
}

export function StylesPanel({ onClose, fileKey, fileLabel }: StylesPanelProps) {
  const { t } = useTranslation();
  const sheets = useSyncExternalStore(subscribeGlobalStyles, listGlobalStyles, listGlobalStyles);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

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

  /** 翻一个开关。`key` 是这一行的身份（文件名，或 「global:文件名」），用来只禁用被点的那颗。 */
  const flip = useCallback(
    (key: string, action: () => Promise<void>) => {
      setBusy(key);
      void action()
        .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)))
        .finally(() => setBusy(null));
    },
    [],
  );

  const applied = sheets.filter((sheet) => sheet.applied).length;

  return (
    <div className="styles-panel w-full h-full flex flex-col bg-cloud/92 backdrop-blur-sm">
      <div className="side-panel-header px-4 pt-3 pb-2 flex items-center justify-between shrink-0 border-b border-paper-deep/20">
        <span className="side-panel-title text-[13px] font-medium text-ink">
          {t("main.window.styles", { defaultValue: "样式" })}
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
              "custom.css 永远生效；同目录里其它的 .css 默认不生效 —— 在这里开成全局，或者挂到某一个打开的文件上。改完保存约两秒自动套用。",
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
            title={t("settings.styles.reloadHint", { defaultValue: "外部编辑器改过之后手动兜底" })}
          >
            {t("settings.styles.reload", { defaultValue: "重新加载" })}
          </button>
        </div>

        {/* 全局那一段 */}
        <div className="mt-4 flex items-baseline justify-between">
          <span className="text-[10.5px] font-mono uppercase tracking-wider text-ink-ghost/80">
            {t("settings.styles.globalSection", { defaultValue: "全局" })}
          </span>
          <span className="text-[10px] text-ink-ghost/70 font-mono tabular-nums">
            {t("settings.styles.active", {
              count: applied,
              defaultValue: "当前生效 {{count}} 份",
            })}
          </span>
        </div>

        {sheets.length === 0 ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-ghost/70">
            {t("settings.styles.empty", {
              defaultValue: "文件夹里还没有样式表。丢一份 .css 进去再点「重新加载」。",
            })}
          </p>
        ) : (
          <ul className="mt-1.5 rounded-lg bg-paper-warm/50 divide-y divide-paper-deep/25">
            {sheets.map((sheet) => (
              <SheetRow
                key={sheet.name}
                sheet={sheet}
                checked={sheet.global}
                busy={busy === `global:${sheet.name}`}
                onToggle={(next) =>
                  flip(`global:${sheet.name}`, () => toggleStyleGlobal(sheet.name, next))
                }
                trailing={
                  sheet.locked ? (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-md text-[9px] text-bamboo bg-bamboo-mist/50"
                      title={t("settings.styles.lockedHint", {
                        defaultValue: "常开：它就是花笺的主样式表，不想用它就把文件改名",
                      })}
                    >
                      {t("settings.styles.locked", { defaultValue: "常开" })}
                    </span>
                  ) : null
                }
              />
            ))}
          </ul>
        )}

        {/* 当前文件那一段 */}
        <div className="mt-5 pt-3 border-t border-paper-deep/20">
          <span className="text-[10.5px] font-mono uppercase tracking-wider text-ink-ghost/80">
            {t("settings.styles.fileSection", { defaultValue: "当前文件" })}
          </span>
          {fileKey ? (
            <>
              <p
                className="mt-1.5 text-[11px] text-ink-soft truncate"
                title={fileKey}
              >
                {fileLabel || fileKey}
              </p>
              <p className="text-[10px] leading-relaxed text-ink-ghost/70 mt-0.5">
                {t("settings.styles.fileHint", {
                  defaultValue: "下面开着的只作用于这个文件，换一个文件就是另一套。",
                })}
              </p>
              <ul className="mt-1.5 rounded-lg bg-paper-warm/50 divide-y divide-paper-deep/25">
                {sheets.map((sheet) => (
                  <SheetRow
                    key={sheet.name}
                    sheet={sheet}
                    checked={sheet.bound}
                    // 常开那份不必挂：它本来就全局生效，挂到某个文件上没有任何额外效果。
                    disabled={sheet.locked}
                    busy={busy === `file:${sheet.name}`}
                    onToggle={(next) =>
                      flip(`file:${sheet.name}`, () =>
                        toggleStyleForFile(fileKey, sheet.name, next),
                      )
                    }
                    trailing={
                      sheet.locked ? (
                        <span className="shrink-0 text-[9px] text-ink-ghost/60">
                          {t("settings.styles.alwaysOn", { defaultValue: "本来就生效" })}
                        </span>
                      ) : null
                    }
                  />
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-ghost/70">
              {t("settings.styles.noFile", {
                defaultValue: "现在没有打开任何文件。打开一个之后，可以在这里给它单独挂样式。",
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 清单里的一行：文件名 + 一颗开关（右边可以再挂一小块说明）。
 *
 * `checked` **由调用方给**：两段的判据不一样 —— 「全局」那一段看 `sheet.global`，
 * 「当前文件」那一段要的是 `sheet.bound`（挂没挂上）。在这里默认用 `global` 的话，
 * 一份既全局开着、又挂在这个文件上的样式表，从文件上摘掉之后开关看着没动。
 */
function SheetRow({
  sheet,
  checked,
  busy,
  disabled = false,
  trailing,
  onToggle,
}: {
  sheet: StyleSheet;
  checked: boolean;
  busy: boolean;
  disabled?: boolean;
  trailing: React.ReactNode;
  onToggle: (next: boolean) => void;
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-1.5" title={sheet.name}>
      <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-ink-soft">
        {sheet.name}
      </span>
      {trailing}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={busy || disabled}
        aria-label={sheet.name}
        onClick={() => onToggle(!checked)}
        className="shrink-0 disabled:opacity-40 disabled:cursor-default cursor-pointer"
      >
        <Switch checked={checked} />
      </button>
    </li>
  );
}
