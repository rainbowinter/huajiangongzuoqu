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
  /**
   * 一份**只当文本塞进去、不执行**的脚本，通常是 **Web Worker 的源码**（pdf.js 的
   * `pdf.worker.min.mjs` 就是这种）。
   *
   * 为什么不放进 `js`：视图帧是 opaque origin，`new Worker(<外部地址>)` 会被 CORS 挡掉
   * （实测见 `Docs/plugin-view-sandbox.md`），所以插件必须先把源码做成 blob 再
   * `new Worker(blob:, { type: "module" })`。源码得先以**文本**形式进到帧里，而放进 `js`
   * 会被当代码执行（那份文件是给 worker 用的，主线程跑它没有意义）。
   *
   * 宿主把它塞进 `<script type="text/plain" id="floral-worker-src">`，插件自己读
   * `textContent` —— 那个 id 定义在 `viewBridge.ts` 的 `VIEW_WORKER_ELEMENT_ID`。
   */
  worker?: string;
  /**
   * 预览区顶上那排控件的**声明**：宿主按它渲染，插件只负责响应命令。
   *
   * 为什么不让插件自己画工具栏：`sandbox="allow-scripts"` 的帧是一块**孤岛**，
   * 只在预览区里，够不到应用窗口的排版（拖拽分栏、标题栏、后续要加的东西都跟它对齐不了），
   * 而且它每次加载都要等插件那一大坨 js 解析完才出得来。
   * 交给宿主渲染就与 Markdown 那排格式化按钮同一个位置、同一套样式，也立刻可点。
   *
   * 交互只有两条消息：宿主下发 `command`（带 `id`，输入控件还带 `value`），
   * 视图回 `state`（`values` 覆盖显示文本、`pressed` 点亮开关）。
   * 详见 `Docs/plugin-api.md` 的「视图工具栏」一节。
   */
  toolbar?: ViewToolbarItem[];
}

/**
 * 视图工具栏里的一项。宿主渲染，插件只声明。
 *
 * `id` 是命令与状态的名字：宿主点一下发 `{ t: "command", id }`，视图回
 * `state.values[id]` / `state.pressed` 时也用同一个 id。所以**同一份声明里不能重名**。
 *
 * `icon` 是**插件目录下的相对路径**（`.svg`），例如 `"icons/zoom-in.svg"`。宿主把它读出来
 * 内联进按钮里（不是 `<img>`）—— 这样图标能跟着主题色走（写 `fill="currentColor"`），
 * 也不用为了几个小图标去动 asset 协议。**布局仍然由宿主决定**，图标只是个装饰。
 * 路径合不合法由后端把关（与 css / js 同一条原则：前端不重复写一遍规则）。
 */
export type ViewToolbarItem =
  /**
   * 按钮。`toggle` 只是「宿主会不会用 pressed 点亮它」的意思，状态仍由视图说了算。
   *
   * `label` 与 `icon` **至少要有一个**，两个都给也合法：这时 `label` 是文字的兜底
   * （画不出图标时用它），单字符的 `label` 在图标面前**让位** —— 它替代的就是图标本身，
   * 两个都画就成了「一颗按钮里两个箭头」。见 `toolbarText.ts`。
   */
  | {
      kind: "button";
      id: string;
      label?: string;
      title?: string;
      toggle?: boolean;
      icon?: string;
    }
  /** 只读的小字（缩放比例、`3 / 14` 这种）。文本由视图通过 `state.values[id]` 给。 */
  | { kind: "readout"; id: string; title?: string }
  /** 输入框，回车提交（页码跳转这种）。 */
  | { kind: "input"; id: string; title?: string; placeholder?: string; width?: number }
  /**
   * 按钮 + 下拉：**选一个**（标注方式、颜色盘这类）。
   *
   * 当前选中的是哪个由 `state.values[id]` 说了算（按钮上就显示那一项的文字），选中一项会发
   * `{ t: "command", id, value }`。选项带 `color` 时画成色块 —— 于是**同一个控件既能选工具
   * 也能选颜色**，不必再加一种。
   */
  | {
      kind: "menu";
      id: string;
      label: string;
      title?: string;
      icon?: string;
      options: ViewToolbarOption[];
    }
  /**
   * 任意颜色：一个色块按钮，**点开系统调色盘**。值是任意 `#rrggbb`。
   *
   * 与「`menu` + 带 `color` 的选项」的分工：那一种是**几个固定色**（列成色块，
   * 一眼看全、点一下就好）；这一种是**要什么色自己挑**。两者都留着 ——
   * 常用的四色用前者更顺手，想微调用后者。
   *
   * ⚠️ 宿主把它画成「自绘色块 + 一个完全透明的原生 `<input type="color">` 盖在上面」
   * （和编辑器里那些色块同一招）：原生色块在十几像素下撑不满，只剩一条横线。
   */
  | { kind: "color"; id: string; title?: string }
  /** 竖线分隔。 */
  | { kind: "separator" };

/** `menu` 里的一项。 */
export interface ViewToolbarOption {
  /** 选中它时发回去的那个值。 */
  value: string;
  label: string;
  /** 任意合法 CSS 颜色。有它就画一个色块，颜色盘靠这个。 */
  color?: string;
  /** 图标（插件目录下的相对路径，见 `icon` 字段的说明）。 */
  icon?: string;
  title?: string;
}

/**
 * 一份声明里最多几项 —— 工具栏是窄条，几十项也没地方放。
 *
 * 24 而不是 16：**这一排是两个插件共用的**（被扩展的视图 + 扩展它的插件，见
 * `files.extendView`）。PDF 阅读器自己就用掉 13 项，批注再叠几项就顶到旧上限了。
 */
const MAX_TOOLBAR_ITEMS = 24;
/** 一个下拉里最多几项。再长就该翻页或分类了，那是插件自己的事。 */
const MAX_MENU_OPTIONS = 24;
/** `id` 只允许这些字符：它要落到 `key`、`data-*` 与消息里，别给自己找转义的麻烦。 */
const TOOLBAR_ID_PATTERN = /^[A-Za-z0-9_.-]{1,48}$/;
const MAX_LABEL = 24;
/** 图标路径的长度上限。够写 `icons/xxx-yyy.svg` 了。 */
const MAX_ICON_PATH = 120;
const MAX_TITLE = 60;
const MAX_PLACEHOLDER = 16;
/** 输入框宽度（px）的上下限：太窄看不清，太宽会把整排顶开。 */
const MIN_INPUT_WIDTH = 36;
const MAX_INPUT_WIDTH = 160;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/** `menu` 的选项表。一项都认不出来时返回 `undefined`（调用方据此丢掉整个菜单）。 */
function parseMenuOptions(raw: unknown): ViewToolbarOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const options: ViewToolbarOption[] = [];
  const seen = new Set<string>();

  for (const entry of raw.slice(0, MAX_MENU_OPTIONS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const value = boundedText(record.value, 48);
    const label = boundedText(record.label, MAX_LABEL);
    if (!value || !label || seen.has(value)) continue;
    seen.add(value);

    // 颜色只当字符串收下，画的时候交给浏览器的 CSSOM —— 它只会在那个元素的
    // `background-color` 上生效，写歪了顶多是不显示，穿不出一个元素之外。
    const color = boundedText(record.color, 32);
    const title = boundedText(record.title, MAX_TITLE);
    const icon = boundedText(record.icon, MAX_ICON_PATH);
    options.push({
      value,
      label,
      ...(color ? { color } : {}),
      ...(icon ? { icon } : {}),
      ...(title ? { title } : {}),
    });
  }

  return options.length > 0 ? options : undefined;
}

/**
 * 校验插件交上来的工具栏声明。
 *
 * 与 `parseViewMessage` 同一条原则：**认不出来的一律丢掉，不猜**。整份声明里只要有一项
 * 形状不对就丢掉那一项（而不是整份作废）—— 少一个按钮总好过预览区整个打不开。
 * 一个可渲染项都没有、或者只剩分隔线时返回 `undefined`（调用方据此不渲染那一排）。
 */
export function parseViewToolbar(raw: unknown): ViewToolbarItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const items: ViewToolbarItem[] = [];
  const seen = new Set<string>();

  for (const entry of raw.slice(0, MAX_TOOLBAR_ITEMS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    if (record.kind === "separator") {
      // 连着的分隔线没有意义，开头那条也没有。
      const last = items[items.length - 1];
      if (last && last.kind !== "separator") items.push({ kind: "separator" });
      continue;
    }

    const id = typeof record.id === "string" && TOOLBAR_ID_PATTERN.test(record.id) ? record.id : null;
    if (!id || seen.has(id)) continue;

    const title = boundedText(record.title, MAX_TITLE);

    if (record.kind === "button") {
      const label = boundedText(record.label, MAX_LABEL);
      const icon = boundedText(record.icon, MAX_ICON_PATH);
      // **文字与图标都没有才是死按钮**。只看 label 会逼着「只想要一个图标」的作者
      // 去写一个假的单字符 label —— 那正是「一颗按钮两个箭头」的由来。
      if (!label && !icon) continue;
      seen.add(id);
      items.push({
        kind: "button",
        id,
        ...(label ? { label } : {}),
        ...(icon ? { icon } : {}),
        ...(title ? { title } : {}),
        ...(record.toggle === true ? { toggle: true } : {}),
      });
      continue;
    }

    if (record.kind === "readout") {
      seen.add(id);
      items.push({ kind: "readout", id, ...(title ? { title } : {}) });
      continue;
    }

    if (record.kind === "input") {
      seen.add(id);
      const placeholder = boundedText(record.placeholder, MAX_PLACEHOLDER);
      const width =
        typeof record.width === "number" && Number.isFinite(record.width)
          ? Math.round(Math.min(MAX_INPUT_WIDTH, Math.max(MIN_INPUT_WIDTH, record.width)))
          : undefined;
      items.push({
        kind: "input",
        id,
        ...(title ? { title } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(width ? { width } : {}),
      });
      continue;
    }

    if (record.kind === "color") {
      seen.add(id);
      items.push({ kind: "color", id, ...(title ? { title } : {}) });
      continue;
    }

    if (record.kind === "menu") {
      const label = boundedText(record.label, MAX_LABEL);
      const options = parseMenuOptions(record.options);
      // 一个可选项都没有的下拉是个死按钮，不如不给。
      if (!label || !options) continue;
      const icon = boundedText(record.icon, MAX_ICON_PATH);
      seen.add(id);
      items.push({
        kind: "menu",
        id,
        label,
        ...(icon ? { icon } : {}),
        ...(title ? { title } : {}),
        options,
      });
    }
  }

  // 末尾那条分隔线没有下家，留着就是一条孤零零的竖线。
  while (items.length > 0 && items[items.length - 1].kind === "separator") items.pop();

  return items.length > 0 ? items : undefined;
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
