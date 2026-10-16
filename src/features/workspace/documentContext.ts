/**
 * 「当前打开的是什么」—— 顶部那一行工具栏按它决定显示哪组按钮。
 *
 * ## 为什么不是直接用 `FilePreviewKind`
 *
 * 笔记**没有文件类型**：它不在磁盘上、没有扩展名，推给插件的 `fileInfo` 对笔记就是
 * `null`（`MainWindow.tsx` 的 `pluginFileInfo`）。所以只按 `kind` 过滤表达不出「笔记」，
 * 而「笔记」恰是这一行按钮最全的那一档。另外只读说明文档（`docView`）打开时
 * `selectedExternalFile` 是 `null`，`isNoteDocument` **是 true** —— 不先把它摘出来，
 * 说明文档会被当成笔记，顶上一排「插入图片 / 删除笔记」全冒出来。
 *
 * ## 这一行 vs 视图自己的工具栏
 *
 * 顶上这一行放的是**文档级动作**（导出、打印、删除、开右侧栏的插件面板）；
 * 插件视图内部那一排（`view.toolbar`：翻页、缩放、标注工具）是**视图内的小工具**，
 * 两者不是一回事，见 `Docs/plugin-api.md`。
 */

import { isFilePreviewKind, type FilePreviewKind } from "./fileTypes";

/** 当前文档属于哪一类。 */
export type DocumentContext = FilePreviewKind | "note" | "doc";

/** 一个插件声明「我在哪些文档里出现」用的过滤器。两个字段都是「空 = 不限」。 */
export interface DocumentActionFilter {
  /** 只在这些上下文里出现。省略 / 空数组 = 所有上下文。 */
  contexts?: readonly DocumentContext[];
  /** 只在这些文件类型 id 里出现（带插件名前缀，如 `pdf-viewer:pdf`）。省略 / 空 = 不限。 */
  typeIds?: readonly string[];
}

/**
 * 插件声明里的一个上下文值认不认。
 *
 * 写成「`note` / `doc` 或者一个合法的文件 kind」而不是维护一张清单 —— 这样
 * `FilePreviewKind` 以后多一个词，这里自动跟上，不会漏。
 */
export function isDocumentContext(value: unknown): value is DocumentContext {
  if (typeof value !== "string") return false;
  return value === "note" || value === "doc" || isFilePreviewKind(value);
}

/** 宿主这边算出来的「当前是什么」—— 判可见性时两样都要。 */
export interface DocumentIdentity {
  context: DocumentContext;
  /** 笔记没有 id，这里是 `null`。 */
  typeId: string | null;
}

/**
 * 判当前文档属于哪一类。
 *
 * ⚠️ **`docView` 必须排在最前**：见文件头的说明，它是唯一会让 `isNoteDocument` 说假话的
 * 情形。`isNoteDocument` 为真且没有文件类型 ⇒ 笔记。
 */
export function documentContextOf(input: {
  docView: boolean;
  isNoteDocument: boolean;
  fileKind: FilePreviewKind | null;
}): DocumentContext {
  if (input.docView) return "doc";
  if (input.fileKind) return input.fileKind;
  return "note";
}

/**
 * 这条插件动作在当前文档里该不该显示。
 *
 * 两个过滤器**都填了就取与** —— `contexts: ["view"]` 加 `typeIds: ["pdf-viewer:pdf"]`
 * 的意思是「只在这个 PDF 视图里」。只填 `contexts: ["note"]` 就是「只在笔记里」。
 */
export function documentActionVisible(
  filter: DocumentActionFilter,
  identity: DocumentIdentity,
): boolean {
  const { contexts, typeIds } = filter;

  if (contexts && contexts.length > 0 && !contexts.includes(identity.context)) return false;
  if (typeIds && typeIds.length > 0) {
    // 笔记拿不到 typeId —— 只按类型过滤的动作在笔记里一律不显示。
    if (identity.typeId === null || !typeIds.includes(identity.typeId)) return false;
  }
  return true;
}
