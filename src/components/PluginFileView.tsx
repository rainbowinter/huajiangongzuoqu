import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileType } from "../features/workspace/fileTypes";
import {
  loadViewDocument,
  mergeToolbarStates,
  viewDataPlugins,
  viewToolbarFor,
} from "../features/plugins/viewAssets";
import { readThemeTokens } from "../features/plugins/themeTokens";
import { getErrorMessage, readExternalFileBytes } from "../features/notes/api";
import {
  readWorkspaceCache,
  readWorkspaceFileBytes,
  writeWorkspaceCache,
} from "../features/workspace/api";
import { PluginView, type PluginViewApi } from "./PluginView";
import { PluginViewToolbar, type ViewToolbarState } from "./PluginViewToolbar";
import { showToast } from "./Toast";

/**
 * 把插件视图接到一个具体文件上：读出视图的 srcdoc、按需喂字节、转发消息，
 * 并在预览区顶上渲染插件声明的那排工具栏控件。
 *
 * 沙箱边界在 `PluginView` 那一层（`sandbox="allow-scripts"`），这里只负责搬运。
 */

interface PluginFileViewProps {
  path: string;
  type: FileType;
}

/** 视图里的深浅色。取当前的 `data-theme`，视图自己按它调样式。 */
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function themeSnapshot(): { theme: "light" | "dark"; tokens: Record<string, string> } {
  return { theme: currentTheme(), tokens: readThemeTokens() };
}

function sameTokens(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * 跟着主题走。
 *
 * 视图是**独立文档**，用户改了深浅色 / 主题色 / 自定义颜色，它自己一点都不知道 ——
 * 那样预览区就会一直是打开时那一刻的配色。这里盯着根元素上的 `data-theme`
 * （深浅色）与 `data-accent`（主题色，两套都写在那几个属性上，见 `App.css`），
 * 一变就重新读一份调色板递给视图。
 */
function useViewTheme(): { theme: "light" | "dark"; tokens: Record<string, string> } {
  const [snapshot, setSnapshot] = useState(themeSnapshot);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setSnapshot((previous) => {
        const next = themeSnapshot();
        // 属性动过不代表颜色动过（比如 `--tab-indent-size` 也在 style 上）——
        // 值没变就别逼着整棵子树重渲染。
        return previous.theme === next.theme && sameTokens(previous.tokens, next.tokens)
          ? previous
          : next;
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent", "style"],
    });
    return () => observer.disconnect();
  }, []);

  return snapshot;
}

export function PluginFileView({ path, type }: PluginFileViewProps) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { theme, tokens } = useViewTheme();
  /**
   * 工具栏的状态由**视图**说了算，这里只是替它拿着（见 PluginViewToolbar 的文件头）。
   *
   * ⚠️ 按插件分开存：一个视图里可能同时跑着两个插件的代码，各报各的。合成一张表的话，
   * 后报的那份会把前一份整个盖掉 —— 表现是「缩放比例」这类小字忽然空了。
   * 合并是安全的：合并后的 id 不会重（`viewToolbarFor` 已经把重名的丢掉了）。
   */
  const [toolbarStates, setToolbarStates] = useState<Record<string, ViewToolbarState>>({});
  // 往视图里下命令的口子，由 PluginView 挂上来。
  const apiRef = useRef<PluginViewApi | null>(null);
  // 顶上那排控件是**基础插件与扩展插件共用**的（`viewToolbarFor` 把两边合起来）。
  const toolbarItems = viewToolbarFor(type);
  const extensionOwners = viewDataPlugins(type);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setError(null);

    void loadViewDocument(type)
      .then((loaded) => {
        if (!cancelled) setDocument(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [type]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-[12px] text-ink-ghost">
        {t("main.view.loadFailed", {
          message: error,
          defaultValue: "这个文件的视图加载失败：{{message}}",
        })}
      </div>
    );
  }

  if (!document) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-ink-ghost">
        {t("common.loading", { defaultValue: "加载中…" })}
      </div>
    );
  }

  const name = path.split(/[\\/]/).pop() ?? path;

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* 插件声明了控件才有这一排 —— 没声明就与从前一模一样，预览区直接顶到最上面。 */}
      <PluginViewToolbar
        items={toolbarItems}
        state={mergeToolbarStates(toolbarStates)}
        onCommand={(id, value) => apiRef.current?.post({ t: "command", id, value })}
      />
      <PluginView
        document={document}
        name={name}
        path={path}
        theme={theme}
        tokens={tokens}
        apiRef={apiRef}
        onState={(plugin, values, pressed) =>
          setToolbarStates((current) => ({ ...current, [plugin ?? ""]: { values, pressed } }))
        }
        // 工作区里的文件优先走工作区通道；从「打开方式」进来的不在任何工作区里，会退回外部通道。
        loadBytes={() =>
          readWorkspaceFileBytes(path).catch(() => readExternalFileBytes(path))
        }
        // 数据落在**这个文件旁边**的 `__floral-notepaper__/<插件>/…` 里（见
        // `Docs/workspace-cache.md`）：文件被拷走、发给别人时，批注跟着走。
        dataPlugins={extensionOwners}
        loadData={(plugin) => readWorkspaceCache(path, plugin)}
        onSaveData={(plugin, data) => {
          void writeWorkspaceCache(path, plugin, data).catch((error: unknown) => {
            // 写不进去得说出来：只读位置（U 盘、网盘）上用户的批注是真的会丢。
            showToast(
              t("main.view.saveDataFailed", {
                message: getErrorMessage(error),
                defaultValue: "这个位置存不了插件的批注数据：{{message}}",
              }),
            );
          });
        }}
        onToast={showToast}
        onLog={(level, message) => {
          // 视图里的日志走宿主控制台 —— 只有 error 会被 Vite 转发出来。
          if (level === "error") console.error(`[plugin-view] ${message}`);
          else if (level === "warn") console.warn(`[plugin-view] ${message}`);
          else console.info(`[plugin-view] ${message}`);
        }}
      />
    </div>
  );
}
