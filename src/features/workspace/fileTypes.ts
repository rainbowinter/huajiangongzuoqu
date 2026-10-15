/**
 * 文件类型注册表。
 *
 * 「哪些扩展名算数、每种长什么样」这件事**不写死在侧栏里**：宿主只需要内置一条
 * Markdown 规则，其余由插件通过 `files.registerType()` 声明。于是没装任何插件时，
 * 工作文件夹里只看得见 `.md`（正是需求要的默认形态），而装上文件读取器之后，
 * 侧栏、颜色、预览方式一次性全都补齐 —— 不需要改动宿主 UI。
 *
 * 快照必须返回**稳定引用**：它会被 `useSyncExternalStore` 直接消费，每次新建数组会
 * 让 React 认为快照一直变化，从而陷入无限重渲染。
 */

import type { CodeThemePreference } from "../markdown/codeThemes";

export type FilePreviewKind =
  | "code"
  | "text"
  | "markdown"
  | "table"
  | "image"
  | "media"
  | "none"
  | "custom"
  | "view";

const FILE_PREVIEW_KINDS = [
  "code",
  "text",
  "markdown",
  "table",
  "image",
  "media",
  "none",
  "custom",
  "view",
] as const;

const KIND_SET: ReadonlySet<string> = new Set(FILE_PREVIEW_KINDS);

/** 校验插件声明里的 `kind`。拼错时应该明确报错，而不是让预览区拿到未知值。 */
export function isFilePreviewKind(value: string): value is FilePreviewKind {
  return KIND_SET.has(value);
}

/**
 * 「有没有编辑器」和「有没有预览面板」是**两件独立的事**，`kind` 同时表达这两点：
 *
 * | kind | 编辑器 | 预览面板 |
 * |---|---|---|
 * | `code` / `text` | 有 | **没有** |
 * | `markdown` | 有 | Markdown 渲染 |
 * | `table` | 有（原始文本） | 解析成表格 |
 * | `image` / `media` / `custom` / `none` | **没有** | 只有预览 |
 *
 * 于是 `.py` / `.txt` / `.log` / `.json` 打开就只是编辑器，不会挂一个空预览窗格；
 * 而 `.csv` 能在「编辑看原文」和「预览看表格」之间切换。
 */

/** 有编辑器的类型。 */
export function isEditableKind(kind: FilePreviewKind): boolean {
  return kind === "code" || kind === "text" || kind === "markdown" || kind === "table";
}

/** 支持「编辑 / 分栏 / 预览」切换的类型 —— 必须是既有编辑器又有预览的。 */
export function hasPreviewPaneKind(kind: FilePreviewKind): boolean {
  return kind === "markdown" || kind === "table";
}

export interface FileType {
  id: string;
  /** 小写扩展名，不含点。 */
  extensions: string[];
  label: string;
  /** 卡片标题前的短标签，建议 2–4 个字符。 */
  badge: string;
  /** 卡片强调色（左侧竖条、标题、徽章）。任意合法 CSS 颜色。 */
  color: string;
  kind: FilePreviewKind;
  /** `kind === "code"` 时交给宿主 highlight.js 管线使用的语言名。 */
  language?: string;
  /**
   * 编辑区字体，任意合法 CSS `font-family` 值。
   *
   * 不填按 `kind` 取默认：`code` / `text` / `table` 用等宽字体，`markdown` 用正文字体。
   * 插件想给某个格式换字体（例如宽字符语言的专用等宽字体）时填这里。
   */
  font?: string;
  /**
   * 代码着色主题。不填则跟随应用主题（浅色 / 深色各一套默认）。
   *
   * 可写单个主题名（明暗都用它），或 `{ light, dark }` 按应用主题各用一套。
   * 可选值见 `features/markdown/codeThemes.ts` 的 `CODE_THEMES`。
   */
  highlightTheme?: CodeThemePreference;
  /**
   * `kind === "view"` 时的视图声明：插件把自己的 HTML / CSS / JS 交出来，
   * 由宿主读成文本、拼成一份 `srcdoc`，塞进 `sandbox="allow-scripts"` 的 iframe。
   *
   * 与 `custom` 的区别是**能跑代码**（canvas、自己的脚本、blob Worker 都行），代价是
   * 它在帧里拿不到任何 Tauri 能力 —— 边界与理由见 `Docs/plugin-view-sandbox.md`。
   * 路径都相对插件目录。
   */
  view?: FileViewSpec;
}

export interface FileViewSpec {
  /** 骨架 HTML。宿主会把下面的 css / js 内联进去后整体作为 srcdoc。 */
  html: string;
  /** 按顺序内联进 `<style>` 的样式表。 */
  css?: string[];
  /** 按顺序拼进同一个内联 module 的脚本。 */
  js?: string[];
}

/** 宿主内置：只认 Markdown。其余全部依赖插件。 */
const BUILTIN_TYPES: readonly FileType[] = Object.freeze([
  {
    id: "markdown",
    extensions: ["md", "markdown"],
    label: "Markdown",
    badge: "MD",
    color: "var(--color-bamboo)",
    kind: "markdown",
  },
]);

/** 交给 `kind === "custom"` 的渲染器：宿主读好内容再递过去，插件拿不到路径。 */
export interface WorkspaceFilePayload {
  name: string;
  /** 绝对路径。插件可以用它做去重、缓存键，但**不能**用它读盘。 */
  path: string;
  /** 文本内容；二进制文件或读取失败时为 `null`。 */
  content: string | null;
}

export type FileRenderer = (file: WorkspaceFilePayload) => Promise<string>;

/** 按类型 id 存放的渲染器。与类型同生共死，见 `registerFileType` 的第二个参数。 */
const renderers = new Map<string, FileRenderer>();

let types: readonly FileType[] = BUILTIN_TYPES;
let extensionIndex = new Map<string, FileType>();
const listeners = new Set<() => void>();

function rebuildIndex(): void {
  const index = new Map<string, FileType>();
  // 后注册的覆盖先注册的：插件应当能盖掉内置规则（例如把 .md 换成自定义渲染）。
  for (const type of types) {
    for (const extension of type.extensions) {
      index.set(extension.toLowerCase(), type);
    }
  }
  extensionIndex = index;
}
rebuildIndex();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[files] 文件类型订阅回调抛错", error);
    }
  }
}

/**
 * 注册一个文件类型，返回按 id 注销的函数。
 *
 * 用 id 去重：同一个插件重新注册（例如刷新后）会替换掉旧条目，而不是越堆越多。
 */
export function registerFileType(type: FileType, renderer?: FileRenderer): () => void {
  const normalized: FileType = {
    ...type,
    extensions: type.extensions.map((extension) => extension.replace(/^\./, "").toLowerCase()),
  };

  types = Object.freeze([...types.filter((item) => item.id !== normalized.id), normalized]);
  if (renderer) {
    renderers.set(normalized.id, renderer);
  } else {
    renderers.delete(normalized.id);
  }
  rebuildIndex();
  notify();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    types = Object.freeze(types.filter((item) => item.id !== normalized.id));
    renderers.delete(normalized.id);
    rebuildIndex();
    notify();
  };
}

/** 取某个类型的自定义渲染器；没有则为 `null`。 */
export function getFileRenderer(typeId: string): FileRenderer | null {
  return renderers.get(typeId) ?? null;
}

export function listFileTypes(): readonly FileType[] {
  return types;
}

export function subscribeFileTypes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 按扩展名找类型；不认识就返回 `null`（此时该文件不会出现在侧栏里）。 */
export function matchFileType(extension: string | null | undefined): FileType | null {
  if (!extension) return null;
  return extensionIndex.get(extension.toLowerCase()) ?? null;
}

/** 供测试与重载使用：恢复成只有内置规则的状态。 */
export function resetFileTypes(): void {
  types = BUILTIN_TYPES;
  renderers.clear();
  rebuildIndex();
  notify();
}
