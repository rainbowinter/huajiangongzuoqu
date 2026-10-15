import type { Note, NoteMetadata } from "../notes/types";

export interface Selection {
  text: string;
  start: number;
  end: number;
}

/**
 * 插件清单。
 *
 * 后 9 个字段由 Rust 侧 `plugins::manifest::PluginManifest` 提供，是原四字段的
 * 超集。`apiVersion` 决定走哪条运行路径：1 = 主线程 `new Function`（旧行为），
 * 2 = 沙箱 Worker + 权限门。
 */
export interface PluginManifest {
  name: string;
  version: string;
  main: string;
  description: string;
  apiVersion: number;
  author?: string;
  homepage?: string;
  /** 清单声明的权限。 */
  permissions: string[];
  /** 实际生效的权限（已声明 ∩ 已授予）。 */
  grantedPermissions: string[];
  /** 清单里的 `contributes`，由前端解析。 */
  contributes?: unknown;
  /** 用户是否启用了这个插件。 */
  enabled: boolean;
  /**
   * 市场里有新版本时自动更新。默认关 —— 这会在用户看不见的时候换掉代码，
   * 那份信任得由用户自己给。
   *
   * ⚠️ 带**新权限**的版本不会被自动装上（见 `market/presentation.ts` 的 `planAutoUpdates`）。
   */
  autoUpdate: boolean;
  /** 清单是否可加载。`false` 时看 `invalidReason`。 */
  valid: boolean;
  invalidReason?: string;
  /** 不致命但值得提示的问题。 */
  warnings: string[];
  /** 插件目录绝对路径。 */
  dirPath: string;
  /**
   * 打哪来的：`bundled` = 随应用分发或用户自己放的，`market` = 从插件市场装的。
   *
   * 插件市场靠它决定「这个能不能从市场更新/卸载」。内置版本校正（Rust 侧）也按它
   * 避开市场插件。
   */
  origin?: "bundled" | "market";
  /**
   * 图标，**已经是 data URL**（Rust 侧按 `plugin.json` 的 `icon` 读出来做的）。
   *
   * 没有这个字段就用宿主的默认图标 —— 插件不提供图标是完全正常的。
   * ⚠️ 别指望它是路径：data URL 是为了绕开 asset 协议的范围放行时机，也为了和市场那边
   * （清单里内联的图标）同一个形状。
   */
  icon?: string;
}

/**
 * 启动时那次「插件版本校正」的结果。
 *
 * 校正跑在 Rust 侧的应用启动流程里（把随包分发的插件同步到数据目录里已装的副本上），
 * 前端起来后取一次。`null` 表示这次启动什么都没更新 —— 此时一个字都不该弹。
 */
export interface PluginSyncReport {
  /** 被覆盖过文件的插件。 */
  updated: string[];
  /** 因为本地有改动而被跳过的插件。 */
  skipped: string[];
  /** 本地改动无法判断、把原件备份走了的插件。 */
  backedUp: string[];
  /** 插件状态文件本身在这次启动里被升级过。 */
  migrated: boolean;
}

/** 插件在宿主里的运行状态。 */
export type PluginStatus =
  /** 已加载并在运行。 */
  | "loaded"
  /** 用户在界面上关掉了它。 */
  | "disabled"
  /** 清单损坏或 apiVersion 不受支持。 */
  | "invalid"
  /** 加载过程中抛错。 */
  | "failed"
  /** 因频繁超时/崩溃被宿主暂停。 */
  | "suspended"
  /** v1 插件，跑在主线程，没有沙箱隔离。 */
  | "legacy";

export interface PluginRuntimeRecord {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  /** v1 插件没有沙箱，界面上需要明确标注。 */
  sandboxed: boolean;
}

export interface PluginCommand {
  id: string;
  title: string;
  plugin: string;
  run: () => void | Promise<void>;
  /** 可选的键位绑定，形如 "Ctrl+Shift+W"。 */
  keybinding?: string;
}

export interface PluginPanelDef {
  id: string;
  title: string;
  width?: number;
  plugin?: string;
  standalone?: boolean;
  /**
   * 面板 HTML 的渲染方式。
   *
   * * `false`（v1 默认）——`render()` 在渲染期同步返回 HTML，行为与升级前一致。
   * * `true`（v2）——`render()` 恒返回空串，真正的 HTML 由宿主异步拉取后写入
   *   `stores.ts` 的缓存，界面从缓存读取并**经消毒后**注入。
   */
  sandboxed?: boolean;
  render: () => string;
  onClick?: (target: HTMLElement) => void;
}

/**
 * v1 插件 API —— **冻结**。
 *
 * 已装的 markdown-table / word-count / outline 三个插件就是按这个形状写的，
 * 不要改动这里的任何签名；新能力一律走 v2 命名空间化 API。
 */
export interface PluginApi {
  addCommand(command: { title: string; run: () => void | Promise<void> }): void;
  getActiveNoteContent(): string | null;
  setActiveNoteContent(content: string): boolean;
  getActiveNoteSelection(): Selection | null;
  replaceActiveNoteSelection(replacement: string): boolean;
  registerSelectionTransformer(transformer: (text: string) => string | null): void;
  registerStatusBarItem(render: (selection: Selection | null) => string | null): void;
  registerPanel(def: PluginPanelDef): void;
  scrollEditorTo(offset: number): void;
  scrollPreviewTo(offset: number): void;
  showToast(message: string, type?: "error" | "warning" | "info"): void;
  listNotes(): Promise<NoteMetadata[]>;
  getNote(id: string): Promise<Note>;
}

export interface PluginDefinition {
  name: string;
  onLoad(api: PluginApi): void | Promise<void>;
  /** v1 也可选地提供卸载钩子；不提供则只做宿主的注册项清理。 */
  onUnload?(): void | Promise<void>;
}
