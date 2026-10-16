import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "../features/notes/api";
import { formatShortDate, formatTime } from "../features/notes/noteUtils";
import {
  deleteWorkspaceFile,
  listWorkspaceDir,
  listWorkspaceSubdirs,
  moveWorkspaceEntry,
  writeWorkspaceFile,
  type WorkspaceEntry,
} from "../features/workspace/api";
import {
  listFileTypes,
  matchFileType,
  subscribeFileTypes,
  type FileType,
} from "../features/workspace/fileTypes";
import { ExplorerFolderRow, ExplorerItem } from "./ExplorerItem";
import { POPUP_VIEWPORT_MARGIN, useViewportPopupPosition } from "./popupPosition";

/**
 * 一个工作文件夹的目录树。
 *
 * 几个刻意的决定：
 *
 * 1. **懒加载**：只列展开到的那一层。递归扫描碰到 `node_modules` 会把界面卡死，
 *    而且绝大多数目录用户根本不会展开。
 * 2. **默认全折叠**：只加载根目录，子目录等用户点开。
 * 3. **按已注册类型过滤**：目录一律显示，文件只显示扩展名被某个 `FileType` 认领的。
 *    没装文件读取器插件时注册表里只有内置的 Markdown 一条，所以只看得见 `.md`。
 * 4. **搜索是有预算的递归遍历**：它和懒加载是冲突的（没展开的目录没数据），所以搜索
 *    时另走一条路——按需向下遍历，但有层数与条目数上限。超限时如实提示，不假装搜完了。
 */
interface WorkspaceTreeProps {
  root: string;
  /** 当前在编辑器中打开的路径，用来给对应卡片加选中态。 */
  selectedPath: string | null;
  onOpenFile: (entry: WorkspaceEntry) => void;
}

interface LevelState {
  entries: WorkspaceEntry[];
  truncated: boolean;
}

/** 右键菜单当前处于哪一层。 */
type MenuMode = "main" | "move" | "confirm-delete";

interface EntryMenu {
  x: number;
  y: number;
  entry: WorkspaceEntry;
}

/** 把绝对路径显示成相对于根的短路径，供「移动到…」列表使用。 */
function relativeTo(root: string, path: string): string {
  return path.slice(root.length).replace(/^[\\/]+/, "") || "/";
}

/** 搜索时最多遍历多少条目录项。 */
const SEARCH_BUDGET = 3000;
/** 搜索时最多向下钻几层。 */
const SEARCH_MAX_DEPTH = 6;

function formatSize(bytes: number | null): string | undefined {
  if (bytes === null) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 取路径的最后一段，用作侧栏标题。导出是因为标题行现在挂在 MainWindow 上。 */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 侧栏副标题里的路径：太长时**从头部截**，保住尾部几段。
 *
 * 与界面上其它地方的 `truncate` 正好相反，是有意的：文件夹的重名都发生在尾部
 * （好几个项目里都有 `src`、`styles`），而头部永远是 `C:\Users\…` 这一截。
 * 交给 CSS 的 `truncate` 去截尾，剩下的恰好是最没用的那段。
 *
 * `maxLength` 由调用方按栏宽估算传入（见 MainWindow 的标题行）：估得**保守**一点，
 * 让这里先截够，别指望外面的 `truncate` 兜底 —— 那一层截的是**尾部**，恰好是刚刚
 * 特意保下来的那几段，一兜底就白保了，还会多出一个省略号。
 */
export function shortenPath(path: string, maxLength = 40): string {
  // 下限兜住极窄的栏宽：只剩一个省略号比不显示还难懂。
  const limit = Math.max(10, Math.floor(maxLength));
  if (path.length <= limit) return path;
  return `…${path.slice(1 - limit)}`;
}

/** 用根路径里出现的分隔符拼子路径 —— 前端拿不到平台信息，跟着已有路径走最稳。 */
function joinPath(dir: string, name: string): string {
  const separator = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`;
}

function extensionOf(name: string): string | null {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return null;
  return name.slice(index + 1).toLowerCase();
}

export function WorkspaceTree({ root, selectedPath, onOpenFile }: WorkspaceTreeProps) {
  const { t } = useTranslation();

  // 订阅类型注册表。这里不取返回值：要的只是「注册表变了就重渲染」这个副作用，
  // 于是插件装好之后不需要重开面板，侧栏会自己重新过滤一遍。
  useSyncExternalStore(subscribeFileTypes, listFileTypes, listFileTypes);

  const [levels, setLevels] = useState<Map<string, LevelState>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceEntry[] | null>(null);
  const [searchCapped, setSearchCapped] = useState(false);
  const [searching, setSearching] = useState(false);

  /** 非 null 时显示新建文件的输入框。 */
  const [draftName, setDraftName] = useState<string | null>(null);

  const load = useCallback(async (dir: string) => {
    setLoading((current) => new Set(current).add(dir));
    try {
      const listing = await listWorkspaceDir(dir);
      setLevels((current) =>
        new Map(current).set(dir, { entries: listing.entries, truncated: listing.truncated }),
      );
      setError(null);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading((current) => {
        const next = new Set(current);
        next.delete(dir);
        return next;
      });
    }
  }, []);

  // 换文件夹时清空整棵树的状态，否则会把上一个文件夹的展开状态带过来。
  useEffect(() => {
    setLevels(new Map());
    setExpanded(new Set());
    setError(null);
    setQuery("");
    setDraftName(null);
    void load(root);
  }, [root, load]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!levels.has(path)) void load(path);
        }
        return next;
      });
    },
    [levels, load],
  );

  // 目录一律显示；文件只显示扩展名被某个 FileType 认领的。
  const visible = (entries: WorkspaceEntry[]) =>
    entries.filter((entry) => entry.isDir || matchFileType(entry.extension) !== null);

  // ---------------------------------------------------------------- 搜索

  useEffect(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      setResults(null);
      setSearchCapped(false);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    const timer = window.setTimeout(() => {
      const found: WorkspaceEntry[] = [];
      let left = SEARCH_BUDGET;

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (left <= 0 || depth > SEARCH_MAX_DEPTH) return;

        let listing: Awaited<ReturnType<typeof listWorkspaceDir>>;
        try {
          listing = await listWorkspaceDir(dir);
        } catch {
          // 单个子目录读不了（权限、刚被删）不该让整次搜索失败。
          return;
        }
        left -= listing.entries.length;

        for (const entry of listing.entries) {
          if (entry.isDir) {
            await walk(entry.path, depth + 1);
          } else if (entry.name.toLowerCase().includes(needle) && matchFileType(entry.extension)) {
            found.push(entry);
          }
        }
      };

      void walk(root, 0).then(() => {
        if (cancelled) return;
        setResults(found);
        // 预算耗尽或触到层数上限时如实说明，别让用户以为"就这些"。
        setSearchCapped(left <= 0);
        setSearching(false);
      });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, root]);

  // ---------------------------------------------------------------- 新建文件

  const handleCreateFile = useCallback(async () => {
    if (draftName === null) return;

    const name = draftName.trim();
    if (!name) {
      setDraftName(null);
      return;
    }
    if (/[\\/]/.test(name) || name === "." || name === "..") {
      setError(t("main.workspace.invalidFileName", { defaultValue: "文件名不能包含路径分隔符" }));
      return;
    }

    const path = joinPath(root, name);
    try {
      // 已存在时会被覆盖 —— 这里刻意不拦，用户想改名重写就让他改。
      await writeWorkspaceFile(path, "");
      setDraftName(null);
      setError(null);
      await load(root);

      const type = matchFileType(extensionOf(name));
      if (!type) {
        setError(
          t("main.workspace.unrecognizedType", {
            defaultValue: "已创建，但该扩展名还没有插件认领，不会显示在列表里",
          }),
        );
        return;
      }

      onOpenFile({
        name,
        path,
        isDir: false,
        size: 0,
        modifiedAt: new Date().toISOString(),
        extension: extensionOf(name),
        preview: null,
      });
    } catch (createError) {
      setError(getErrorMessage(createError));
    }
  }, [draftName, root, load, onOpenFile, t]);

  // ---------------------------------------------------------------- 渲染

  // ---------------------------------------------------------------- 右键菜单

  const [menu, setMenu] = useState<EntryMenu | null>(null);
  const [menuMode, setMenuMode] = useState<MenuMode>("main");
  const [subdirs, setSubdirs] = useState<string[] | null>(null);
  const { popupRef, popupPosition } = useViewportPopupPosition(
    menu,
    `${menuMode}:${subdirs?.length ?? 0}`,
  );

  /**
   * 删除/移动会改变某一层的内容，而受影响的那一层未必是根目录。
   * 把**当前已加载的层**全部重取一遍：简单，且不会有漏刷新的角落。
   */
  const reloadLoadedLevels = useCallback(async () => {
    await Promise.all([...levels.keys()].map((dir) => load(dir)));
  }, [levels, load]);

  const openMenu = (event: ReactMouseEvent, entry: WorkspaceEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuMode("main");
    setSubdirs(null);
    setMenu({ x: event.clientX, y: event.clientY, entry });
  };

  // 点别处收起。监听冒泡阶段的 click，并在弹窗容器上 stopPropagation，
  // 这样菜单内部的点击不会被自己的关闭逻辑吃掉。
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  // 切到「移动到…」时才去列子目录：这一步要递归扫盘，不该在打开菜单时就付这个代价。
  useEffect(() => {
    if (menuMode !== "move" || !menu) return;
    let cancelled = false;
    void listWorkspaceSubdirs(root)
      .then((dirs) => {
        if (!cancelled) setSubdirs(dirs);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSubdirs([]);
        setError(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [menuMode, menu, root]);

  const handleDeleteEntry = useCallback(async () => {
    if (!menu) return;
    const target = menu.entry;
    setMenu(null);
    try {
      await deleteWorkspaceFile(target.path);
      await reloadLoadedLevels();
    } catch (error) {
      setError(getErrorMessage(error));
    }
  }, [menu, reloadLoadedLevels]);

  const handleMoveEntry = useCallback(
    async (targetDir: string) => {
      if (!menu) return;
      const target = menu.entry;
      setMenu(null);
      try {
        await moveWorkspaceEntry(target.path, targetDir);
        await reloadLoadedLevels();
      } catch (error) {
        setError(getErrorMessage(error));
      }
    },
    [menu, reloadLoadedLevels],
  );

  const fileCard = (entry: WorkspaceEntry, type: FileType | null, depth: number) => (
    <ExplorerItem
      key={entry.path}
      inset
      title={entry.name}
      badge={type?.badge ?? null}
      accent={type?.color ?? null}
      meta={entry.modifiedAt ? formatShortDate(entry.modifiedAt) : undefined}
      subtitle={entry.preview ?? undefined}
      subtitleLines={1}
      details={[
        entry.modifiedAt ? formatTime(entry.modifiedAt) : "",
        formatSize(entry.size) ?? "",
      ].filter(Boolean)}
      selected={entry.path === selectedPath}
      onSelect={() => onOpenFile(entry)}
      onContextMenu={(event) => openMenu(event, entry)}
      depth={depth}
    />
  );

  const renderLevel = (dir: string, depth: number) => {
    const level = levels.get(dir);
    if (!level) return null;

    const entries = visible(level.entries);
    if (entries.length === 0) {
      return (
        <p
          className="py-2 text-[11px] text-ink-ghost leading-relaxed"
          style={{ paddingLeft: 12 + depth * 12 }}
        >
          {t("main.workspace.emptyLevel", { defaultValue: "没有可显示的文件" })}
        </p>
      );
    }

    return entries.map((entry) => {
      if (!entry.isDir) {
        return fileCard(entry, matchFileType(entry.extension), depth);
      }

      const isOpen = expanded.has(entry.path);
      const childLevel = levels.get(entry.path);
      return (
        <div key={entry.path}>
          <ExplorerFolderRow
            name={entry.name}
            open={isOpen}
            depth={depth}
            count={childLevel ? visible(childLevel.entries).length : undefined}
            onToggle={() => toggleDir(entry.path)}
          />
          {isOpen ? renderLevel(entry.path, depth + 1) : null}
        </div>
      );
    });
  };

  const rootLevel = levels.get(root);
  const isLoadingRoot = loading.has(root);

  return (
    <div className="workspace-tree flex flex-col min-h-0 flex-1">
      {/* 搜索与新建：与笔记面板保持同一套观感 */}
      <div className="px-3 pb-2 shrink-0 space-y-1">
        <div className="flex items-center gap-2 px-2.5 h-8 rounded-lg bg-paper-warm/80 border border-paper-deep/40 focus-within:border-bamboo/30 focus-within:bg-cloud transition-all">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="text-ink-ghost shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("main.workspace.searchPlaceholder", { defaultValue: "搜索文件…" })}
            className="flex-1 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              className="text-ink-ghost hover:text-ink-faint transition-colors cursor-pointer"
              title={t("main.sidebar.clearSearch", { defaultValue: "清空搜索" })}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>

        {draftName === null ? (
          <button
            onClick={() => setDraftName("未命名.md")}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-bamboo hover:bg-bamboo-mist/60 transition-all cursor-pointer"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t("main.workspace.newFile", { defaultValue: "新建文件" })}
          </button>
        ) : (
          <input
            type="text"
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") void handleCreateFile();
              if (event.key === "Escape") setDraftName(null);
            }}
            onBlur={() => setDraftName(null)}
            placeholder={t("main.workspace.newFilePlaceholder", {
              defaultValue: "文件名（含扩展名）",
            })}
            className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/80 border border-bamboo/30 text-[12px] font-body text-ink outline-none"
          />
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-hidden pb-4">
        {error ? (
          <p className="px-3 py-2 text-[11px] text-ink-ghost leading-relaxed">{error}</p>
        ) : null}

        {results !== null ? (
          <>
            {searching ? (
              <p className="px-3 py-2 text-[11px] text-ink-ghost">
                {t("main.workspace.searching", { defaultValue: "搜索中…" })}
              </p>
            ) : results.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-ink-ghost leading-relaxed">
                {t("main.workspace.noResults", { defaultValue: "没有匹配的文件" })}
              </p>
            ) : (
              <>
                {results.map((entry) => fileCard(entry, matchFileType(entry.extension), 0))}
                {searchCapped ? (
                  <p className="px-3 py-2 text-[10px] text-ink-ghost/70 leading-relaxed">
                    {t("main.workspace.searchCapped", {
                      defaultValue: "文件过多，搜索只覆盖了一部分目录",
                    })}
                  </p>
                ) : null}
              </>
            )}
          </>
        ) : isLoadingRoot && !rootLevel ? (
          <p className="px-3 py-3 text-[11px] text-ink-ghost">
            {t("common.loading", { defaultValue: "载入中…" })}
          </p>
        ) : rootLevel ? (
          <>
            {renderLevel(root, 0)}
            {rootLevel.truncated ? (
              <p className="px-3 py-2 text-[10px] text-ink-ghost/70 leading-relaxed">
                {t("main.workspace.truncated", { defaultValue: "条目过多，仅显示前一部分" })}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {menu ? (
        <div
          ref={popupRef}
          className="popup-menu fixed z-[9999] min-w-[168px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none animate-menu-enter"
          style={{
            left: popupPosition?.x ?? menu.x,
            top: popupPosition?.y ?? menu.y,
            maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {menuMode === "main" ? (
            <>
              <button
                onClick={() => setMenuMode("move")}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.workspace.moveTo", { defaultValue: "移动到…" })}
              </button>
              <button
                onClick={() => setMenuMode("confirm-delete")}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer border-t border-paper-deep/20"
              >
                {t("main.workspace.deleteFile", { defaultValue: "删除文件" })}
              </button>
            </>
          ) : menuMode === "confirm-delete" ? (
            <>
              <p className="px-3 py-1.5 text-[11px] text-ink-ghost break-all">{menu.entry.name}</p>
              <button
                onClick={() => void handleDeleteEntry()}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer border-t border-paper-deep/20"
              >
                {t("main.workspace.confirmDelete", { defaultValue: "确认删除（不可恢复）" })}
              </button>
              <button
                onClick={() => setMenuMode("main")}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-faint hover:bg-paper-warm transition-colors cursor-pointer border-t border-paper-deep/20"
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setMenuMode("main")}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body text-ink-ghost hover:bg-paper-warm transition-colors cursor-pointer border-b border-paper-deep/20"
              >
                <span>←</span>
                <span>{t("common.back", { defaultValue: "返回" })}</span>
              </button>
              <button
                onClick={() => void handleMoveEntry(root)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.workspace.moveToRoot", { defaultValue: "根目录" })}
              </button>
              {subdirs === null ? (
                <p className="px-3 py-1.5 text-[11px] text-ink-ghost">
                  {t("common.loading", { defaultValue: "载入中…" })}
                </p>
              ) : (
                subdirs.map((dir) => (
                  <button
                    key={dir}
                    onClick={() => void handleMoveEntry(dir)}
                    className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer truncate"
                  >
                    {relativeTo(root, dir)}
                  </button>
                ))
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
