import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MouseEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exportMarkdownNote, importMarkdownNote } from "../features/importExport/api";
import { MarkdownPreview } from "../features/markdown/MarkdownPreview";
import { applyAlign } from "../features/markdown/alignText";
import { sidePanelModeOf, type SidePanelMode } from "../features/windows/sidePanelMode";
import { renderMarkdownLines } from "../features/markdown/syntaxHighlight";
import { showToast } from "./Toast";
import { PluginCommandPanel } from "./PluginCommandPanel";
import { AboutPanel } from "./AboutPanel";
import { StylesPanel } from "./StylesPanel";
import { CommandPalette } from "./CommandPalette";
import { FindReplacePanel } from "./FindReplacePanel";
import { dispatchCommandKeybinding, registerBuiltinCommand } from "../features/commands/registry";
import { createEditorAccessor, registerActiveContent } from "../features/plugins/activeContent";
import {
  emitContentChanged,
  emitFloralEvent,
  installFloralEventBridge,
} from "../features/plugins/events";
import { caretAfterChange, editorHistory } from "../features/editor/history";
import { registerEditorJump, registerPreviewJump } from "../features/plugins/jump";
import {
  loadPlugins,
  refreshPluginStatusBar,
  updatePluginEditorMirror,
} from "../features/plugins/loader";
import { pluginOwningPath } from "../features/plugins/pluginPaths";
import { runStartupAutoUpdatesQuietly } from "../features/market/autoUpdate";
import type { EditorFileInfo } from "../features/plugins/protocol";
import {
  listDocumentActions,
  listEditorGutters,
  listNoteMenuItems,
  listDecorations,
  listPluginPanels,
  listPopovers,
  listToolbarButtons,
  notifyContentChanged,
  subscribeDocumentActions,
  subscribeEditorGutters,
  subscribeNoteMenuItems,
  subscribeDecorations,
  subscribePluginPanels,
  subscribePopovers,
  subscribeToolbarButtons,
} from "../features/plugins/registry";
import type { PluginDecoration, PluginDocumentAction, PluginPopover } from "../features/plugins/registry";
import { sanitizePluginHtml } from "../features/plugins/sanitizeHtml";
import {
  getDecorationItems,
  getGutterLines,
  getPanelHtml,
  getPopoverHtml,
  panelFileKeyOf,
  pluginStoresRevision,
  subscribePluginStores,
} from "../features/plugins/stores";
import { usePluginStatusBar } from "../features/plugins/usePluginStatusBar";
import type { PluginPanelDef, Selection } from "../features/plugins/types";
import {
  blockIndexAtOffset,
  blockOffsetsFromLayer,
  measureBlockOffsets,
  measureSelectionRects,
  parseBlocks,
  stripMarkdownInline,
  tagPreviewBlocks,
  type SelectionRect,
} from "../features/markdown/scrollSync";
import {
  chooseDataDirectory,
  getConfig,
  migrateDataDir,
  normalizeViewMode,
  saveConfig,
} from "../features/settings/api";
import type { AppConfig, ViewMode } from "../features/settings/types";
import { normalizeTileColor } from "../features/settings/tileColor";
// `formatSize` 虽然住在市场模块里，但它就是个「字节数 → 人能读的大小」的纯格式化函数，
// 与市场没有关系 —— 与其再抄第三份，不如把它当公共工具用。
import { formatSize } from "../features/market/presentation";
import {
  addWorkspaceFolder,
  clearWorkspaceCache,
  removeWorkspaceFolder,
  setWorkspaceIcon,
  workspaceCacheInfo,
  type WorkspaceCacheInfo,
  type WorkspaceEntry,
} from "../features/workspace/api";
import { postActiveViewCommand } from "../features/plugins/activeView";
import {
  documentActionVisible,
  documentContextOf,
  exportFormatsFor,
  type ExportFormat,
} from "../features/workspace/documentContext";
import {
  hasPreviewPaneKind,
  isEditableKind,
  listFileTypes,
  matchFileType,
  subscribeFileTypes,
} from "../features/workspace/fileTypes";
import {
  escapeHtmlEntities,
  highlightCode,
  splitHighlightedHtml,
} from "../features/markdown/highlight";
import { setCodeThemeOverride } from "../features/markdown/codeThemes";
import { ActivityBar, NotesIcon, type ActivityBarItem } from "./ActivityBar";
import { WorkspaceIcon } from "./WorkspaceIcons";
import { BackgroundLayer } from "./BackgroundLayer";
import { ExplorerItem } from "./ExplorerItem";
import { FilePreview, TablePreview } from "./FilePreview";
import { Modal } from "./Modal";
import { PdfExportPanel } from "./PdfExportPanel";
import { WorkspaceTree, folderName, shortenPath } from "./WorkspaceTree";
import { POPUP_VIEWPORT_MARGIN, useViewportPopupPosition } from "./popupPosition";
import { disposeListener } from "./listeners";
import { SettingsPanel } from "./SettingsPanel";
import { SlidingButtonGroup } from "./SlidingButtonGroup";
import {
  createNote,
  createCategory,
  deleteCategory,
  deleteNote,
  getErrorMessage,
  getFileModifiedTime,
  getNote,
  listCategories,
  listNotes,
  moveNoteCategory,
  readExternalFile,
  renameCategory,
  saveExternalFile,
  updateNote,
} from "../features/notes/api";
import { listableExternalFiles } from "../features/notes/externalFiles";
import { UpdateBadge } from "../features/update/UpdateBadge";
import { useUpdate } from "../features/update/useUpdate";
import { cleanUnusedImages, saveImageFromPath } from "../features/images/api";
import { useImagePaste, insertTextAtCursor } from "../features/images/useImagePaste";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import { handleMarkdownShortcut } from "../features/shortcuts/markdownShortcuts";
import { buildPrintBody } from "../features/pdfExport/api";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { ExternalFile, Note, NoteMetadata } from "../features/notes/types";
import {
  countNoteChars,
  filterNotes,
  formatShortDate,
  formatTime,
  getDisplayTitle,
  groupNotesByCategory,
  metadataFromNote,
} from "../features/notes/noteUtils";
import type { CategoryGroup } from "../features/notes/noteUtils";
import {
  getNoteContextMenuItems,
  type NoteContextMenuAction,
} from "../features/notes/noteContextMenu";
import { takeStartupFile } from "../features/windows/api";
import {
  closeCurrentWindow,
  minimizeCurrentWindow,
  setCurrentWindowAlwaysOnTop,
  toggleMaximizeCurrentWindow,
  isCurrentWindowMaximized,
  startCurrentWindowDrag,
} from "../features/windows/controls";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
/** 侧栏模式与「哪个 id 挂哪一层」的映射都在 features/windows/sidePanelMode.ts。 */

/** 活动栏里「笔记」那一格的 id。工作文件夹的 id 直接用它自己的绝对路径。 */
const EXPLORER_NOTES = "notes";

/**
 * 这些类型不走编辑器，改用 FilePreview 只读展示。
 *
 * `code` / `text` / `markdown` 不在列：它们是可编辑的文本，继续用 textarea +
 * 高亮层，只是高亮的来源不同（代码走 highlight.js，Markdown 走自带的分词器）。
 */
/**
 * 这个路径是否属于「没有编辑器」的类型（图片 / 媒体 / 插件自定义 / 不支持）。
 *
 * 用来决定打开文件时**要不要把它当文本读**：图片是二进制，按文本读不只是报
 * "stream did not contain valid UTF-8"，更糟的是 `setSelectedId` 根本执行不到，
 * 界面会停在上一个文件上。
 */
function isRichPreviewPath(filePath: string): boolean {
  const index = filePath.lastIndexOf(".");
  const extension = index >= 0 ? filePath.slice(index + 1).toLowerCase() : null;
  const type = matchFileType(extension);
  return type !== null && !isEditableKind(type.kind);
}

/**
 * 超过这个长度就**不再重建高亮 HTML**。
 *
 * 编辑器每敲一个键都会把整篇内容重新转成 HTML 垫在透明的 textarea 底下 —— 对几十万
 * 字的文件，这个代价足以让输入卡到没法用。超限时退化成普通文本编辑（见下面 textarea
 * 的 color），而不是硬着色。
 */
const MAX_HIGHLIGHT_CHARS = 200_000;

/**
 * 预览落后编辑器多久。
 *
 * 预览整篇重排一次要几百毫秒（见 `previewContent` 的说明），跟着每一次按键走等于把
 * 编辑器拖死。停笔之后才跟上，打字期间它一动不动。
 */
const PREVIEW_LAG_MS = 350;

/**
 * 超过这个长度干脆不打开。
 *
 * textarea 与高亮层都扛不住百万字符级别的内容，硬开只会把整个界面冻住 —— 那比
 * 「明确告诉你打不开」糟糕得多。
 */
const MAX_EDITABLE_CHARS = 1_000_000;

/** 预览「纸张式」缩放的范围与步长。 */
const PREVIEW_ZOOM_MIN = 0.25;
const PREVIEW_ZOOM_MAX = 5;
const PREVIEW_ZOOM_STEP = 0.15;

function clampPreviewZoom(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, rounded));
}


interface NoteMenuState {
  x: number;
  y: number;
  noteId: string;
}

interface CategoryMenuState {
  x: number;
  y: number;
  category: string;
}

type FormatAction =
  | "bold"
  | "italic"
  | "heading"
  | "hr"
  | "ul"
  | "ol"
  | "code"
  | "quote"
  | "inlineMath"
  | "blockMath"
  | "alignLeft"
  | "alignCenter"
  | "alignRight";

function applyFormat(
  textarea: HTMLTextAreaElement,
  action: FormatAction,
  translate: TFunction,
  setContent: (v: string) => void,
  markDirty: () => void,
) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  const lineStart = before.lastIndexOf("\n") + 1;
  const currentLine = before.slice(lineStart);

  let result: string;
  let cursorStart: number;
  let cursorEnd: number;

  switch (action) {
    case "bold": {
      const fallback = translate("main.formatSample.boldText", { defaultValue: "粗体文本" });
      const wrapped = `**${selected || fallback}**`;
      result = before + wrapped + after;
      cursorStart = start + 2;
      cursorEnd = cursorStart + (selected || fallback).length;
      break;
    }
    case "italic": {
      const fallback = translate("main.formatSample.italicText", { defaultValue: "斜体文本" });
      const wrapped = `*${selected || fallback}*`;
      result = before + wrapped + after;
      cursorStart = start + 1;
      cursorEnd = cursorStart + (selected || fallback).length;
      break;
    }
    case "heading": {
      const prefix = currentLine.match(/^(#{1,5})\s/);
      if (prefix) {
        const newLevel = prefix[1].length < 5 ? "#".repeat(prefix[1].length + 1) : "#";
        const beforeLine = value.slice(0, lineStart);
        const afterPrefix = value.slice(lineStart + prefix[0].length);
        result = beforeLine + newLevel + " " + afterPrefix;
        const offset = newLevel.length + 1 - prefix[0].length;
        cursorStart = start + offset;
        cursorEnd = end + offset;
      } else if (currentLine.length > 0 && start === end) {
        result = value.slice(0, lineStart) + "## " + value.slice(lineStart);
        cursorStart = start + 3;
        cursorEnd = cursorStart;
      } else if (selected) {
        result = before + `## ${selected}` + after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + selected.length;
      } else {
        result =
          before +
          `## ${translate("main.formatSample.headingText", { defaultValue: "标题" })}` +
          after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + 2;
      }
      break;
    }
    case "hr": {
      const newlineBefore = before.endsWith("\n") || before === "" ? "" : "\n";
      const newlineAfter = after.startsWith("\n") || after === "" ? "" : "\n";
      result = before + `${newlineBefore}---${newlineAfter}` + after;
      cursorStart = cursorEnd = before.length + newlineBefore.length + 3;
      break;
    }
    case "ul": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l) => `- ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.listItem", { defaultValue: "列表项" });
        const item = `- ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 2;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "ol": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l, i) => `${i + 1}. ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.listItem", { defaultValue: "列表项" });
        const item = `1. ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "code": {
      if (selected.includes("\n")) {
        const wrapped = "```\n" + selected + "\n```";
        result = before + wrapped + after;
        cursorStart = start + 4;
        cursorEnd = cursorStart + selected.length;
      } else {
        const fallback = translate("main.formatSample.codeText", { defaultValue: "代码" });
        const wrapped = `\`${selected || fallback}\``;
        result = before + wrapped + after;
        cursorStart = start + 1;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "quote": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.quoteText", { defaultValue: "引用文本" });
        const item = `> ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 2;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "inlineMath": {
      const wrapped = `$${selected || "E=mc^2"}$`;
      result = before + wrapped + after;
      cursorStart = start + 1;
      cursorEnd = cursorStart + (selected || "E=mc^2").length;
      break;
    }
    // 段落对齐。换行、选区、撤销都交给 `applyAlign` 算好，这里只做搬运 ——
    // 它返回的 [start, end) 就是那段正文在新文本里的位置，所以连着点几下能一路切换。
    case "alignLeft":
    case "alignCenter":
    case "alignRight": {
      const kind =
        action === "alignLeft" ? "left" : action === "alignRight" ? "right" : ("center" as const);
      const edit = applyAlign(value, start, end, kind);

      result = edit.text;
      cursorStart = edit.start;
      cursorEnd = edit.end;
      break;
    }
    case "blockMath": {
      const wrapped = `\n$$\n${selected || "x^2 + y^2 = r^2"}\n$$\n`;
      result = before + wrapped + after;
      cursorStart = start + 4;
      cursorEnd = cursorStart + (selected || "x^2 + y^2 = r^2").length;
      break;
    }
  }

  textarea.focus();
  textarea.setSelectionRange(0, value.length);
  document.execCommand("insertText", false, result);
  setContent(result);
  markDirty();
  requestAnimationFrame(() => {
    textarea.setSelectionRange(cursorStart, cursorEnd);
  });
}

interface LoadEpoch {
  // 开始一次新的异步加载，返回本次 epoch token；之后用 isCurrent 校验是否仍然有效
  bump: () => number;
  // 只读取当前 epoch 而不自增：用于"记录事件到达瞬间的代次，期间若发生切换则过期"
  peek: () => number;
  // 异步完成后调用：仅当期间未发生新的 bump（用户未切换/重载）时为 true
  isCurrent: (token: number) => boolean;
}

// 统一封装"加载竞态守卫"：每次切换/加载笔记自增 epoch，异步结果回来后用
// isCurrent 判断是否过期。集中此处后，新增异步加载路径只需 bump/isCurrent 两步，
// 避免裸 ref 在多处内联导致的"忘记连线 → stale 结果覆盖新选中"竞态回归
function useLoadEpoch(): LoadEpoch {
  const ref = useRef(0);
  return useMemo<LoadEpoch>(
    () => ({
      bump: () => (ref.current += 1),
      peek: () => ref.current,
      isCurrent: (token: number) => ref.current === token,
    }),
    [],
  );
}

interface MainWindowProps {
  initialSettingsOpen?: boolean;
  initialConfig?: AppConfig;
}

/**
 * 高亮层的**一行**。
 *
 * 这一层原先是一整块 `dangerouslySetInnerHTML`：内容一变，浏览器就把整串 HTML 重新
 * 解析一遍、把整棵子树拆了重建。几千行的文档里改一个字符，代价是 O(全文) 的 DOM 重建
 * —— 那才是输入卡顿的主因，不是分词。
 *
 * 拆成一行一个组件之后，React 按 key 对齐，`memo` 的逐行比较只认 HTML 字符串：没变的
 * 行连属性都不重设，DOM 一个字节都不动。改一行就只改一行。
 */
const HighlightLine = memo(
  function HighlightLine({ html }: { html: string }) {
    return (
      <div
        className="relative"
        // 空行必须垫一个零宽空格：空 `<div>` 里没有行盒，高度会塌成 0，后面的行
        // 全部上移一行，与 textarea 彻底错位。零宽不占宽度，只把行盒撑出来。
        dangerouslySetInnerHTML={{ __html: html === "" ? "\u200b" : html }}
      />
    );
  },
  (prev, next) => prev.html === next.html,
);

/**
 * 行旁注层的**一行**。
 *
 * 行号是逐行渲染的，几千行就是几千个节点。没有 `memo` 的话，每敲一个键都要把这
 * 几千个节点重新构造一遍 —— 编辑一行，代价却是全文。这里按「这一行的原文 + 这一行
 * 各栏的文字」做逐行比较，没变的行直接跳过，DOM 一个字节都不动。
 */
const GutterRow = memo(
  function GutterRow({
    line,
    cells,
    laneWidths,
    totalWidth,
  }: {
    line: string;
    cells: readonly string[];
    laneWidths: readonly number[];
    totalWidth: number;
  }) {
    return (
      <div className="relative">
        <div
          className="absolute top-0 flex justify-end"
          style={{ right: "100%", width: totalWidth }}
        >
          {cells.map((cell, index) => (
            <span
              key={index}
              className="font-mono tabular-nums text-right pr-2 text-ink-ghost/60"
              style={{ width: laneWidths[index], fontSize: "10px" }}
            >
              {cell}
            </span>
          ))}
        </div>
        {/* 这一行的原文，只用来撑出行高。空行垫一个零宽空格，否则高度塌成 0，
            后面的行号会整体上移一行。 */}
        <span style={{ visibility: "hidden" }}>{line === "" ? "\u200b" : line}</span>
      </div>
    );
  },
  // 逐行比较。栏宽/栏数变了也要重渲染，所以把宽度也编进比较里。
  (prev, next) =>
    prev.line === next.line &&
    prev.totalWidth === next.totalWidth &&
    prev.laneWidths.join("|") === next.laneWidths.join("|") &&
    prev.cells.length === next.cells.length &&
    prev.cells.every((cell, index) => cell === next.cells[index]),
);

/**
 * 字符偏移落在第几行（0 起）。
 *
 * 线性扫一遍就是最快的办法：`split` 要先切出一整个数组，十几万字符下反而更贵。
 */
function lineIndexAtOffset(text: string, offset: number): number {
  const limit = Math.min(offset, text.length);
  let line = 0;
  for (let index = 0; index < limit; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * 用**高亮层**把一个字符区间换算成它在编辑区里的矩形。
 *
 * 高亮层就是浏览器按与 textarea **完全相同**的文本、宽度、字体排出来的那一份布局本身，
 * 问它不会错 —— 编辑区打字、光标、正文对位都正常，说明它就是准的。
 *
 * 这里原先走 `measureSelectionRects`：它另起一个 div、复制 textarea 的样式再排一遍。那是
 * 一份**手工维护的复制品**，只要有一处样式没复制对（字体、内容宽度、盒模型……），换行位置
 * 就和真实编辑区错开，错误还会随行数累积 —— 表现为「在预览里框选一段文字，编辑区的高亮框
 * 落到了下一行」。
 *
 * 坐标口径：返回值用**层的边框盒**作原点，与调用方渲染高亮框的容器同源（两者都是编辑区里
 * 同一个 `relative` 父盒的绝对定位子元素，层又是它的第一个子元素，静态位置就在父盒内容区
 * 顶部），所以不需要任何换算常数。
 *
 * 返回 `null` 表示层不可用（放弃着色时它是空的），调用方自行回退到镜像测量。
 */
function lineRectsFromLayer(
  layer: HTMLElement | null,
  text: string,
  start: number,
  end: number,
): SelectionRect[] | null {
  if (!layer || layer.children.length === 0) return null;

  const firstLine = lineIndexAtOffset(text, start);
  const lastLine = lineIndexAtOffset(text, Math.max(start, end - 1));
  const origin = layer.getBoundingClientRect();

  const rects: SelectionRect[] = [];
  // 逐行推进，不重复扫描正文：第一行的行首就是 start 前面那个换行符之后。
  let lineStart = text.lastIndexOf("\n", start - 1) + 1;

  for (let index = firstLine; index <= lastLine; index += 1) {
    const breakAt = text.indexOf("\n", lineStart);
    const lineStop = breakAt === -1 ? text.length : breakAt;
    const node = layer.children[index];

    // 源码里的字符区间 → 这一行里的字符区间。空行没有文本节点，单独给一条细带，
    // 否则跨空行的选区会在那儿断掉。
    const from = Math.max(0, start - lineStart);
    const to = Math.min(end, lineStop) - lineStart;
    const range = node instanceof HTMLElement && to > from ? rangeOverText(node, from, to) : null;

    if (range) {
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 && rect.height === 0) continue;
        rects.push({
          top: rect.top - origin.top,
          left: rect.left - origin.left,
          width: rect.width,
          height: rect.height,
        });
      }
    } else if (lineStop === lineStart && node instanceof HTMLElement) {
      // 只给**空行**补细带：非空行出现空区间，说明选区恰好停在这一行的边界上，
      // 那行本来就没被选中，画出来反而多一条。
      rects.push({
        top: node.offsetTop,
        left: 0,
        width: 2,
        height: node.offsetHeight,
      });
    }

    lineStart = lineStop + 1;
  }

  return rects.length > 0 ? rects : null;
}

/**
 * 在一行的高亮 HTML 里截出第 `from`～`to` 个字符的 Range。
 *
 * 高亮层每一行的 DOM 文本就是**该行源码**：hljs 只在外面包了 `<span>`，一个字符都没增删。
 * 所以按文本节点累加长度就能定位字符 —— 不必按 HTML 结构去猜。
 */
function rangeOverText(root: HTMLElement, from: number, to: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const length = textNode.data.length;

    if (!startNode && seen + length >= from) {
      startNode = textNode;
      startOffset = from - seen;
    }
    if (seen + length >= to) {
      endNode = textNode;
      endOffset = to - seen;
      break;
    }
    seen += length;
  }

  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, Math.min(startOffset, startNode.data.length));
  range.setEnd(endNode, Math.min(endOffset, endNode.data.length));
  return range;
}

/**
 * 行内装饰的色块。
 *
 * 做得很小（9px）是有意的：它只能**叠**在正文上 —— 正文是一个真实的 `<textarea>`，
 * 字符位置由浏览器排版所有，往高亮层里插元素不会让 textarea 的字符跟着挪。所以色块
 * 摆在颜色字面量**前面那个空格**上，代价最小（`color:#fff` 这种没空格的写法会盖住 `:`）。
 * （VS Code 能推开文字是因为它的编辑器是自绘的，这里做不到。）
 */
const EDITOR_SWATCH_SIZE = 9;
const EDITOR_SWATCH_GAP = 1;
/** 一次最多渲染多少个。畸形文件不该把编辑区拖垮。 */
const MAX_EDITOR_SWATCHES = 300;
/**
 * 选色防抖。
 *
 * `<input type="color">` 在 Chrome 里**拖动时就会连续发事件**（React 的 onChange 绑的就是
 * 它），不防抖的话一次拖动要写几十遍正文：几十条撤销记录、几十轮插件重算。等手停下来再写。
 */
const SWATCH_PICK_DEBOUNCE_MS = 160;

interface EditorSwatch {
  key: string;
  left: number;
  top: number;
  color: string;
  offset: number;
  length: number;
  decoration: PluginDecoration;
}

export function MainWindow({
  initialSettingsOpen = false,
  initialConfig = undefined,
}: MainWindowProps = {}) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [externalFiles, setExternalFiles] = useState<ExternalFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(
    normalizeViewMode(initialConfig?.defaultViewMode ?? "split"),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [content, setContent] = useState("");

  /* TEMP-PERF */
  const perfRef = useRef({ typedAt: 0, tokenize: 0, mirror: 0, hljs: 0 });
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [findMatches, setFindMatches] = useState<Array<{ start: number; end: number }>>([]);
  const [currentFindIndex, setCurrentFindIndex] = useState(-1);
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [noteMenu, setNoteMenu] = useState<NoteMenuState | null>(null);
  const [noteMenuClosing, setNoteMenuClosing] = useState(false);
  const [activePanelId, setActivePanelId] = useState<string | null>(
    initialSettingsOpen && initialConfig ? "settings" : null,
  );

  /**
   * 只读说明文档（「关于」那几篇、插件详细信息）。
   *
   * 有值时正文区显示它而不是当前笔记。内容是**内存里的字符串**，既不是磁盘上的笔记、
   * 也不是外部文件 —— 所以它绕开保存路由，也完全不碰 `externalFiles`（那个列表同时
   * 还是「这是不是外部文件」的判据，往里塞东西会连累保存逻辑）。
   *
   * 用户在左侧选了别的东西就把它清掉（见三处 `setSelectedId`）：文档是「临时看一眼」，
   * 不该粘在笔记上面不走。
   */
  const [docView, setDocView] = useState<{ title: string; content: string } | null>(null);
  const [standalonePanels, setStandalonePanels] = useState<PluginPanelDef[]>(() =>
    listPluginPanels().filter((panel) => panel.standalone),
  );
  // 订阅插件缓存 store：v2 面板的 HTML 与行旁注的逐行文字都是异步拉取后写进缓存的，
  // 更新时要触发重渲染。revision 留着 —— 行旁注的 useMemo 要靠它判断该不该重算。
  const pluginStoreRevision = useSyncExternalStore(
    subscribePluginStores,
    pluginStoresRevision,
    pluginStoresRevision,
  );
  const editorGutterList = useSyncExternalStore(
    subscribeEditorGutters,
    listEditorGutters,
    listEditorGutters,
  );
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [activeSelection, setActiveSelection] = useState<Selection | null>(null);
  const [highlightRects, setHighlightRects] = useState<SelectionRect[]>([]);
  const [editorScrollTop, setEditorScrollTop] = useState(0);
  const [matchedRange, setMatchedRange] = useState<{ start: number; end: number } | null>(null);
  const [mountedSidePanel, setMountedSidePanel] = useState<SidePanelMode | null>(
    initialSettingsOpen && initialConfig ? "settings" : null,
  );
  const [sidePanelContentVisible, setSidePanelContentVisible] = useState(
    Boolean(initialSettingsOpen && initialConfig),
  );
  const [settingsConfig, setSettingsConfig] = useState<AppConfig | null>(initialConfig ?? null);
  const settingsLoadedRef = useRef(false);
  const [activeExplorer, setActiveExplorer] = useState<string>(EXPLORER_NOTES);
  const [workspaceFolders, setWorkspaceFolders] = useState<string[]>([]);
  /** 移除一个有缓存的工作文件夹时，等用户在确认框上选「保留还是删掉」。 */
  const [pendingFolderRemoval, setPendingFolderRemoval] = useState<{
    path: string;
    info: WorkspaceCacheInfo;
  } | null>(null);
  const [savedDataDir, setSavedDataDir] = useState<string | null>(initialConfig?.dataDir ?? null);

  /**
   * 保存的文件如果落在某个插件**自己的目录**里，就通知那个插件。
   *
   * 用途是「改完插件样式表，保存即生效」—— 否则用户每次都得回插件面板点「重新加载」。
   * 只覆盖**在花笺里保存**这一条路；用外部编辑器改文件不会触发（那需要一个文件监视器，
   * 是另一件事）。
   */
  const notifyPluginAssetSaved = useCallback(
    (path: string) => {
      const owner = pluginOwningPath(savedDataDir ?? "", path);
      if (owner) emitFloralEvent("plugin:assetsChanged", { plugin: owner, path });
    },
    [savedDataDir],
  );
  const [noteTransitionKey, setNoteTransitionKey] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteExiting, setDeleteExiting] = useState(false);
  /** 整个主窗口是否钉在最前（**不是**再开一个磁贴窗）。 */
  const [windowPinned, setWindowPinned] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  /**
   * 「导出 PDF」面板。内容在**打开那一刻**就定下来：面板开着的时候用户还能在背后改笔记，
   * 但我们导的是他点下那一刻看到的那一份。
   */
  const [pdfPanel, setPdfPanel] = useState<{ title: string; bodyHtml: string } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [showCategoryInput, setShowCategoryInput] = useState(false);
  const [categoryInputValue, setCategoryInputValue] = useState("");
  const [noteMenuMode, setNoteMenuMode] = useState<"main" | "move">("main");
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renameCategoryValue, setRenameCategoryValue] = useState("");
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const [settingsOverlay, setSettingsOverlay] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 1080 : true,
  );
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [categoryMenu, setCategoryMenu] = useState<CategoryMenuState | null>(null);
  const [categoryMenuClosing, setCategoryMenuClosing] = useState(false);
  const [categoryMenuConfirmDelete, setCategoryMenuConfirmDelete] = useState(false);
  const [categoryMenuHoverSuppressed, setCategoryMenuHoverSuppressed] = useState(false);
  const { popupRef: noteMenuRef, popupPosition: noteMenuPosition } = useViewportPopupPosition(
    noteMenu,
    `${noteMenuMode}:${categories.length}`,
  );
  const { popupRef: categoryMenuRef, popupPosition: categoryMenuPosition } =
    useViewportPopupPosition(categoryMenu, categoryMenuConfirmDelete);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  /** 逐行高亮层。跳转时直接问它「第 N 行在哪儿」，不必再造镜像测量。 */
  const highlightLayerRef = useRef<HTMLDivElement>(null);
  const windowLabelRef = useRef("main");
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const blockOffsets = useRef<number[]>([]);
  const scrollSource = useRef<"editor" | "preview" | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureRafRef = useRef<number>(0);
  const measureControllerRef = useRef<AbortController | null>(null);
  const externalFileMtimeRef = useRef<number>(0);
  const lastExternalSaveRef = useRef<number>(0);
  const imageBaseDir = useImageBaseDir();
  const saveStateRef = useRef(saveState);
  const isMacOS = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      (/Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac"))
    );
  }, []);
  saveStateRef.current = saveState;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const titleValueRef = useRef(title);
  titleValueRef.current = title;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const externalFilesRef = useRef(externalFiles);
  externalFilesRef.current = externalFiles;
  // 每次"应用/切换当前笔记"都会自增；异步加载完成后若 epoch 已变化，说明用户
  // 已切换到别处，该次结果直接丢弃，避免旧的加载结果覆盖新选中的笔记
  const loadEpoch = useLoadEpoch();
  // 串行化所有保存请求，避免自动保存与切换触发的保存并发写同一篇笔记
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * 「保存当前笔记/外部文件」的间接引用。
   *
   * `loadExternalFile` 要在切换文件前先保存（自动保存是 900ms 防抖的，切走时计时器会被
   * 取消，不补这一下就会丢刚敲的字），但它定义在 `saveCurrentNote` **之前** —— 把后者写进
   * 依赖数组会在渲染期撞上 TDZ。用 ref 绕开，和上面的 `externalFilesRef` 一个路子。
   */
  const saveCurrentNoteRef = useRef<(force?: boolean) => Promise<boolean>>(async () => true);

  // 应用自更新。没配端点时这个 hook 什么都不做（连一次请求都不发），标题栏也不会多出东西。
  const update = useUpdate();

  const pluginStatusItems = usePluginStatusBar(activeSelection);
  /** 内容过大时放弃着色，让 textarea 直接显示文字（见其 color 的取值）。 */
  const highlightDisabled = content.length > MAX_HIGHLIGHT_CHARS;
  useEffect(() => {
    // 编辑器访问器由 createEditorAccessor 统一实现；NotePad 用的是同一份，
    // 避免两处逐字重复后各自漂移。
    registerActiveContent(
      createEditorAccessor({
        getTextArea: () => contentRef.current,
        getContent: () => contentValueRef.current,
        setContent: (value) => setContent(value),
        markDirty: () => {
          if (selectedIdRef.current) {
            saveStateRef.current = "dirty";
            setSaveState("dirty");
          }
        },
      }),
    );
    return () => registerActiveContent(null);
  }, []);

  // 事件总线：把 Tauri 侧（笔记/配置变更）与窗口焦点事件接上。
  useEffect(() => installFloralEventBridge(), []);

  // 内容与选区变化广播给插件。内容侧自带 150ms 节流。
  useEffect(() => {
    emitContentChanged(content);
  }, [content]);

  useEffect(() => {
    emitFloralEvent("editor:selectionChanged", activeSelection);
  }, [activeSelection]);

  useEffect(() => {
    emitFloralEvent("workspace:ready", undefined);
  }, []);

  useEffect(() => {
    void loadPlugins().then(() => {
      /**
       * 插件加载完了再看一眼市场：开了「自动更新」的那几个插件如果有新版，顺手装上。
       *
       * 只挂在**主窗口**上：快速便签窗口也走同一个 `loadPlugins()`，两个窗口同时去装
       * 同一个插件会互相踩。这个函数自己会判断「有没有开了自动更新的插件」，没有的话
       * 一个网络请求都不发。
       */
      void runStartupAutoUpdatesQuietly();
    });
  }, []);

  useEffect(() => {
    registerEditorJump((offset) => {
      const textarea = contentRef.current;
      if (!textarea) return;

      /**
       * 直接问高亮层要位置，不再造镜像测量。
       *
       * 高亮层现在是**一行一个 div**（见 HighlightLine），所以「第 N 行在哪儿」直接读
       * `children[N].offsetTop` 就有 —— O(1)。
       *
       * 原先走 `measureSelectionRects`：它每次新建一个镜像 div、把整篇正文塞进去、
       * 强制一次全文布局。十几万字符的笔记里，点一次目录要等 0.5 秒，全耗在这上面。
       */
      const lineIndex = lineIndexAtOffset(textarea.value, offset);
      const lineNode = highlightLayerRef.current?.children[lineIndex];
      if (lineNode instanceof HTMLElement) {
        textarea.scrollTop = lineNode.offsetTop;
        return;
      }

      // 放弃着色时（超大文档）高亮层是空的，退回镜像测量。
      const rects = measureSelectionRects(textarea, offset, offset + 1);
      if (rects.length > 0) {
        textarea.scrollTop = rects[0].top;
      }
    });

    registerPreviewJump((offset) => {
      const preview = previewScrollRef.current;
      if (!preview) return;

      /**
       * 跳转前先把纸张缩放归 1。
       *
       * 缩放是 `transform`，**不参与布局** —— 撑开层给的是「缩放后」的尺寸，而
       * `getBoundingClientRect()` 量到的是「已经缩放」的视觉位置。两者要换算成滚动
       * 坐标，差一个倍率就整段跑偏；而且缩放态下正文的换行位置没变，跳过去也只是
       * 看个大概，本来就没意义。归位之后再跳，落点就是确定的。
       *
       * 跳完**停在 100%**，不还原：目录是拿来导航的，导航完还在放大状态里继续读
       * 一个错位的视图，比丢掉倍率更难受。
       */
      if (previewZoomRef.current !== 1) {
        previewZoomRef.current = 1;
        setPreviewZoom(1);
      }

      // 等这一帧把 transform 与撑开层都改完再量。同一帧里量的话拿到的还是缩放态的
      // 位置；下一帧读 rect 会强制同步布局，拿到的是归位后的真实位置。
      requestAnimationFrame(() => {
        if (previewScrollRef.current !== preview) return;
        // 预览模式下滚动同步未启用，data-block-index 可能还没设置，这里补一次
        tagPreviewBlocks(preview, content);
        const line = content.slice(0, offset).split("\n").length - 1;
        const blocks = parseBlocks(content);
        const blockIndex = blocks.findIndex((b) => b.startLine <= line && line < b.endLine);
        if (blockIndex < 0) return;

        const el = preview.querySelector<HTMLElement>(`[data-block-index="${blockIndex}"]`);
        if (!el) return;

        const elRect = el.getBoundingClientRect();
        const previewRect = preview.getBoundingClientRect();
        preview.scrollTop += elRect.top - previewRect.top;
      });
    });

    return () => {
      registerEditorJump(null);
      registerPreviewJump(null);
    };
  }, [content]);

  useEffect(() => {
    notifyContentChanged();
  }, [content]);

  /**
   * 设置面板的数据来源。
   *
   * **每次打开面板都重新拉一次配置**，而不是只在 `settingsConfig` 为空时拉一次。
   * 有些配置项在别处也会被改——托盘菜单的「关闭到托盘 / 开机自启」就是——那些改动
   * 只会在后端广播 `config-changed`，而 MainWindow 并不监听它。于是面板里显示的
   * 还是上次打开时的旧值，用户会以为"设置没生效 / 改了回去"。
   *
   * `defaultViewMode` 只在**首次**加载时应用：它叫"默认视图"，每开一次设置面板就拿它
   * 覆盖用户当前选择是不对的。
   */
  useEffect(() => {
    if (activePanelId !== "settings") return;
    let cancelled = false;
    void getConfig()
      .then((config) => {
        if (cancelled) return;
        setSettingsConfig(config);
        setSavedDataDir(config.dataDir);
        if (!settingsLoadedRef.current) {
          settingsLoadedRef.current = true;
          setViewMode(normalizeViewMode(config.defaultViewMode));
        }
      })
      .catch((error) => {
        if (!cancelled) showToast(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [activePanelId]);

  useEffect(() => {
    return subscribePluginPanels(() =>
      setStandalonePanels(listPluginPanels().filter((panel) => panel.standalone)),
    );
  }, []);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  );
  const selectedNoteRef = useRef(selectedNote);
  selectedNoteRef.current = selectedNote;

  const selectedExternalFile = useMemo(
    () => externalFiles.find((f) => f.id === selectedId) ?? null,
    [externalFiles, selectedId],
  );

  /**
   * 侧栏「外部文件」那一栏要列出来的条目。
   *
   * **只影响显示**：从工作区树点开的文件仍留在 `externalFiles` 里（保存路由与
   * 「这算不算外部文件」的判据都靠它），只是不列出来。详见 `listableExternalFiles`。
   */
  const listedExternalFiles = useMemo(
    () => listableExternalFiles(externalFiles),
    [externalFiles],
  );

  /** 当前打开的外部文件路径。工作文件夹里的文件也走同一条通道。 */
  const activeFilePath = selectedExternalFile?.filePath ?? null;

  // 订阅文件类型注册表：插件装上之后，**已经打开**的文件也能立刻切到预览形态。
  const fileTypes = useSyncExternalStore(subscribeFileTypes, listFileTypes, listFileTypes);

  /** 当前文件对应的类型声明；扩展名没被任何插件认领时为 null。 */
  /**
   * 当前文件的扩展名（小写、不含点）。笔记没有磁盘文件，为 null。
   *
   * 按**文件名**取而不是对整个路径 `lastIndexOf(".")`：路径里任何一层目录带点
   * （`E:\a.b\Makefile`）都会算出一个荒唐的扩展名，运气不好还会撞上真实类型。
   */
  const activeFileExtension = useMemo(() => {
    if (!activeFilePath) return null;
    const separator = Math.max(activeFilePath.lastIndexOf("/"), activeFilePath.lastIndexOf("\\"));
    const name = activeFilePath.slice(separator + 1);
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index + 1).toLowerCase() : null;
  }, [activeFilePath]);

  const selectedFileType = useMemo(
    () => matchFileType(activeFileExtension),
    // fileTypes 只是为了让注册表变化时重新匹配。
    [activeFileExtension, fileTypes],
  );

  /**
   * 当前文档的形态。「有没有编辑器」和「有没有预览面板」是**两件独立的事**：
   *
   * - 编辑器：`code` / `text` / `markdown` / `table` 有；图片 / 媒体 / 插件自定义没有。
   * - 预览面板：只在该类型**定义过预览**时才有 —— `markdown` 走 Markdown 渲染，
   *   `table` 解析成表格；而 `code` / `text` 没有预览，打开就只是编辑器。
   *
   * 于是「编辑 / 分栏 / 预览」这组只在两者兼备时出现，其余情况要么只给编辑器、
   * 要么只给预览（`.py`、`.json`、`.log` 都不会再挂一个空的预览窗格）。
   */
  const standalonePreview = selectedFileType !== null && !isEditableKind(selectedFileType.kind);
  /**
   * 预览面板的出现条件：**笔记**，以及确实声明了预览的格式（`.md` / `.csv`）。
   *
   * 不再用「类型为 null 就有预览」兜底：那等于把「扩展名没被任何插件认领」也算成
   * 有预览，拖进来一个不认识的格式就会平白多出一个 Markdown 窗格。没有声明就没有。
   */
  const showPreviewPane =
    selectedExternalFile === null ||
    (selectedFileType !== null && hasPreviewPaneKind(selectedFileType.kind));

  /**
   * **实际**生效的视图形态。
   *
   * `viewMode` 是用户的选择，会跨文件保留：在 `.md` 里选了「分栏」，再打开 `.py`，
   * `viewMode` 仍然是 `split` —— 于是编辑器只占一半宽度、右边那个预览面板又不渲染，
   * 剩下的地方就是一大片空白，中间还杵着一根拖拽手柄。
   *
   * 所以「有没有预览面板」必须由**文件类型**说了算，不能由残留的 `viewMode` 说了算：
   * 没有预览面板时一律按「编辑」处理。`viewMode` 本身不动，切回笔记时用户原来的
   * 选择还在。
   */
  const effectiveViewMode: ViewMode = showPreviewPane ? viewMode : "edit";

  /** 推给插件的文件身份。笔记没有磁盘路径，也没有文件类型。 */
  const pluginFileInfo: EditorFileInfo | null = activeFilePath
    ? {
        path: activeFilePath,
        typeId: selectedFileType?.id ?? null,
        kind: selectedFileType?.kind ?? null,
        language: selectedFileType?.language ?? null,
      }
    : null;

  // 把编辑器状态推给 v2 插件（镜像），并在选区变化时刷新它们的状态栏项。
  //
  // ⚠️ 这个 effect 必须待在 `activeFilePath` / `selectedFileType` **之后**：依赖数组
  // 在渲染期就要求值，写在它们前面会 TDZ `ReferenceError`。
  useEffect(() => {
    const mirrorStarted = performance.now(); /* TEMP-PERF */
    updatePluginEditorMirror({
      content,
      selection: activeSelection,
      cursor: contentRef.current?.selectionStart ?? 0,
      activeNoteId: selectedId ?? null,
      file: pluginFileInfo,
    });
    refreshPluginStatusBar(activeSelection);
    perfRef.current.mirror += performance.now() - mirrorStarted; /* TEMP-PERF */
  }, [content, activeSelection, selectedId, pluginFileInfo]);

  /**
   * **只有预览**的文件（图片 / 媒体）也走同一套纸张式缩放 —— 放大看细节正是
   * 打开它们的主要目的。
   *
   * 只给 `image` / `media`：`custom`（插件自绘的 HTML）和 `none` 内部有自己的滚动
   * 与布局，外面再套一层缩放只会互相打架。
   */
  const zoomableStandalone =
    standalonePreview &&
    selectedFileType !== null &&
    activeFilePath !== null &&
    (selectedFileType.kind === "image" || selectedFileType.kind === "media");

  /** 当前视图是不是「纸张式预览」—— 可以 Ctrl+滚轮缩放、按住空格拖动。 */
  const isPaperPreview = zoomableStandalone || (showPreviewPane && effectiveViewMode === "preview");

  /**
   * 纸张预览的「身份」。缩放层与拖拽监听都挂在 DOM 上，而这个 DOM 会随视图形态
   * 整体重建；只盯 `selectedId` 的话，「笔记预览 → 图片预览」这种两边都是纸张预览、
   * 元素却已经换了一个的切换就漏掉了，监听会留在已卸载的节点上。
   */
  const paperPreviewKey = isPaperPreview ? (zoomableStandalone ? "file" : "pane") : "none";

  /**
   * 编辑器字体：有语法的文件（代码 / 纯文本 / 表格）改用等宽字体。
   *
   * 除了「一眼能与笔记区分开」，等宽还有实际作用：列对齐、缩进层级、代码里的标点
   * 宽度都靠它才对得上。
   *
   * ⚠️ textarea 与它上面那层高亮**必须用同一字体和行高** —— 两者错位的话，
   * 光标会和文字对不上。所以两处共用这一个常量，不要各写各的。
   */
  const usesCodeFont =
    selectedFileType !== null &&
    isEditableKind(selectedFileType.kind) &&
    selectedFileType.kind !== "markdown";
  const editorFontClass = usesCodeFont ? "font-mono leading-[1.6]" : "font-body leading-[1.9]";

  /** 插件可以给某个格式单独指定字体；留空就用上面的默认。 */
  const editorFontFamily = selectedFileType?.font;

  /** 笔记文档（非外部文件）。插入图片要往笔记的 images 目录写文件，只对笔记成立。 */
  const isNoteDocument = selectedExternalFile === null;

  /**
   * 顶部那一行按**当前打开的是什么**编排。
   *
   * 那一行放的是**文档级动作**（导出、删除、开右侧栏的插件面板）；插件视图自己那排
   * （`view.toolbar`：翻页、缩放、标注工具）是**视图内的小工具**，两者不是一回事。
   * 「属于哪一类」的判据抽在 `documentContextOf` 里，好单独测 —— 它判错只表现为
   * 「按钮多一个少一个」，不报错、不崩，肉眼在代码里很难看出来。
   *
   * 取舍：**文件专属的按钮按上下文整组换**（插入图片只对笔记成立、导出 PDF 对 PDF 不成立），
   * 而**通用按钮保留原位、不适用时禁用**，位置稳定才不会每次换文件都要重新找。
   * 只有【完全没有可编辑正文】的上下文（PDF、图片、说明文档）才让通用按钮一并让位 ——
   * 那时候一排全灰的按钮比没有更难看。
   */
  const documentContext = documentContextOf({
    docView: docView !== null,
    isNoteDocument,
    fileKind: selectedFileType?.kind ?? null,
  });

  /** 当前上下文有没有一段可编辑的正文（撤销/重做只对它们成立）。 */
  const hasEditableBody =
    documentContext === "note" ||
    documentContext === "markdown" ||
    documentContext === "table" ||
    documentContext === "code" ||
    documentContext === "text";

  /** 导出下拉里有哪几项。空 = 这一行不出导出按钮（判据在 documentContext.ts 里，可单测）。 */
  const exportFormats = exportFormatsFor(documentContext);

  /**
   * 只读说明文档把正文顶掉了，顶上这一行整体让它一让 —— 这时候连选中都还留在
   * 背后那篇笔记上，任何按钮点下去都是作用在别的东西上。
   */
  const toolbarIdle = documentContext === "doc";

  /**
   * 右侧栏那块插件面板按它分桶存内容（见 `stores.ts` 的 `setPanelHtml`）。
   * **必须与 `v2Host` 写的一侧用同一个函数算**，所以走 `panelFileKeyOf` 而不是在这儿
   * 再写一遍 `path ?? id`。
   */
  const panelFileKey = panelFileKeyOf({ path: activeFilePath, noteId: selectedId });

  /** 没有行旁注时，正文的左边距 —— 对应容器原本的 `px-5`。 */
  const EDITOR_BASE_PADDING = 20;

  /**
   * 有行旁注时，那一栏离编辑区左边缘留多少。
   *
   * 刻意比 `EDITOR_BASE_PADDING` 小得多：那段内边距是给**正文**的呼吸，而行号是边栏，
   * 它和正文之间本来就还有 8px 间隔（`pr-2`）。两段留白叠在一起，数字会被推到离左边缘
   * 四十多像素的地方 —— 看着就像白扔了一块。
   */
  const EDITOR_GUTTER_EDGE = 4;

  /**
   * 编辑区左侧的行旁注栏。
   *
   * 插件只出**文字**（每行一条），排版全部由这里负责：把每一行的原文再排一遍（不可
   * 见），让它按与编辑器**完全相同**的宽度、字体、制表位去换行 —— 行高因此天然对得
   * 上，一行折成三行时行号也只出现在第一行。插件量不到编辑器的换行与行高，把排版
   * 交给它只会得到一根对不齐的栏。
   */
  const editorGutterRows = useMemo(() => content.split("\n"), [content]);
  const editorGutters = useMemo(
    () => editorGutterList.map((gutter) => ({ ...gutter, lines: getGutterLines(gutter.id) })),
    [editorGutterList, pluginStoreRevision],
  );
  const editorGutterWidth = editorGutters.reduce((total, gutter) => total + gutter.width, 0);
  /** 各栏的宽度。行组件拿它排每一格，memo 比较里也用它。 */
  const gutterLaneWidths = useMemo(
    () => editorGutters.map((gutter) => gutter.width),
    [editorGutters],
  );
  /** 正文列的左边界。有行旁注时整体右移，腾出那一栏。 */
  const editorTextLeft =
    editorGutterWidth > 0 ? EDITOR_GUTTER_EDGE + editorGutterWidth : EDITOR_BASE_PADDING;

  /**
   * 行内装饰（颜色块这类贴着字符的小控件）。
   *
   * 插件只给「哪个字符区间、什么颜色」，**位置由宿主从高亮层量**（`lineRectsFromLayer`）——
   * 与选区高亮走的是同一条路径：高亮层就是浏览器按真实编辑区排出来的那份布局，问它不会错。
   */
  const editorDecorationList = useSyncExternalStore(
    subscribeDecorations,
    listDecorations,
    listDecorations,
  );
  const editorDecorations = useMemo(
    () =>
      editorDecorationList.map((decoration) => ({
        decoration,
        items: getDecorationItems(decoration.id),
      })),
    [editorDecorationList, pluginStoreRevision],
  );

  /**
   * 这份内容是不是「可以当 Markdown 编辑」。
   *
   * 笔记本身就是 Markdown；`.md` / `.markdown` 在注册表里是 `kind: "markdown"`。
   * 其余一律不算 —— 往 `.py` 里插 `**加粗**`、`# 标题` 不是「不支持」，是错的。
   *
   * ⚠️ 别拿 `showPreviewPane` 当判据：它把 `table`（.csv）也算进来了，而 csv 是
   * 数据不是文档，格式化对它同样没有意义。
   */
  const markdownEditorActive = isNoteDocument || selectedFileType?.kind === "markdown";

  /**
   * 状态栏中段显示的那个「格式」。
   *
   * 笔记与 `.md` 是 Markdown（且预览支持 LaTeX）；其余报**它的类型名** —— 名字来自
   * 文件类型注册表，也就是声明这个格式的那个插件（`.py` → Python，`.csv` → 表格）。
   * 认不出的格式退回扩展名大写：写「PY」也比一律写「Markdown + LaTeX」诚实，
   * 后者会让人以为渲染管线给这份文件做了什么。
   */
  const statusFormatLabel = markdownEditorActive
    ? t("main.statusBar.format", { defaultValue: "Markdown + LaTeX" })
    : (selectedFileType?.label ??
      activeFileExtension?.toUpperCase() ??
      t("main.statusBar.plainText", { defaultValue: "纯文本" }));

  /**
   * 代码文件的语法标注。
   *
   * 编辑器的高亮层本来就是「一层 HTML 垫在透明 textarea 底下」，所以只要换掉高亮
   * 来源即可 —— 不必为代码文件另做一套只读视图，那样就丢了「可编辑并写回磁盘」。
   */
  const [codeHighlightedHtml, setCodeHighlightedHtml] = useState<string | null>(null);

  /**
   * 高亮层的逐行 HTML。`null` 表示放弃着色 —— 那时文字由 textarea 自己显示。
   *
   * 两条来源各有各的切法：hljs 吃的是整篇代码（多行字符串、块注释都靠跨行上下文），
   * 输出里一个 `<span>` 可能横跨好几行，必须按标签安全地切开；而 Markdown 那边本来就
   * 是逐行、无状态的分词，直接按行渲染并缓存即可。
   */
  const highlightedLines = useMemo(() => {
    const started = performance.now(); /* TEMP-PERF */
    const result = (() => {
      if (highlightDisabled) return null;
      if (codeHighlightedHtml !== null) return splitHighlightedHtml(codeHighlightedHtml);
      return renderMarkdownLines(content);
    })();
    perfRef.current.tokenize = performance.now() - started; /* TEMP-PERF */
    return result;
  }, [content, codeHighlightedHtml, highlightDisabled]);

  /** 色块的位置。口径与选区高亮一致：相对高亮层的边框盒。 */
  const [editorSwatches, setEditorSwatches] = useState<EditorSwatch[]>([]);

  /**
   * 把「字符区间」量成屏幕位置。
   *
   * 放在 layout effect 里、而不是渲染期：渲染期读 DOM 拿到的还是**上一帧**的布局。
   * 依赖里带上 `highlightedLines` 等一切会改变换行的东西 —— 栏宽一变，同一行的折行位置
   * 就变了，色块会集体错位。
   */
  useLayoutEffect(() => {
    const layer = highlightLayerRef.current;
    const items = editorDecorations.flatMap((entry) =>
      entry.items.map((item) => ({ ...item, decoration: entry.decoration })),
    );

    if (!layer || items.length === 0) {
      // 高亮层为空（超大文档放弃着色）时 `lineRectsFromLayer` 一律返回 null。
      // 这里一并收成空数组，**不**退回镜像测量 —— 装饰是锦上添花，不值得为它引一次全文重排。
      setEditorSwatches((current) => (current.length === 0 ? current : []));
      return;
    }

    if (items.length > MAX_EDITOR_SWATCHES) {
      console.warn(
        `[editor] 行内装饰过多（${items.length} 条），只渲染前 ${MAX_EDITOR_SWATCHES} 条`,
      );
    }

    const next: EditorSwatch[] = [];
    for (const item of items.slice(0, MAX_EDITOR_SWATCHES)) {
      const rect = lineRectsFromLayer(layer, content, item.offset, item.offset + item.length)?.[0];
      if (!rect) continue;
      next.push({
        key: `${item.decoration.id}:${item.offset}`,
        left: Math.max(0, rect.left - EDITOR_SWATCH_SIZE - EDITOR_SWATCH_GAP),
        top: rect.top + (rect.height - EDITOR_SWATCH_SIZE) / 2,
        color: item.color,
        offset: item.offset,
        length: item.length,
        decoration: item.decoration,
      });
    }

    setEditorSwatches(next);
  }, [
    content,
    editorDecorations,
    highlightedLines,
    viewMode,
    editorGutterWidth,
    settingsConfig?.fontSize,
  ]);

  const swatchPickTimers = useRef(new Map<string, number>());

  const queueSwatchPick = useCallback((swatch: EditorSwatch, color: string) => {
    const timers = swatchPickTimers.current;
    const pending = timers.get(swatch.key);
    if (pending) window.clearTimeout(pending);

    timers.set(
      swatch.key,
      window.setTimeout(() => {
        timers.delete(swatch.key);
        swatch.decoration.pick?.(swatch.offset, swatch.length, color);
      }, SWATCH_PICK_DEBOUNCE_MS),
    );
  }, []);

  useEffect(
    () => () => {
      for (const timer of swatchPickTimers.current.values()) window.clearTimeout(timer);
      swatchPickTimers.current.clear();
    },
    [],
  );

  /* TEMP-PERF */
  useLayoutEffect(() => {
    const per = perfRef.current;
    if (!per.typedAt) return;
    const total = performance.now() - per.typedAt;
    per.typedAt = 0;
    // 只在内容真的很大时打点，免得小文档刷屏
    if (content.length > 20000) {
      console.error(
        `[perf] ${(content.length / 1000).toFixed(0)}k字 / ${content.split("\n").length}行 | ` +
          `分词 ${per.tokenize.toFixed(1)}ms | 镜像 ${per.mirror.toFixed(1)}ms | ` +
          `hljs ${per.hljs.toFixed(1)}ms | 到绘制前共 ${total.toFixed(1)}ms`,
      );
    }
    per.hljs = 0;
    per.mirror = 0;
  }, [highlightedLines]);
  useEffect(() => {
    // 高亮来源按类型定：
    //   code            → highlight.js
    //   text / table    → 没有语法，转义后原样输出
    //   笔记 / markdown → 交给自带的 Markdown 分词器（置 null）
    //
    // 最后这条很重要：把 CSV 当 Markdown 着色会满屏乱码色。
    const language = selectedFileType?.kind === "code" ? selectedFileType.language : undefined;

    if (highlightDisabled) {
      setCodeHighlightedHtml("");
      return undefined;
    }

    if (language) {
      let cancelled = false;
      const hljsStarted = performance.now(); /* TEMP-PERF */
      void highlightCode(content, language).then((html) => {
        perfRef.current.hljs = performance.now() - hljsStarted; /* TEMP-PERF */
        if (!cancelled) setCodeHighlightedHtml(html);
      });
      return () => {
        cancelled = true;
      };
    }

    const isPlain =
      selectedFileType?.kind === "code" ||
      selectedFileType?.kind === "text" ||
      selectedFileType?.kind === "table";
    setCodeHighlightedHtml(isPlain ? escapeHtmlEntities(content) : null);
    return undefined;
  }, [content, selectedFileType, highlightDisabled]);

  // ------------------------------------------------------------ 预览缩放
  //
  // 「纸张式」放大：只对预览内容做 transform，**不重排** —— 图片会真的变大、换行
  // 位置也不变，这正是「看清图片细节」需要的。与之相对，整界面缩放走的是 WebView
  // 的 setZoom（见 features/settings/uiZoom.ts），两者互不干扰。

  const [previewZoom, setPreviewZoom] = useState(1);
  const previewZoomRef = useRef(1);
  const previewContentRef = useRef<HTMLDivElement>(null);
  const [previewContentSize, setPreviewContentSize] = useState({ width: 0, height: 0 });

  /**
   * 量出预览内容的**布局**尺寸。
   *
   * `offsetWidth/offsetHeight` 不受 `transform` 影响，所以这里量到的始终是未缩放的
   * 尺寸，不会和撑开层互相依赖。
   */
  useEffect(() => {
    const element = previewContentRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const measure = () =>
      setPreviewContentSize({ width: element.offsetWidth, height: element.offsetHeight });

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selectedId, paperPreviewKey]);

  /**
   * 预览区的 Ctrl+滚轮缩放。**只在纸张预览时挂载** —— 编辑与分栏里不生效：那两个
   * 形态下内容是要改的，放大只会碍事。
   *
   * ⚠️ 必须用原生 `addEventListener` 且 `passive: false`。React 的 `onWheel` 是被动
   * 监听，在里面 `preventDefault()` 无效，浏览器自己的缩放会同时发生。
   */
  useEffect(() => {
    const scroller = previewScrollRef.current;
    if (!scroller || !isPaperPreview) return;

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        // Shift + 滚轮 = 横向平移。Chromium 多数情况下自己会做，但不同 WebView 版本
        // 行为不一致，而且有些鼠标压根没有横向滚轮 —— 显式处理，保证任何设备都能
        // 左右移动。只有真的能横向滚动时才拦截，否则放行给浏览器的纵向滚动。
        if (event.shiftKey && scroller.scrollWidth > scroller.clientWidth) {
          event.preventDefault();
          scroller.scrollLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX;
        }
        // 其余情况**不要** preventDefault：普通滚轮的纵向滚动交给浏览器默认行为。
        return;
      }
      event.preventDefault();

      const previous = previewZoomRef.current;
      const next = clampPreviewZoom(
        previous + (event.deltaY > 0 ? -PREVIEW_ZOOM_STEP : PREVIEW_ZOOM_STEP),
      );
      if (next === previous) return;

      // 以光标为中心：先求出光标下那个点在**未缩放内容**里的坐标，缩放后再让同一个
      // 点回到光标的屏幕位置。
      const rect = scroller.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const localX = (offsetX + scroller.scrollLeft) / previous;
      const localY = (offsetY + scroller.scrollTop) / previous;

      previewZoomRef.current = next;
      setPreviewZoom(next);

      // 撑开层与 transform 要等这一帧渲染完，滚动范围才够大，否则滚动量会被夹住。
      requestAnimationFrame(() => {
        scroller.scrollLeft = localX * next - offsetX;
        scroller.scrollTop = localY * next - offsetY;
      });
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [paperPreviewKey, selectedId]);

  /**
   * 按住空格 + 左键拖动来平移预览，和图片查看器的手感一致。
   *
   * 为什么用空格而不是直接左键拖：预览正文是可以**选中文字**的，直接拖会变成选词。
   * 空格是这类工具约定俗成的「临时切到抓手」修饰键。
   *
   * 滚动量直接写 `scrollLeft/scrollTop`，不经过 state —— 拖拽每帧都要更新，绕一圈
   * setState 再渲染的话跟手性会明显变差。
   */
  useEffect(() => {
    if (paperPreviewKey === "none") return;
    const scroller = previewScrollRef.current;
    if (!scroller) return;

    let spaceHeld = false;
    let dragging = false;
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const syncCursor = () => {
      scroller.style.cursor = dragging ? "grabbing" : spaceHeld ? "grab" : "";
    };

    /** 输入框、按钮上的空格各有各的用处（打字、触发点击），不能抢。 */
    const ownsSpace = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") {
        return true;
      }
      return target.isContentEditable || tag === "A";
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (ownsSpace(event.target)) return;

      // ⚠️ 每一次 keydown 都要拦，包括按住时反复发的 repeat 事件。
      // 只拦第一下的话，后面每个 repeat 都会走浏览器的默认行为 —— 空格翻一屏 ——
      // 表现就是「一按住就往下跳一大段」。状态的切换才是只需要做一次的那部分。
      event.preventDefault();
      if (event.repeat) return;

      spaceHeld = true;
      syncCursor();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceHeld = false;
      if (!dragging) syncCursor();
    };

    // 切走窗口时 keyup 收不到，不兜这一下回来会一直停在抓手状态。
    const onBlur = () => {
      spaceHeld = false;
      if (!dragging) syncCursor();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!spaceHeld || event.button !== 0) return;
      dragging = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = scroller.scrollLeft;
      startTop = scroller.scrollTop;
      // 捕获指针：拖到窗口外再松手也收得到 pointerup，不会「粘住」。
      scroller.setPointerCapture(event.pointerId);
      event.preventDefault();
      syncCursor();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      scroller.scrollLeft = startLeft - (event.clientX - startX);
      scroller.scrollTop = startTop - (event.clientY - startY);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      pointerId = null;
      if (scroller.hasPointerCapture(event.pointerId)) {
        scroller.releasePointerCapture(event.pointerId);
      }
      syncCursor();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    scroller.addEventListener("pointerdown", onPointerDown);
    scroller.addEventListener("pointermove", onPointerMove);
    scroller.addEventListener("pointerup", onPointerUp);
    scroller.addEventListener("pointercancel", onPointerUp);

    return () => {
      scroller.style.cursor = "";
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("pointermove", onPointerMove);
      scroller.removeEventListener("pointerup", onPointerUp);
      scroller.removeEventListener("pointercancel", onPointerUp);
    };
  }, [paperPreviewKey, selectedId]);

  /**
   * 把当前文件类型声明的代码主题交给全局。
   *
   * 只**声明偏好**、不直接 apply：主题是所有窗口共用的，统一由 App 按「偏好 +
   * 当前明暗」算出最终值，这样小窗与磁贴也会跟着换。
   */
  useEffect(() => {
    setCodeThemeOverride(selectedFileType?.highlightTheme);
    // 离开这个文件时清掉覆盖，免得下一个文件沿用上一个格式的配色。
    return () => setCodeThemeOverride(undefined);
  }, [selectedFileType]);

  const isExternal = selectedExternalFile !== null;
  const isExternalRef = useRef(isExternal);
  isExternalRef.current = isExternal;

  const noteMenuTarget = useMemo(
    () => notes.find((note) => note.id === noteMenu?.noteId) ?? null,
    [noteMenu?.noteId, notes],
  );
  const noteContextMenuItems = useMemo(() => getNoteContextMenuItems(t), [t]);
  // 插件贡献的笔记列表右键菜单项。
  const notePluginMenuItems = useSyncExternalStore(
    subscribeNoteMenuItems,
    listNoteMenuItems,
    listNoteMenuItems,
  );
  // 插件贡献的编辑器工具栏按钮。
  const toolbarPluginButtons = useSyncExternalStore(
    subscribeToolbarButtons,
    listToolbarButtons,
    listToolbarButtons,
  );

  /** 插件的**文档动作**（顶上那一行）。过滤见 `documentActionVisible`。 */
  const pluginDocumentActions = useSyncExternalStore(
    subscribeDocumentActions,
    listDocumentActions,
    listDocumentActions,
  );

  /**
   * 插件贡献的工具栏浮层（按钮 + 下拉）。
   *
   * `anchor` 是按钮当时的屏幕坐标，交给 `useViewportPopupPosition` 夹进视口 ——
   * 分栏模式下编辑区可能只有几百像素宽，往下拉的面板很容易越过窗口右缘。
   */
  const pluginPopovers = useSyncExternalStore(subscribePopovers, listPopovers, listPopovers);
  const [openPopover, setOpenPopover] = useState<{
    id: string;
    anchor: { x: number; y: number };
    trigger: HTMLElement;
  } | null>(null);
  const { popupRef: popoverRef, popupPosition: popoverPosition } = useViewportPopupPosition(
    openPopover?.anchor ?? null,
    openPopover?.id,
  );

  const handleTogglePopover = useCallback((popover: PluginPopover, trigger: HTMLElement) => {
    setOpenPopover((current) => {
      if (current?.id === popover.id) return null;

      // 点开时**才**向插件要内容：浮层是临时界面，没人开着的时候不渲染。
      popover.refresh();
      const rect = trigger.getBoundingClientRect();
      return { id: popover.id, anchor: { x: rect.left, y: rect.bottom + 4 }, trigger };
    });
  }, []);

  const activePopover = openPopover
    ? (pluginPopovers.find((item) => item.id === openPopover.id) ?? null)
    : null;

  // 点到浮层外面、按 Esc、或窗口失焦就收起。
  useEffect(() => {
    if (!openPopover) return;

    const closeOnOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return;
      // 触发按钮也要排除：它不在浮层里，但它自己的 click 已经负责收起了。
      // 不排掉的话，mousedown 先关、随后的 click 又开，表现为「再点一次收不起来」。
      if (target && openPopover.trigger.contains(target)) return;
      setOpenPopover(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPopover(null);
    };
    const closeOnBlur = () => setOpenPopover(null);

    document.addEventListener("mousedown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [openPopover, popoverRef]);

  /** 打开一篇只读说明文档（「关于」的三篇、插件详细信息都走这里）。 */
  const openDocView = useCallback((title: string, content: string) => {
    setDocView({ title, content });
  }, []);

  const saveStateLabel = useMemo<Record<SaveState, string>>(
    () => ({
      idle: t("main.statusBar.saveState.idle", { defaultValue: "未选择" }),
      dirty: t("main.statusBar.saveState.dirty", { defaultValue: "未保存" }),
      saving: t("main.statusBar.saveState.saving", { defaultValue: "保存中" }),
      saved: t("main.statusBar.saveState.saved", { defaultValue: "已保存" }),
      error: t("main.statusBar.saveState.error", { defaultValue: "保存失败" }),
    }),
    [t],
  );
  const toolbarButtons = useMemo<
    { label: string; title: string; style: string; action: FormatAction }[]
  >(
    () => [
      {
        label: "B",
        title: t("main.toolbar.bold", { defaultValue: "粗体" }),
        style: "font-bold",
        action: "bold",
      },
      {
        label: "I",
        title: t("main.toolbar.italic", { defaultValue: "斜体" }),
        style: "italic",
        action: "italic",
      },
      {
        label: "H",
        title: t("main.toolbar.heading", { defaultValue: "标题" }),
        style: "font-bold",
        action: "heading",
      },
      {
        label: "—",
        title: t("main.toolbar.hr", { defaultValue: "分割线" }),
        style: "",
        action: "hr",
      },
      {
        label: "•",
        title: t("main.toolbar.ul", { defaultValue: "无序列表" }),
        style: "",
        action: "ul",
      },
      {
        label: "1.",
        title: t("main.toolbar.ol", { defaultValue: "有序列表" }),
        style: "font-mono text-[9px]",
        action: "ol",
      },
      {
        label: "<>",
        title: t("main.toolbar.code", { defaultValue: "代码" }),
        style: "font-mono text-[9px]",
        action: "code",
      },
      {
        label: "❝",
        title: t("main.toolbar.quote", { defaultValue: "引用" }),
        style: "",
        action: "quote",
      },
      {
        label: "∑",
        title: t("main.toolbar.inlineMath", { defaultValue: "行内公式" }),
        style: "font-mono text-[11px]",
        action: "inlineMath",
      },
      {
        label: "∫",
        title: t("main.toolbar.blockMath", { defaultValue: "块级公式" }),
        style: "font-mono text-[11px]",
        action: "blockMath",
      },
      // 段落对齐。写进正文的是 `::: center` 这种纯文本容器，**不是 HTML 标签** ——
      // 渲染见 features/markdown/remarkAlign.ts，正文侧的换算见 alignText.ts。
      {
        label: "⇤",
        title: t("main.toolbar.alignLeft", { defaultValue: "居左" }),
        style: "",
        action: "alignLeft",
      },
      {
        label: "⇔",
        title: t("main.toolbar.alignCenter", { defaultValue: "居中" }),
        style: "",
        action: "alignCenter",
      },
      {
        label: "⇥",
        title: t("main.toolbar.alignRight", { defaultValue: "居右" }),
        style: "",
        action: "alignRight",
      },
    ],
    [t],
  );
  const viewModeOptions = useMemo(
    () => [
      {
        value: "edit" as ViewMode,
        label: t("settings.defaultView.edit", { defaultValue: "编辑" }),
      },
      {
        value: "split" as ViewMode,
        label: t("settings.defaultView.split", { defaultValue: "分栏" }),
      },
      {
        value: "preview" as ViewMode,
        label: t("settings.defaultView.preview", { defaultValue: "预览" }),
      },
    ],
    [t],
  );
  const activeStandalonePanelId = activePanelId?.startsWith("standalone:")
    ? activePanelId.slice("standalone:".length)
    : null;
  const visibleSidePanel = sidePanelModeOf(activePanelId);
  const sidePanelExpanded = visibleSidePanel !== null;
  const togglePanel = useCallback((panelId: string) => {
    setActivePanelId((current) => (current === panelId ? null : panelId));
  }, []);

  const filteredNotes = useMemo(() => filterNotes(notes, searchQuery), [notes, searchQuery]);

  const categoryGroups = useMemo(
    () => groupNotesByCategory(filteredNotes, categories),
    [filteredNotes, categories],
  );

  const lineCount = useMemo(() => content.split("\n").length, [content]);
  const byteSize = useMemo(
    () => (new TextEncoder().encode(content).length / 1024).toFixed(1),
    [content],
  );
  const charCount = useMemo(() => countNoteChars(content), [content]);

  const applyNote = useCallback(
    (note: Note) => {
      // 立刻同步各 ref，保证保存快照与守卫在下一次渲染前就能读到最新值
      loadEpoch.bump();
      selectedIdRef.current = note.id;
      titleValueRef.current = note.title;
      contentValueRef.current = note.content;
      saveStateRef.current = "saved";
      setSelectedId(note.id);
      // 选了笔记就等于离开了说明文档。
      setDocView(null);
      setTitle(note.title);
      setContent(note.content);
      setSaveState("saved");
      setNoteTransitionKey((k) => k + 1);
    },
    [loadEpoch, t],
  );

  const replaceNoteMetadata = useCallback((note: Note) => {
    const metadata = metadataFromNote(note);
    setNotes((current) => {
      const exists = current.some((item) => item.id === metadata.id);
      const next = exists
        ? current.map((item) => (item.id === metadata.id ? metadata : item))
        : [metadata, ...current];
      return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }, []);

  const loadNote = useCallback(
    async (id: string) => {
      const epoch = loadEpoch.bump();
      const note = await getNote(id);
      // 加载期间用户又切换/加载了别的笔记，丢弃本次结果
      if (!loadEpoch.isCurrent(epoch)) return;
      applyNote(note);
      replaceNoteMetadata(note);
    },
    [applyNote, replaceNoteMetadata, loadEpoch],
  );

  const refreshNotes = useCallback(async () => {
    const [loadedNotes, loadedCategories] = await Promise.all([listNotes(), listCategories()]);
    setNotes(loadedNotes);
    setCategories(loadedCategories);
    return loadedNotes;
  }, []);

  const clearCurrentNote = useCallback(() => {
    loadEpoch.bump();
    selectedIdRef.current = null;
    titleValueRef.current = "";
    contentValueRef.current = "";
    saveStateRef.current = "idle";
    setSelectedId(null);
    setDocView(null);
    setTitle("");
    setContent("");
    setSaveState("idle");
  }, [loadEpoch]);

  const loadExternalFile = useCallback(
    async (
      filePath: string,
      options: { readText?: boolean; fromWorkspace?: boolean } = {},
    ) => {
      // 先把手上这篇存了再切。自动保存是 900ms 防抖的（见下面的 effect），而切走会让那个
      // effect 重新跑、**取消**掉还没到点的计时器 —— 刚敲完字就点开另一个文件，这段改动
      // 会凭空消失。放在这里而不是各个调用方，是为了五条入口（工作区树、拖拽、启动参数、
      // 第二实例事件、列表点击）一次全兜住。
      await saveCurrentNoteRef.current();

      // 图片 / 媒体 / 表格 / 插件自定义预览都不该按文本读：二进制文件会直接报
      // "stream did not contain valid UTF-8"，而且用户会看到一个莫名其妙的 Toast。
      // 它们的真实内容由 FilePreview 自己去取。
      const readText = options.readText ?? !isRichPreviewPath(filePath);
      const epoch = loadEpoch.bump();
      try {
        const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
        const displayTitle = fileName.replace(/\.(md|txt)$/i, "");

        let fileContent = "";
        let mtime = 0;
        if (readText) {
          [fileContent, mtime] = await Promise.all([
            readExternalFile(filePath),
            getFileModifiedTime(filePath),
          ]);

          if (fileContent.length > MAX_EDITABLE_CHARS) {
            showToast(
              t("main.externalFile.tooLarge", {
                defaultValue: "文件过大（{{size}} 字符），暂不支持打开",
                size: fileContent.length.toLocaleString(),
              }),
            );
            return;
          }
        }

        setExternalFiles((current) => {
          if (current.some((f) => f.id === filePath)) {
            // 已经在了就原样留着 —— 包括它的 `fromWorkspace`。同一个文件先被从系统打开
            // （可见）、再从工作区树点一次，不该把它变成隐藏的：先到先得。
            return current;
          }
          return [
            ...current,
            {
              id: filePath,
              title: displayTitle,
              filePath,
              fromWorkspace: options.fromWorkspace,
            },
          ];
        });

        if (!loadEpoch.isCurrent(epoch)) return;
        selectedIdRef.current = filePath;
        titleValueRef.current = displayTitle;
        contentValueRef.current = fileContent;
        saveStateRef.current = "saved";
        setSelectedId(filePath);
        // 同理：打开文件也离开文档。
        setDocView(null);
        setTitle(displayTitle);
        setContent(fileContent);
        setSaveState("saved");
        setNoteTransitionKey((k) => k + 1);
        externalFileMtimeRef.current = mtime;
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [loadEpoch, t],
  );

  // ------------------------------------------------------------ 工作文件夹
  //
  // 列表**独立于设置面板加载**：侧栏随时要用它，不能等到用户打开设置面板才去拉配置。

  useEffect(() => {
    let cancelled = false;
    void getConfig()
      .then((config) => {
        if (!cancelled) setWorkspaceFolders(config.workspaceFolders ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 添加 / 移除都会在后端改配置并广播 `config-changed`，这里跟着同步 ——
  // 于是别的窗口改了文件夹列表，本窗口也会跟上。
  useEffect(() => {
    const unlisten = listen<AppConfig>("config-changed", (event) => {
      setWorkspaceFolders(event.payload.workspaceFolders ?? []);
    });
    return () => {
      disposeListener(unlisten);
    };
  }, []);

  // 活动栏指向的文件夹若被移除（可能是另一个窗口移除的），退回笔记视图，
  // 否则面板会停在一个不存在的路径上。
  useEffect(() => {
    if (activeExplorer === EXPLORER_NOTES) return;
    if (!workspaceFolders.includes(activeExplorer)) setActiveExplorer(EXPLORER_NOTES);
  }, [workspaceFolders, activeExplorer]);

  const handleAddWorkspaceFolder = useCallback(async () => {
    try {
      const picked = await chooseDataDirectory();
      if (!picked) return;

      const config = await addWorkspaceFolder(picked);
      const folders = config.workspaceFolders ?? [];
      setWorkspaceFolders(folders);

      // 用后端返回的**规范化**路径去激活：目录选择器给的是原始路径，与存下来的可能
      // 写法不同（尾斜杠、Windows 的 8.3 短名），直接拿 picked 当 id 会匹配不上。
      const added = folders[folders.length - 1];
      if (added) setActiveExplorer(added);
      setSidebarCollapsed(false);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, []);

  /**
   * 真正把文件夹从列表里摘掉。`clearCache` 表示用户刚才在确认框里选了「一起删掉」。
   *
   * 两件事**分开做**：先把缓存删掉再摘路径？不 —— 反过来的话，删缓存失败（被占用、
   * 只读）就会把用户卡在一个「想移除却移除不掉」的状态里。移除是用户的本意，删缓存
   * 是附带动作，附带动作失败只提示一句，不该拦住本意。
   */
  const commitRemoveWorkspaceFolder = useCallback(
    async (path: string, clearCache: boolean) => {
      try {
        const config = await removeWorkspaceFolder(path);
        setWorkspaceFolders(config.workspaceFolders ?? []);
        setActiveExplorer((current) => (current === path ? EXPLORER_NOTES : current));

        if (clearCache) {
          try {
            const cleared = await clearWorkspaceCache(path);
            showToast(`已清理 ${cleared.files} 个缓存文件`, "info");
          } catch (error) {
            showToast(`工作文件夹已移除，但缓存没删掉：${getErrorMessage(error)}`);
          }
        }
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [],
  );

  /**
   * 移除工作文件夹。**有缓存时先问一句**（用户定的）。
   *
   * 问的是「要不要连 `__floral-notepaper__` 一起删」：那里面是插件写的旁挂数据（批注这类），
   * 删了就没了；而不删的话它就静静躺在那个文件夹里，下次再挂上来就还在。没有缓存时
   * 不必打扰用户，直接移除。
   */
  /**
   * 给一个工作文件夹换图标。纯粹是观感，所以失败也只是弹个 toast —— 配置没有变化，
   * 那一格继续用原来的图标。
   */
  const handleSetWorkspaceIcon = useCallback(
    async (path: string, icon: string) => {
      try {
        const config = await setWorkspaceIcon(path, icon);
        setSettingsConfig(config);
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [t],
  );

  const handleRemoveWorkspaceFolder = useCallback(
    async (path: string) => {
      const info = await workspaceCacheInfo(path).catch(() => null);
      if (info?.exists && info.files > 0) {
        setPendingFolderRemoval({ path, info });
        return;
      }
      await commitRemoveWorkspaceFolder(path, false);
    },
    [commitRemoveWorkspaceFolder],
  );

  /**
   * 复用既有的「外部文件」通道：它已经处理好读取、编辑、自动保存与外部改动轮询。
   *
   * `fromWorkspace` 让这条**不列进侧栏的「外部文件」**：工作区树自己就是它的导航，
   * 再在「笔记」面板里冒一条会让人以为凭空多了篇笔记。记账本身照旧（保存路由要靠它）。
   */
  const handleOpenWorkspaceFile = useCallback(
    (entry: WorkspaceEntry) => {
      void loadExternalFile(entry.path, { fromWorkspace: true });
    },
    [loadExternalFile],
  );

  const handleSelectExplorer = useCallback(
    (id: string) => {
      // 点当前已选中的那一格 = 收起/展开面板（VSCode 的习惯）；点别的格 = 切过去并展开。
      if (id === activeExplorer) {
        setSidebarCollapsed((collapsed) => !collapsed);
        return;
      }
      setActiveExplorer(id);
      setSidebarCollapsed(false);
    },
    [activeExplorer],
  );

  /**
   * 把侧栏切回「笔记」并展开。
   *
   * 拖进来 / 从系统打开的文件都落进笔记区的「外部文件」。如果用户当时正停在某个工作
   * 文件夹上，文件确实加进去了、却在当前视图里看不见 —— 这条路径负责把它显式翻出来。
   */
  const revealExternalFiles = useCallback(() => {
    setActiveExplorer(EXPLORER_NOTES);
    setSidebarCollapsed(false);
  }, []);

  const activityItems = useMemo<ActivityBarItem[]>(
    () => [
      {
        id: EXPLORER_NOTES,
        title: t("main.explorer.notes", { defaultValue: "笔记" }),
        icon: <NotesIcon />,
      },
      ...workspaceFolders.map((folder) => ({
        id: folder,
        title: folder,
        // 图标是用户自己挑的（右键那一格就能换）。没挑过、或者存的 id 现在认不出来了，
        // `WorkspaceIcon` 自己会回落到文件夹图标。
        icon: <WorkspaceIcon id={settingsConfig?.workspaceIcons?.[folder]} />,
        iconId: settingsConfig?.workspaceIcons?.[folder],
        removable: true,
      })),
    ],
    [workspaceFolders, settingsConfig?.workspaceIcons, t],
  );

  useEffect(() => {
    try {
      windowLabelRef.current = getCurrentWindow().label;
    } catch {
      windowLabelRef.current = "main";
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setIsLoading(true);
      try {
        const [loadedConfig, loadedNotes, loadedCategories] = await Promise.all([
          getConfig(),
          listNotes(),
          listCategories(),
        ]);
        if (cancelled) return;
        setSettingsConfig(loadedConfig);
        setSavedDataDir(loadedConfig.dataDir);
        setViewMode(normalizeViewMode(loadedConfig.defaultViewMode));
        setNotes(loadedNotes);
        setCategories(loadedCategories);
        setCollapsedCategories(new Set(loadedCategories));
        if (loadedNotes[0]) {
          const note = await getNote(loadedNotes[0].id);
          if (!cancelled) applyNote(note);
        } else {
          clearCurrentNote();
        }

        if (!cancelled) {
          const startupFile = await takeStartupFile();
          if (!cancelled && startupFile) {
            revealExternalFiles();
            await loadExternalFile(startupFile);
          }
        }
      } catch (error) {
        if (!cancelled) showToast(getErrorMessage(error));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyNote, clearCurrentNote]);

  useEffect(() => {
    if (visibleSidePanel) {
      setMountedSidePanel(visibleSidePanel);
      setSidePanelContentVisible(false);

      const frame = window.requestAnimationFrame(() => {
        setSidePanelContentVisible(true);
      });

      return () => window.cancelAnimationFrame(frame);
    }

    setSidePanelContentVisible(false);
    if (!mountedSidePanel) return;

    const timer = window.setTimeout(() => {
      setMountedSidePanel((current) => (current === mountedSidePanel ? null : current));
    }, 320);

    return () => window.clearTimeout(timer);
  }, [mountedSidePanel, visibleSidePanel]);

  useEffect(() => {
    const unlisten = listen("notes-changed", () => {
      // 记录事件到达时的 epoch；其间用户一旦切换/加载了笔记，本次同步即过期，
      // 不再用过期的列表快照去改选中或回填内容，避免把选中"拉回"刚保存的旧笔记
      const epochAtEvent = loadEpoch.peek();
      const isStale = () => !loadEpoch.isCurrent(epochAtEvent);
      void refreshNotes()
        .then((loaded) => {
          if (isStale()) return;
          const currentId = selectedIdRef.current;
          if (!currentId) return;
          const stillExists = loaded.some((n) => n.id === currentId);
          if (stillExists) {
            if (saveStateRef.current !== "dirty" && saveStateRef.current !== "saving") {
              void getNote(currentId)
                .then((note) => {
                  if (isStale()) return;
                  if (selectedIdRef.current !== currentId) return;
                  if (saveStateRef.current === "dirty" || saveStateRef.current === "saving") {
                    return;
                  }
                  titleValueRef.current = note.title;
                  contentValueRef.current = note.content;
                  saveStateRef.current = "saved";
                  setTitle(note.title);
                  setContent(note.content);
                  setSaveState("saved");
                })
                .catch(() => undefined);
            }
          } else if (selectedNoteRef.current) {
            if (loaded[0]) {
              void loadNote(loaded[0].id);
            } else {
              clearCurrentNote();
            }
          }
        })
        .catch(() => undefined);
    });
    return () => {
      disposeListener(unlisten);
    };
  }, [refreshNotes, loadNote, clearCurrentNote, loadEpoch]);

  useEffect(() => {
    function handleFocus() {
      void refreshNotes();
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshNotes]);

  useEffect(() => {
    const onResize = () => setSettingsOverlay(window.innerWidth < 1080);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("open-external-file", (event) => {
      revealExternalFiles();
      void loadExternalFile(event.payload);
    });
    return () => {
      disposeListener(unlisten);
    };
  }, [loadExternalFile, revealExternalFiles]);

  useEffect(() => {
    const TEXT_RE = /\.(md|markdown|txt)$/i;
    const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const textPaths: string[] = [];
      const imagePaths: string[] = [];

      for (const p of event.payload.paths) {
        if (TEXT_RE.test(p)) textPaths.push(p);
        else if (IMAGE_RE.test(p)) imagePaths.push(p);
      }

      if (textPaths.length > 0) {
        revealExternalFiles();
      }
      for (const p of textPaths) {
        void loadExternalFile(p);
      }

      if (imagePaths.length > 0 && selectedIdRef.current && !isExternalRef.current) {
        const noteId = selectedIdRef.current;
        void (async () => {
          const textarea = contentRef.current;
          if (!textarea) return;
          try {
            const rels = await Promise.all(imagePaths.map((p) => saveImageFromPath(noteId, p)));
            const markdown = rels.map((rel) => `![](${rel})`).join("\n");
            insertTextAtCursor(textarea, setContent, markdown);
            saveStateRef.current = "dirty";
            setSaveState("dirty");
          } catch (error) {
            showToast(getErrorMessage(error));
          }
        })();
      }
    });

    return () => {
      disposeListener(unlisten);
    };
  }, [loadExternalFile, revealExternalFiles, setContent]);

  useEffect(() => {
    const unlisten = listen<string>("open-note", (event) => {
      void loadNote(event.payload);
    });
    return () => {
      disposeListener(unlisten);
    };
  }, [loadNote]);

  useEffect(() => {
    const unlisten = listen<string>("shortcut-register-failed", (event) => {
      showToast(event.payload, "warning");
    });
    return () => {
      disposeListener(unlisten);
    };
  }, []);

  useEffect(() => {
    if (!selectedExternalFile) return;

    const interval = window.setInterval(async () => {
      if (Date.now() - lastExternalSaveRef.current < 2000) return;
      try {
        const mtime = await getFileModifiedTime(selectedExternalFile.filePath);
        if (selectedIdRef.current !== selectedExternalFile.id) return;
        if (mtime !== externalFileMtimeRef.current) {
          externalFileMtimeRef.current = mtime;
          const fileContent = await readExternalFile(selectedExternalFile.filePath);
          if (selectedIdRef.current !== selectedExternalFile.id) return;
          contentValueRef.current = fileContent;
          saveStateRef.current = "saved";
          setContent(fileContent);
          setSaveState("saved");
        }
      } catch {
        // file may have been deleted or become inaccessible
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [selectedExternalFile]);

  useEffect(() => {
    function closeMenus() {
      setNoteMenuClosing(true);
      setCategoryMenuClosing(true);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenus();
    }

    document.addEventListener("mousedown", closeMenus);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", closeMenus);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!noteMenuClosing || !noteMenu) return;
    const timer = window.setTimeout(() => {
      setNoteMenu(null);
      setNoteMenuClosing(false);
      setNoteMenuMode("main");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [noteMenuClosing, noteMenu]);

  useEffect(() => {
    if (!categoryMenuClosing || !categoryMenu) return;
    const timer = window.setTimeout(() => {
      setCategoryMenu(null);
      setCategoryMenuClosing(false);
      setCategoryMenuConfirmDelete(false);
      setCategoryMenuHoverSuppressed(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [categoryMenuClosing, categoryMenu]);

  useEffect(() => {
    if (!categoryMenuHoverSuppressed || !categoryMenu) return;
    const releaseHover = () => setCategoryMenuHoverSuppressed(false);
    window.addEventListener("mousemove", releaseHover, { once: true });
    window.addEventListener("mousedown", releaseHover, { once: true });
    return () => {
      window.removeEventListener("mousemove", releaseHover);
      window.removeEventListener("mousedown", releaseHover);
    };
  }, [categoryMenuHoverSuppressed, categoryMenu]);

  const switchCategoryMenuPanel = useCallback((confirmDelete: boolean) => {
    setCategoryMenuHoverSuppressed(true);
    setCategoryMenuConfirmDelete(confirmDelete);
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const performSave = useCallback(
    async (force: boolean): Promise<boolean> => {
      // 非强制保存（自动保存、切换前保存）在没有未保存修改时直接视为成功
      if (!force && saveStateRef.current !== "dirty") return true;
      const id = selectedIdRef.current;
      if (!id) return false;

      // 在保存瞬间对当前笔记做快照；之后用户切换笔记不影响本次写入的内容，
      // 保存完成后也只在"仍停留在这篇笔记"时才更新保存状态
      const titleSnapshot = titleValueRef.current;
      const contentSnapshot = contentValueRef.current;
      const stillCurrent = () => selectedIdRef.current === id;
      const settleSaveState = (state: SaveState) => {
        if (!stillCurrent()) return;
        saveStateRef.current = state;
        setSaveState(state);
      };

      const externalFile = externalFilesRef.current.find((file) => file.id === id) ?? null;

      settleSaveState("saving");
      try {
        if (externalFile) {
          await saveExternalFile(externalFile.filePath, contentSnapshot);
          notifyPluginAssetSaved(externalFile.filePath);
          lastExternalSaveRef.current = Date.now();
          const mtime = await getFileModifiedTime(externalFile.filePath);
          if (stillCurrent()) {
            externalFileMtimeRef.current = mtime;
          }
          settleSaveState(contentValueRef.current === contentSnapshot ? "saved" : "dirty");
        } else {
          const category = notesRef.current.find((note) => note.id === id)?.category ?? "";
          const note = await updateNote(id, {
            title: titleSnapshot,
            content: contentSnapshot,
            category,
          });
          replaceNoteMetadata(note);
          const contentChanged =
            contentValueRef.current !== contentSnapshot || titleValueRef.current !== titleSnapshot;
          settleSaveState(contentChanged ? "dirty" : "saved");
        }
        return true;
      } catch (error) {
        settleSaveState("error");
        showToast(getErrorMessage(error));
        return false;
      }
    },
    [replaceNoteMetadata],
  );

  const saveCurrentNote = useCallback(
    (force = false): Promise<boolean> => {
      const run = saveQueueRef.current.then(() => performSave(force));
      saveQueueRef.current = run.catch(() => undefined);
      return run;
    },
    [performSave],
  );
  // 供定义在本函数之前的 `loadExternalFile` 调用（见 `saveCurrentNoteRef` 的说明）。
  saveCurrentNoteRef.current = saveCurrentNote;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void saveCurrentNote(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [saveCurrentNote]);

  // Ctrl/Cmd+Shift+P 呼出命令面板。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 把内置动作登记进统一命令表，让命令面板不至于只有插件命令。
  // 注意：这些命令**不绑定键位**——Ctrl+S / Ctrl+H 等已有 document 级监听器，
  // 再绑一次会导致同一次按键被处理两遍（preventDefault 不会阻止 document 上的监听器）。
  useEffect(() => {
    const disposables = [
      registerBuiltinCommand({
        id: "builtin.save",
        title: t("main.command.save", { defaultValue: "保存当前笔记" }),
        run: () => saveCurrentNote(true).then(() => undefined),
      }),
      registerBuiltinCommand({
        id: "builtin.cycle-view",
        title: t("main.command.cycleView", { defaultValue: "切换编辑 / 分屏 / 预览" }),
        run: () =>
          setViewMode((mode) => {
            const index = viewModeOptions.findIndex((option) => option.value === mode);
            const next = viewModeOptions[(index + 1) % viewModeOptions.length];
            return next ? next.value : mode;
          }),
      }),
      registerBuiltinCommand({
        id: "builtin.find",
        title: t("main.command.find", { defaultValue: "查找与替换" }),
        run: () => setFindReplaceOpen(true),
      }),
      registerBuiltinCommand({
        id: "builtin.settings",
        title: t("main.command.settings", { defaultValue: "打开设置" }),
        run: () => togglePanel("settings"),
      }),
      registerBuiltinCommand({
        id: "builtin.plugins",
        title: t("main.command.plugins", { defaultValue: "打开插件面板" }),
        run: () => togglePanel("plugins"),
      }),
    ];

    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [saveCurrentNote, t, togglePanel, viewModeOptions]);

  useEffect(() => {
    if (!selectedId || saveState !== "dirty") return undefined;
    if (isExternal) {
      if (!settingsConfig?.externalFileAutoSave) return undefined;
    } else {
      if (!settingsConfig?.noteAutoSave) return undefined;
    }

    const timer = window.setTimeout(() => {
      void saveCurrentNote();
    }, 900);

    return () => window.clearTimeout(timer);
  }, [
    // content 与 title 用于在持续输入时不断重置防抖计时器
    content,
    title,
    isExternal,
    saveCurrentNote,
    saveState,
    selectedId,
    settingsConfig?.noteAutoSave,
    settingsConfig?.externalFileAutoSave,
  ]);

  const handleNewNote = async () => {
    await saveCurrentNote();
    try {
      const note = await createNote({ title: "", content: "", category: activeCategory });
      replaceNoteMetadata(note);
      applyNote(note);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleOpenSettings = useCallback(() => {
    togglePanel("settings");
  }, [togglePanel]);

  const handleMigrateDataDir = async () => {
    if (!settingsConfig) return;
    try {
      const dir = await chooseDataDirectory();
      if (!dir) return;
      // 后端会在所选目录下创建 floral 子目录存放数据；先告知用户，
      // 避免其在文件管理器打开所选目录看到"空文件夹"而误判数据丢失
      const confirmed = window.confirm(
        t("settings.dataDir.confirmSubdir", {
          dir,
          defaultValue: "数据将存放在「{{dir}}」下的 floral 子文件夹中，是否继续？",
        }),
      );
      if (!confirmed) return;
      const savedConfig = await migrateDataDir(dir);
      setSettingsConfig(savedConfig);
      setSavedDataDir(savedConfig.dataDir);
      const loadedNotes = await refreshNotes();
      if (loadedNotes[0]) {
        await loadNote(loadedNotes[0].id);
      } else {
        clearCurrentNote();
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistSettings = useCallback(
    (nextConfig: AppConfig) => {
      if (settingsSaveTimer.current) {
        clearTimeout(settingsSaveTimer.current);
      }
      settingsSaveTimer.current = setTimeout(async () => {
        const previousDataDir = savedDataDir ?? nextConfig.dataDir;
        const normalizedConfig = {
          ...nextConfig,
          defaultViewMode: normalizeViewMode(nextConfig.defaultViewMode),
          tileColor: normalizeTileColor(nextConfig.tileColor),
        };
        try {
          const savedConfig = await saveConfig(normalizedConfig);
          setSettingsConfig(savedConfig);
          setSavedDataDir(savedConfig.dataDir);
          setViewMode(normalizeViewMode(savedConfig.defaultViewMode));

          if (savedConfig.dataDir !== previousDataDir) {
            const loadedNotes = await refreshNotes();
            if (loadedNotes[0]) {
              await loadNote(loadedNotes[0].id);
            } else {
              clearCurrentNote();
            }
          }
        } catch (error) {
          showToast(getErrorMessage(error));
        }
      }, 300);
    },
    [savedDataDir, refreshNotes, loadNote, clearCurrentNote],
  );

  const handleSettingsChange = useCallback(
    (nextConfig: AppConfig) => {
      setSettingsConfig(nextConfig);
      void emit("config-changed", nextConfig);
      persistSettings(nextConfig);
    },
    [persistSettings],
  );

  const handleCloseSettings = useCallback(() => {
    setActivePanelId(null);
  }, []);

  const handleOpenPlugins = useCallback(() => {
    togglePanel("plugins");
  }, [togglePanel]);

  const handleOpenAbout = useCallback(() => {
    togglePanel("about");
  }, [togglePanel]);

  const handleCloseAbout = useCallback(() => {
    setActivePanelId(null);
  }, []);

  /** 右侧栏的「样式」——全局样式表（`<数据目录>/styles/*.css`）的只读视图。 */
  const handleOpenStyles = useCallback(() => {
    togglePanel("styles");
  }, [togglePanel]);

  const handleCloseStyles = useCallback(() => {
    setActivePanelId(null);
  }, []);

  const handleClosePlugins = useCallback(() => {
    setActivePanelId(null);
  }, []);

  const handleToggleStandalonePanel = useCallback(
    (panelId: string) => {
      togglePanel("standalone:" + panelId);
    },
    [togglePanel],
  );

  /**
   * 点一条插件文档动作。
   *
   * 两条路可以同时声明，各有各的用途：`viewCommand` 发给**当前那个沙箱视图**（视图插件
   * 真正的逻辑住在帧里 —— 「导出批注」要拿 pdf-lib 重写整份 PDF，Worker 侧够不到画布与
   * 文字层）；`run` 在插件自己的 Worker 沙箱里跑。先发命令、再跑 run，顺序固定，免得
   * 作者在两处各写一半时还要猜先后。
   */
  const handleDocumentAction = useCallback(
    (action: PluginDocumentAction) => {
      if (action.viewCommand) postActiveViewCommand(action.viewCommand);
      if (!action.run) return;
      void Promise.resolve()
        .then(() => action.run?.())
        .catch((error: unknown) => showToast(getErrorMessage(error)));
    },
    [],
  );

  const handleImportNote = async () => {
    try {
      const saved = await saveCurrentNote();
      if (!saved) return;

      const note = await importMarkdownNote(activeCategory);
      if (!note) return;

      replaceNoteMetadata(note);
      applyNote(note);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleSelectNote = async (id: string) => {
    if (id === selectedId) return;
    setDeleteConfirm(false);
    // 排队保存：等待可能在途的自动保存，并把尚未落盘的修改一并存掉
    await saveCurrentNote();

    setIsLoading(true);
    try {
      await loadNote(id);
    } catch (error) {
      showToast(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 点侧栏「外部文件」里的条目。
   *
   * **复用 `loadExternalFile`**，不再自己抄一遍读取逻辑。原来这里比它少两道关卡
   * （`isRichPreviewPath` 与 `MAX_EDITABLE_CHARS`），于是图片/二进制文件能被加进列表，
   * 点它却抛「不是有效的 UTF-8」，`setSelectedId` 执行不到 —— 条目就永远点不开了。
   * 合成一处之后，两边不可能再分叉。
   *
   * 这里只保留 `loadExternalFile` 没有的两件事：开头那道「点的就是当前这个」的守卫，
   * 以及把整段圈进 `setIsLoading`（那个标志由 bootstrap 与这里共同使用，不该让它接管）。
   * 保存与错误提示都在 `loadExternalFile` 里面了。
   */
  const handleSelectExternalFile = async (id: string) => {
    if (id === selectedId) return;
    setDeleteConfirm(false);
    setIsLoading(true);
    try {
      await loadExternalFile(id);
    } catch (error) {
      // `loadExternalFile` 自己会吞掉读取错误，这里只是兜底 —— 调用点全是 `void`，
      // 漏出去的 rejection 没人接。
      showToast(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveExternalFile = async (id: string) => {
    if (selectedId === id && saveState === "dirty") {
      const shouldSave = window.confirm(
        t("main.confirm.unsavedExternalFile", {
          title: title || t("common.untitledFile", { defaultValue: "未命名文件" }),
          defaultValue: "「{{title}}」有未保存的更改，是否保存到原文件？",
        }),
      );
      if (shouldSave) {
        const saved = await saveCurrentNote();
        if (!saved) return;
      }
    }
    setExternalFiles((current) => current.filter((f) => f.id !== id));
    if (selectedId === id) {
      clearCurrentNote();
    }
  };

  const handleDeleteNote = async (noteId = selectedId) => {
    if (!noteId) return;

    setDeleteConfirm(false);
    try {
      await deleteNote(noteId);
      const remaining = await refreshNotes();
      if (noteId === selectedId && remaining[0]) {
        await loadNote(remaining[0].id);
      } else if (noteId === selectedId) {
        clearCurrentNote();
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleOpenNoteMenu = (event: MouseEvent<HTMLElement>, noteId: string) => {
    event.preventDefault();
    event.stopPropagation();

    setNoteMenuClosing(false);
    setHoveredId(noteId);
    setNoteMenu({
      x: event.clientX,
      y: event.clientY,
      noteId,
    });
  };

  const handleExportNote = async (note: NoteMetadata) => {
    try {
      if (note.id === selectedId) {
        const saved = await saveCurrentNote();
        if (!saved) return;
      }

      await exportMarkdownNote({
        id: note.id,
        title: note.id === selectedId ? title : note.title,
      });
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleNoteMenuAction = (action: NoteContextMenuAction) => {
    const note = noteMenuTarget;
    if (!note) return;

    if (action === "export") {
      setNoteMenuClosing(true);
      void handleExportNote(note);
      return;
    }

    if (action === "move") {
      setNoteMenuMode("move");
      return;
    }

    setNoteMenuClosing(true);
    void handleDeleteNote(note.id);
  };

  const handleMoveNote = async (noteId: string, targetCategory: string) => {
    setNoteMenuClosing(true);
    try {
      await moveNoteCategory(noteId, targetCategory);
      await refreshNotes();
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleCreateCategory = async () => {
    const name = categoryInputValue.trim();
    if (!name) {
      setShowCategoryInput(false);
      return;
    }
    try {
      await createCategory(name);
      setCategories((prev) => [...prev, name].sort());
      setShowCategoryInput(false);
      setCategoryInputValue("");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleRenameCategory = async (oldName: string) => {
    const newName = renameCategoryValue.trim();
    if (!newName || newName === oldName) {
      setRenamingCategory(null);
      return;
    }

    try {
      await renameCategory(oldName, newName);
      await refreshNotes();
      setRenamingCategory(null);
      setRenameCategoryValue("");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleDeleteCategory = async (name: string) => {
    try {
      await deleteCategory(name);
      await refreshNotes();
      if (activeCategory === name) {
        setActiveCategory("");
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const toggleCategoryCollapse = (category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const markDirty = () => {
    if (!selectedId) return;
    saveStateRef.current = "dirty";
    setSaveState("dirty");
  };

  const findAllMatches = useCallback(
    (findText: string) => {
      if (!findText) return [] as Array<{ start: number; end: number }>;
      const matches: Array<{ start: number; end: number }> = [];
      let index = content.indexOf(findText);
      while (index !== -1) {
        matches.push({ start: index, end: index + findText.length });
        index = content.indexOf(findText, index + findText.length);
      }
      return matches;
    },
    [content],
  );

  const handleFindNext = useCallback(
    (findText: string) => {
      const textarea = contentRef.current;
      if (!textarea || !findText) return;
      const matches = findAllMatches(findText);
      if (matches.length === 0) {
        setFindMatches([]);
        setCurrentFindIndex(-1);
        return;
      }
      const currentPos = textarea.selectionStart;
      let nextIndex = matches.findIndex((m) => m.start > currentPos);
      if (nextIndex === -1) nextIndex = 0;
      const match = matches[nextIndex];
      setFindMatches(matches);
      setCurrentFindIndex(nextIndex);
      textarea.focus();
      textarea.setSelectionRange(match.start, match.end);
      const rects = lineRectsFromLayer(
        highlightLayerRef.current,
        textarea.value,
        match.start,
        match.start + 1,
      );
      if (rects?.[0]) textarea.scrollTop = rects[0].top;
    },
    [content, findAllMatches],
  );

  const handleFindPrev = useCallback(
    (findText: string) => {
      const textarea = contentRef.current;
      if (!textarea || !findText) return;
      const matches = findAllMatches(findText);
      if (matches.length === 0) {
        setFindMatches([]);
        setCurrentFindIndex(-1);
        return;
      }
      const currentPos = textarea.selectionStart;
      let prevIndex = -1;
      for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i].end <= currentPos) {
          prevIndex = i;
          break;
        }
      }
      if (prevIndex === -1) prevIndex = matches.length - 1;
      const match = matches[prevIndex];
      setFindMatches(matches);
      setCurrentFindIndex(prevIndex);
      textarea.focus();
      textarea.setSelectionRange(match.start, match.end);
      const rects = lineRectsFromLayer(
        highlightLayerRef.current,
        textarea.value,
        match.start,
        match.start + 1,
      );
      if (rects?.[0]) textarea.scrollTop = rects[0].top;
    },
    [content, findAllMatches],
  );

  const handleReplace = useCallback(
    (findText: string, replaceText: string) => {
      const textarea = contentRef.current;
      if (!textarea || !findText) return;
      const matches = findAllMatches(findText);
      if (matches.length === 0) return;
      const currentStart = textarea.selectionStart;
      const currentEnd = textarea.selectionEnd;
      let replaceIndex = matches.findIndex((m) => m.start === currentStart && m.end === currentEnd);
      if (replaceIndex === -1) {
        replaceIndex = matches.findIndex((m) => m.start >= currentStart);
        if (replaceIndex === -1) replaceIndex = 0;
      }
      const match = matches[replaceIndex];
      const next = content.slice(0, match.start) + replaceText + content.slice(match.end);
      // 替换走的是 setContent，不经过 textarea 的 onChange，得自己记一笔。
      // coalesce=false：一次替换就是一步，不该和前后打字并在一起。
      if (selectedId) editorHistory.record(selectedId, content, next, false);
      setContent(next);
      markDirty();
      const newEnd = match.start + replaceText.length;
      textarea.setSelectionRange(match.start, newEnd);
      setFindMatches([]);
      setCurrentFindIndex(-1);
    },
    [content, findAllMatches, markDirty],
  );

  const handleReplaceAll = useCallback(
    (findText: string, replaceText: string) => {
      if (!findText) return;
      const next = content.split(findText).join(replaceText);
      if (next === content) return;
      if (selectedId) editorHistory.record(selectedId, content, next, false);
      setContent(next);
      markDirty();
      setFindMatches([]);
      setCurrentFindIndex(-1);
    },
    [content, markDirty],
  );

  const ensureNoteSaved = useCallback(async (): Promise<string | null> => {
    if (selectedId) return selectedId;
    try {
      const note = await createNote({ title, content, category: activeCategory });
      replaceNoteMetadata(note);
      applyNote(note);
      return note.id;
    } catch {
      return null;
    }
  }, [selectedId, title, content, activeCategory, replaceNoteMetadata, applyNote]);

  const {
    handlePaste: imagePasteHandler,
    handleDrop: imageDropHandler,
    handleDragOver: imageDragOverHandler,
  } = useImagePaste({
    noteId: selectedId,
    textareaRef: contentRef,
    setContent,
    markDirty,
    onEnsureNoteSaved: ensureNoteSaved,
    disabled: isExternal,
    onError: showToast,
    t,
  });

  const handleCleanUnusedImages = async () => {
    if (!selectedId || isExternal) return;
    try {
      const removed = await cleanUnusedImages(selectedId, content);
      if (removed.length > 0) {
        showToast(
          t("main.images.cleaned", {
            count: removed.length,
            defaultValue: "已清理 {{count}} 张图片",
          }),
          "info",
        );
      } else {
        showToast(t("main.images.cleanedNone", { defaultValue: "没有需要清理的图片" }), "info");
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  /**
   * 把历史里的某一份内容换上去。
   *
   * 光标要自己放：原生撤销会把它送回改动处，而我们只能整份替换 `value`，不处理的话
   * 光标会跳到文末 —— 撤一下就到文末，接着打字就跑偏了。
   */
  const applyHistorySnapshot = (text: string) => {
    const previous = contentRef.current?.value ?? content;
    setContent(text);
    markDirty();
    requestAnimationFrame(() => {
      const textarea = contentRef.current;
      if (!textarea) return;
      const caret = caretAfterChange(previous, text);
      textarea.setSelectionRange(caret, caret);
    });
  };

  /**
   * 撤销 / 重做走**按文件分开的自建栈**，不用浏览器原生的。
   *
   * 原生撤销栈挂在 `<textarea>` 这个元素上，而所有文件共用同一个 textarea —— 打开
   * 另一份内容只是把它的 value 换掉，栈并不跟着走。于是「在 A 里打字 → 切到 B →
   * 按 Ctrl+Z」撤掉的是 A 的字，屏幕上却是 B 被改了。详见 features/editor/history.ts。
   */
  const handleUndo = () => {
    if (!selectedId) return;
    const text = editorHistory.undo(selectedId);
    if (text === null) return;
    applyHistorySnapshot(text);
  };

  const handleRedo = () => {
    if (!selectedId) return;
    const text = editorHistory.redo(selectedId);
    if (text === null) return;
    applyHistorySnapshot(text);
  };

  // 渲染期直接读：能改变它们的动作（记录、撤销、重做）都同时改了 `content`，
  // 因此必定伴随一次重渲染，这里读到的一定是最新的。
  const canUndoNow = selectedId !== null && editorHistory.canUndo(selectedId);
  const canRedoNow = selectedId !== null && editorHistory.canRedo(selectedId);

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    void isCurrentWindowMaximized().then(setIsMaximized);
    const unlisten = getCurrentWindow().onResized(() => {
      void isCurrentWindowMaximized().then(setIsMaximized);
    });
    return () => {
      disposeListener(unlisten);
    };
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const newWidth = Math.min(Math.max(e.clientX, 180), 500);
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => setIsResizingSidebar(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    if (!isResizingSplit) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(Math.max(ratio, 0.2), 0.8));
    };
    const onMouseUp = () => setIsResizingSplit(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSplit]);

  const cancelScrollMeasurement = useCallback(() => {
    if (measureDebounceRef.current) clearTimeout(measureDebounceRef.current);
    cancelAnimationFrame(measureRafRef.current);
    measureControllerRef.current?.abort();
  }, []);

  const scrollSyncEnabled = settingsConfig?.splitScrollSync ?? true;

  const scheduleScrollMeasurement = useCallback(
    (delayMs = 0) => {
      if (viewMode !== "split" || !scrollSyncEnabled) return;
      if (!contentRef.current || !previewScrollRef.current) return;

      /**
       * **不清空旧偏移量。**
       *
       * 原先这里一进来就 `blockOffsets.current = []`，而它被清空的瞬间滚动同步就整个停摆
       * （`handleEditorScroll` 见到空数组直接 return）。编辑时每敲一个字都会重跑测量，旧的
       * 又被清掉、新的要等 250ms 防抖 —— 结果就是**边打字边滚动时预览完全跟不上**。
       * 留着上一轮的值，顶多是刚编辑那几行的偏移旧了一点点，比彻底不动强得多。
       */
      cancelScrollMeasurement();

      const controller = new AbortController();
      measureControllerRef.current = controller;

      const measure = () => {
        if (!contentRef.current || !previewScrollRef.current) return;

        // 先问高亮层：真实布局，零累积误差，而且只是读 N 个 offsetTop，便宜到可以每帧做。
        const fromLayer = blockOffsetsFromLayer(highlightLayerRef.current, content);
        if (fromLayer) {
          blockOffsets.current = fromLayer;
          tagPreviewBlocks(previewScrollRef.current, content);
          return;
        }

        // 层不可用（超大文档放弃着色）。镜像测量要把全文重排一遍，很贵 —— 所以只有这条路
        // 继续保留防抖，且跟着 controller 一起可取消。
        measureDebounceRef.current = setTimeout(() => {
          const textarea = contentRef.current;
          if (!textarea) return;
          void measureBlockOffsets(content, textarea, controller.signal).then((offsets) => {
            if (controller.signal.aborted) return;
            blockOffsets.current = offsets;
            if (previewScrollRef.current) tagPreviewBlocks(previewScrollRef.current, content);
          });
        }, 250);
      };

      if (delayMs > 0) {
        measureDebounceRef.current = setTimeout(() => {
          measureRafRef.current = requestAnimationFrame(measure);
        }, delayMs);
      } else {
        measureRafRef.current = requestAnimationFrame(measure);
      }
    },
    [cancelScrollMeasurement, content, scrollSyncEnabled, viewMode],
  );

  /**
   * 每帧都重新量一遍，**不退避**。
   *
   * 退避原本是为了躲开 `measureBlockOffsets` 的全文重排；现在量的是高亮层（读 N 个
   * offsetTop），便宜到可以跟着每一帧走。这也顺手修了「边打字边滚，预览跟不上」：以前
   * 编辑时 250ms 防抖一直被打断，测量几乎不落地。
   */
  useEffect(() => {
    if (viewMode !== "split" || !scrollSyncEnabled) {
      blockOffsets.current = [];
      cancelScrollMeasurement();
      return;
    }

    scheduleScrollMeasurement();

    return () => {
      cancelScrollMeasurement();
    };
  }, [
    cancelScrollMeasurement,
    content,
    scrollSyncEnabled,
    scheduleScrollMeasurement,
    selectedId,
    settingsConfig?.fontSize,
    settingsConfig?.renderHtmlMarkdown,
    splitRatio,
    viewMode,
  ]);

  useEffect(() => {
    if (viewMode !== "split") return;

    const observedElements: Element[] = [];
    if (splitContainerRef.current) observedElements.push(splitContainerRef.current);
    if (contentRef.current) observedElements.push(contentRef.current);
    if (previewScrollRef.current) observedElements.push(previewScrollRef.current);

    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => scheduleScrollMeasurement(120);
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    if (observedElements.length === 0) return;

    const observer = new ResizeObserver(() => {
      scheduleScrollMeasurement(120);
    });
    observedElements.forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [scheduleScrollMeasurement, viewMode]);

  // Reset preview scroll on note switch
  useEffect(() => {
    if (previewScrollRef.current) {
      previewScrollRef.current.scrollTop = 0;
    }
    // 编辑器也要一并归零：切笔记时 textarea 是同一个 DOM 节点，浏览器会把越界的
    // scrollTop 静默 clamp 回新上限（且**不派发 scroll 事件**），于是高亮层还停在旧
    // 偏移上，表现为「编辑区空白或显示旧内容，滚一下才回来」。
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
    setEditorScrollTop(0);
  }, [selectedId]);

  /**
   * 把编辑器高亮层的偏移与 textarea 的真实 scrollTop 重新对齐。
   *
   * 可见文字来自那层绝对定位的高亮层，它的位置完全由 `editorScrollTop` 决定，而这个
   * state 只在 textarea 触发原生 `scroll` 事件时才更新。有三条路径会让 scrollTop
   * 变化却不发事件：切笔记时的静默 clamp、`key={viewMode}` 重挂载后归零、内容被程序
   * 改写后高度收缩。任何一条没跟上，高亮层就被顶到视口外，编辑区看起来是空的。
   *
   * 依赖里放 `content` 是为了覆盖撤销、插件写入、查找替换这些程序化改动。值相同
   * 时 React 会跳过重渲染，所以逐键运行不会有额外开销。
   */
  useEffect(() => {
    const textarea = contentRef.current;
    const actual = textarea ? textarea.scrollTop : 0;
    setEditorScrollTop((previous) => (previous === actual ? previous : actual));
  }, [selectedId, viewMode, content]);

  const handleEditorScroll = useCallback(() => {
    const ta = contentRef.current;
    if (ta) setEditorScrollTop(ta.scrollTop);

    if (viewMode !== "split") return;
    if (scrollSource.current === "preview") return;

    const textarea = contentRef.current;
    const preview = previewScrollRef.current;
    if (!textarea || !preview) return;

    scrollSource.current = "editor";
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      scrollSource.current = null;
    }, 150);

    const offsets = blockOffsets.current;
    if (offsets.length === 0) return;

    const blockIdx = blockIndexAtOffset(offsets, textarea.scrollTop);
    const el = preview.querySelector<HTMLElement>(`[data-block-index="${blockIdx}"]`);
    if (!el) return;

    /**
     * 块内还要按**比例**插值，不能只把整块顶到顶部。
     *
     * 只对齐块首的话，编辑区停在某个长段落中间时，预览会把这一段拉回开头 —— 于是预览里
     * 正在写的那一句被推到下方看不见的地方，越长的块偏得越远。
     *
     * 比例用同一块在两边的「已走过多少」来算：编辑区侧是滚动量，预览侧是块高。两边都按
     * `getBoundingClientRect()` 量（缩放是内层 `transform`，撑开层已经是缩放后的尺寸，所以
     * 视口 px 与滚动内容 px 同尺度，不需要再除以倍率）。
     */
    const containerRect = preview.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const blockTop = offsets[blockIdx];
    const blockBottom = offsets[blockIdx + 1] ?? textarea.scrollHeight;
    const span = Math.max(1, blockBottom - blockTop);
    const fraction = Math.min(1, Math.max(0, (textarea.scrollTop - blockTop) / span));

    const nextEl = preview.querySelector<HTMLElement>(`[data-block-index="${blockIdx + 1}"]`);
    const height = nextEl ? nextEl.getBoundingClientRect().top - elRect.top : elRect.height;

    preview.scrollTop = preview.scrollTop + (elRect.top - containerRect.top) + fraction * height;
  }, [viewMode]);

  const handlePreviewScroll = useCallback(() => {
    if (viewMode !== "split") return;
    if (scrollSource.current === "editor") return;

    const textarea = contentRef.current;
    const preview = previewScrollRef.current;
    if (!textarea || !preview) return;

    scrollSource.current = "preview";
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      scrollSource.current = null;
    }, 150);

    const elements = preview.querySelectorAll<HTMLElement>("[data-block-index]");
    if (elements.length === 0) return;

    const containerRect = preview.getBoundingClientRect();
    let topDomIndex = 0;
    let topEl: HTMLElement | null = null;
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerRect.top + 1) {
        topDomIndex = parseInt(el.getAttribute("data-block-index")!, 10);
        topEl = el;
        break;
      }
    }

    const offsets = blockOffsets.current;
    if (topDomIndex >= offsets.length) return;

    // 与反方向对称：落点也在块内按比例插值，否则预览滚到长段落中间时，编辑区会被拉回块首。
    const blockTop = offsets[topDomIndex];
    const blockBottom = offsets[topDomIndex + 1] ?? textarea.scrollHeight;
    const span = Math.max(1, blockBottom - blockTop);
    const rect = topEl?.getBoundingClientRect();
    const fraction = rect
      ? Math.min(1, Math.max(0, (containerRect.top - rect.top) / Math.max(1, rect.height)))
      : 0;

    textarea.scrollTop = blockTop + fraction * span;
  }, [viewMode]);

  const handlePreviewSelect = useCallback(() => {
    if (viewMode !== "split" && viewMode !== "preview") return;

    const selection = window.getSelection();
    const hasSelection = selection && !selection.isCollapsed && selection.rangeCount > 0;
    const selectedText = hasSelection ? selection.toString() : "";

    if (!selection || !selectedText) {
      setMatchedRange(null);
      setHighlightRects([]);
      return;
    }

    const textarea = contentRef.current;
    if (!textarea) return;

    let selStart = -1;
    let selEnd = -1;

    // 优先：块索引定位 + 块内匹配
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const startEl = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const blockEl = startEl?.closest("[data-block-index]");
    if (blockEl) {
      const blockIndex = Number(blockEl.getAttribute("data-block-index"));
      const block = parseBlocks(content)[blockIndex];
      if (block) {
        const lines = content.split("\n");
        let startOffset = 0;
        for (let i = 0; i < block.startLine; i++) {
          startOffset += lines[i].length + 1;
        }
        const blockText = lines.slice(block.startLine, block.endLine).join("\n");
        const match = blockText.indexOf(selectedText);
        if (match >= 0) {
          selStart = startOffset + match;
          selEnd = selStart + selectedText.length;
        }
      }
    }

    // 兜底：去除格式符号后匹配（应对 **、_、换行等渲染差异）
    if (selStart < 0) {
      const { plain, positions } = stripMarkdownInline(content);
      const normalized = selectedText.replace(/\s+/g, " ");
      const plainIndex = plain.indexOf(normalized);
      if (plainIndex >= 0) {
        selStart = positions[plainIndex];
        selEnd = positions[plainIndex + normalized.length - 1] + 1;
      }
    }

    if (selStart < 0) {
      setMatchedRange(null);
      setHighlightRects([]);
      return;
    }

    setMatchedRange({ start: selStart, end: selEnd });

    // 保存原始矩形，滚动偏移在渲染时用 editorScrollTop 减去
    const rects =
      lineRectsFromLayer(highlightLayerRef.current, textarea.value, selStart, selEnd) ??
      measureSelectionRects(textarea, selStart, selEnd);

    setHighlightRects(rects);
    setEditorScrollTop(textarea.scrollTop);
  }, [content, viewMode]);

  const handleEditorFocus = useCallback(() => {
    if (!matchedRange) return;
    const textarea = contentRef.current;
    if (!textarea) return;
    textarea.setSelectionRange(matchedRange.start, matchedRange.end);
    setMatchedRange(null);
    setHighlightRects([]);
  }, [matchedRange]);

  /**
   * 把**整个主窗口**钉在最前。
   *
   * 以前这个按钮是「为当前笔记开一个置顶磁贴窗」，现在改成直接给主窗口设
   * always-on-top：用户要的是“这个界面别被挡住”，而不是再开一个小窗。磁贴窗能力
   * 本身没动，只是不再由这个按钮承担。
   */
  const handleTogglePin = useCallback(async () => {
    const next = !windowPinned;
    try {
      await setCurrentWindowAlwaysOnTop(next);
      setWindowPinned(next);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [windowPinned]);

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!content.trim()) {
        showToast(t("errors.emptyContentExport", { defaultValue: "没有可导出的内容" }));
        return;
      }

      const fallbackTitle = t("common.untitledNote", { defaultValue: "无标题笔记" });

      if (format === "md") {
        try {
          const path = await save({
            defaultPath: `${title || fallbackTitle}.md`,
            filters: [{ name: "Markdown", extensions: ["md"] }],
          });
          if (typeof path !== "string") return;
          // 走 save_external_file 而不是 notes_export_markdown：后者按笔记 id 取内容，
          // 对工作文件夹里打开的外部文件不适用。这条路径对两者都成立。
          await saveExternalFile(path, content);
          notifyPluginAssetSaved(path);
        } catch (error) {
          showToast(getErrorMessage(error));
        }
        return;
      }

      try {
        // 捕获渲染后的预览 HTML（含格式化、图片等）
        // 取**内容层**而不是滚动容器：后者还含撑开层与 scale 包装，打进 PDF 会串版。
        const renderedHtml =
          (previewContentRef.current ?? previewScrollRef.current)?.innerHTML ?? undefined;
        // 打开导出界面（预览 + 设置），真正的生成在那边按用户选的参数做。
        // 没有预览（编辑器模式、或还没渲染出来）时才退回自己转一份 Markdown。
        const bodyHtml = await buildPrintBody({
          title: title || fallbackTitle,
          content,
          renderedHtml,
        });
        setPdfPanel({ title: title || fallbackTitle, bodyHtml });
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [content, title, t],
  );

  /**
   * 导出下拉：点到菜单外面才收起。
   *
   * ⚠️ 这里必须判断事件是否落在菜单内。早先的写法是无条件关闭，于是在菜单项上
   * 按下鼠标的瞬间菜单就被卸载了，随之而来的 `click` 再也派发不到那个按钮上——
   * 两个格式都点不动，症状是「另存为 PDF 没反应」。
   */
  useEffect(() => {
    if (!exportMenuOpen) return;
    // 参数用 DOM 的 `Event`：本文件顶部的 `MouseEvent` 是 React 的合成事件类型，
    // 两者不兼容。
    const close = (event: Event) => {
      const target = event.target as Node | null;
      if (target && exportMenuRef.current?.contains(target)) return;
      setExportMenuOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [exportMenuOpen]);

  const toggleMaximize = () => {
    void toggleMaximizeCurrentWindow().then(() => isCurrentWindowMaximized().then(setIsMaximized));
  };

  const handleTitleBarMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.button !== 0) return;
    if (event.detail === 2) {
      toggleMaximize();
      return;
    }
    void startCurrentWindowDrag().catch(() => undefined);
  };

  const handleMinimize = () => {
    void minimizeCurrentWindow();
  };

  const handleMaximize = () => {
    toggleMaximize();
  };

  const handleClose = () => {
    void closeCurrentWindow();
  };

  /**
   * 预览吃的正文：**滞后于编辑器**。
   *
   * 预览是整篇走 react-markdown（remark / rehype-raw / rehype-sanitize / katex 全套）
   * 重新解析排版的，十几万字符一次要几百毫秒 —— 实测 1.1 万字符的文档里，敲一个键到
   * 浏览器该绘制之间是 **780ms**，其中分词只占 0.6ms、镜像推送 0.5ms。**那 780ms 几乎
   * 全是它在重排整篇文章。**
   *
   * 而这个开销和编辑本身无关：编辑器那层早就改成按行增量了。让预览跟着每一次按键走，
   * 等于每敲一个字就把整篇重排一遍。所以这里让它慢半拍 —— 停下来之后才跟上。打字时
   * 预览不动，编辑器就顺了。
   */
  const [previewContent, setPreviewContent] = useState(content);

  // 换文件立刻跟上，否则切过去会先看到上一篇的内容。
  useEffect(() => {
    setPreviewContent(content);
    // 只认「换了哪一篇」这一个触发条件；content 只用来取当下的值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // 打字时滞后。350ms 是手感与开销的折中：再短会频繁触发重排，再长会觉得预览「跟不上」。
  useEffect(() => {
    if (previewContent === content) return undefined;
    const timer = window.setTimeout(() => setPreviewContent(content), PREVIEW_LAG_MS);
    return () => window.clearTimeout(timer);
  }, [content, previewContent]);

  /** 预览正文。抽出来是因为它在「预览」与「分栏」两种结构里各渲染一次。 */
  const previewBody =
    selectedFileType?.kind === "table" ? (
      <TablePreview text={previewContent} isTsv={/\.tsv$/i.test(activeFilePath ?? "")} />
    ) : (
      <MarkdownPreview
        content={previewContent}
        fontSize={settingsConfig?.fontSize ?? 14}
        renderHtml={settingsConfig?.renderHtmlMarkdown ?? false}
        imageBaseDir={imageBaseDir ?? undefined}
      />
    );

  /** 缩放倍率徽章。预览面板与独立预览都要用，抽出来只写一份。 */
  const previewZoomBadge =
    previewZoom !== 1 ? (
      <button
        onClick={() => {
          previewZoomRef.current = 1;
          setPreviewZoom(1);
        }}
        className="absolute right-3 top-2 z-10 px-2 h-6 rounded-md bg-cloud/90 backdrop-blur-sm border border-paper-deep/50 text-[10px] font-mono text-ink-soft hover:text-bamboo transition-colors cursor-pointer"
        title={t("main.preview.resetZoom", { defaultValue: "点击恢复 100%" })}
      >
        {Math.round(previewZoom * 100)}%
      </button>
    ) : null;

  return (
    <div className="main-window w-full h-screen flex flex-col">
      <div className="main-surface relative noise-bg bg-cloud overflow-hidden flex flex-col flex-1">
        <BackgroundLayer config={settingsConfig} />
        <div
          className={`titlebar relative z-10 flex items-center justify-between h-11 bg-paper/55 backdrop-blur-[1px] border-b border-paper-deep/30 shrink-0 select-none cursor-default ${
            isMacOS ? "pl-20 pr-5" : "pl-5 pr-0"
          }`}
          onMouseDown={handleTitleBarMouseDown}
        >
          <div className="titlebar-brand flex items-center gap-3 min-w-0">
            <span className="text-[15px] font-serif font-medium text-ink-soft tracking-wide leading-none">
              花笺
            </span>
            <span className="text-[11px] text-ink-ghost font-body leading-none translate-y-px">
              —
            </span>
            <span className="titlebar-title text-[11px] text-ink-faint font-body truncate max-w-[240px] leading-none translate-y-px">
              {title ||
                selectedNote?.preview ||
                t("common.untitledNote", { defaultValue: "无标题笔记" })}
            </span>
          </div>
          <div className="titlebar-actions flex items-center">
            {/* 窗口置顶。放在插件工具组的左边：它是「整个界面」的开关，不属于任何
                单个文件的工具。 */}
            <button
              onClick={() => void handleTogglePin()}
              aria-pressed={windowPinned}
              className={`titlebar-button w-10 h-11 flex items-center justify-center transition-all cursor-pointer ${
                windowPinned
                  ? "is-active text-bamboo bg-bamboo-mist/50"
                  : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50"
              }`}
              title={
                windowPinned
                  ? t("main.window.unpin", { defaultValue: "取消窗口置顶" })
                  : t("main.window.pin", { defaultValue: "窗口置顶" })
              }
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z" />
              </svg>
            </button>
            <button
              onClick={handleOpenPlugins}
              className="titlebar-button w-10 h-11 flex items-center justify-center text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer"
              title="插件"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 3v2a2 2 0 1 0 4 0V3h4a1 1 0 0 1 1 1v4h-2a2 2 0 1 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 1 0-4 0v2H5a1 1 0 0 1-1-1v-4h2a2 2 0 1 0 0-4H4V5a1 1 0 0 1 1-1h4z" />
              </svg>
            </button>
            <button
              onClick={() => void handleOpenSettings()}
              className="titlebar-button w-10 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer"
              title={t("main.window.settings", { defaultValue: "设置" })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            {/* 「关于」：开右侧栏。
                做成侧栏而不是标题栏上的下拉菜单 —— 下拉会被标题栏那套拖拽/叠层吃掉
                点击（实测点不动），而且**它放不下东西**：版本、下载地址、更新源、
                数据目录这些本来就属于「关于」该说的。 */}
            <button
              onClick={handleOpenAbout}
              className={`titlebar-button w-10 h-11 flex items-center justify-center transition-all cursor-pointer ${
                visibleSidePanel === "about"
                  ? "is-active text-bamboo bg-bamboo-mist/50"
                  : "text-ink-ghost hover:text-ink-faint hover:bg-paper-warm"
              }`}
              title={t("main.about.title", { defaultValue: "关于" })}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            </button>

            {/* 「样式」：开右侧栏，看全局样式表（`<数据目录>/styles/*.css`）现在生效了哪几份。
                没有开关 —— 目录里有哪几份就有哪几份生效，所以这里只是个查看入口。 */}
            <button
              onClick={handleOpenStyles}
              className={`titlebar-button w-10 h-11 flex items-center justify-center transition-all cursor-pointer ${
                visibleSidePanel === "styles"
                  ? "is-active text-bamboo bg-bamboo-mist/50"
                  : "text-ink-ghost hover:text-ink-faint hover:bg-paper-warm"
              }`}
              title={t("main.styles.title", { defaultValue: "样式" })}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2 2 7l10 5 10-5-10-5z" />
                <path d="m2 17 10 5 10-5" />
                <path d="m2 12 10 5 10-5" />
              </svg>
            </button>

            {/* 右上角：有新版时冒一颗胶囊。没更新时它渲染成 null，什么都不占。 */}
            <UpdateBadge controller={update} />
            {!isMacOS && (
              <>
                <div className="w-px h-4 bg-paper-deep/30 mx-0.5" />

                <button
                  onClick={handleMinimize}
                  className="window-control w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
                  title={t("main.window.minimize", { defaultValue: "最小化" })}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <rect x="1" y="5.5" width="10" height="1" fill="currentColor" rx="0.5" />
                  </svg>
                </button>
                <button
                  onClick={handleMaximize}
                  className="window-control w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
                  title={
                    isMaximized
                      ? t("main.window.restore", { defaultValue: "还原" })
                      : t("main.window.maximize", { defaultValue: "最大化" })
                  }
                >
                  {isMaximized ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    >
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <path d="M3 5H2V2a1 1 0 0 1 1-1h5v1" />
                    </svg>
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    >
                      <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
                    </svg>
                  )}
                </button>
                <button
                  onClick={handleClose}
                  className="window-control is-close w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-red-500 hover:bg-danger-bg transition-all cursor-pointer"
                  title={t("main.window.close", { defaultValue: "关闭" })}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>

        <div className="main-body relative z-10 flex flex-1 min-h-0">
          <ActivityBar
            items={activityItems}
            activeId={activeExplorer}
            onSelect={handleSelectExplorer}
            onAdd={() => void handleAddWorkspaceFolder()}
            addTitle={t("main.explorer.addFolder", { defaultValue: "添加工作文件夹" })}
            onRemove={(id) => void handleRemoveWorkspaceFolder(id)}
            onSetIcon={(id, icon) => void handleSetWorkspaceIcon(id, icon)}
          />
          <div
            className={`sidebar ${
              sidebarCollapsed ? "is-collapsed" : ""
            } border-r border-paper-deep/30 bg-paper/40 shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]`}
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          >
            <div
              className="sidebar-inner flex flex-col h-full"
              style={{ width: `${sidebarWidth}px` }}
            >
              {/* 侧栏自己的标题行，两个视图共用。

                  收起按钮放在这里、而不是主工具栏那一排：它管的是**这一栏**，和
                  「当前文件」的那排工具不是一回事，混在一起每次都要找。收起来之后要
                  展开，点活动栏里当前高亮的那一格即可（点已选中的格 = 收起/展开）。

                  这里原本还有个 ×（从侧栏移除工作文件夹）。它挪去了活动栏图标的右键
                  菜单 —— 移除是低频且不可逆的操作，不该和常用按钮挤在同一行。 */}
              <div className="sidebar-header flex items-center justify-between gap-2 px-3 py-1.5 shrink-0">
                <div className="min-w-0 flex-1">
                  <span
                    className="sidebar-title block text-[11px] font-display font-medium text-ink-faint truncate"
                    title={activeExplorer === EXPLORER_NOTES ? undefined : activeExplorer}
                  >
                    {activeExplorer === EXPLORER_NOTES
                      ? t("main.explorer.notes", { defaultValue: "笔记" })
                      : folderName(activeExplorer)}
                  </span>
                  {/* 副标题：这个文件夹的**完整地址**。
                      只给名字时，几个工作文件夹都叫 src / styles 就分不清是哪个了。
                      路径从头部截（见 shortenPath），且长度跟着栏宽走 —— 估得保守些，
                      免得外面的 truncate 再从尾部削一刀，把特意保下来的那几段吃掉。 */}
                  {activeExplorer !== EXPLORER_NOTES && (
                    <span
                      className="sidebar-subtitle block text-[10px] leading-4 text-ink-ghost/70 truncate"
                      title={activeExplorer}
                    >
                      {shortenPath(activeExplorer, (sidebarWidth - 64) / 5.5)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer shrink-0"
                  title={t("main.window.collapseSidebar", { defaultValue: "收起侧栏" })}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>
              </div>

              {/* 活动栏选的是工作文件夹时，把笔记那套内容整段换掉。用 Fragment 而不是
                  包一层 div：Fragment 不产生 DOM 节点，原有的 flex 布局完全不受影响。
                  下面这一大段沿用原有缩进，交给 oxfmt 统一整理。 */}
              {activeExplorer === EXPLORER_NOTES ? (
                <>
                  <div className="note-search px-3 pt-3 pb-2 shrink-0">
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
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={t("main.sidebar.searchPlaceholder", {
                          defaultValue: "搜索笔记…",
                        })}
                        className="flex-1 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
                      />
                      {searchQuery && (
                        <button
                          onClick={() => setSearchQuery("")}
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
                      )}
                    </div>
                  </div>

                  <div className="px-3 pb-2 shrink-0 space-y-1">
                    <button
                      onClick={handleNewNote}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-bamboo hover:bg-bamboo-mist/60 transition-all cursor-pointer group"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        className="group-hover:rotate-90 transition-transform duration-200"
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      <span>{t("main.sidebar.newNote", { defaultValue: "新建笔记" })}</span>
                    </button>
                    <button
                      onClick={() => void handleImportNote()}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer group"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 3v12" />
                        <path d="m7 10 5 5 5-5" />
                        <path d="M5 21h14" />
                      </svg>
                      <span>
                        {t("main.sidebar.importMarkdown", { defaultValue: "导入 Markdown" })}
                      </span>
                    </button>
                  </div>

                  <div className="flex items-center justify-between px-5 pb-1.5 shrink-0">
                    <span className="text-[10px] text-ink-ghost font-mono tracking-wider uppercase">
                      {t("common.noteCount", {
                        count: filteredNotes.length,
                        defaultValue: "{{count}} 篇笔记",
                      })}
                      {listedExternalFiles.length > 0
                        ? ` · ${t("common.externalFileCount", {
                            count: listedExternalFiles.length,
                            defaultValue: "{{count}} 个外部文件",
                          })}`
                        : ""}
                    </span>
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (showCategoryInput && categoryInputValue.trim()) {
                          void handleCreateCategory();
                          return;
                        }
                        setShowCategoryInput(true);
                      }}
                      className="text-[10px] text-ink-ghost hover:text-bamboo transition-colors cursor-pointer"
                      title={t("main.category.new", { defaultValue: "新建分类" })}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </div>

                  {showCategoryInput && (
                    <div className="px-3 pb-2 shrink-0">
                      <input
                        type="text"
                        autoFocus
                        value={categoryInputValue}
                        onChange={(e) => setCategoryInputValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleCreateCategory();
                          if (e.key === "Escape") {
                            setShowCategoryInput(false);
                            setCategoryInputValue("");
                          }
                        }}
                        onBlur={() => void handleCreateCategory()}
                        placeholder={t("main.category.placeholder", {
                          defaultValue: "输入分类名…",
                        })}
                        className="w-full px-2.5 h-7 rounded-lg text-[12px] font-body text-ink bg-paper-warm/80 border border-paper-deep/40 focus:border-bamboo/30 placeholder:text-ink-ghost/60"
                      />
                    </div>
                  )}

                  <div className="note-list flex-1 overflow-y-auto px-2 pb-2">
                    <div className="space-y-0.5">
                      {listedExternalFiles.length > 0 && (
                        <>
                          <div className="note-group-header px-3 py-1.5 text-[10px] text-ink-ghost/50 font-mono tracking-wider uppercase">
                            {t("main.externalFiles.title", { defaultValue: "外部文件" })}
                          </div>
                          {listedExternalFiles.map((file) => {
                            const isSelected = file.id === selectedId;
                            const isHovered = file.id === hoveredId;

                            return (
                              <div
                                key={file.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => void handleSelectExternalFile(file.id)}
                                onKeyDown={(event) => {
                                  // 外层从 <button> 改成 <div role="button">：卡片里还有
                                  // 一个「从列表移除」的按钮，而 <button> 按规范不能包含
                                  // 交互内容。失去的原生键盘行为在这里补齐。
                                  if (event.key !== "Enter" && event.key !== " ") return;
                                  event.preventDefault();
                                  void handleSelectExternalFile(file.id);
                                }}
                                onMouseEnter={() => setHoveredId(file.id)}
                                onMouseLeave={() => setHoveredId(null)}
                                className={`explorer-item w-full text-left rounded-xl px-3 py-2.5 transition-all duration-[600ms] cursor-pointer group relative ${
                                  isSelected
                                    ? "is-selected bg-bamboo-mist/70"
                                    : isHovered
                                      ? "is-hovered bg-paper-warm/70"
                                      : "bg-transparent"
                                }`}
                              >
                                <div
                                  className={`explorer-item-accent absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                                    isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                                  }`}
                                />

                                <div className="flex items-baseline justify-between mb-0.5">
                                  <span
                                    className={`explorer-item-title text-[13px] font-display font-medium truncate pr-2 transition-colors flex items-center gap-1.5 ${
                                      isSelected ? "text-bamboo" : "text-ink-soft"
                                    }`}
                                  >
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      className="shrink-0 opacity-60"
                                    >
                                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                      <polyline points="14 2 14 8 20 8" />
                                    </svg>
                                    {file.title}
                                  </span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRemoveExternalFile(file.id);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 text-ink-ghost hover:text-red-400 transition-all p-0.5"
                                    title={t("main.externalFiles.remove", {
                                      defaultValue: "从列表移除",
                                    })}
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
                                      <line x1="18" y1="6" x2="6" y2="18" />
                                      <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                  </button>
                                </div>

                                <p className="explorer-item-subtitle text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors pl-[18px]">
                                  {file.filePath}
                                </p>
                              </div>
                            );
                          })}
                        </>
                      )}

                      {categoryGroups.map((group: CategoryGroup) => {
                        if (!group.category) {
                          return (
                            <div
                              key="__uncategorized__"
                              className={`note-group rounded-lg transition-all duration-200 ${
                                dragOverCategory === ""
                                  ? "is-drag-over bg-bamboo/10 ring-1 ring-bamboo/20"
                                  : ""
                              }`}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                                setDragOverCategory("");
                              }}
                              onDragLeave={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                  setDragOverCategory(null);
                                }
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                setDragOverCategory(null);
                                const noteId = e.dataTransfer.getData("text/plain");
                                if (noteId) void handleMoveNote(noteId, "");
                              }}
                            >
                              {group.notes.map((note) => (
                                <ExplorerItem
                                  key={note.id}
                                  draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.setData("text/plain", note.id);
                                    e.dataTransfer.effectAllowed = "move";
                                  }}
                                  onSelect={() => void handleSelectNote(note.id)}
                                  onContextMenu={(event) => handleOpenNoteMenu(event, note.id)}
                                  onHoverChange={(hovered) =>
                                    setHoveredId(hovered ? note.id : null)
                                  }
                                  selected={note.id === selectedId}
                                  hovered={note.id === hoveredId}
                                  title={getDisplayTitle(note, t)}
                                  meta={formatShortDate(note.updatedAt)}
                                  subtitle={
                                    note.preview ||
                                    t("common.blankNote", { defaultValue: "空白笔记" })
                                  }
                                  details={[
                                    formatTime(note.updatedAt),
                                    t("common.wordCount", {
                                      count: note.wordCount,
                                      defaultValue: "{{count}} 字",
                                    }),
                                  ]}
                                />
                              ))}
                            </div>
                          );
                        }

                        const isCollapsed = collapsedCategories.has(group.category);

                        return (
                          <div key={group.category} className="note-group px-2 mb-0.5">
                            <div
                              className={`note-group-header flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg group/cat cursor-pointer select-none transition-all duration-200 ${
                                dragOverCategory === group.category
                                  ? "is-drag-over bg-bamboo/15 border border-bamboo/40 ring-1 ring-bamboo/20"
                                  : isCollapsed
                                    ? "bg-transparent border border-bamboo/15"
                                    : "is-open bg-bamboo/8 border border-bamboo/15 rounded-b-none"
                              }`}
                              onClick={() => toggleCategoryCollapse(group.category)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setCategoryMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  category: group.category,
                                });
                                setCategoryMenuClosing(false);
                                setCategoryMenuConfirmDelete(false);
                              }}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                                setDragOverCategory(group.category);
                              }}
                              onDragLeave={() => setDragOverCategory(null)}
                              onDrop={(e) => {
                                e.preventDefault();
                                setDragOverCategory(null);
                                const noteId = e.dataTransfer.getData("text/plain");
                                if (noteId) void handleMoveNote(noteId, group.category);
                              }}
                            >
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className={`text-bamboo/50 shrink-0 transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
                              >
                                <polyline points="9 18 15 12 9 6" />
                              </svg>
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="text-bamboo/50 shrink-0"
                              >
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                              </svg>
                              {renamingCategory === group.category ? (
                                <input
                                  type="text"
                                  autoFocus
                                  value={renameCategoryValue}
                                  onChange={(e) => setRenameCategoryValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === "Enter")
                                      void handleRenameCategory(group.category);
                                    if (e.key === "Escape") setRenamingCategory(null);
                                  }}
                                  onBlur={() => void handleRenameCategory(group.category)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="flex-1 min-w-0 px-1 text-[10px] font-mono text-ink bg-paper-warm/80 border border-bamboo/30 rounded"
                                />
                              ) : (
                                <span className="text-[11px] text-bamboo/70 font-medium truncate">
                                  {group.category}
                                </span>
                              )}
                              <span className="text-[9px] text-bamboo/40 font-mono ml-auto shrink-0">
                                {group.notes.length}
                              </span>
                            </div>

                            <div className={`category-body ${isCollapsed ? "" : "expanded"}`}>
                              <div
                                className="category-body-inner bg-bamboo/[0.03] border border-t-0 border-bamboo/10 rounded-b-lg pb-1 pt-1"
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = "move";
                                  setDragOverCategory(group.category);
                                }}
                                onDragLeave={(e) => {
                                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                    setDragOverCategory(null);
                                  }
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  setDragOverCategory(null);
                                  const noteId = e.dataTransfer.getData("text/plain");
                                  if (noteId) void handleMoveNote(noteId, group.category);
                                }}
                              >
                                {group.notes.length === 0 ? (
                                  <div className="note-empty px-3 py-3 text-center text-[11px] text-ink-ghost/50">
                                    {t("main.category.emptyFolder", { defaultValue: "空文件夹" })}
                                  </div>
                                ) : (
                                  group.notes.map((note) => (
                                    <ExplorerItem
                                      key={note.id}
                                      inset
                                      draggable
                                      onDragStart={(e) => {
                                        e.dataTransfer.setData("text/plain", note.id);
                                        e.dataTransfer.effectAllowed = "move";
                                      }}
                                      onSelect={() => void handleSelectNote(note.id)}
                                      onContextMenu={(event) => handleOpenNoteMenu(event, note.id)}
                                      onHoverChange={(hovered) =>
                                        setHoveredId(hovered ? note.id : null)
                                      }
                                      selected={note.id === selectedId}
                                      hovered={note.id === hoveredId}
                                      title={getDisplayTitle(note, t)}
                                      meta={formatShortDate(note.updatedAt)}
                                      subtitle={
                                        note.preview ||
                                        t("common.blankNote", { defaultValue: "空白笔记" })
                                      }
                                      details={[
                                        formatTime(note.updatedAt),
                                        t("common.wordCount", {
                                          count: note.wordCount,
                                          defaultValue: "{{count}} 字",
                                        }),
                                      ]}
                                    />
                                  ))
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {!isLoading &&
                        filteredNotes.length === 0 &&
                        listedExternalFiles.length === 0 && (
                          <div className="note-empty px-3 py-8 text-center text-[12px] text-ink-ghost leading-relaxed">
                            {searchQuery
                              ? t("main.search.noResults", { defaultValue: "没有匹配的笔记" })
                              : t("main.search.empty", { defaultValue: "还没有笔记" })}
                          </div>
                        )}
                    </div>
                  </div>
                </>
              ) : (
                <WorkspaceTree
                  key={activeExplorer}
                  root={activeExplorer}
                  selectedPath={selectedId}
                  onOpenFile={handleOpenWorkspaceFile}
                />
              )}
            </div>
          </div>

          {!sidebarCollapsed && (
            <div
              className={`sidebar-resizer w-1 shrink-0 cursor-col-resize group relative ${isResizingSidebar ? "is-dragging bg-bamboo/30" : "hover:bg-bamboo/20"} transition-colors`}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingSidebar(true);
              }}
            >
              <div
                className={`absolute inset-y-0 -left-1 -right-1 ${isResizingSidebar ? "" : "group-hover:bg-bamboo/5"}`}
              />
            </div>
          )}

          <div className="main-column flex-1 flex flex-col min-w-0">
            {/* 允许换行：插件多了之后（样式/统计/目录…）这一行放不下。原来固定 h-10
                且不换行，按钮会被压到逐字竖排，插件页签还会和视图切换叠在一起。 */}
            <div
              className={`doc-toolbar flex flex-wrap items-center gap-x-1 gap-y-0.5 px-4 py-1 border-b border-paper-deep/20 shrink-0 bg-paper/20 ${
                toolbarIdle ? "is-idle hidden" : "min-h-10"
              }`}
            >
              <div className="doc-toolbar-group flex flex-wrap items-center gap-1 min-w-0">
                {documentContext === "note" ? (
                  <button
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={async () => {
                      const filePath = await open({
                        multiple: false,
                        directory: false,
                        filters: [
                          {
                            name: "Images",
                            extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
                          },
                        ],
                      });
                      if (typeof filePath !== "string" || !selectedId || isExternal) return;
                      try {
                        const relativePath = await saveImageFromPath(selectedId, filePath);
                        const textarea = contentRef.current;
                        if (textarea && relativePath) {
                          const mdImage = `![](${relativePath})`;
                          textarea.focus();
                          document.execCommand("insertText", false, "\n" + mdImage + "\n");
                          setContent(textarea.value);
                          markDirty();
                        }
                      } catch (error) {
                        showToast(getErrorMessage(error));
                      }
                    }}
                    disabled={!selectedId || isExternal}
                    className="doc-toolbar-button w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    title={t("notepad.button.insertImage", { defaultValue: "插入图片" })}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </button>
                ) : null}

                {hasEditableBody ? (
                  <>
                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={handleUndo}
                      disabled={!canUndoNow}
                      className="doc-toolbar-button w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      title={t("main.editor.undo", { defaultValue: "撤销（Ctrl+Z）" })}
                      aria-label={t("main.editor.undoLabel", { defaultValue: "撤销" })}
                    >
                      <svg
                        data-testid="main-editor-undo-icon"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M9 14 4 9l5-5" />
                        <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
                      </svg>
                    </button>

                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={handleRedo}
                      disabled={!canRedoNow}
                      className="doc-toolbar-button w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      title={t("main.editor.redo", { defaultValue: "重做（Ctrl+Y）" })}
                      aria-label={t("main.editor.redoLabel", { defaultValue: "重做" })}
                    >
                      <svg
                        data-testid="main-editor-redo-icon"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        style={{ transform: "scaleX(-1)" }}
                      >
                        <path d="M9 14 4 9l5-5" />
                        <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
                      </svg>
                    </button>
                  </>
                ) : null}

                {/*
                  导出：**一个按钮 + 一份格式下拉**。
                  格式清单按当前文档算（`exportFormatsFor`）—— 笔记 / Markdown 能导 .md 和
                  PDF，表格只能导 PDF。这样按钮的位置对所有文件都一样，点开才看到「这份
                  能导成什么」，不必记「哪个格式藏在哪」。
                */}
                {exportFormats.length > 0 ? (
                  <div className="relative">
                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setExportMenuOpen((open) => !open)}
                      disabled={!selectedId}
                      className={`doc-toolbar-button w-7 h-7 flex items-center justify-center rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                        exportMenuOpen
                          ? "is-active text-bamboo bg-bamboo-mist/50"
                          : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/40"
                      }`}
                      title={t("main.editor.export", { defaultValue: "导出…" })}
                      aria-haspopup="menu"
                      aria-expanded={exportMenuOpen}
                    >
                      <svg
                        data-testid="main-editor-export-icon"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                    {exportMenuOpen ? (
                      <div
                        ref={exportMenuRef}
                        role="menu"
                        className="context-menu absolute left-0 top-8 z-50 min-w-[168px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg shadow-lg animate-menu-enter"
                      >
                        {exportFormats.map((format) => (
                          <button
                            key={format}
                            role="menuitem"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setExportMenuOpen(false);
                              void handleExport(format);
                            }}
                            className="context-menu-item w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
                          >
                            {format === "md"
                              ? t("main.editor.saveAsMarkdown", { defaultValue: "另存为 Markdown" })
                              : t("main.editor.exportPdf", {
                                  defaultValue: "导出 PDF（预览并调纸张、边距…）",
                                })}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/*
                  删除**只在笔记里**有。它走的是 `notes_delete`（按笔记 id 删），对工作区里
                  打开的外部文件根本不成立 —— 那些文件该在左侧文件树里删。以前这按钮对外部
                  文件也是亮着的，点下去只会弹一个「找不到」。
                */}
                {documentContext === "note" && deleteConfirm ? (
                  <div
                    className={`flex items-center gap-1 ml-1 ${deleteExiting ? "animate-delete-confirm-exit" : "animate-delete-confirm"}`}
                  >
                    <span className="text-[11px] text-red-400 whitespace-nowrap">
                      {t("main.editor.confirmDelete", { defaultValue: "确认删除？" })}
                    </span>
                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDeleteExiting(true);
                        setTimeout(() => {
                          setDeleteExiting(false);
                          setDeleteConfirm(false);
                          void handleDeleteNote();
                        }, 150);
                      }}
                      className="px-2 h-6 rounded-md text-[11px] text-cloud bg-red-400 hover:bg-red-500 transition-colors cursor-pointer whitespace-nowrap outline-none"
                    >
                      {t("common.delete", { defaultValue: "删除" })}
                    </button>
                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDeleteExiting(true);
                        setTimeout(() => {
                          setDeleteExiting(false);
                          setDeleteConfirm(false);
                        }, 150);
                      }}
                      className="px-2 h-6 rounded-md text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer outline-none"
                    >
                      {t("common.cancel", { defaultValue: "取消" })}
                    </button>
                  </div>
                ) : null}

                {documentContext === "note" && !deleteConfirm ? (
                  <button
                    onClick={() => setDeleteConfirm(true)}
                    disabled={!selectedId}
                    className="doc-toolbar-button is-danger w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-red-400 hover:bg-danger-bg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    title={t("noteMenu.delete", { defaultValue: "删除笔记" })}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3,6 5,6 21,6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                ) : null}

                {/* 插件贡献的独立面板页签（目录、统计…）。原先挂在标题栏上，但它们
                    本质上和这一行的其他按钮一样，都是针对当前这份内容的操作。 */}
                {standalonePanels.map((panel) => (
                  <button
                    key={panel.id}
                    onClick={() => handleToggleStandalonePanel(panel.id)}
                    className={`doc-tab px-2.5 h-7 shrink-0 whitespace-nowrap flex items-center justify-center rounded-lg text-[11px] transition-all cursor-pointer ${
                      activeStandalonePanelId === panel.id
                        ? "is-active text-bamboo bg-bamboo-mist/50"
                        : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/40"
                    }`}
                    title={panel.title}
                  >
                    {panel.title}
                  </button>
                ))}

                {/* 插件贡献的**文档级动作**（`ui.registerDocumentAction`）。按当前文档
                    过滤 —— 给 PDF 做的「导出批注」不该在打开一篇笔记时冒出来。 */}
                {pluginDocumentActions
                  .filter((action) =>
                    documentActionVisible(action, {
                      context: documentContext,
                      typeId: selectedFileType?.id ?? null,
                    }),
                  )
                  .map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleDocumentAction(action)}
                      className="doc-toolbar-button px-2.5 h-7 shrink-0 whitespace-nowrap flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/40 transition-all cursor-pointer"
                      title={`${action.title}（插件 ${action.plugin}）`}
                    >
                      {action.icon ?? action.title}
                    </button>
                  ))}
              </div>

              {/* 用 ml-auto 而不是父级的 justify-between：父级一旦换行，justify-between
                  会把两组分别顶到两端、中间留出一大片空白。 */}
              {showPreviewPane ? (
                <SlidingButtonGroup
                  className="doc-toolbar-right ml-auto shrink-0"
                  options={viewModeOptions}
                  value={viewMode}
                  onChange={setViewMode}
                  buttonClassName="px-3 py-1 whitespace-nowrap"
                />
              ) : null}
            </div>

            {/* 说明文档顶掉笔记的标题栏：留着笔记的标题去显示别的文档，看起来就像
                「这篇笔记里写的居然是使用指南」。 */}
            {docView ? (
              <div
                key={`doc-${docView.title}`}
                className="doc-header animate-note-enter px-6 pt-4 pb-2 shrink-0 border-b border-paper-deep/15 flex items-start justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="doc-header-title text-[20px] font-display font-bold text-ink tracking-wide truncate">
                    {docView.title}
                  </div>
                  <div className="mt-1.5">
                    <span className="doc-header-label text-[10px] text-ink-ghost font-mono">
                      {t("main.doc.label", { defaultValue: "说明文档 · 只读" })}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setDocView(null)}
                  className="doc-header-close shrink-0 px-3 h-7 rounded-lg text-[11px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/40 transition-all cursor-pointer"
                  title={t("main.doc.closeHint", { defaultValue: "关掉文档，回到原来的笔记" })}
                >
                  {t("main.doc.close", { defaultValue: "关闭" })}
                </button>
              </div>
            ) : (
            <div
              key={noteTransitionKey}
              className="doc-header animate-note-enter px-6 pt-4 pb-2 shrink-0 border-b border-paper-deep/15"
            >
              <input
                type="text"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  markDirty();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    contentRef.current?.focus();
                  }
                }}
                placeholder={t("common.untitledNote", { defaultValue: "无标题笔记" })}
                disabled={!selectedId}
                className="doc-header-title w-full text-[20px] font-display font-bold text-ink placeholder:text-ink-ghost/50 tracking-wide disabled:opacity-60"
              />
              <div className="doc-header-meta flex items-center gap-3 mt-1.5">
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums truncate max-w-[200px]">
                  {selectedExternalFile
                    ? t("main.externalFile.label", {
                        path: selectedExternalFile.filePath,
                        defaultValue: "外部文件 · {{path}}",
                      })
                    : selectedNote
                      ? `${formatShortDate(selectedNote.updatedAt)} ${formatTime(selectedNote.updatedAt)}`
                      : "--"}
                </span>
                <span className="text-[10px] text-ink-ghost/40">·</span>
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("common.wordCount", { count: charCount, defaultValue: "{{count}} 字" })}
                </span>
                {pluginStatusItems.map((text) => (
                  <span key={text} className="text-[10px] text-ink-ghost font-mono tabular-nums">
                    · {text}
                  </span>
                ))}
                <span className="text-[10px] text-ink-ghost/40">·</span>
                <span
                  key={saveState}
                  className={`save-state text-[10px] font-mono tabular-nums animate-status-fade ${
                    saveState === "error"
                      ? "is-error text-red-400"
                      : saveState === "dirty"
                        ? "is-dirty text-amber-500/70"
                        : "is-saved text-bamboo/60"
                  }`}
                >
                  {saveStateLabel[saveState]}
                </span>
              </div>
            </div>
            )}

            <div
              key={effectiveViewMode}
              ref={splitContainerRef}
              className="content-area flex-1 flex min-h-0 animate-view-fade"
            >
              {docView ? (
                // 只读文档：直接渲染内存里那段 Markdown。**不走 FilePreview** ——
                // 那个是照 `path` 读盘的，这里没有盘上的文件。
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <div className="max-w-[46rem] mx-auto px-8 py-6">
                    <MarkdownPreview
                      content={docView.content}
                      fontSize={settingsConfig?.fontSize ?? 14}
                    />
                  </div>
                </div>
              ) : standalonePreview && selectedFileType && activeFilePath ? (
                zoomableStandalone ? (
                  <div className="preview-pane relative flex flex-col min-h-0 min-w-0 flex-1">
                    {previewZoomBadge}
                    {/* 照片的纸张式缩放。内容层用 inset-0 撑满滚动视口 —— 图片的
                        object-contain 需要一个**有确定高度**的父级才能把大图缩进屏内，
                        高度留 auto 的话 max-h-full 就是空的，竖图只能滚着看。 */}
                    <div
                      ref={previewScrollRef}
                      className="preview-scroll relative flex-1 overflow-auto"
                      style={{ scrollbarGutter: "stable" }}
                    >
                      <div
                        aria-hidden="true"
                        style={{
                          width: previewContentSize.width * previewZoom,
                          height: previewContentSize.height * previewZoom,
                        }}
                      />
                      <div
                        ref={previewContentRef}
                        className="absolute inset-0 flex flex-col"
                        style={{
                          transform: `scale(${previewZoom})`,
                          transformOrigin: "0 0",
                        }}
                      >
                        {/* key 用路径：换文件要整体重建，否则上一个文件的异步渲染结果会串台 */}
                        <FilePreview
                          key={activeFilePath}
                          path={activeFilePath}
                          type={selectedFileType}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  /* key 用路径：换文件要整体重建，否则上一个文件的异步渲染结果会串台 */
                  <FilePreview key={activeFilePath} path={activeFilePath} type={selectedFileType} />
                )
              ) : !selectedId && !isLoading ? (
                <div className="empty-state flex-1 flex items-center justify-center text-[13px] text-ink-ghost">
                  {t("main.editor.emptyHint", { defaultValue: "选择或新建一篇笔记" })}
                </div>
              ) : (
                <>
                  {/* 没有预览面板的类型（code / text）永远走编辑器，否则用户停在
                      「预览」模式下打开 .py 会看到一片空白。 */}
                  {!standalonePreview &&
                    (effectiveViewMode === "edit" || effectiveViewMode === "split") && (
                      <div
                        className="editor-pane flex flex-col min-h-0 shrink-0"
                        style={{
                          width: effectiveViewMode === "split" ? `${splitRatio * 100}%` : "100%",
                        }}
                      >
                        <div className="editor-toolbar flex items-center gap-0.5 px-4 pt-2 pb-1 shrink-0">
                          {/* 只有笔记与 .md 才给 Markdown 格式化按钮。开着 .py 时那一排
                              全是灰的，留着只占地方 —— 所以整排不渲染。 */}
                          {markdownEditorActive &&
                            toolbarButtons.map((button) => (
                              <button
                                key={button.label}
                                title={button.title}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  if (contentRef.current) {
                                    applyFormat(
                                      contentRef.current,
                                      button.action,
                                      t,
                                      setContent,
                                      markDirty,
                                    );
                                  }
                                }}
                                className={`editor-tool w-6 h-6 flex items-center justify-center rounded text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer ${button.style}`}
                              >
                                {button.label}
                              </button>
                            ))}
                          {/* 插件浮层：按钮 + 下拉。markdownOnly 的那些与 Markdown 格式化
                              按钮同进同出 —— 公式、符号这类东西在 .py 里没有意义。 */}
                          {pluginPopovers
                            .filter((popover) => !popover.markdownOnly || markdownEditorActive)
                            .map((popover) => (
                              <button
                                key={popover.id}
                                type="button"
                                title={`${popover.title}（插件 ${popover.plugin}）`}
                                aria-haspopup="dialog"
                                aria-expanded={openPopover?.id === popover.id}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={(event) =>
                                  handleTogglePopover(popover, event.currentTarget)
                                }
                                className={`editor-tool h-6 px-2 flex items-center justify-center rounded text-[11px] transition-all cursor-pointer ${
                                  openPopover?.id === popover.id
                                    ? "is-active text-bamboo bg-bamboo-mist/60"
                                    : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50"
                                }`}
                              >
                                {popover.icon ?? popover.title}
                              </button>
                            ))}
                          {/* 插件按钮照旧：那是插件自己的贡献点，与 Markdown 无关。 */}
                          {toolbarPluginButtons.map((button) => (
                            <button
                              key={button.id}
                              type="button"
                              title={`${button.title}（插件 ${button.plugin}）`}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                void Promise.resolve()
                                  .then(() => button.run())
                                  .catch((error: unknown) =>
                                    showToast(`插件工具栏按钮执行失败：${String(error)}`),
                                  );
                              }}
                              className="editor-tool h-6 px-2 flex items-center justify-center rounded text-[11px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer"
                            >
                              {button.icon ?? button.title}
                            </button>
                          ))}
                        </div>

                        <div
                          className="editor-scroll relative flex-1 min-h-0 overflow-hidden px-5 pb-4"
                          // 有行旁注时把正文整体右移，腾出左边那一栏。
                          // 没有行旁注时**一个像素都不动** —— 默认观感保持原样。
                          style={
                            editorGutterWidth > 0 ? { paddingLeft: editorTextLeft } : undefined
                          }
                        >
                          <div
                            ref={highlightLayerRef}
                            aria-hidden="true"
                            className={`absolute right-5 pointer-events-none ${editorFontClass}`}
                            style={{
                              left: editorTextLeft,
                              // 用 transform 而不是 top：top 会触发布局，长文每帧重排会掉帧
                              // 并闪出空白；transform 走合成层，视觉结果完全一致。
                              transform: `translateY(${-editorScrollTop}px)`,
                              willChange: "transform",
                              fontFamily: editorFontFamily,

                              fontSize: `${settingsConfig?.fontSize ?? 14}px`,
                              tabSize: `var(--tab-indent-size, 2)`,
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              padding: "2px",
                              // 正文颜色直接跟随主题。历史上这里接过一个「文字渲染颜色」
                              // 设置项，但它存的是固定色值，切深色主题不会跟着变 —— 已移除。
                              // `--md-text-color` 这一层留着：插件仍可通过 ui:style 覆盖它。
                              color: "var(--md-text-color, var(--color-ink-soft))",
                            }}
                          >
                            {highlightedLines?.map((html, index) => (
                              <HighlightLine key={index} html={html} />
                            ))}
                          </div>
                          {editorGutters.length > 0 ? (
                            /*
                             * 行旁注层。刻意**不写 overflow-hidden** —— 行号挂在每一行的左侧
                             * 之外（`right: 100%`），裁掉就什么也看不见了。越界的部分由外层
                             * 编辑区的 overflow-hidden 兜住。
                             */
                            <div
                              aria-hidden="true"
                              className={`absolute right-5 top-0 bottom-0 pointer-events-none ${editorFontClass}`}
                              style={{
                                left: editorTextLeft,
                                // 下面几项必须与上面那层高亮**逐字一致**：宽度、字体、字号、
                                // 制表位任何一项不同，换行位置就会偏，行号立刻错位。
                                fontFamily: editorFontFamily,
                                fontSize: `${settingsConfig?.fontSize ?? 14}px`,
                                tabSize: `var(--tab-indent-size, 2)`,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                padding: "2px",
                              }}
                            >
                              <div
                                style={{
                                  transform: `translateY(${-editorScrollTop}px)`,
                                  willChange: "transform",
                                }}
                              >
                                {editorGutterRows.map((line, index) => (
                                  <GutterRow
                                    key={index}
                                    line={line}
                                    cells={editorGutters.map((gutter) => gutter.lines[index] ?? "")}
                                    laneWidths={gutterLaneWidths}
                                    totalWidth={editorGutterWidth}
                                  />
                                ))}
                              </div>
                            </div>
                          ) : null}

                          <textarea
                            ref={contentRef}
                            data-tab-indent="true"
                            value={content}
                            onChange={(event) => {
                              perfRef.current.typedAt = performance.now(); /* TEMP-PERF */
                              const next = event.target.value;
                              // coalesce=true：连续输入并成一步，否则打二十个字就要
                              // 按二十次撤销。这里是**唯一**会记录打字的地方。
                              if (selectedId) {
                                editorHistory.record(selectedId, content, next, true);
                              }
                              setContent(next);
                              markDirty();
                            }}
                            onSelect={(event) => {
                              const textarea = event.currentTarget;
                              const start = textarea.selectionStart;
                              const end = textarea.selectionEnd;
                              setActiveSelection(
                                start === end
                                  ? null
                                  : { text: textarea.value.slice(start, end), start, end },
                              );
                            }}
                            onFocus={handleEditorFocus}
                            onPaste={markdownEditorActive ? imagePasteHandler : undefined}
                            onDrop={markdownEditorActive ? imageDropHandler : undefined}
                            onDragOver={markdownEditorActive ? imageDragOverHandler : undefined}
                            onScroll={handleEditorScroll}
                            onKeyDown={(event) => {
                              // 撤销 / 重做必须自己接管：原生的栈是所有文件共用的一个。
                              // 不拦的话浏览器会先撤掉「上一个文件」的那一笔。
                              if ((event.ctrlKey || event.metaKey) && !event.altKey) {
                                const key = event.key.toLowerCase();
                                if (key === "z" || key === "y") {
                                  event.preventDefault();
                                  if (key === "y" || event.shiftKey) handleRedo();
                                  else handleUndo();
                                  return;
                                }
                              }
                              if (
                                (event.ctrlKey || event.metaKey) &&
                                event.key.toLowerCase() === "h"
                              ) {
                                event.preventDefault();
                                setFindReplaceOpen((open) => !open);
                                return;
                              }
                              // 内置快捷键优先，插件键位只在其未被处理时才介入，
                              // 否则插件可以用一个键位把 Ctrl+B 抢走。
                              // Markdown 快捷键只在笔记 / .md 上生效 —— 否则 Ctrl+B
                              // 会往 .py 里塞一对星号。
                              if (markdownEditorActive && handleMarkdownShortcut(event)) return;
                              dispatchCommandKeybinding(event);
                            }}
                            className={`editor-input relative w-full h-full text-ink-soft placeholder:text-ink-ghost/40 ${editorFontClass}`}
                            style={{
                              fontSize: `${settingsConfig?.fontSize ?? 14}px`,
                              tabSize: `var(--tab-indent-size, 2)`,
                              // 平时文字是透明的，靠上面的高亮层显示字形；
                              // 禁用着色时必须把文字显出来，否则整篇看不见。
                              color: highlightDisabled
                                ? "var(--md-text-color, var(--color-ink-soft))"
                                : "transparent",
                              caretColor: "var(--color-ink)",
                              fontFamily: editorFontFamily,

                              padding: "2px",
                            }}
                            placeholder={t("main.editor.contentPlaceholder", {
                              defaultValue: "开始写作……",
                            })}
                            spellCheck={false}
                            disabled={!selectedId}
                          />
                          {editorSwatches.length > 0 && (
                            <div
                              className="absolute right-5 top-0 bottom-0 pointer-events-none"
                              style={{ left: editorTextLeft }}
                            >
                              <div
                                style={{
                                  transform: `translateY(${-editorScrollTop}px)`,
                                  willChange: "transform",
                                }}
                              >
                                {editorSwatches.map((swatch) => (
                                  /*
                                   * 色块是**自绘**的 div，取色器是一个铺在它上面、完全透明的
                                   * `<input type="color">`（点它弹系统取色器，与设置里那个一致）。
                                   *
                                   * 为什么不直接拿 input 当色块：它在 9px 下撑不满 —— UA 内部的
                                   * 那个色板有自己的最小尺寸与内边距，缩到这里只剩一条横线。
                                   * 自绘之后尺寸完全归我们管，只借用它的「点开取色器」这一个能力。
                                   */
                                  <div
                                    key={swatch.key}
                                    className="pointer-events-auto absolute rounded-[2px] border border-paper-deep/60"
                                    style={{
                                      left: swatch.left,
                                      top: swatch.top,
                                      width: EDITOR_SWATCH_SIZE,
                                      height: EDITOR_SWATCH_SIZE,
                                      background: swatch.color,
                                    }}
                                  >
                                    <input
                                      type="color"
                                      value={swatch.color}
                                      // `pick` 由插件实现 —— 它知道原文是 #hex 还是 rgba，
                                      // 能顺手保住 alpha。
                                      onChange={(event) =>
                                        queueSwatchPick(swatch, event.target.value)
                                      }
                                      aria-label={t("main.editor.colorSwatch", {
                                        defaultValue: "改这个颜色",
                                      })}
                                      title={swatch.color}
                                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {highlightRects.length > 0 && (
                            <div
                              className="pointer-events-none absolute right-5 top-0 bottom-0 overflow-hidden"
                              style={{ left: editorTextLeft }}
                              aria-hidden="true"
                            >
                              {highlightRects.map((rect, index) => (
                                <div
                                  key={index}
                                  className="absolute"
                                  style={{
                                    top: rect.top - editorScrollTop,
                                    left: rect.left,
                                    width: rect.width,
                                    height: rect.height,
                                    background: "rgba(120, 130, 140, 0.35)",
                                  }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                  {effectiveViewMode === "split" && (
                    <div
                      className={`pane-resizer w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center ${isResizingSplit ? "is-dragging bg-bamboo/30" : "hover:bg-bamboo/20"} transition-colors`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setIsResizingSplit(true);
                      }}
                    >
                      <div
                        className={`absolute inset-y-0 -left-1.5 -right-1.5 ${isResizingSplit ? "" : "group-hover:bg-bamboo/5"}`}
                      />
                      {/* 拖拽手柄指示器 */}
                      <div className="relative z-10 flex flex-col gap-[3px] opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                      </div>
                    </div>
                  )}

                  {showPreviewPane &&
                    (effectiveViewMode === "preview" || effectiveViewMode === "split") && (
                      <div className="preview-pane relative flex flex-col min-h-0 min-w-0 flex-1">
                        {previewZoomBadge}
                        {effectiveViewMode === "split" && (
                          <div className="px-4 pt-2.5 pb-1 shrink-0">
                            <span className="text-[10px] text-ink-ghost/60 font-mono tracking-widest uppercase">
                              {t("main.editor.previewLabel", { defaultValue: "Preview" })}
                            </span>
                          </div>
                        )}
                        {effectiveViewMode === "preview" ? (
                          /* 预览模式：纸张式缩放。内容被 transform 放大，另有一层「撑开层」
                           给出缩放后的尺寸 —— transform 不参与布局，没有它放大之后右下角
                           就滚不到。 */
                          <div
                            ref={previewScrollRef}
                            onScroll={handlePreviewScroll}
                            onMouseUp={handlePreviewSelect}
                            className="relative flex-1 overflow-auto"
                            // 恒定预留滚动条槽位。否则会出现一个自我循环：内容变宽 → 出横向
                            // 滚动条 → 可用高度少一条 → 纵向滚动条出现 → 可用宽度又少一条 →
                            // 正文重排、高度再变……放大到 200% 以上时会看到边缘抖动。
                            // 预留之后可用宽度是常数，这个循环从根上断掉。
                            style={{ scrollbarGutter: "stable" }}
                          >
                            <div
                              aria-hidden="true"
                              style={{
                                width: previewContentSize.width * previewZoom,
                                height: previewContentSize.height * previewZoom,
                              }}
                            />
                            <div
                              ref={previewContentRef}
                              className="absolute left-0 top-0 right-0 px-6 pt-3 pb-6"
                              style={{
                                transform: `scale(${previewZoom})`,
                                transformOrigin: "0 0",
                              }}
                            >
                              {previewBody}
                            </div>
                          </div>
                        ) : (
                          /* 分栏与编辑：完全走原来的结构。分栏里的预览是用来**对照**的，
                           套上缩放层会同时影响两栏布局与滚动同步；编辑模式本来就没有
                           缩放这个概念。 */
                          <div
                            ref={previewScrollRef}
                            onScroll={handlePreviewScroll}
                            onMouseUp={handlePreviewSelect}
                            className="preview-scroll flex-1 overflow-auto px-6 pt-1 pb-6"
                          >
                            {previewBody}
                          </div>
                        )}
                      </div>
                    )}
                </>
              )}
            </div>

            <div className="status-bar flex items-center justify-between px-4 h-7 border-t border-paper-deep/20 bg-paper/30 shrink-0">
              <div className="status-bar-left flex items-center gap-3">
                <span className="status-text text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("main.statusBar.lineNumber", {
                    count: lineCount,
                    defaultValue: "Ln {{count}}",
                  })}
                </span>
                <span className="text-[10px] text-ink-ghost/40">|</span>
                <span className="status-text text-[10px] text-ink-ghost font-mono">
                  {statusFormatLabel}
                </span>
              </div>
              <div className="status-bar-right flex items-center gap-3">
                {selectedId && !isExternal && content.includes("images/") && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCleanUnusedImages()}
                      className="status-action text-[10px] text-ink-ghost hover:text-bamboo font-mono cursor-pointer transition-colors"
                    >
                      {t("main.images.cleanUnused", { defaultValue: "清理未使用图片" })}
                    </button>
                    <span className="text-[10px] text-ink-ghost/40">|</span>
                  </>
                )}
                <span className="status-text text-[10px] text-ink-ghost font-mono">
                  {t("main.statusBar.encoding", { defaultValue: "UTF-8" })}
                </span>
                <span className="text-[10px] text-ink-ghost/40">|</span>
                <span className="status-text text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("main.statusBar.byteSize", { size: byteSize, defaultValue: "{{size}} KB" })}
                </span>
              </div>
            </div>
          </div>
          {settingsConfig && activePanelId === "settings" && settingsOverlay && (
            <div className="side-panel-scrim absolute inset-0 z-20" onClick={handleCloseSettings} />
          )}
          <div
            className={`side-panel ${
              sidePanelExpanded ? "is-open" : ""
            } ${settingsOverlay ? "is-overlay" : ""} relative shrink-0 overflow-hidden h-full transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              sidePanelExpanded || mountedSidePanel ? "border-l border-paper-deep/20" : "border-l-0"
            } ${
              settingsOverlay
                ? `absolute right-0 top-0 bottom-0 z-30 ${visibleSidePanel ? "w-[360px] shadow-xl" : "w-0"}`
                : `${sidePanelExpanded ? "w-[360px]" : "w-0"}`
            }`}
          >
            <div
              className={`side-panel-view absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "settings"
                  ? sidePanelContentVisible && visibleSidePanel === "settings"
                    ? "is-active translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "settings" && settingsConfig ? (
                <SettingsPanel
                  config={settingsConfig}
                  onChange={handleSettingsChange}
                  onMigrateDataDir={() => void handleMigrateDataDir()}
                  onClose={handleCloseSettings}
                  update={update}
                />
              ) : null}
            </div>
            <div
              className={`side-panel-view absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "plugins"
                  ? sidePanelContentVisible && visibleSidePanel === "plugins"
                    ? "is-active translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "plugins" ? (
                <PluginCommandPanel onClose={handleClosePlugins} onOpenDoc={openDocView} />
              ) : null}
            </div>
            <div
              className={`side-panel-view absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "about"
                  ? sidePanelContentVisible && visibleSidePanel === "about"
                    ? "is-active translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "about" ? (
                <AboutPanel
                  onClose={handleCloseAbout}
                  onOpenDoc={openDocView}
                  notesDir={settingsConfig?.dataDir}
                />
              ) : null}
            </div>
            <div
              className={`side-panel-view absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "styles"
                  ? sidePanelContentVisible && visibleSidePanel === "styles"
                    ? "is-active translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "styles" ? (
                <StylesPanel onClose={handleCloseStyles} />
              ) : null}
            </div>
            <div
              className={`side-panel-view absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "standalone"
                  ? sidePanelContentVisible && visibleSidePanel === "standalone"
                    ? "is-active translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "standalone" && activeStandalonePanelId
                ? (() => {
                    const panel = standalonePanels.find((p) => p.id === activeStandalonePanelId);
                    return panel ? (
                      <div className="w-full h-full flex flex-col bg-cloud/92 backdrop-blur-sm">
                        <div className="side-panel-header px-4 pt-3 pb-2 flex items-center justify-between shrink-0">
                          <span className="side-panel-title text-[13px] font-medium text-ink">
                            {panel.title}
                          </span>
                          <button
                            type="button"
                            onClick={() => setActivePanelId(null)}
                            className="side-panel-close w-6 h-6 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                            >
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <div
                          className="side-panel-body px-3 pb-3 flex-1 min-h-0 overflow-y-auto text-[12px] text-ink-soft"
                          // v2 面板的 HTML 来自沙箱 Worker，必须消毒后再注入主世界——
                          // 否则插件一句 onerror 就能在宿主权限下执行，沙箱会被完全绕过。
                          // v1 面板维持原样（可信遗留）。
                          //
                          // 取自**当前这份文件**的那个桶（`panelFileKeyOf` 与 v2Host 写的一侧
                          // 是同一个函数）。切回一篇看过的笔记时拿到的还是上次那一串 ——
                          // React 见字符串没变就不碰这棵子树，展开的层级与滚动位置都还在。
                          dangerouslySetInnerHTML={{
                            __html: panel.sandboxed
                              ? sanitizePluginHtml(getPanelHtml(panel.id, panelFileKey))
                              : panel.render(),
                          }}
                          onClick={(event) => panel.onClick?.(event.target as HTMLElement)}
                        />
                      </div>
                    ) : null;
                  })()
                : null}
            </div>
          </div>
        </div>
      </div>
      {findReplaceOpen && (
        <FindReplacePanel
          matchInfo={
            findMatches.length > 0 ? `${currentFindIndex + 1}/${findMatches.length}` : "0/0"
          }
          onFindNext={handleFindNext}
          onFindPrev={handleFindPrev}
          onReplace={handleReplace}
          onReplaceAll={handleReplaceAll}
          onClose={() => setFindReplaceOpen(false)}
        />
      )}
      {/* 移除工作文件夹时的确认框。**只有那个文件夹里确实有缓存才出现** ——
          没有缓存可删的时候多问一句纯属打扰。 */}
      {pdfPanel ? (
        <PdfExportPanel
          title={pdfPanel.title}
          bodyHtml={pdfPanel.bodyHtml}
          onClose={() => setPdfPanel(null)}
        />
      ) : null}

      {pendingFolderRemoval ? (
        <Modal
          title={t("main.workspace.removeWithCache.title", {
            defaultValue: "移除这个工作文件夹",
          })}
          onCancel={() => setPendingFolderRemoval(null)}
        >
          <p className="text-[11px] text-ink-ghost leading-relaxed mb-2">
            {t("main.workspace.removeWithCache.body", {
              path: pendingFolderRemoval.path,
              count: pendingFolderRemoval.info.files,
              size: formatSize(pendingFolderRemoval.info.bytes),
              defaultValue:
                "{{path}} 里有一个花笺自己的缓存文件夹（__floral-notepaper__），共 {{count}} 个文件、{{size}}。里面是插件写下的数据（比如 PDF 的批注）。",
            })}
          </p>
          <p className="text-[11px] text-ink-ghost leading-relaxed">
            {t("main.workspace.removeWithCache.hint", {
              defaultValue:
                "只移除的话，那个文件夹原样留着 —— 以后再把目录挂回来，批注还在。",
            })}
          </p>
          <div className="flex items-center justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setPendingFolderRemoval(null)}
              className="px-3 h-7 rounded-lg text-[11px] text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
            <button
              type="button"
              onClick={() => {
                const target = pendingFolderRemoval.path;
                setPendingFolderRemoval(null);
                void commitRemoveWorkspaceFolder(target, false);
              }}
              className="px-3 h-7 rounded-lg text-[11px] text-bamboo bg-bamboo-mist/50 hover:bg-bamboo-mist transition-colors cursor-pointer"
            >
              {t("main.workspace.removeWithCache.keep", { defaultValue: "只移除，保留缓存" })}
            </button>
            <button
              type="button"
              onClick={() => {
                const target = pendingFolderRemoval.path;
                setPendingFolderRemoval(null);
                void commitRemoveWorkspaceFolder(target, true);
              }}
              className="px-3 h-7 rounded-lg text-[11px] text-rust bg-rust-mist/50 hover:bg-rust-mist transition-colors cursor-pointer"
            >
              {t("main.workspace.removeWithCache.clear", { defaultValue: "一起删掉" })}
            </button>
          </div>
        </Modal>
      ) : null}

      {openPopover && activePopover && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={activePopover.title}
          className="context-menu popup-menu fixed z-[9999] bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg shadow-lg animate-menu-enter overflow-x-hidden overflow-y-auto"
          style={{
            left: popoverPosition?.x ?? openPopover.anchor.x,
            top: popoverPosition?.y ?? openPopover.anchor.y,
            width: activePopover.width ?? 320,
            maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {(() => {
            const html = sanitizePluginHtml(getPopoverHtml(activePopover.id));
            if (!html) {
              return (
                <p className="px-3 py-3 text-[11px] text-ink-ghost">
                  {t("main.pluginPopover.loading", { defaultValue: "正在加载…" })}
                </p>
              );
            }
            return (
              <div
                className="py-1.5 px-1.5 text-[12px] text-ink-soft"
                // 与插件面板同一条路径：**必须**消毒后才能进主世界。
                dangerouslySetInnerHTML={{ __html: html }}
                onClick={(event) => {
                  activePopover.onClick?.(event.target as HTMLElement);
                  // 面板式的浮层（符号表那种）要连点好几次，默认不收起。
                  if (activePopover.closeOnClick) setOpenPopover(null);
                }}
              />
            );
          })()}
        </div>
      )}
      {noteMenu && noteMenuTarget && (
        <div
          ref={noteMenuRef}
          className={`context-menu popup-menu fixed z-[9999] min-w-[168px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none ${noteMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
          style={{
            left: noteMenuPosition?.x ?? noteMenu.x,
            top: noteMenuPosition?.y ?? noteMenu.y,
            maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {noteMenuMode === "main" ? (
            <div key="main" className="animate-menu-slide-right">
              {noteContextMenuItems.map((item, index) => (
                <button
                  key={item.action}
                  onClick={() => handleNoteMenuAction(item.action)}
                  className={`context-menu-item w-full flex items-center justify-between px-3 py-1.5 text-[12px] font-body transition-colors cursor-pointer ${
                    item.tone === "danger"
                      ? "is-danger text-red-400 hover:bg-danger-bg hover:text-red-500"
                      : "text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo"
                  } ${index > 0 ? "border-t border-paper-deep/20" : ""}`}
                >
                  <span>{item.label}</span>
                </button>
              ))}
              {notePluginMenuItems.length > 0 ? (
                <>
                  {notePluginMenuItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        const target = noteMenuTarget;
                        setNoteMenu(null);
                        void Promise.resolve()
                          .then(() => item.run(target.id))
                          .catch((error: unknown) => {
                            showToast(
                              t("main.pluginMenu.failed", {
                                defaultValue: "插件菜单项执行失败：{{error}}",
                                error: String(error),
                              }),
                            );
                          });
                      }}
                      className="context-menu-item w-full flex items-center justify-between px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer border-t border-paper-deep/20"
                    >
                      <span>{item.title}</span>
                      <span className="text-[10px] text-ink-ghost">{item.plugin}</span>
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          ) : (
            <div key="move" className="animate-menu-slide-left">
              <button
                onClick={() => setNoteMenuMode("main")}
                className="context-menu-item w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body text-ink-ghost hover:bg-paper-warm transition-colors cursor-pointer border-b border-paper-deep/20"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                <span>{t("common.back", { defaultValue: "返回" })}</span>
              </button>
              <button
                onClick={() => void handleMoveNote(noteMenuTarget.id, "")}
                className="context-menu-item w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.category.uncategorized", { defaultValue: "未分类" })}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => void handleMoveNote(noteMenuTarget.id, cat)}
                  className="context-menu-item w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {categoryMenu && (
        <div
          ref={categoryMenuRef}
          className={`context-menu popup-menu fixed z-[9999] min-w-[140px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none ${categoryMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
          data-hover-suppressed={categoryMenuHoverSuppressed ? "" : undefined}
          style={{
            left: categoryMenuPosition?.x ?? categoryMenu.x,
            top: categoryMenuPosition?.y ?? categoryMenu.y,
            maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {categoryMenuConfirmDelete ? (
            <div key="category-confirm" className="animate-menu-slide-left">
              <div className="px-3 py-1.5 text-[11px] font-body text-ink-faint border-b border-paper-deep/20">
                {t("main.category.confirmDelete", {
                  category: categoryMenu.category,
                  defaultValue: "确认删除「{{category}}」？",
                })}
              </div>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  void handleDeleteCategory(categoryMenu.category);
                  setCategoryMenuClosing(true);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer outline-none"
              >
                {t("main.category.confirmDeleteAction", { defaultValue: "确认删除" })}
              </button>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => switchCategoryMenuPanel(false)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer outline-none"
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
            </div>
          ) : (
            <div key="category-main" className="animate-menu-slide-right">
              <button
                onClick={() => {
                  setCategoryMenuClosing(true);
                  setRenamingCategory(categoryMenu.category);
                  setRenameCategoryValue(categoryMenu.category);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.category.rename", { defaultValue: "重命名" })}
              </button>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => switchCategoryMenuPanel(true)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer border-t border-paper-deep/20 outline-none"
              >
                {t("main.category.delete", { defaultValue: "删除分类" })}
              </button>
            </div>
          )}
        </div>
      )}

      {commandPaletteOpen ? <CommandPalette onClose={() => setCommandPaletteOpen(false)} /> : null}
    </div>
  );
}
