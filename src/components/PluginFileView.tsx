import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileType } from "../features/workspace/fileTypes";
import {
  loadViewDocument,
  mergeToolbarStates,
  ownerOfFileType,
  viewDataPlugins,
  viewToolbarFor,
  viewToolbarIcons,
} from "../features/plugins/viewAssets";
import { usePluginIcons } from "../features/plugins/usePluginIcons";
import { setActiveViewCommandSink } from "../features/plugins/activeView";
import { readThemeTokens } from "../features/plugins/themeTokens";
import { getErrorMessage, readExternalFileBytes, saveExternalFileBytes } from "../features/notes/api";
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

/**
 * 一次最多读几个图标。工具栏一共也就 24 项，超出的部分多半是插件在刷声明。
 */
const MAX_TOOLBAR_ICONS = 32;

/**
 * 把这一排要用的图标读进来。
 *
 * 每项一条 `readPluginAsset`，读的是**声明它的那个插件**目录下的文件（扩展插件的图标在它
 * 自己那儿）。读不到、不是 SVG、消毒后什么都不剩 —— 都只是「这一项没有图标」，
 * 不报错也不提示：图标是加法，不该因为它让整个工具栏出不来。
 *
 * 读与消毒都在 `loadPluginIcon` 里（渲染那一层用的是 `dangerouslySetInnerHTML`，
 * 边界就在那个函数里，别把没消毒的东西传下去）。
 */
function useToolbarIcons(type: FileType): Map<string, string> {
  // 顺手限个量：一屏几十个图标已经夸张了，再多一定是声明写歪了。
  const requests = useMemo(
    () => viewToolbarIcons(type).slice(0, MAX_TOOLBAR_ICONS),
    [type],
  );
  return usePluginIcons(requests);
}

/** 从文件名里取扩展名（给保存对话框的过滤器用）。取不到就让调用方兜底。 */
function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return match ? match[1].toLowerCase() : "";
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
  const toolbarIcons = useToolbarIcons(type);
  const extensionOwners = viewDataPlugins(type);
  // 插件面板要往**自己这个**视图发命令时，宿主靠它把跨插件的命令挡掉。
  const viewOwner = ownerOfFileType(type.id) ?? "";

  /**
   * 把「往视图里发命令」这个口子交给宿主顶上那一行。
   *
   * 文档级动作（「导出批注」这种）在**主窗口顶部**，而它的实现在帧里，只有这里拿得到
   * `post`。挂载时就交出去、卸载时收回 —— 不收的话那个口子会指向一个已经拆掉的 iframe，
   * 点按钮静默无反应。
   */
  useEffect(() => {
    setActiveViewCommandSink({
      owner: viewOwner,
      post: (commandId, value) => {
        apiRef.current?.post({ t: "command", id: commandId, value });
      },
    });
    return () => setActiveViewCommandSink(null);
  }, [viewOwner]);

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
    <div className="plugin-view flex-1 flex flex-col min-h-0 min-w-0">
      {/* 插件声明了控件才有这一排 —— 没声明就与从前一模一样，预览区直接顶到最上面。 */}
      <PluginViewToolbar
        items={toolbarItems}
        icons={toolbarIcons}
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
        onSaveFile={(name, bytes) => {
          // 「另存为带批注的 PDF」这条路：**弹的是原生保存对话框**，路径由用户挑。
          // 插件拿不到路径，也写不了别的地方 —— 这是导出，不是「插件能写文件」。
          void (async () => {
            const { save } = await import("@tauri-apps/plugin-dialog");
            const path = await save({
              defaultPath: name,
              filters: [{ name: "文件", extensions: [extensionOf(name) || "pdf"] }],
            });
            if (typeof path !== "string") return;
            try {
              await saveExternalFileBytes(path, bytes);
              showToast(
                t("main.view.savedFile", {
                  path,
                  defaultValue: "已保存到 {{path}}",
                }),
                "info",
              );
            } catch (error) {
              showToast(
                t("main.view.saveFileFailed", {
                  message: getErrorMessage(error),
                  defaultValue: "存不了这个文件：{{message}}",
                }),
              );
            }
          })();
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
