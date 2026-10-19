import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useTranslation } from "react-i18next";
import { copyFilePaths, readClipboardFiles } from "../features/clipboard/api";
import { getErrorMessage } from "../features/notes/api";
import { formatShortDate, formatTime } from "../features/notes/noteUtils";
import { openWithSystemApp, showSystemProperties } from "../features/system/api";
import {
  copyWorkspaceEntries,
  deleteWorkspaceEntries,
  listWorkspaceDir,
  moveWorkspaceEntries,
  renameWorkspaceEntry,
  writeWorkspaceFile,
  type WorkspaceEntry,
} from "../features/workspace/api";
import { setWorkspaceDropHandler } from "../features/workspace/dropBridge";
import { startFileDragOut } from "../features/workspace/dragOut";
import {
  listFileTypes,
  matchFileType,
  subscribeFileTypes,
  type FileType,
} from "../features/workspace/fileTypes";
import {
  expandAncestors,
  filterExpandedPaths,
  readDisplayMode,
  readExpanded,
  writeDisplayMode,
  writeExpanded,
  type TreeDisplayMode,
} from "../features/workspace/treePrefs";
import { ExplorerFolderRow, ExplorerItem } from "./ExplorerItem";
import { FileKindIcon } from "./FileKindIcon";
import { Modal, ModalActions } from "./Modal";
import { POPUP_VIEWPORT_MARGIN, useViewportPopupPosition } from "./popupPosition";
import { showToast } from "./Toast";
import { WorkspaceFolderPicker } from "./WorkspaceFolderPicker";

/**
 * 一个工作文件夹的目录树。
 *
 * 几个刻意的决定：
 *
 * 1. **懒加载**：只列展开到的那一层。递归扫描碰到 `node_modules` 会把界面卡死，
 *    而且绝大多数目录用户根本不会展开。
 * 2. **展开状态与显示方式按根记忆**（`treePrefs.ts`）：组件会被 `key={root}` 重挂，
 *    状态不能只活在组件里。
 * 3. **按已注册类型过滤**：目录一律显示，文件只显示扩展名被某个 `FileType` 认领的。
 * 4. **像资源管理器**：Ctrl/Shift 多选、空白处拖拽框选、右键批量操作、拖入/粘贴复制。
 */
interface WorkspaceTreeProps {
  root: string;
  /** 当前在编辑器中打开的路径，用来给对应卡片加选中态。 */
  selectedPath: string | null;
  onOpenFile: (entry: WorkspaceEntry, options?: { newTab?: boolean }) => void;
  /** 重命名成功后通知宿主：如果这个文件正开着，要把路径一起改掉。 */
  onPathRenamed?: (oldPath: string, newPath: string) => void;
  /** 删除成功后通知宿主：删掉的文件（或文件夹里）的标签要一起关掉。 */
  onPathsRemoved?: (paths: string[]) => void;
  /** 移动成功后通知宿主：打开中的文件路径跟着改。 */
  onPathsMoved?: (moves: Array<{ from: string; to: string }>) => void;
  /**
   * 正在拖侧栏边框。为 `true` 时**图片缩略图先换成类型图标**，松手后再挂回 `<img>`。
   *
   * 图片多的目录里，每改一次宽度浏览器都要重新采样、绘制几十上百张缩略图，拖动会
   * 明显卡顿。宽度先跟手走，图片等松手再渲染 —— 这就是「先流畅变化，再渲染图片」。
   */
  resizing?: boolean;
}

interface LevelState {
  entries: WorkspaceEntry[];
  truncated: boolean;
}

interface EntryMenu {
  x: number;
  y: number;
  entry: WorkspaceEntry;
}

/** 行内新建 / 重命名的草稿。 */
interface DraftState {
  kind: "create" | "rename";
  /** 新建的目标目录 / 重命名的父目录。 */
  dir: string;
  /** 重命名的原路径。 */
  path?: string;
  value: string;
  error: string | null;
}

type PendingAction =
  | { kind: "delete"; paths: string[] }
  | { kind: "copyIn"; sources: string[]; targetDir: string };

interface PickerState {
  sources: string[];
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

export function extensionOf(name: string): string | null {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return null;
  return name.slice(index + 1).toLowerCase();
}

/** 取一个路径的父目录（保留原分隔符风格）。 */
export function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : path;
}

/**
 * 「新建文件」默认落在哪个目录。
 *
 * 优先跟着**当前打开的文件**走（用户就在那个目录里做事）；打开的不是这个工作区里的
 * 文件时退回根目录。用户点过某个文件夹之后 `focusedDir` 会被显式改写，不再跟文件走。
 */
function initialFocusedDir(root: string, selectedPath: string | null): string {
  if (!selectedPath) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  if (!selectedPath.startsWith(prefix)) return root;
  const parent = dirOf(selectedPath);
  return parent.startsWith(root) ? parent : root;
}

/** 文件名能不能用：字符与扩展名两道。返回错误文案，合法时返回 `null`。 */
export function validateDraftName(value: string): string | null {
  const name = value.trim();
  if (!name) return "文件名不能为空";
  if (name === "." || name === "..") return "文件名不能是 . 或 ..";
  if (name.includes("/") || name.includes("\\")) return "文件名不能包含路径分隔符";
  if (name.endsWith(" ") || name.endsWith(".")) return "文件名不能以空格或点结尾";
  if (!matchFileType(extensionOf(name))) {
    return "这个格式没有插件认领，请换一个扩展名（如 .md / .txt）";
  }
  return null;
}

/**
 * 批量操作前去掉「祖先已经被选中」的后代。
 *
 * 一个文件夹已经包含子树；再单独处理里面的文件会变成「删两次 / 目标已存在」。
 */
export function collapseSelectedPaths(
  root: string,
  paths: string[],
  dirs: ReadonlySet<string>,
): string[] {
  const separator = root.includes("\\") ? "\\" : "/";
  const sorted = [...new Set(paths)].sort();
  return sorted.filter(
    (path) =>
      !sorted.some(
        (other) =>
          other !== path &&
          dirs.has(other) &&
          path.startsWith(`${other}${separator}`),
      ),
  );
}

/**
 * 行内新建 / 重命名的输入卡片。
 *
 * 刻意**不画类型图标**：这一行的任务只是「把名字敲对」，多一个图标反而让输入框
 * 变窄；新建成功后真正的卡片会带着图标出现。
 */
function ExplorerDraftRow({
  value,
  error,
  depth,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  error: string | null;
  depth: number;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="explorer-draft-row px-1 py-0.5" style={{ marginLeft: 4 + depth * 12 }}>
      <input
        autoFocus
        type="text"
        value={value}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        className="explorer-draft w-full h-7 px-2 rounded-md bg-paper-warm/90 border border-bamboo/40 text-[12px] font-body text-ink outline-none focus:border-bamboo"
      />
      {error ? (
        <p className="explorer-draft-error mt-1 px-1 text-[10px] text-red-400 leading-snug">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function WorkspaceTree({
  root,
  selectedPath,
  onOpenFile,
  onPathRenamed,
  onPathsRemoved,
  onPathsMoved,
  resizing = false,
}: WorkspaceTreeProps) {
  const { t } = useTranslation();

  // 订阅类型注册表。返回值也留着：框选/扁平列表要用同一份过滤结果。
  const fileTypes = useSyncExternalStore(subscribeFileTypes, listFileTypes, listFileTypes);

  const [levels, setLevels] = useState<Map<string, LevelState>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    expandAncestors(root, filterExpandedPaths(root, readExpanded(root))),
  );
  const [displayMode, setDisplayMode] = useState<TreeDisplayMode>(() =>
    readDisplayMode(root),
  );
  const [focusedDir, setFocusedDir] = useState<string>(() =>
    initialFocusedDir(root, selectedPath),
  );
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceEntry[] | null>(null);
  const [searchCapped, setSearchCapped] = useState(false);
  const [searching, setSearching] = useState(false);

  const [draft, setDraft] = useState<DraftState | null>(null);

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;
  const selectionAnchorRef = useRef<string | null>(null);
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);

  const focusedDirRef = useRef(focusedDir);
  focusedDirRef.current = focusedDir;

  const [menu, setMenu] = useState<EntryMenu | null>(null);
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null);
  const { popupRef: menuRef, popupPosition: menuPosition } = useViewportPopupPosition(
    menu,
    `${selectedPaths.size}:${menu?.entry.path ?? ""}`,
  );
  const { popupRef: viewMenuRef, popupPosition: viewMenuPosition } =
    useViewportPopupPosition(viewMenu, displayMode);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<PickerState | null>(null);

  // ---------------------------------------------------------------- 载入

  const load = useCallback(async (dir: string): Promise<boolean> => {
    setLoading((current) => new Set(current).add(dir));
    try {
      const listing = await listWorkspaceDir(dir);
      setLevels((current) =>
        new Map(current).set(dir, { entries: listing.entries, truncated: listing.truncated }),
      );
      setError(null);
      return true;
    } catch (loadError) {
      setError(getErrorMessage(loadError));
      return false;
    } finally {
      setLoading((current) => {
        const next = new Set(current);
        next.delete(dir);
        return next;
      });
    }
  }, []);

  // 换文件夹时重建状态，并从 localStorage 恢复这个根上次展开到哪几层。
  // 祖先目录要一起补上，否则深层路径没有父级渲染、永远看不见。
  useEffect(() => {
    setLevels(new Map());
    setError(null);
    setQuery("");
    setDraft(null);
    setSelectedPaths(new Set());
    selectionAnchorRef.current = null;

    const restored = expandAncestors(root, filterExpandedPaths(root, readExpanded(root)));
    setExpanded(restored);
    setDisplayMode(readDisplayMode(root));
    setFocusedDir(initialFocusedDir(root, selectedPath));

    void (async () => {
      await load(root);
      for (const path of restored) {
        const loaded = await load(path);
        if (!loaded) {
          // 这个目录在两次运行之间被删了 / 改名了：从展开集合里摘掉，别让
          // 用户看到一条「路径不存在」的错误。
          setExpanded((current) => {
            if (!current.has(path)) return current;
            const next = new Set(current);
            next.delete(path);
            return next;
          });
          setError(null);
        }
      }
    })();
    // `selectedPath` 只用来算初始焦点，之后由下面的 effect 单独跟随。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, load]);

  // 展开状态一变就写回。初始化时写回的是刚从存储里读出来的同一份，不会丢。
  useEffect(() => {
    writeExpanded(root, expanded);
  }, [root, expanded]);

  // 「新建文件」默认跟着当前打开的文件走；用户点过文件夹之后这里会改写它。
  useEffect(() => {
    if (!selectedPath) return;
    const separator = root.includes("\\") ? "\\" : "/";
    const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
    if (selectedPath.startsWith(prefix)) setFocusedDir(dirOf(selectedPath));
  }, [root, selectedPath]);

  // 点别处收起草稿。用 mousedown 而不是输入框的 onBlur：窗口失焦（Alt+Tab）
  // 也会触发 blur，那一会儿输入框还是空的，按 blur 取消会把用户刚敲的名字吞掉。
  useEffect(() => {
    if (!draft) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".explorer-draft-row")) return;
      setDraft(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [draft]);

  const reloadLoadedLevels = useCallback(async () => {
    await Promise.all([...levels.keys()].map((dir) => load(dir)));
  }, [levels, load]);

  // ---------------------------------------------------------------- 展开 / 视图

  const visible = useCallback(
    (entries: WorkspaceEntry[]) =>
      entries.filter((entry) => entry.isDir || matchFileType(entry.extension) !== null),
    // 注册表变化时重算（`fileTypes` 只是为了让依赖成立）。
    [fileTypes],
  );

  const toggleDir = useCallback(
    (path: string) => {
      setFocusedDir(path);
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

  const setViewMode = useCallback(
    (mode: TreeDisplayMode) => {
      setDisplayMode(mode);
      writeDisplayMode(root, mode);
      setViewMenu(null);
    },
    [root],
  );

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

  // ---------------------------------------------------------------- 新建 / 重命名

  /** 在某个目录里打开行内新建卡片（必要时先展开并加载那一层）。 */
  const beginCreate = useCallback(
    (dir: string) => {
      setFocusedDir(dir);

      // 目标目录可能在收起的子树里（例如从搜索结果打开的文件）：把祖先一并展开，
      // 否则草稿卡片所在的层级根本不会渲染。
      const ancestors = expandAncestors(root, [dir]);
      setExpanded((current) => {
        const next = new Set(current);
        for (const path of ancestors) next.add(path);
        return next;
      });
      for (const path of ancestors) {
        if (!levels.has(path)) void load(path);
      }

      setDraft({ kind: "create", dir, value: "未命名.md", error: null });
    },
    [root, levels, load],
  );

  const beginRename = useCallback((entry: WorkspaceEntry) => {
    setDraft({
      kind: "rename",
      dir: dirOf(entry.path),
      path: entry.path,
      value: entry.name,
      error: null,
    });
  }, []);

  const submitDraft = useCallback(async () => {
    if (!draft) return;

    const name = draft.value.trim();
    const invalid = validateDraftName(name);
    if (invalid) {
      setDraft({ ...draft, error: invalid });
      return;
    }

    try {
      if (draft.kind === "create") {
        // 目标目录还没加载过时先列一次，避免悄悄覆盖同名文件。
        const level = levels.get(draft.dir) ?? (await listWorkspaceDir(draft.dir));
        const exists = level.entries.some(
          (entry) => entry.name.toLowerCase() === name.toLowerCase(),
        );
        if (exists) {
          setDraft({ ...draft, error: "同名文件已存在" });
          return;
        }

        const path = joinPath(draft.dir, name);
        await writeWorkspaceFile(path, "");
        setDraft(null);
        setError(null);
        await load(draft.dir);
        onOpenFile({
          name,
          path,
          isDir: false,
          size: 0,
          modifiedAt: new Date().toISOString(),
          extension: extensionOf(name),
          preview: null,
        });
        return;
      }

      if (!draft.path) return;
      const newPath = await renameWorkspaceEntry(draft.path, name);
      const oldPath = draft.path;
      setDraft(null);
      setError(null);
      setSelectedPaths((current) => {
        if (!current.has(oldPath)) return current;
        const next = new Set(current);
        next.delete(oldPath);
        next.add(newPath);
        return next;
      });
      await load(draft.dir);
      onPathRenamed?.(oldPath, newPath);
    } catch (submitError) {
      setDraft({ ...draft, error: getErrorMessage(submitError) });
    }
  }, [draft, levels, load, onOpenFile, onPathRenamed]);

  // ---------------------------------------------------------------- 多选

  const knownDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const level of levels.values()) {
      for (const entry of level.entries) {
        if (entry.isDir) dirs.add(entry.path);
      }
    }
    return dirs;
  }, [levels]);

  const collapsedSelection = useMemo(
    () => collapseSelectedPaths(root, [...selectedPaths], knownDirs),
    [knownDirs, root, selectedPaths],
  );

  /** 当前可见（按渲染顺序）的条目，Shift 范围选择与框选都靠它。 */
  const flattenedVisible = useMemo(() => {
    const out: WorkspaceEntry[] = [];
    const visit = (dir: string) => {
      const level = levels.get(dir);
      if (!level) return;
      for (const entry of visible(level.entries)) {
        out.push(entry);
        if (entry.isDir && expanded.has(entry.path)) visit(entry.path);
      }
    };
    visit(root);
    return out;
  }, [expanded, levels, root, visible]);

  const selectRange = useCallback(
    (anchor: string, target: string) => {
      const paths = flattenedVisible.map((entry) => entry.path);
      const from = paths.indexOf(anchor);
      const to = paths.indexOf(target);
      if (from < 0 || to < 0) return false;
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelectedPaths(new Set(paths.slice(start, end + 1)));
      return true;
    },
    [flattenedVisible],
  );

  const handleRowClick = useCallback(
    (entry: WorkspaceEntry, event: ReactMouseEvent) => {
      const additive = event.ctrlKey || event.metaKey;

      if (event.shiftKey && selectionAnchorRef.current) {
        if (selectRange(selectionAnchorRef.current, entry.path)) return;
      }

      if (entry.isDir) {
        setFocusedDir(entry.path);
      } else {
        setFocusedDir(dirOf(entry.path));
      }

      if (additive) {
        setSelectedPaths((current) => {
          const next = new Set(current);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        selectionAnchorRef.current = entry.path;
        return;
      }

      setSelectedPaths(new Set([entry.path]));
      selectionAnchorRef.current = entry.path;

      if (entry.isDir) {
        toggleDir(entry.path);
      } else {
        onOpenFile(entry);
      }
    },
    [onOpenFile, selectRange, toggleDir],
  );

  /**
   * 空白处按住左键拖拽框选。
   *
   * 只认落在**滚动区空白处**的 mousedown —— 点在任何行、按钮、输入框上都不是框选的
   * 开始。矩形与每个带 `data-workspace-path` 的行求交，命中的全部选中。
   */
  /**
   * 从某个点开始框选。调用方负责先判断「这一点算不算空白」。
   *
   * `clearOnClick`：没拖动就松手时要不要清空选中。目录树的空白处沿用老行为
   * （点空白 = 取消选择）；活动栏 / 侧栏的辅助区域只是「借一块地方起手」，点一下
   * 不该把你在目录里选好的东西清掉。
   */
  const beginMarquee = useCallback(
    (startX: number, startY: number, clearOnClick: boolean) => {
      let moved = false;

      const update = (clientX: number, clientY: number) => {
        const left = Math.min(startX, clientX);
        const top = Math.min(startY, clientY);
        const width = Math.abs(clientX - startX);
        const height = Math.abs(clientY - startY);
        if (width + height <= 3) return;
        moved = true;

        setMarquee({ left, top, width, height });

        const scroll = treeScrollRef.current;
        if (!scroll) return;

        const right = left + width;
        const bottom = top + height;
        const hits = new Set<string>();
        for (const element of scroll.querySelectorAll<HTMLElement>("[data-workspace-path]")) {
          const rect = element.getBoundingClientRect();
          if (rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom) {
            continue;
          }
          const path = element.getAttribute("data-workspace-path");
          if (path) hits.add(path);
        }
        setSelectedPaths(hits);
      };

      const onMove = (moveEvent: MouseEvent) => update(moveEvent.clientX, moveEvent.clientY);
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        setMarquee(null);
        if (!moved && clearOnClick) {
          setSelectedPaths(new Set());
          selectionAnchorRef.current = null;
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [],
  );

  /** 目录树滚动区里的空白处。 */
  const startMarquee = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          ".explorer-item, .explorer-folder, .explorer-icon-tile, button, input, .explorer-draft-row, .workspace-tree-toolbar",
        )
      ) {
        return;
      }

      // 滚动条也长在这个 div 上：从滑轨上按下不是框选，放过去，免得拖滚动条时
      // 顺手拉出一个选框、把选中状态清掉。
      const scrollRect = treeScrollRef.current?.getBoundingClientRect();
      if (scrollRect && event.clientX >= scrollRect.right - 18) return;

      event.preventDefault();
      beginMarquee(event.clientX, event.clientY, true);
    },
    [beginMarquee],
  );

  /**
   * 辅助起手区：**活动栏（左侧那一条）与侧栏里除目录树之外的空白**。
   *
   * 目录树经常被条目铺满，找不到一块空白按下去；但活动栏那一列除了几个图标之外
   * 全是空白，从那里按住左键往右/下拖，一样可以框选目录里的条目。这里用 document
   * 监听 + `closest` 限定范围，不碰目录树滚动区（它有自己的 handler，避免起两次）。
   */
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".workspace-tree-scroll")) return;
      if (!target.closest(".sidebar, .activity-bar")) return;
      if (
        target.closest(
          "button, input, textarea, select, [contenteditable='true'], [role='dialog'], .popup-menu, .explorer-item, .explorer-folder, .explorer-icon-tile, .explorer-draft-row, .workspace-tree-toolbar",
        )
      ) {
        return;
      }

      event.preventDefault();
      beginMarquee(event.clientX, event.clientY, false);
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [beginMarquee]);

  // ---------------------------------------------------------------- 批量动作

  const copySelection = useCallback(async () => {
    const paths = collapseSelectedPaths(root, [...selectedPathsRef.current], knownDirs);
    if (paths.length === 0) return;
    try {
      await copyFilePaths(paths);
    } catch (copyError) {
      setError(getErrorMessage(copyError));
    }
  }, [knownDirs, root]);

  const copySelectionPaths = useCallback(async () => {
    const paths = collapseSelectedPaths(root, [...selectedPathsRef.current], knownDirs);
    if (paths.length === 0) return;
    try {
      await writeText(paths.join("\n"));
      showToast(t("main.workspace.pathCopied", { defaultValue: "已复制文件路径" }), "info");
    } catch (copyError) {
      setError(getErrorMessage(copyError));
    }
  }, [knownDirs, root, t]);

  const requestDelete = useCallback(
    (paths: string[]) => {
      const collapsed = collapseSelectedPaths(root, paths, knownDirs);
      if (collapsed.length === 0) return;
      setPendingError(null);
      setPending({ kind: "delete", paths: collapsed });
    },
    [knownDirs, root],
  );

  const openMovePicker = useCallback(
    (paths: string[]) => {
      const collapsed = collapseSelectedPaths(root, paths, knownDirs);
      if (collapsed.length === 0) return;
      setPicker({ sources: collapsed });
    },
    [knownDirs, root],
  );

  const pasteInto = useCallback(async (targetDir: string) => {
    try {
      const paths = await readClipboardFiles();
      if (paths.length === 0) {
        showToast(
          t("main.workspace.clipboardEmpty", { defaultValue: "剪贴板里没有文件" }),
          "warning",
        );
        return;
      }
      setPendingError(null);
      setPending({ kind: "copyIn", sources: paths, targetDir });
    } catch (readError) {
      setError(getErrorMessage(readError));
    }
  }, [t]);

  const confirmPending = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    setPendingError(null);
    try {
      if (pending.kind === "delete") {
        const count = await deleteWorkspaceEntries(pending.paths);
        onPathsRemoved?.(pending.paths);
        await reloadLoadedLevels();
        setSelectedPaths(new Set());
        showToast(
          t("main.workspace.deletedCount", {
            count,
            defaultValue: "已删除 {{count}} 个项目",
          }),
          "info",
        );
      } else {
        const count = await copyWorkspaceEntries(pending.sources, pending.targetDir);
        await reloadLoadedLevels();
        showToast(
          t("main.workspace.copiedCount", {
            count,
            defaultValue: "已复制 {{count}} 个项目",
          }),
          "info",
        );
      }
      setPending(null);
    } catch (actionError) {
      setPendingError(getErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  }, [onPathsRemoved, pending, reloadLoadedLevels, t]);

  const confirmMove = useCallback(
    async (targetDir: string) => {
      if (!picker) return;
      // 已经在目标目录里的项不用再移一次 —— 后端会以「目标已存在」拒绝整批。
      const sources = picker.sources.filter((source) => dirOf(source) !== targetDir);
      if (sources.length === 0) {
        setPicker(null);
        return;
      }
      setBusy(true);
      try {
        const count = await moveWorkspaceEntries(sources, targetDir);
        onPathsMoved?.(
          sources.map((source) => ({
            from: source,
            to: joinPath(targetDir, folderName(source)),
          })),
        );
        await reloadLoadedLevels();
        setSelectedPaths(new Set());
        setPicker(null);
        showToast(
          t("main.workspace.movedCount", {
            count,
            defaultValue: "已移动 {{count}} 个项目",
          }),
          "info",
        );
      } catch (moveError) {
        setError(getErrorMessage(moveError));
      } finally {
        setBusy(false);
      }
    },
    [onPathsMoved, picker, reloadLoadedLevels, t],
  );

  // 拖入：MainWindow 的落点判断把「落在树里」的路径交给这里。
  useEffect(() => {
    setWorkspaceDropHandler((paths, targetDir) => {
      setPendingError(null);
      setPending({
        kind: "copyIn",
        sources: paths,
        targetDir: targetDir ?? focusedDirRef.current,
      });
    });
    return () => setWorkspaceDropHandler(null);
  }, []);

  // 快捷键：Delete 删除、Ctrl+C 复制文件、Ctrl+V 粘贴到焦点目录。
  // 编辑器 / 输入框里的按键一律放过（Ctrl+C 在编辑器里是复制文字）。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 确认框 / 选择器开着时，快捷键不该绕到它们后面去改选中集合。
      if (document.querySelector("[role='dialog']")) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, [contenteditable='true'], .editor-input, [role='dialog']",
        )
      ) {
        return;
      }

      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (mod && key === "c" && selectedPathsRef.current.size > 0) {
        event.preventDefault();
        void copySelection();
        return;
      }
      if (mod && key === "v") {
        event.preventDefault();
        void pasteInto(focusedDirRef.current);
        return;
      }
      if (
        !mod &&
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedPathsRef.current.size > 0
      ) {
        event.preventDefault();
        requestDelete([...selectedPathsRef.current]);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [copySelection, pasteInto, requestDelete]);

  // ---------------------------------------------------------------- 右键菜单

  const openMenu = (event: ReactMouseEvent, entry: WorkspaceEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setViewMenu(null);
    setMenu({ x: event.clientX, y: event.clientY, entry });
    setSelectedPaths((current) =>
      current.has(entry.path) ? current : new Set([entry.path]),
    );
    selectionAnchorRef.current = entry.path;
  };

  /*
   * 「点别处收起」一律挂在 **mousedown** 上，而不是 click。
   *
   * 打开菜单的那一下 click 可能要等 React 把 passive effect 冲掉才把这个监听器装上；
   * 如果装在同一轮事件的分发过程中，这个 listener 会**接住打开菜单的那一下 click**，
   * 于是菜单刚出现就被收起 —— 表现就是「点了没反应」。
   * mousedown 在 click 之前发生，新装的监听器不会看到已经过去的那一下。
   *
   * 浮层是 portal 到 body 的，不在按钮的 DOM 子树里，所以「点浮层内部」必须靠 ref
   * 单独放过；否则点菜单项时先触发 mousedown，菜单在 click 之前就没了。
   */
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      setMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu, menuRef]);

  useEffect(() => {
    if (!viewMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (viewMenuRef.current?.contains(target)) return;
      // 再点一次按钮是「收起」，交给按钮自己的 onClick 处理。
      if (target instanceof Element && target.closest(".workspace-view-button")) return;
      setViewMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [viewMenu, viewMenuRef]);

  // ---------------------------------------------------------------- 渲染

  const draftRow = (depth: number) =>
    draft ? (
      <ExplorerDraftRow
        value={draft.value}
        error={draft.error}
        depth={depth}
        placeholder={draft.kind === "rename" ? "新的文件名" : "文件名（含扩展名）"}
        onChange={(value) => setDraft({ ...draft, value, error: null })}
        onSubmit={() => void submitDraft()}
        onCancel={() => setDraft(null)}
      />
    ) : null;

  const dragOut = (path: string) => (event: ReactDragEvent) => {
    // 压掉 WebView2 自己的 HTML5 拖拽，改走原生 DoDragDrop（能落到资源管理器）。
    event.preventDefault();
    if ((event.target as HTMLElement).closest(".explorer-folder-add")) return;
    void startFileDragOut(path);
  };

  const fileCard = (entry: WorkspaceEntry, type: FileType | null, depth: number) => (
    <ExplorerItem
      key={entry.path}
      inset
      compact={displayMode === "list"}
      leadingIcon={
        displayMode === "list" ? (
          <FileKindIcon kind={type?.kind ?? "none"} size={13} color={type?.color} />
        ) : undefined
      }
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
      multiSelected={selectedPaths.has(entry.path)}
      dataPath={entry.path}
      dataDrop={dirOf(entry.path)}
      draggable
      onDragStart={dragOut(entry.path)}
      onSelect={(event) => handleRowClick(entry, event)}
      onAuxClick={() => onOpenFile(entry, { newTab: true })}
      onContextMenu={(event) => openMenu(event, entry)}
      depth={depth}
    />
  );

  /** 图标视图里的一格。**只给文件用** —— 文件夹在每一层顶部排成行。 */
  const iconTile = (entry: WorkspaceEntry, type: FileType | null) => {
    const selected = entry.path === selectedPath;
    const multiSelected = selectedPaths.has(entry.path);
    return (
      <div
        key={entry.path}
        data-workspace-path={entry.path}
        data-workspace-drop={dirOf(entry.path)}
        draggable
        onDragStart={dragOut(entry.path)}
        onClick={(event) => handleRowClick(entry, event)}
        onContextMenu={(event) => openMenu(event, entry)}
        title={entry.name}
        className={`explorer-icon-tile group relative flex flex-col items-center gap-1 p-2 rounded-lg cursor-pointer transition-colors ${
          selected
            ? "is-selected bg-bamboo-mist/70"
            : multiSelected
              ? "is-multi-selected bg-bamboo-mist/45 ring-1 ring-inset ring-bamboo/20"
              : "hover:bg-paper-warm/70"
        }`}
      >
        {type?.kind === "image" && !resizing ? (
          <img
            src={convertFileSrc(entry.path)}
            alt=""
            loading="lazy"
            draggable={false}
            className="w-12 h-12 object-cover rounded-md border border-paper-deep/30"
          />
        ) : (
          <FileKindIcon
            kind={type?.kind ?? "none"}
            size={38}
            color={type?.color}
          />
        )}
        <span className="w-full text-[10px] leading-tight text-center line-clamp-2 break-all text-ink-soft">
          {entry.name}
        </span>
      </div>
    );
  };

  const renderLevel = (dir: string, depth: number) => {
    const level = levels.get(dir);
    if (!level) return null;

    const entries = visible(level.entries);
    const createHere = draft?.kind === "create" && draft.dir === dir;

    if (entries.length === 0 && !createHere) {
      return (
        <p
          className="py-2 text-[11px] text-ink-ghost leading-relaxed"
          style={{ paddingLeft: 12 + depth * 12 }}
        >
          {t("main.workspace.emptyLevel", { defaultValue: "没有可显示的文件" })}
        </p>
      );
    }

    return (
      <>
        {entries.map((entry) => {
          // 重命名时用行内卡片顶掉原来那一行（不画图标）。
          if (draft?.kind === "rename" && draft.path === entry.path) {
            return <div key={entry.path}>{draftRow(depth)}</div>;
          }

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
                compact={displayMode === "list"}
                focused={focusedDir === entry.path}
                multiSelected={selectedPaths.has(entry.path)}
                dataPath={entry.path}
                dataDrop={entry.path}
                count={childLevel ? visible(childLevel.entries).length : undefined}
                onCreate={() => beginCreate(entry.path)}
                createTitle={t("main.workspace.createHere", {
                  defaultValue: "在这里新建文件",
                })}
                onToggle={(event) => handleRowClick(entry, event)}
                draggable
                onDragStart={dragOut(entry.path)}
                onContextMenu={(event) => openMenu(event, entry)}
              />
              {isOpen ? renderLevel(entry.path, depth + 1) : null}
            </div>
          );
        })}
        {createHere ? <div key="__draft__">{draftRow(depth)}</div> : null}
      </>
    );
  };

  /**
   * 图标视图的一层：**文件夹置顶、排成行，只有文件进网格**。
   *
   * 与资源管理器一致：文件夹是容器，不该跟图片抢格子；它们保持「一行一个」的层级感，
   * 展开后在下面继续「子文件夹行 + 文件网格」。这样目录再深也不会把一堆文件夹图标
   * 铺满整屏。
   */
  const renderIconLevel = (dir: string, depth: number): ReactNode => {
    const level = levels.get(dir);
    if (!level) return null;

    const entries = visible(level.entries);
    const folders = entries.filter((entry) => entry.isDir);
    const files = entries.filter((entry) => !entry.isDir);
    const createHere = draft?.kind === "create" && draft.dir === dir;

    if (entries.length === 0 && !createHere) {
      return (
        <p
          className="py-2 text-[11px] text-ink-ghost leading-relaxed"
          style={{ paddingLeft: 12 + depth * 12 }}
        >
          {t("main.workspace.emptyLevel", { defaultValue: "没有可显示的文件" })}
        </p>
      );
    }

    return (
      <div>
        {folders.map((entry) => {
          const isOpen = expanded.has(entry.path);
          const childLevel = levels.get(entry.path);
          return (
            <div key={entry.path}>
              <ExplorerFolderRow
                name={entry.name}
                open={isOpen}
                depth={depth}
                focused={focusedDir === entry.path}
                multiSelected={selectedPaths.has(entry.path)}
                dataPath={entry.path}
                dataDrop={entry.path}
                count={childLevel ? visible(childLevel.entries).length : undefined}
                onCreate={() => beginCreate(entry.path)}
                createTitle={t("main.workspace.createHere", {
                  defaultValue: "在这里新建文件",
                })}
                onToggle={(event) => handleRowClick(entry, event)}
                draggable
                onDragStart={dragOut(entry.path)}
                onContextMenu={(event) => openMenu(event, entry)}
              />
              {isOpen ? (
                <div className="workspace-icon-children">
                  {renderIconLevel(entry.path, depth + 1)}
                </div>
              ) : null}
            </div>
          );
        })}

        {files.length > 0 ? (
          <div
            className="workspace-icon-grid grid gap-1 px-1 mt-1"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))",
              marginLeft: depth ? depth * 12 : undefined,
            }}
          >
            {files.map((entry) =>
              draft?.kind === "rename" && draft.path === entry.path ? (
                <div key={entry.path} className="col-span-2">
                  {draftRow(depth)}
                </div>
              ) : (
                <div key={entry.path}>
                  {iconTile(entry, matchFileType(entry.extension))}
                </div>
              ),
            )}
          </div>
        ) : null}

        {createHere ? draftRow(depth) : null}
      </div>
    );
  };

  const rootLevel = levels.get(root);
  const isLoadingRoot = loading.has(root);

  const selectionCount = collapsedSelection.length;
  const singleEntry =
    selectionCount === 1 &&
    menu &&
    collapsedSelection[0] === menu.entry.path
      ? menu.entry
      : null;

  const targetLabel = pending?.kind === "copyIn"
    ? pending.targetDir === root
      ? t("main.workspace.rootFolder", { defaultValue: "根目录" })
      : folderName(pending.targetDir)
    : "";

  return (
    <div className="workspace-tree flex flex-col min-h-0 flex-1">
      {/* 搜索、查看方式与新建：与笔记面板保持同一套观感 */}
      <div className="px-3 pb-2 shrink-0 space-y-1">
        <div className="workspace-tree-toolbar flex items-center gap-1">
          <div className="flex items-center gap-2 px-2.5 h-8 flex-1 min-w-0 rounded-lg bg-paper-warm/80 border border-paper-deep/40 focus-within:border-bamboo/30 focus-within:bg-cloud transition-all">
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
              className="flex-1 min-w-0 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
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

          <button
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu(null);
              setViewMenu((current) =>
                current ? null : { x: rect.left, y: rect.bottom + 4 },
              );
            }}
            aria-haspopup="menu"
            aria-expanded={viewMenu !== null}
            title={t("main.workspace.view", { defaultValue: "查看方式" })}
            className={`workspace-view-button shrink-0 h-8 px-1.5 flex items-center gap-1 rounded-lg border transition-all cursor-pointer ${
              viewMenu
                ? "text-bamboo bg-bamboo-mist/50 border-bamboo/25"
                : "text-ink-ghost bg-paper-warm/80 border-paper-deep/40 hover:text-bamboo"
            }`}
          >
            {displayMode === "list" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            ) : displayMode === "icons" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="4" y="4" width="6" height="6" rx="1" />
                <rect x="14" y="4" width="6" height="6" rx="1" />
                <rect x="4" y="14" width="6" height="6" rx="1" />
                <rect x="14" y="14" width="6" height="6" rx="1" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="4" width="18" height="7" rx="1" />
                <rect x="3" y="14" width="18" height="6" rx="1" />
              </svg>
            )}
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>

        <button
          onClick={() => beginCreate(focusedDir)}
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
          <span>{t("main.workspace.newFile", { defaultValue: "新建文件" })}</span>
          <span className="ml-auto max-w-[96px] truncate text-[10px] font-mono text-bamboo/50">
            {focusedDir === root
              ? t("main.workspace.rootFolder", { defaultValue: "根目录" })
              : folderName(focusedDir)}
          </span>
        </button>
      </div>

      <div
        ref={treeScrollRef}
        /* pb-16：列表末端留一块能按下去的空白 —— 条目铺满时，滚到底就能从这里起手框选。 */
        className="workspace-tree-scroll flex-1 overflow-y-auto scrollbar-hidden pb-16"
        onMouseDown={startMarquee}
      >
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
            {displayMode === "icons" ? renderIconLevel(root, 0) : renderLevel(root, 0)}
            {rootLevel.truncated ? (
              <p className="px-3 py-2 text-[10px] text-ink-ghost/70 leading-relaxed">
                {t("main.workspace.truncated", { defaultValue: "条目过多，仅显示前一部分" })}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {/* 框选矩形：fixed 到视口，和鼠标坐标同一套坐标系。 */}
      {marquee
        ? createPortal(
            <div
              className="workspace-marquee fixed z-[70] pointer-events-none rounded-sm border border-bamboo/50 bg-bamboo/10"
              style={{
                left: marquee.left,
                top: marquee.top,
                width: marquee.width,
                height: marquee.height,
              }}
            />,
            document.body,
          )
        : null}

      {/* 查看方式下拉 */}
      {viewMenu
        ? createPortal(
            <div
              ref={viewMenuRef}
              role="menu"
              className="workspace-view-menu popup-menu fixed z-[9999] min-w-[132px] py-1 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg shadow-lg animate-menu-enter select-none"
              style={{
                left: viewMenuPosition?.x ?? viewMenu.x,
                top: viewMenuPosition?.y ?? viewMenu.y,
                maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
                maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {(
                [
                  { mode: "list" as const, label: t("main.workspace.viewList", { defaultValue: "列表" }) },
                  { mode: "cards" as const, label: t("main.workspace.viewCards", { defaultValue: "卡片" }) },
                  { mode: "icons" as const, label: t("main.workspace.viewIcons", { defaultValue: "图标" }) },
                ]
              ).map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={displayMode === option.mode}
                  onClick={() => setViewMode(option.mode)}
                  className={`workspace-view-item context-menu-item w-full flex items-center gap-2 text-left px-3 py-1.5 text-[12px] font-body transition-colors cursor-pointer ${
                    displayMode === option.mode
                      ? "is-active text-bamboo bg-bamboo-mist/40"
                      : "text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo"
                  }`}
                >
                  <FileKindIcon
                    kind={
                      option.mode === "list"
                        ? "note"
                        : option.mode === "cards"
                          ? "markdown"
                          : "image"
                    }
                    size={13}
                  />
                  {option.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      {/* 右键菜单 */}
      {menu ? (
        <div
          ref={menuRef}
          className="popup-menu fixed z-[9999] min-w-[168px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none animate-menu-enter"
          style={{
            left: menuPosition?.x ?? menu.x,
            top: menuPosition?.y ?? menu.y,
            maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {selectionCount > 1 ? (
            <p className="px-3 py-1 text-[10px] text-ink-ghost font-mono">
              {t("main.workspace.selectedCount", {
                count: selectionCount,
                defaultValue: "已选 {{count}} 项",
              })}
            </p>
          ) : null}

          {singleEntry && !singleEntry.isDir ? (
            <>
              <button
                onClick={() => {
                  const entry = singleEntry;
                  setMenu(null);
                  onOpenFile(entry, { newTab: true });
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.workspace.openInNewTab", { defaultValue: "在新标签页中打开" })}
              </button>
              <button
                onClick={() => {
                  const entry = singleEntry;
                  setMenu(null);
                  beginRename(entry);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.workspace.rename", { defaultValue: "重命名" })}
              </button>
            </>
          ) : null}

          <button
            onClick={() => {
              setMenu(null);
              void copySelection();
            }}
            className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
          >
            {selectionCount > 1
              ? t("main.workspace.copyCount", {
                  count: selectionCount,
                  defaultValue: "复制（{{count}} 项）",
                })
              : t("main.workspace.copyFile", { defaultValue: "复制" })}
          </button>
          <button
            onClick={() => {
              setMenu(null);
              void copySelectionPaths();
            }}
            className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
          >
            {t("main.workspace.copyPath", { defaultValue: "复制文件路径" })}
          </button>

          {singleEntry ? (
            <>
              <button
                onClick={() => {
                  const entry = singleEntry;
                  setMenu(null);
                  void pasteInto(entry.isDir ? entry.path : focusedDir);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.workspace.pasteHere", { defaultValue: "粘贴到这里" })}
              </button>
              {!singleEntry.isDir ? (
                <>
                  <button
                    onClick={() => {
                      const entry = singleEntry;
                      setMenu(null);
                      void openWithSystemApp(entry.path).catch((openError: unknown) =>
                        setError(getErrorMessage(openError)),
                      );
                    }}
                    className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
                  >
                    {t("main.workspace.openWith", { defaultValue: "打开方式…" })}
                  </button>
                  <button
                    onClick={() => {
                      const entry = singleEntry;
                      setMenu(null);
                      void showSystemProperties(entry.path).catch((propertyError: unknown) =>
                        setError(getErrorMessage(propertyError)),
                      );
                    }}
                    className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
                  >
                    {t("main.workspace.properties", { defaultValue: "属性" })}
                  </button>
                </>
              ) : null}
            </>
          ) : null}

          <button
            onClick={() => {
              setMenu(null);
              openMovePicker([...selectedPathsRef.current]);
            }}
            className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
          >
            {t("main.workspace.moveTo", { defaultValue: "移动到…" })}
          </button>
          <button
            onClick={() => {
              setMenu(null);
              requestDelete([...selectedPathsRef.current]);
            }}
            className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer border-t border-paper-deep/20"
          >
            {selectionCount > 1
              ? t("main.workspace.deleteCount", {
                  count: selectionCount,
                  defaultValue: "删除（{{count}} 项）",
                })
              : singleEntry?.isDir
                ? t("main.workspace.deleteFolder", { defaultValue: "删除文件夹" })
                : t("main.workspace.deleteFile", { defaultValue: "删除文件" })}
          </button>
        </div>
      ) : null}

      {/* 批量删除 / 拖入复制的确认框 */}
      {pending ? (
        <Modal
          title={
            pending.kind === "delete"
              ? t("main.workspace.confirmDeleteTitle", { defaultValue: "删除项目" })
              : t("main.workspace.confirmCopyTitle", { defaultValue: "复制到工作区" })
          }
          onCancel={() => {
            if (!busy) setPending(null);
          }}
        >
          <p className="text-[12px] text-ink-soft leading-relaxed">
            {pending.kind === "delete"
              ? t("main.workspace.confirmDeleteBatch", {
                  count: pending.paths.length,
                  defaultValue:
                    "确定删除 {{count}} 个项目吗？文件夹会连同里面的所有文件一起删除，不可恢复。",
                })
              : t("main.workspace.confirmCopyBatch", {
                  count: pending.sources.length,
                  target: targetLabel,
                  defaultValue:
                    "确定把 {{count}} 个项目复制到「{{target}}」下吗？文件夹会连同里面的所有文件一起复制。",
                })}
          </p>
          {pendingError ? (
            <p className="mt-2 text-[11px] text-red-400 leading-relaxed">{pendingError}</p>
          ) : null}
          <ModalActions
            busy={busy}
            danger={pending.kind === "delete"}
            confirmLabel={
              pending.kind === "delete"
                ? t("main.workspace.confirmDelete", { defaultValue: "确认删除" })
                : t("main.workspace.confirmCopy", { defaultValue: "复制" })
            }
            onCancel={() => {
              if (!busy) setPending(null);
            }}
            onConfirm={() => void confirmPending()}
          />
        </Modal>
      ) : null}

      {/* 「移动到…」的目录树选择器 */}
      {picker ? (
        <WorkspaceFolderPicker
          root={root}
          title={t("main.workspace.moveToTitle", { defaultValue: "移动到…" })}
          exclude={picker.sources}
          confirmLabel={t("main.workspace.moveHere", { defaultValue: "移动到这里" })}
          busy={busy}
          onCancel={() => {
            if (!busy) setPicker(null);
          }}
          onConfirm={(dir) => void confirmMove(dir)}
        />
      ) : null}
    </div>
  );
}
