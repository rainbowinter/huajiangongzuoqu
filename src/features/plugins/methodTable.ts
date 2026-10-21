/**
 * 插件可调用的方法表（宿主侧实现）。
 *
 * 三个刻意的设计决定：
 *
 * 1. **权限门只在这一处**。`dispatchPluginCall` 是插件调用的唯一入口，先查方法表、
 *    再做权限检查、最后带超时执行。这样不可能出现「加了新方法忘了加门」。
 *    配套单测会断言：凡是需要能力的方法都必须声明 `permission`。
 * 2. **宿主侧不做业务逻辑**，只做参数校验与转发，真正的操作由 `PluginHostBridge`
 *    实现（见 `hosts/v2Host.ts`）。这样方法表可以脱离 React 单独测试。
 * 3. **超时分档**：读 5s、磁盘 IO 15s、插件回调 10s。超时由调用方 terminate/失败处理。
 */

import type { Disposable } from "./disposable";
import type { PluginApiError } from "./protocol";
import { TIMEOUTS, type MethodDescriptor, type PluginInfo } from "./protocol";
import { PermissionError, checkPermission, type Permission } from "./permissions";
import type { CodeThemePreference } from "../markdown/codeThemes";
import type { FontFaceOverride } from "../fonts/fontFace";
import { parseViewToolbar, type FileViewSpec, type ViewToolbarItem } from "../workspace/fileTypes";
import { isDocumentContext, type DocumentContext } from "../workspace/documentContext";
import { isWorkspaceFolderTarget } from "../workspace/folderBridge";

export interface CommandContribution {
  id: string;
  title: string;
  keybinding?: string;
  runToken: string;
}

export interface PanelContribution {
  id: string;
  title: string;
  width?: number;
  standalone?: boolean;
  renderToken: string;
  onClickToken?: string;
  /** `change` 事件（下拉框、复选框）也送回插件。 */
  onChangeToken?: string;
}

export interface StatusBarContribution {
  id: string;
  renderToken: string;
}

/**
 * 编辑器行旁注：在编辑区左侧加一栏「每行一段文字」。
 *
 * 插件只负责**出文字**（行号、以后的 git blame、TODO 标记…），位置与滚动同步由宿主
 * 保证 —— 插件量不到编辑器的换行与行高，把它交给插件只会得到对不齐的栏。
 */
export interface GutterContribution {
  id: string;
  title: string;
  /** 栏宽（px）。默认 44。 */
  width?: number;
  /** 返回**每行一个字符串**；第 i 项对应第 i 个逻辑行。 */
  renderToken: string;
}

export interface MenuContribution {
  id: string;
  title: string;
  runToken: string;
}

export interface ToolbarContribution {
  id: string;
  title: string;
  icon?: string;
  runToken: string;
}

/**
 * 文档动作：主窗口**顶上那一行**的一个按钮。
 *
 * ## 与 `ui.registerToolbarButton` 的分工
 *
 * 那个是**往编辑器那排格式按钮里塞**（粗体、斜体旁边），只有打开笔记 / Markdown 时才在。
 * 这个是**文档级动作**（导出、打印、另存、跑一遍校验），放在主窗口顶部那一行 —— 也就是
 * 「插入图片 / 撤销 / 另存为 / 删除」旁边，和「打开右侧栏插件面板」的页签同一层。
 *
 * ⚠️ 别和 `view.toolbar` 搞混：那是**视图内部的小工具**（PDF 的翻页、缩放、标注工具），
 * 渲染在预览区里面、iframe 上面。分界线是**「这是对这一份文档做的事，还是对这一屏画面做
 * 的事」**。详见 `Docs/plugin-api.md`。
 *
 * ## 什么时候出现
 *
 * 顶上那一行按当前打开的东西编排（`documentContext.ts`），所以这个按钮也得会挑场合：
 * 给 PDF 做的「导出批注」不该在打开一篇笔记时冒出来。
 */
export interface DocumentActionContribution {
  id: string;
  title: string;
  /**
   * 按钮上的图标。两种写法：
   *
   * - **插件目录下的相对路径**（`"icons/export.svg"`）—— 宿主读成文本、消毒后**内联**，
   *   于是能跟 `currentColor` 走（与 `view.toolbar` 的图标同一条通道）；
   * - **一个短文字字形**（`"导出"`）—— 原样当文字画。
   *
   * 判据见 `viewAssets.ts` 的 `isIconAssetPath`。不给就只显示 `title`。
   */
  icon?: string;
  /** 在插件沙箱里跑的处理函数。与 `viewCommand` 二选一（或都给）。 */
  runToken?: string;
  /**
   * 把这条命令转发给**当前那个沙箱视图**（`{t:"command", id}`）。
   *
   * 为什么需要它：视图类插件真正的逻辑住在帧里（拿得到画布、pdf.js、选区），worker 侧的
   * `run()` 够不到 —— 「导出批注」这种动作只有帧里的代码做得了。给一个命令 id 就行。
   */
  viewCommand?: string;
  /** 只在这些文档上下文里出现（`note` / `markdown` / `view`…）。空 = 不限。 */
  contexts?: readonly DocumentContext[];
  /** 只在这些文件类型 id 里出现（带插件名前缀）。空 = 不限。 */
  typeIds?: readonly string[];
  /**
   * 下拉里的项。给了（且至少有一项认得出来）这个动作就变成一个**下拉**：点开菜单再选。
   *
   * 什么时候该用：**同一件事的几种做法**（导出原始 PDF / 导出带批注的 PDF）。做成两颗
   * 并排的按钮更占地方，而且「导出」这个词重复两遍。
   *
   * ⚠️ 给了 `items` 之后，顶层的 `run` / `viewCommand` **不再被调用** —— 按钮只负责展开
   * 菜单，「点什么」由各项目己说。
   */
  items?: readonly DocumentActionItem[];
}

/** 文档动作下拉里的一项。 */
export interface DocumentActionItem {
  id: string;
  title: string;
  /** 在插件沙箱里跑的处理函数。与 `viewCommand` 二选一（或都给）。 */
  runToken?: string;
  /** 转发给当前那个沙箱视图帧的命令 id。 */
  viewCommand?: string;
}

/**
 * 行内动作：**插件列表里、这个插件那一行**展开后的一颗按钮。
 *
 * 与 `ui.registerCommand` 的区别不在长相，在**入口在哪**：命令面板是一个得先知道有它存在
 * 的地方（敲名字才找得到），而行内动作就摆在「这个插件」旁边 —— 用户点开这一行的原因是
 * 「我想看看这个插件能干什么」，答案应该当场在那儿，不必再去别处找。
 *
 * 典型用法：插件管的东西放在 `<数据目录>` 下、不在任何工作区里，用户看不到，
 * 那就顺手帮他把那个文件夹加进去。
 *
 * 只认 `run`（在 worker 里跑）：行内动作没有「转发给当前视图」的场合 —— 它跟当前打开
 * 什么文件毫无关系。
 */
export interface RowActionContribution {
  id: string;
  title: string;
  /** 按钮上显示的文字字形；不给就只显示 title。 */
  icon?: string;
  /** 在插件沙箱里跑的处理函数。 */
  runToken: string;
}

/**
 * 工具栏浮层：工具栏上的一个按钮，点开一个**贴着它**的下拉面板，内容由插件渲染。
 *
 * 与 `registerPanel` 的分工：面板是常驻侧栏，浮层是随手开合的临时界面 —— 符号表、
 * 表情选择、颜色盘、模板插入这类「看一眼、点一下、关掉」的东西用它更合适。
 *
 * 下拉内容**懒加载**：注册时不渲染，用户点开时才向插件要一次 HTML。
 */
export interface PopoverContribution {
  id: string;
  title: string;
  /** 按钮上显示的文字；不给就用 `title`。 */
  icon?: string;
  /** 下拉宽度（px），默认 320。高度由内容决定，超出会滚。 */
  width?: number;
  /** `true` 时只在笔记 / Markdown 文件下出现，与内置的 Markdown 格式化按钮一致。 */
  markdownOnly?: boolean;
  /** 点开时调用一次，返回下拉里的 HTML。 */
  renderToken: string;
  /**
   * 点击下拉内容时的回调。
   *
   * **返回一个字符串**表示「用这段 HTML 换掉当前内容」—— 分类切换、翻页这类交互靠它
   * 实现，插件只需在自己的沙箱里记住状态。返回其它值则内容保持不变。
   */
  onClickToken?: string;
  /** 每次点击后自动收起。默认 `false` —— 符号表那种要连点好几次。 */
  closeOnClick?: boolean;
}

/**
 * 行内装饰：在正文里叠一层**贴着字符**的小控件。
 *
 * 与行旁注（`ui.registerGutter`）的分工：行旁注在左侧固定栏里出**文字**，位置与点击都不归
 * 插件管；行内装饰跟着**列位置**走，而且是可点的 —— 颜色块、跳转箭头、行内提示都走这个口子。
 *
 * `render()` 返回的是**数据**不是 HTML（`{ offset, length, color }`），所以这条链路不需要
 * 消毒器。
 */
export interface DecorationContribution {
  id: string;
  title: string;
  /** 每次正文 / 文件变化时调用一次，返回要叠的条目。 */
  renderToken: string;
  /** 用户选完颜色时调用：`(offset, length, "#rrggbb")`。 */
  pickToken?: string;
}

export interface SelectionTransformerContribution {
  id: string;
  transformToken: string;
}

export interface StyleContribution {
  id: string;
  /** 原始 CSS 文本，由宿主插进一个 `<style>` 元素。 */
  css: string;
}

/**
 * 文件类型声明。
 *
 * 插件**不接触文件系统**：它只负责说「`.py` 是 Python、徽章是 PY、颜色是这个」，
 * 至于"文件夹里有哪些文件、内容是什么"全部由宿主提供。这条边界让「文件读取器」
 * 这种看起来很大的功能不需要任何新增的文件系统权限。
 */
export interface FileTypeContribution {
  id: string;
  /** 扩展名，不含点，大小写不敏感。 */
  extensions: string[];
  label: string;
  badge: string;
  /** 卡片强调色，任意合法 CSS 颜色。 */
  color: string;
  kind: string;
  /** `kind === "code"` 时交给宿主 highlight.js 的语言名。 */
  language?: string;
  /** 编辑区字体，任意合法 CSS font-family。不填按 kind 取默认。 */
  font?: string;
  /** 代码着色主题：单个主题名，或 `{ light, dark }` 按应用主题各用一套。 */
  highlightTheme?: CodeThemePreference;
  /** `kind === "custom"` 时的渲染回调令牌。 */
  renderToken?: string;
  /**
   * `kind === "view"` 时的视图声明（相对插件目录的路径）。
   *
   * 与 `custom` 分开一个权限词（`files:view`）：这里插件交出来的代码会跑在宿主给的
   * 沙箱视图里，**能画 canvas、能跑自己的脚本**，比「只登记一条扩展名规则」能力更强，
   * 值得单独可撤销。沙箱边界见 `Docs/plugin-view-sandbox.md`。
   */
  view?: FileViewSpec;
  /**
   * 「新建这种文件」时先写进去的原始字节（base64）。
   *
   * 零字节的 `.docx` 不是合法 ZIP，Word 打不开；插件可以在这里给一份最小模板，
   * 宿主新建文件时直接落盘。上限 1.5MB（base64 字符数），只该放骨架，别塞整篇文档。
   */
  newFile?: string;
}

/**
 * 解析插件交上来的视图声明。
 *
 * `html` 必填（没有骨架就没得拼），`css` / `js` 是可选字符串数组 —— 路径都相对插件目录。
 * 抽成独立函数是为了能单测：这里处理的是**不可信输入**，形状判断错一个就会出现
 * 「插件说它有视图、宿主却拼不出东西」这种难查的故障。
 */
export function parseViewSpec(raw: unknown): FileViewSpec | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const record = raw as Record<string, unknown>;
  if (typeof record.html !== "string" || record.html.length === 0) return undefined;

  const paths = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const filtered = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return filtered.length > 0 ? filtered : undefined;
  };

  const css = paths(record.css);
  const js = paths(record.js);
  // worker 是**单个**路径（一份源码），不是列表。
  const worker =
    typeof record.worker === "string" && record.worker.length > 0 ? record.worker : undefined;
  // 工具栏是**声明**不是路径：宿主按它渲染控件，所以这里要逐项校验（见 parseViewToolbar）。
  const toolbar = parseViewToolbar(record.toolbar);

  return {
    html: record.html,
    ...(css ? { css } : {}),
    ...(js ? { js } : {}),
    ...(worker ? { worker } : {}),
    ...(toolbar ? { toolbar } : {}),
  };
}

/**
 * 「扩展别人的视图」声明（`files.extendView`）。
 *
 * 一个插件把自己的 js / css / 工具栏项并进**另一个插件注册的视图**里（同一个沙箱帧、
 * 同一个内联 module）。典型用途：批注插件往 PDF 阅读器上叠一层高亮 —— 让批注插件自己
 * 重新实现一遍 PDF 渲染显然不现实。
 *
 * 目标用 `typeId` 指（**带插件名前缀**的那个，`pdf-viewer:pdf`，与 `ownerOfFileType`
 * 同一套约定）。目标还没注册时也收下 —— 加载顺序不该决定谁能扩展谁。
 */
export interface ViewExtensionContribution {
  typeId: string;
  css?: string[];
  js?: string[];
  toolbar?: ViewToolbarItem[];
  /**
   * 要不要一条**私有数据通道**（`floralView.extension("<插件名>")`）。
   *
   * 要的话得声明 `workspace:cache` 权限：那条通道写的是**用户文件夹里**的
   * `__floral-notepaper__/`，与「你的代码在沙箱里跑」是两件事，用户该在权限清单里看见它。
   * 不声明就只是并点样式和按钮，碰不到磁盘。
   */
  data?: boolean;
}

/** `typeId` 的形状：`<插件名>:<类型 id>`，两段都是普通名字。 */
const VIEW_TYPE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,64}$/;

/**
 * 解析扩展声明。与 `parseViewSpec` 同一条原则：**认不出来的一律丢掉，不猜**。
 *
 * 三样（css / js / toolbar）一样都没有时整份作废 —— 那是一次什么都没做的调用，
 * 收下只会让人以为生效了。
 */
export function parseViewExtension(raw: unknown): ViewExtensionContribution | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;

  const typeId = typeof record.typeId === "string" ? record.typeId.trim() : "";
  if (!VIEW_TYPE_ID_PATTERN.test(typeId)) return undefined;

  const paths = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const filtered = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return filtered.length > 0 ? filtered : undefined;
  };

  const css = paths(record.css);
  const js = paths(record.js);
  const toolbar = parseViewToolbar(record.toolbar);
  // `data` 也是「做了什么」，单独要一条数据通道时它也成立。
  if (!css && !js && !toolbar && record.data !== true) return undefined;

  return {
    typeId,
    ...(css ? { css } : {}),
    ...(js ? { js } : {}),
    ...(toolbar ? { toolbar } : {}),
    ...(record.data === true ? { data: true } : {}),
  };
}

/**
 * 字体登记声明。
 *
 * 插件只说"我的字体放在哪个文件夹"，其余全由宿主完成：列文件、生成 asset URL、拼
 * `@font-face`、注入样式、登记族名。插件既**拿不到路径**（回给它的只有族名），也
 * **塞不进任意 CSS**（规则由宿主按校验过的文件名生成）—— 因此这比 `ui:style` 还弱。
 */
export interface FontRegistration {
  /** 相对插件目录的字体文件夹，默认为 `fonts`。 */
  dir?: string;
  /**
   * 按**文件名**覆盖自动推导出的族名 / 字重 / 字形。
   *
   * 族名由文件名推导（见 `features/fonts/fontFace.ts`），字体文件名乱起来六亲不认时
   * 用这里兜。键是 `listAssets` 那种纯文件名，不是路径。
   */
  overrides?: Record<string, FontFaceOverride>;
}

export interface PluginFontRegistrationResult {
  /** 本次登记到的字体族名（去重）。 */
  families: string[];
  /** 实际加载的字体**文件**数（一个字族可能占多个文件）。 */
  count: number;
}

/**
 * 宿主能力桥。方法表只依赖这个接口，不直接碰 React / Tauri / 注册表，
 * 因此可以用一个假的 bridge 做完整的方法表测试。
 */
export interface PluginHostBridge {
  // ---- ui
  showToast(message: string, type?: string): void;
  registerCommand(contribution: CommandContribution): string;
  registerPanel(contribution: PanelContribution): string;
  registerStatusBarItem(contribution: StatusBarContribution): string;
  registerGutter(contribution: GutterContribution): string;
  registerEditorMenuItem(contribution: MenuContribution): string;
  registerNoteMenuItem(contribution: MenuContribution): string;
  registerToolbarButton(contribution: ToolbarContribution): string;
  registerDocumentAction(contribution: DocumentActionContribution): string;
  registerRowAction(contribution: RowActionContribution): string;
  /** 把数据目录下的一个文件夹加进左侧工作区并跳过去（只认 `@data` / `@data/styles`）。 */
  openWorkspaceFolder(path: string): Promise<void>;
  registerPopover(contribution: PopoverContribution): string;
  registerDecorations(contribution: DecorationContribution): string;
  registerSelectionTransformer(contribution: SelectionTransformerContribution): string;
  /** 把一段 CSS 注入当前窗口的主世界。 */
  registerStyle(contribution: StyleContribution): string;
  /** 声明一种可识别的文件类型。 */
  registerFileType(contribution: FileTypeContribution): string;
  /** 把资源并进**另一个插件注册的视图**。 */
  registerViewExtension(contribution: ViewExtensionContribution): string;
  openPanel(panelId: string): void;
  /** 把一条命令发给**当前这个插件的**沙箱视图；没有活视图时返回 false。 */
  uiSendToView(id: string, value?: string): boolean;

  /** 读插件自己目录下的文本资源（样式表、附加脚本、图标 SVG…）。 */
  readPluginAsset(relativePath: string): Promise<string>;
  /** 列出插件自己目录下某个子目录里的可读资源文件名（不递归）。 */
  listPluginAssets(relativeDir: string): Promise<string[]>;

  /**
   * 扫描插件自己的字体目录并登记为可用的 `@font-face`。
   *
   * 回传的只有**族名**：绝对路径在主世界就被 `convertFileSrc` 吃掉了，插件全程
   * 不知道自己的文件在哪。
   */
  registerFonts(options: FontRegistration): Promise<PluginFontRegistrationResult>;

  // ---- editor
  editorGetContent(): string;
  editorSetContent(content: string): void;
  editorGetSelection(): { text: string; start: number; end: number } | null;
  editorReplaceSelection(replacement: string): boolean;
  editorInsertText(text: string, at: "cursor" | "docEnd"): boolean;
  editorWrapSelection(before: string, after: string): boolean;
  editorReplaceRange(start: number, end: number, text: string): boolean;
  editorSetSelection(start: number, end: number): void;
  editorFocus(): void;
  editorGetCursor(): { line: number; column: number; offset: number } | null;
  editorScrollTo(offset: number): void;
  editorScrollPreviewTo(offset: number): void;

  // ---- workspace / categories
  workspaceListNotes(): Promise<unknown>;
  workspaceGetNote(id: string): Promise<unknown>;
  workspaceCreateNote(request: unknown): Promise<unknown>;
  workspaceUpdateNote(id: string, request: unknown): Promise<unknown>;
  workspaceDeleteNote(id: string): Promise<void>;
  workspaceMoveNoteCategory(id: string, category: string): Promise<unknown>;
  workspaceOpenNote(id: string): Promise<void>;
  workspaceGetActiveNote(): Promise<unknown>;
  categoriesList(): Promise<string[]>;
  categoriesCreate(name: string): Promise<void>;

  // ---- storage / settings / events
  // ---- 工作区缓存（`__floral-notepaper__/`）：**跟文件走**的数据，比如批注
  cacheGet(filePath: string): Promise<unknown>;
  cacheSet(filePath: string, value: unknown): Promise<void>;
  cacheDelete(filePath: string): Promise<boolean>;

  storageGet(key: string): Promise<unknown>;
  storageSet(key: string, value: unknown): Promise<void>;
  storageDelete(key: string): Promise<void>;
  storageKeys(): Promise<string[]>;
  storageClear(): Promise<void>;
  settingsGet(): Promise<Record<string, unknown>>;
  subscribeEvent(topic: string): void;
  unsubscribeEvent(topic: string): void;

  // ---- system
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  dialogMessage(message: string, options?: Record<string, unknown>): Promise<void>;
  dialogConfirm(message: string, options?: Record<string, unknown>): Promise<boolean>;
  dialogPrompt(message: string, options?: Record<string, unknown>): Promise<string | null>;

  /** 释放一个注册项（`ui.dispose` / 返回的 Disposable 调用）。 */
  disposeRegistration(id: string): void;
}

export interface PluginCallContext {
  plugin: PluginInfo;
  declared: readonly string[];
  granted: readonly string[];
  bridge: PluginHostBridge;
}

interface MethodEntry {
  /** 需要的能力。省略表示该方法不触碰受保护能力（必须登记在 NO_PERMISSION_METHODS 里）。 */
  permission?: Permission;
  timeoutMs?: number;
  handler: (ctx: PluginCallContext, args: unknown[]) => unknown | Promise<unknown>;
}

// --------------------------------------------------------------- 参数工具

function asRecord(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidArgument(method, "参数必须是对象");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, method: string, field: string): string {
  if (typeof value !== "string") {
    throw invalidArgument(method, `${field} 必须是字符串`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 校验「新建文件模板」。
 *
 * 它会被宿主直接写盘，所以**必须是严格的 base64**：带换行、带空白、长度不是 4 的
 * 倍数都拒绝。上限只该装骨架（空白 DOCX 约 1.8KB），1.5MB 已经宽到不像模板。
 */
const MAX_NEW_FILE_BASE64 = 1_500_000;

function parseNewFileTemplate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidArgument("files.registerType", "newFile 必须是非空 base64 字符串");
  }
  if (value.length > MAX_NEW_FILE_BASE64) {
    throw invalidArgument("files.registerType", "newFile 模板太大（上限 1.5MB）");
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw invalidArgument("files.registerType", "newFile 不是合法的 base64");
  }
  return value;
}

function asNumber(value: unknown, method: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidArgument(method, `${field} 必须是有限数字`);
  }
  return value;
}

function invalidArgument(method: string, message: string): PluginApiError {
  const error = new Error(`${method}：${message}`) as PluginApiError;
  Object.assign(error, { name: "PluginApiError", code: "invalidArgument", details: { method } });
  return error;
}

/**
 * 从参数对象里取一个回调令牌，缺失即报错。
 *
 * `field` 用的是**插件侧的字段名**（`run` / `render` / `onClick` / `transform`）：
 * 沙箱侧的 `serializeArg` 会把函数就地替换成令牌，但**保留原字段名**。
 * 所以插件写 `{ id, title, run() {...} }`，宿主看到的是 `{ id, title, run: "\0h:0" }`。
 */
function requireToken(record: Record<string, unknown>, field: string, method: string): string {
  const token = record[field];
  if (typeof token !== "string" || token.length === 0) {
    throw invalidArgument(method, `${field} 必须是一个回调函数`);
  }
  return token;
}

// ---------------------------------------------------------------- 方法表

export const METHOD_TABLE: Record<string, MethodEntry> = {
  // ---- plugin（无权限：只回显插件自身的身份信息）
  "plugin.info": {
    handler: (ctx) => ctx.plugin,
  },
  // 读自己的资源不需要权限：插件代码本来就是从这个目录加载的，能读自己的样式表
  // 不构成任何新增能力。路径穿越由后端 `safe_join_file` 挡。
  "plugin.readAsset": {
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.readPluginAsset(asString(args[0], "plugin.readAsset", "relativePath")),
  },
  "plugin.listAssets": {
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.listPluginAssets(asString(args[0], "plugin.listAssets", "relativeDir")),
  },

  // ---- ui
  "ui.showToast": {
    permission: "ui:toast",
    handler: (ctx, args) => {
      const message = asString(args[0], "ui.showToast", "message");
      const type = asOptionalString(args[1]);
      ctx.bridge.showToast(message, type);
      return undefined;
    },
  },
  "ui.registerCommand": {
    permission: "ui:command",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerCommand");
      const id = asString(record.id, "ui.registerCommand", "id");
      const title = asString(record.title, "ui.registerCommand", "title");
      const runToken = requireToken(record, "run", "ui.registerCommand");
      return ctx.bridge.registerCommand({
        id,
        title,
        runToken,
        ...(asOptionalString(record.keybinding) ? { keybinding: record.keybinding as string } : {}),
      });
    },
  },
  "ui.registerPanel": {
    permission: "ui:panel",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerPanel");
      const id = asString(record.id, "ui.registerPanel", "id");
      const title = asString(record.title, "ui.registerPanel", "title");
      const renderToken = requireToken(record, "render", "ui.registerPanel");
      const onClickToken = asOptionalString(record.onClick);
      const onChangeToken = asOptionalString(record.onChange);
      return ctx.bridge.registerPanel({
        id,
        title,
        renderToken,
        ...(onClickToken ? { onClickToken } : {}),
        ...(onChangeToken ? { onChangeToken } : {}),
        ...(typeof record.width === "number" ? { width: record.width } : {}),
        ...(typeof record.standalone === "boolean" ? { standalone: record.standalone } : {}),
      });
    },
  },
  "ui.registerGutter": {
    permission: "ui:gutter",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerGutter");
      const id = asString(record.id, "ui.registerGutter", "id");
      const title = asString(record.title, "ui.registerGutter", "title");
      const renderToken = requireToken(record, "render", "ui.registerGutter");
      return ctx.bridge.registerGutter({
        id,
        title,
        renderToken,
        ...(typeof record.width === "number" ? { width: record.width } : {}),
      });
    },
  },
  "ui.registerStatusBarItem": {
    permission: "ui:statusbar",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerStatusBarItem");
      return ctx.bridge.registerStatusBarItem({
        id: asString(record.id, "ui.registerStatusBarItem", "id"),
        renderToken: requireToken(record, "render", "ui.registerStatusBarItem"),
      });
    },
  },
  "ui.registerEditorMenuItem": {
    permission: "ui:menus",
    handler: (ctx, args) =>
      ctx.bridge.registerEditorMenuItem(menuContribution(args, "ui.registerEditorMenuItem")),
  },
  "ui.registerNoteMenuItem": {
    permission: "ui:menus",
    handler: (ctx, args) =>
      ctx.bridge.registerNoteMenuItem(menuContribution(args, "ui.registerNoteMenuItem")),
  },
  "ui.registerToolbarButton": {
    permission: "ui:toolbar",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerToolbarButton");
      const icon = asOptionalString(record.icon);
      return ctx.bridge.registerToolbarButton({
        id: asString(record.id, "ui.registerToolbarButton", "id"),
        title: asString(record.title, "ui.registerToolbarButton", "title"),
        runToken: requireToken(record, "run", "ui.registerToolbarButton"),
        ...(icon ? { icon } : {}),
      });
    },
  },
  "ui.registerDocumentAction": {
    permission: "ui:document-action",
    handler: (ctx, args) => {
      const method = "ui.registerDocumentAction";
      const record = asRecord(args[0], method);
      const icon = asOptionalString(record.icon);
      const items = parseDocumentActionItems(record.items);
      // 函数是可选的（转发命令那种就不带 run），但**一个都没有**就等于点下去什么都不
      // 发生 —— 那种按钮不如不出现。下拉形态由 `items` 提供那个「点什么」。
      const runToken = asOptionalString(record.run);
      const viewCommand = asOptionalString(record.viewCommand);
      if (!items && !runToken && !viewCommand) {
        throw invalidArgument(method, "要么给 items（下拉），要么给 run / viewCommand");
      }
      const contexts = asDocumentContexts(record.contexts);
      const typeIds = asStringList(record.typeIds);
      return ctx.bridge.registerDocumentAction({
        id: asString(record.id, method, "id"),
        title: asString(record.title, method, "title"),
        ...(icon ? { icon } : {}),
        // 给了下拉就不再要顶层那两个回调：按钮只负责展开菜单（见接口上的说明）。
        ...(items ? { items } : { ...(runToken ? { runToken } : {}), ...(viewCommand ? { viewCommand } : {}) }),
        ...(contexts ? { contexts } : {}),
        ...(typeIds ? { typeIds } : {}),
      });
    },
  },
  "ui.registerRowAction": {
    permission: "ui:row-action",
    handler: (ctx, args) => {
      const method = "ui.registerRowAction";
      const record = asRecord(args[0], method);
      const icon = asOptionalString(record.icon);
      return ctx.bridge.registerRowAction({
        id: asString(record.id, method, "id"),
        title: asString(record.title, method, "title"),
        runToken: requireToken(record, "run", method),
        ...(icon ? { icon } : {}),
      });
    },
  },
  "workspace.openFolder": {
    permission: "workspace:folders",
    handler: (ctx, args) => {
      const method = "workspace.openFolder";
      const path = asString(args[0], method, "路径");
      if (!isWorkspaceFolderTarget(path)) {
        throw invalidArgument(
          method,
          `只认 @data 与 @data/styles（插件住在数据目录里，不该去猜用户磁盘的结构），收到：${path}`,
        );
      }
      return ctx.bridge.openWorkspaceFolder(path);
    },
  },
  "ui.registerPopover": {
    permission: "ui:popover",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerPopover");
      const icon = asOptionalString(record.icon);
      const onClickToken = asOptionalString(record.onClick);
      return ctx.bridge.registerPopover({
        id: asString(record.id, "ui.registerPopover", "id"),
        title: asString(record.title, "ui.registerPopover", "title"),
        renderToken: requireToken(record, "render", "ui.registerPopover"),
        ...(icon ? { icon } : {}),
        ...(typeof record.width === "number" ? { width: record.width } : {}),
        ...(typeof record.markdownOnly === "boolean" ? { markdownOnly: record.markdownOnly } : {}),
        ...(typeof record.closeOnClick === "boolean" ? { closeOnClick: record.closeOnClick } : {}),
        ...(onClickToken ? { onClickToken } : {}),
      });
    },
  },
  "ui.registerDecorations": {
    permission: "ui:decorations",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerDecorations");
      const pickToken = asOptionalString(record.pick);
      return ctx.bridge.registerDecorations({
        id: asString(record.id, "ui.registerDecorations", "id"),
        title: asString(record.title, "ui.registerDecorations", "title"),
        renderToken: requireToken(record, "render", "ui.registerDecorations"),
        ...(pickToken ? { pickToken } : {}),
      });
    },
  },
  "ui.openPanel": {
    permission: "ui:open-panel",
    handler: (ctx, args) => {
      ctx.bridge.openPanel(asString(args[0], "ui.openPanel", "panelId"));
      return undefined;
    },
  },
  /**
   * 面板 → 当前沙箱视图的一条命令。
   *
   * 权限用 `files:view`：能交出视图代码的插件，才有资格跟自己那个视图说话。
   * 宿主按 `owner` 过滤，发不到别人的视图里。
   */
  "ui.sendToView": {
    permission: "files:view",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.sendToView");
      const id = asString(record.id, "ui.sendToView", "id");
      const value = asOptionalString(record.value);
      return ctx.bridge.uiSendToView(id, value);
    },
  },
  "ui.registerStyle": {
    permission: "ui:style",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "ui.registerStyle");
      return ctx.bridge.registerStyle({
        id: asString(record.id, "ui.registerStyle", "id"),
        css: asString(record.css, "ui.registerStyle", "css"),
      });
    },
  },
  // ---- files（工作文件夹里"哪些扩展名算数、每种长什么样"）
  "files.registerType": {
    permission: "files:register",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "files.registerType");
      const extensions = record.extensions;
      if (!Array.isArray(extensions) || extensions.length === 0) {
        throw invalidArgument("files.registerType", "extensions 必须是非空数组");
      }
      const renderToken = asOptionalString(record.render);
      const view = parseViewSpec(record.view);
      const newFile = parseNewFileTemplate(record.newFile);

      return ctx.bridge.registerFileType({
        id: asString(record.id, "files.registerType", "id"),
        extensions: extensions.map((value) =>
          asString(value, "files.registerType", "extensions[]"),
        ),
        label: asString(record.label, "files.registerType", "label"),
        badge: asString(record.badge, "files.registerType", "badge"),
        color: asString(record.color, "files.registerType", "color"),
        kind: asString(record.kind, "files.registerType", "kind"),
        ...(asOptionalString(record.language) ? { language: record.language as string } : {}),
        ...(asOptionalString(record.font) ? { font: record.font as string } : {}),
        ...(asCodeThemePreference(record.highlightTheme)
          ? { highlightTheme: asCodeThemePreference(record.highlightTheme) }
          : {}),
        ...(renderToken ? { renderToken } : {}),
        ...(view ? { view } : {}),
        ...(newFile ? { newFile } : {}),
      });
    },
  },
  // 往**别人的视图**里并资源。权限与 `files.registerType` 提供视图时那一道**同一个**
  // （`files:view`）：两者交出去的都是会在沙箱里真的跑起来的代码，能力同一量级。
  "files.extendView": {
    timeoutMs: TIMEOUTS.io,
    permission: "files:view",
    handler: (ctx, args) => {
      const extension = parseViewExtension(args[0]);
      if (!extension) {
        throw invalidArgument(
          "files.extendView",
          "要给出 typeId，以及 css / js / toolbar / data 之一",
        );
      }
      return ctx.bridge.registerViewExtension(extension);
    },
  },

  // ---- fonts（插件自带字体）
  //
  // 不需要权限：宿主自己读盘、自己拼 `@font-face`，插件既拿不到路径也塞不进任意 CSS,
  // 能力严格弱于 `ui:style`。
  "fonts.register": {
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) => {
      const record = args[0] === undefined ? {} : asRecord(args[0], "fonts.register");
      const dir = asOptionalString(record.dir);
      const overrides = asFontOverrides(record.overrides, "fonts.register");

      return ctx.bridge.registerFonts({
        ...(dir ? { dir } : {}),
        ...(overrides ? { overrides } : {}),
      });
    },
  },
  "ui.dispose": {
    handler: (ctx, args) => {
      ctx.bridge.disposeRegistration(asString(args[0], "ui.dispose", "id"));
      return undefined;
    },
  },

  // ---- editor
  "editor.getContent": {
    permission: "editor:read",
    handler: (ctx) => ctx.bridge.editorGetContent(),
  },
  "editor.setContent": {
    permission: "editor:write",
    handler: (ctx, args) => {
      ctx.bridge.editorSetContent(asString(args[0], "editor.setContent", "content"));
      return true;
    },
  },
  "editor.getSelection": {
    permission: "editor:read",
    handler: (ctx) => ctx.bridge.editorGetSelection(),
  },
  "editor.replaceSelection": {
    permission: "editor:write",
    handler: (ctx, args) =>
      ctx.bridge.editorReplaceSelection(asString(args[0], "editor.replaceSelection", "text")),
  },
  "editor.insertText": {
    permission: "editor:write",
    handler: (ctx, args) => {
      const text = asString(args[0], "editor.insertText", "text");
      const at = args[1] === "docEnd" ? "docEnd" : "cursor";
      return ctx.bridge.editorInsertText(text, at);
    },
  },
  "editor.wrapSelection": {
    permission: "editor:write",
    handler: (ctx, args) => {
      const before = asString(args[0], "editor.wrapSelection", "before");
      const after = asOptionalString(args[1]) ?? before;
      return ctx.bridge.editorWrapSelection(before, after);
    },
  },
  "editor.replaceRange": {
    permission: "editor:write",
    handler: (ctx, args) => {
      const start = asNumber(args[0], "editor.replaceRange", "start");
      const end = asNumber(args[1], "editor.replaceRange", "end");
      const text = asString(args[2], "editor.replaceRange", "text");
      return ctx.bridge.editorReplaceRange(start, end, text);
    },
  },
  "editor.setSelection": {
    permission: "editor:write",
    handler: (ctx, args) => {
      const start = asNumber(args[0], "editor.setSelection", "start");
      const end = typeof args[1] === "number" ? args[1] : start;
      ctx.bridge.editorSetSelection(start, end);
      return undefined;
    },
  },
  "editor.getCursor": {
    permission: "editor:read",
    handler: (ctx) => ctx.bridge.editorGetCursor(),
  },
  "editor.focus": {
    permission: "editor:write",
    handler: (ctx) => {
      ctx.bridge.editorFocus();
      return undefined;
    },
  },
  "editor.scrollTo": {
    permission: "editor:read",
    handler: (ctx, args) => {
      ctx.bridge.editorScrollTo(asNumber(args[0], "editor.scrollTo", "offset"));
      return undefined;
    },
  },
  "editor.scrollPreviewTo": {
    permission: "editor:read",
    handler: (ctx, args) => {
      ctx.bridge.editorScrollPreviewTo(asNumber(args[0], "editor.scrollPreviewTo", "offset"));
      return undefined;
    },
  },
  "editor.registerSelectionTransformer": {
    permission: "editor:read",
    handler: (ctx, args) => {
      const record = asRecord(args[0], "editor.registerSelectionTransformer");
      return ctx.bridge.registerSelectionTransformer({
        id: asString(record.id, "editor.registerSelectionTransformer", "id"),
        transformToken: requireToken(record, "transform", "editor.registerSelectionTransformer"),
      });
    },
  },

  // ---- workspace
  "workspace.listNotes": {
    permission: "workspace:read",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.workspaceListNotes(),
  },
  "workspace.getNote": {
    permission: "workspace:read",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.workspaceGetNote(asString(args[0], "workspace.getNote", "id")),
  },
  "workspace.createNote": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) => ctx.bridge.workspaceCreateNote(args[0]),
  },
  "workspace.updateNote": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.workspaceUpdateNote(asString(args[0], "workspace.updateNote", "id"), args[1]),
  },
  "workspace.deleteNote": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.workspaceDeleteNote(asString(args[0], "workspace.deleteNote", "id"));
      return undefined;
    },
  },
  "workspace.moveNoteCategory": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.workspaceMoveNoteCategory(
        asString(args[0], "workspace.moveNoteCategory", "id"),
        asString(args[1], "workspace.moveNoteCategory", "category"),
      ),
  },
  "workspace.openNote": {
    permission: "workspace:write",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.workspaceOpenNote(asString(args[0], "workspace.openNote", "id"));
      return undefined;
    },
  },
  "workspace.getActiveNote": {
    permission: "workspace:read",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.workspaceGetActiveNote(),
  },
  "categories.list": {
    permission: "categories:read",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.categoriesList(),
  },
  "categories.create": {
    permission: "categories:write",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.categoriesCreate(asString(args[0], "categories.create", "name"));
      return undefined;
    },
  },

  // ---- workspace.cache（跟着文件走的缓存）
  //
  // 与下面的 `storage.*` 是两件事：`storage` 是**每个插件一份**、存在应用数据目录里；
  // 这里存的是**与某个文件相关**的数据（批注这类），落在那个文件旁边的
  // `__floral-notepaper__/` 里，文件被拷走时数据跟着走。
  "workspace.cacheGet": {
    permission: "workspace:cache",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.cacheGet(asString(args[0], "workspace.cacheGet", "filePath")),
  },
  "workspace.cacheSet": {
    permission: "workspace:cache",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.cacheSet(
        asString(args[0], "workspace.cacheSet", "filePath"),
        args[1] ?? null,
      );
      return undefined;
    },
  },
  "workspace.cacheDelete": {
    permission: "workspace:cache",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) =>
      ctx.bridge.cacheDelete(asString(args[0], "workspace.cacheDelete", "filePath")),
  },

  // ---- storage
  "storage.get": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx, args) => ctx.bridge.storageGet(asString(args[0], "storage.get", "key")),
  },
  "storage.set": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.storageSet(asString(args[0], "storage.set", "key"), args[1] ?? null);
      return undefined;
    },
  },
  "storage.delete": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.storageDelete(asString(args[0], "storage.delete", "key"));
      return undefined;
    },
  },
  "storage.keys": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.storageKeys(),
  },
  "storage.clear": {
    permission: "storage",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx) => {
      await ctx.bridge.storageClear();
      return undefined;
    },
  },

  // ---- settings
  "settings.get": {
    permission: "settings",
    timeoutMs: TIMEOUTS.io,
    handler: (ctx) => ctx.bridge.settingsGet(),
  },

  // ---- events
  "events.subscribe": {
    permission: "events",
    handler: (ctx, args) => {
      ctx.bridge.subscribeEvent(asString(args[0], "events.subscribe", "topic"));
      return undefined;
    },
  },
  "events.unsubscribe": {
    permission: "events",
    handler: (ctx, args) => {
      ctx.bridge.unsubscribeEvent(asString(args[0], "events.unsubscribe", "topic"));
      return undefined;
    },
  },

  // ---- system
  "system.clipboard.read": {
    permission: "system:clipboard:read",
    handler: (ctx) => ctx.bridge.clipboardRead(),
  },
  "system.clipboard.write": {
    permission: "system:clipboard:write",
    handler: async (ctx, args) => {
      await ctx.bridge.clipboardWrite(asString(args[0], "system.clipboard.write", "text"));
      return undefined;
    },
  },
  "system.openExternal": {
    permission: "system:open-external",
    timeoutMs: TIMEOUTS.io,
    handler: async (ctx, args) => {
      await ctx.bridge.openExternal(asString(args[0], "system.openExternal", "url"));
      return undefined;
    },
  },
  "system.dialog.message": {
    permission: "system:dialog",
    handler: async (ctx, args) => {
      await ctx.bridge.dialogMessage(
        asString(args[0], "system.dialog.message", "message"),
        asDialogOptions(args[1]),
      );
      return undefined;
    },
  },
  "system.dialog.confirm": {
    permission: "system:dialog",
    handler: (ctx, args) =>
      ctx.bridge.dialogConfirm(
        asString(args[0], "system.dialog.confirm", "message"),
        asDialogOptions(args[1]),
      ),
  },
  "system.dialog.prompt": {
    permission: "system:dialog",
    handler: (ctx, args) =>
      ctx.bridge.dialogPrompt(
        asString(args[0], "system.dialog.prompt", "message"),
        asDialogOptions(args[1]),
      ),
  },
};

function menuContribution(args: unknown[], method: string): MenuContribution {
  const record = asRecord(args[0], method);
  return {
    id: asString(record.id, method, "id"),
    title: asString(record.title, method, "title"),
    runToken: requireToken(record, "run", method),
  };
}

/** 文档动作最多声明多少个过滤词 —— 手滑写个几千条也不该拖慢每一帧的工具栏。 */
const MAX_DOCUMENT_ACTION_FILTER = 32;
/** 一个文档动作的下拉项数上限。菜单长到要滚动就已经该拆成两个动作了。 */
const MAX_DOCUMENT_ACTION_ITEMS = 12;

/**
 * 解析插件给的文档上下文清单。
 *
 * 认不出的词**直接丢**，既不报错也不当成 `doc` 之类猜一个：写错一个词只该让那一条不
 * 显示，不该让整个插件加载失败。**全丢光了返回 `undefined`（= 不限）而不是空数组** ——
 * 空数组的意思是「哪都不显示」，那不是作者想要的，更像我们把它写坏了。
 */
function asDocumentContexts(value: unknown): DocumentContext[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = value.filter(isDocumentContext);
  return kept.length > 0 ? kept : undefined;
}

/**
 * 解析文档动作的下拉项。
 *
 * 老规矩「**认得出就收、认不出就丢**」：少一项只让那一项不显示，不会让整个按钮没掉。
 * 但**一项都不剩**时返回 `undefined` —— 那时候这个动作就退回单按钮形态（由顶层
 * `run` / `viewCommand` 决定成不成立），而不是变成一个点开是空的菜单。
 *
 * ⚠️ 这里**允许一项都不带 `title` 之外的东西吗**？不允许：`run` 与 `viewCommand` 都没有
 * 的项点下去什么都不发生，不如不出现（与文档动作本身同一条规矩）。
 */
function parseDocumentActionItems(value: unknown): DocumentActionItem[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const kept: DocumentActionItem[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_DOCUMENT_ACTION_ITEMS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const id = asOptionalString(record.id);
    const title = asOptionalString(record.title);
    if (!id || !title || seen.has(id)) continue;

    const runToken = asOptionalString(record.run);
    const viewCommand = asOptionalString(record.viewCommand);
    if (!runToken && !viewCommand) continue;

    seen.add(id);
    kept.push({
      id,
      title,
      ...(runToken ? { runToken } : {}),
      ...(viewCommand ? { viewCommand } : {}),
    });
  }

  return kept.length > 0 ? kept : undefined;
}

/** 解析插件给的字符串清单（去空、去重、限量）。不是数组就返回 `undefined`。 */
function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: string[] = [];
  for (const entry of value.slice(0, MAX_DOCUMENT_ACTION_FILTER)) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (!text || kept.includes(text)) continue;
    kept.push(text);
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * 解析插件给的主题声明。
 *
 * 非法值一律丢弃（回落到跟随应用主题），而不是报错：主题只是个观感选项，为它让
 * 整个文件类型注册失败不划算。
 */
function asCodeThemePreference(value: unknown): CodeThemePreference | undefined {
  if (typeof value === "string" && value.length > 0) return value;

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.light === "string" && typeof record.dark === "string") {
      return { light: record.light, dark: record.dark };
    }
  }

  return undefined;
}

function asDialogOptions(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

// ------------------------------------------------------------ 调度与超时

/**
 * 明确登记「不需要权限」的方法。
 *
 * 单测会断言：方法表里每个条目要么声明了 `permission`，要么在这个集合里。
 * 这样新增方法时忘记加门会直接测试失败，而不是静默放行。
 */
export const NO_PERMISSION_METHODS: ReadonlySet<string> = new Set([
  "plugin.info",
  "plugin.listAssets",
  "plugin.readAsset",
  "fonts.register",
  "ui.dispose",
]);

/**
 * 解析插件给的字体覆盖表。
 *
 * 与主题声明同样采取"非法值丢弃"而不是报错：这是给乱文件名兜底的逃生口，为一条写错的
 * 覆盖项让整个字体登记失败不划算。`overrides` 本身不是对象时才报错——那属于调用方式
 * 就错了。
 */
function asFontOverrides(
  value: unknown,
  method: string,
): Record<string, FontFaceOverride> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument(method, "overrides 必须是以文件名为键的对象");
  }

  const result: Record<string, FontFaceOverride> = {};
  for (const [file, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;

    const entry = raw as Record<string, unknown>;
    const override: FontFaceOverride = {};
    if (typeof entry.family === "string" && entry.family.trim()) {
      override.family = entry.family.trim();
    }
    if (typeof entry.weight === "number" && Number.isFinite(entry.weight)) {
      override.weight = entry.weight;
    }
    if (entry.style === "normal" || entry.style === "italic") {
      override.style = entry.style;
    }
    result[file] = override;
  }

  return result;
}

export function methodDescriptors(): MethodDescriptor[] {
  return Object.entries(METHOD_TABLE).map(([name, entry]) => ({
    name,
    ...(entry.permission ? { permission: entry.permission } : {}),
    ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
  }));
}

function methodNotFoundError(method: string): PluginApiError {
  const error = new Error(`插件 API 不存在：${method}`) as PluginApiError;
  Object.assign(error, {
    name: "PluginApiError",
    code: "methodNotFound",
    details: { method },
  });
  return error;
}

function timeoutError(method: string, ms: number): PluginApiError {
  const error = new Error(`插件调用超时：${method}（${ms}ms）`) as PluginApiError;
  Object.assign(error, {
    name: "PluginApiError",
    code: "pluginTimeout",
    details: { method, timeoutMs: String(ms) },
  });
  return error;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(method, ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 插件调用的唯一入口：查表 → 权限门 → 带超时执行。
 */
export async function dispatchPluginCall(
  ctx: PluginCallContext,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const entry = METHOD_TABLE[method];
  if (!entry) {
    throw methodNotFoundError(method);
  }

  if (entry.permission) {
    checkPermission(ctx.declared, ctx.granted, entry.permission, method, ctx.plugin.name);
  }

  const timeoutMs = entry.timeoutMs ?? TIMEOUTS.read;
  return withTimeout(Promise.resolve(entry.handler(ctx, args ?? [])), timeoutMs, method);
}

/** 供测试与文档列举：按命名空间分组的方法名。 */
export function methodsByNamespace(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const name of Object.keys(METHOD_TABLE)) {
    const [namespace] = name.split(".");
    (grouped[namespace] ??= []).push(name);
  }
  return grouped;
}

/** 类型出口，避免内部实现细节泄漏。 */
export type { Disposable };
export { PermissionError };
