/**
 * 标签页的**纯数据**部分：打开列表的增删与「关掉之后激活谁」。
 *
 * 刻意不把「当前活动标签」放进来 —— 活动文档的唯一真源是 `selectedId`（保存路由、
 * 撤销栈、插件镜像、侧栏选中都靠它）。再存一份 `activeTabKey` 只会在十几个激活
 * 入口之间产生不同步。这里只回答「列表怎么变」。
 */

export type OpenDocumentKind = "note" | "file" | "doc";

export interface OpenDocument {
  /** 在列表里做比较用的稳定键：`note:<id>` / `file:<小写路径>` / `doc:<名字>`。 */
  key: string;
  kind: OpenDocumentKind;
  /** note id、文件的原始绝对路径，或只读文档的键（显示、读盘时用这一份）。 */
  id: string;
  /** 从工作区树打开的（侧栏「外部文件」不重复列出来）。 */
  fromWorkspace?: boolean;
}

/**
 * Windows 路径比较不区分大小写；标签去重必须跟着这个规则，否则从「外部文件」列表
 * 与工作区树各点一次同一个文件，会出现两个标签。
 */
export function normalizeDocumentPath(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

export function openDocumentKey(kind: OpenDocumentKind, id: string): string {
  if (kind === "note") return `note:${id}`;
  // 只读文档不是磁盘路径：保持原样，别做路径归一化（否则大小写会被吞掉）。
  if (kind === "doc") return `doc:${id}`;
  return `file:${normalizeDocumentPath(id)}`;
}

export function makeDocument(
  kind: OpenDocumentKind,
  id: string,
  options: { fromWorkspace?: boolean } = {},
): OpenDocument {
  return {
    key: openDocumentKey(kind, id),
    kind,
    id,
    ...(options.fromWorkspace ? { fromWorkspace: true } : {}),
  };
}

export function findDocument(
  documents: readonly OpenDocument[],
  kind: OpenDocumentKind,
  id: string,
): OpenDocument | null {
  const key = openDocumentKey(kind, id);
  return documents.find((document) => document.key === key) ?? null;
}

/**
 * 加一个标签。
 *
 * - 已经在列表里：原样返回（调用方随后只需要激活它）。
 * - `append`：加到末尾。
 * - `replace`：替换**当前活动标签**（`activeKey`）所在的那一格，保持位置不变；
 *   没有活动标签就追加。
 */
export function upsertDocument(
  documents: readonly OpenDocument[],
  document: OpenDocument,
  mode: "replace" | "append",
  activeKey: string | null,
): OpenDocument[] {
  if (documents.some((item) => item.key === document.key)) {
    return [...documents];
  }

  if (mode === "append" || !activeKey) {
    return [...documents, document];
  }

  const index = documents.findIndex((item) => item.key === activeKey);
  if (index < 0) return [...documents, document];

  const next = [...documents];
  next[index] = document;
  return next;
}

export function closeDocument(
  documents: readonly OpenDocument[],
  key: string,
): OpenDocument[] {
  return documents.filter((document) => document.key !== key);
}

/**
 * 关掉一个标签之后该激活谁：优先右邻，没有就左邻；列表空了返回 `null`。
 *
 * 必须在**移除之前**调用（它需要原列表里的位置）。
 */
export function neighborKey(
  documents: readonly OpenDocument[],
  closingKey: string,
): string | null {
  const index = documents.findIndex((document) => document.key === closingKey);
  if (index < 0) return documents[0]?.key ?? null;

  const right = documents[index + 1];
  if (right) return right.key;
  const left = documents[index - 1];
  return left?.key ?? null;
}

/** 文件名（不含目录），标签标题用。 */
export function documentTitleFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.(md|markdown|txt)$/i, "") || name;
}
