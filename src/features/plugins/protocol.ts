/**
 * 宿主 ↔ 插件沙箱之间的 RPC 协议。
 *
 * 设计要点：
 *
 * * **函数不能跨边界。** `postMessage` 只能传结构化克隆得了的值，插件传给
 *   `ui.registerCommand(id, title, run)` 的 `run` 是函数。做法是在插件侧把函数
 *   登记进本地表、替换成 `HANDLER_PREFIX` 开头的令牌，宿主只存令牌，需要回调时
 *   发 `invoke` 消息。宿主**永远拿不到插件函数**，插件也**永远拿不到宿主对象**。
 * * **错误形状与 Rust 的 `AppError` 对齐**：`{ code, message, details }`，其中
 *   `details` 只允许字符串值（Rust 侧是 `BTreeMap<String, String>`）。
 */

/** 插件侧回调令牌的前缀。用不可打印字符开头，避免与普通字符串参数撞车。 */
import type { FilePreviewKind } from "../workspace/fileTypes";

export const HANDLER_PREFIX = "\u0000h:";

export interface SerializedError {
  /** `AppError` 的 code，或宿主自造的：permissionDenied / pluginTimeout / … */
  code: string;
  message: string;
  /** 只允许字符串值，与 Rust 的 AppError.details 保持一致。 */
  details?: Record<string, string>;
  stack?: string;
}

/**
 * 当前打开的文件是什么。
 *
 * 插件过去只能读到正文，**无从知道这是 `.py` 还是 `.md`** —— 于是「按文件类型做
 * 不同的事」只能靠嗅探正文猜。这里把身份补上。
 *
 * 字段都投影成纯数据：镜像要跨 `postMessage`（结构化克隆），传 `FileType` 实例
 * 是过不去的。
 */
export interface EditorFileInfo {
  /** 绝对路径。笔记没有磁盘路径，为 `null`。 */
  path: string | null;
  /** 命中文件类型注册表时的 id（如 `"python"`）；没被任何插件认领时为 `null`。 */
  typeId: string | null;
  kind: FilePreviewKind | null;
  /** highlight.js 语言名，只有 `kind === "code"` 的文件才有。 */
  language: string | null;
}

/** 会被推送给插件的宿主状态镜像。 */
export interface EditorMirror {
  content: string;
  selection: { text: string; start: number; end: number } | null;
  cursor: number;
  activeNoteId: string | null;
  /** 每次内容变化自增，插件可据此判断快照是否过期。 */
  contentEpoch: number;
  /** 当前文件身份；笔记与未被认领的格式为 `null`。 */
  file: EditorFileInfo | null;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  permissions: string[];
  grantedPermissions: string[];
  locale: string;
}

/** 方法表条目：宿主侧描述一个可被插件调用的方法。 */
export interface MethodDescriptor {
  name: string;
  /** 需要的权限；不填表示该方法不触碰任何受保护能力。 */
  permission?: string;
  /** 超时上限，默认取 `TIMEOUTS.read`。 */
  timeoutMs?: number;
}

export type HostToWorker =
  | {
      t: "init";
      plugin: PluginInfo;
      /** 插件入口脚本源码。宿主读盘后下发，沙箱里用 `new Function` 执行。 */
      code: string;
      methods: MethodDescriptor[];
      mirror: EditorMirror;
      settings: Record<string, unknown>;
    }
  | { t: "reply"; id: number; ok: true; value: unknown }
  | { t: "reply"; id: number; ok: false; error: SerializedError }
  /** 推送状态/事件。`topic` 形如 "editor.mirror"、"settings.changed"。 */
  | { t: "event"; topic: string; payload: unknown }
  /** 宿主回调插件注册的函数。 */
  | { t: "invoke"; id: number; handler: string; args: unknown[] }
  | { t: "dispose"; reason: UnloadReason };

export type WorkerToHost =
  | { t: "ready" }
  | { t: "call"; id: number; method: string; args: unknown[] }
  | { t: "invokeReply"; id: number; ok: true; value: unknown }
  | { t: "invokeReply"; id: number; ok: false; error: SerializedError }
  | { t: "log"; level: PluginLogLevel; message: string; stack?: string }
  | { t: "loaded" }
  | { t: "loadFailed"; error: SerializedError }
  | { t: "disposed" };

export type UnloadReason = "unload" | "reload" | "disable" | "timeout" | "crash";

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

/** 各类调用的超时上限（毫秒）。 */
export const TIMEOUTS = {
  /** 读取型调用。 */
  read: 5_000,
  /** 涉及磁盘/网络的调用，放宽。 */
  io: 15_000,
  /** 插件自身回调（render、命令 run、转换器）。 */
  callback: 10_000,
  /** `onLoad` / `onUnload`。 */
  lifecycle: 5_000,
} as const;

export function serializeError(error: unknown, fallbackCode = "pluginError"): SerializedError {
  if (error && typeof error === "object" && "code" in error) {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      stack?: unknown;
    };
    const details: Record<string, string> = {};
    if (candidate.details && typeof candidate.details === "object") {
      for (const [key, value] of Object.entries(candidate.details)) {
        if (typeof value === "string") details[key] = value;
      }
    }
    return {
      code: typeof candidate.code === "string" ? candidate.code : fallbackCode,
      message: typeof candidate.message === "string" ? candidate.message : String(error),
      ...(Object.keys(details).length > 0 ? { details } : {}),
      ...(typeof candidate.stack === "string" ? { stack: candidate.stack } : {}),
    };
  }

  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}

/** 插件侧可见的错误类型，让作者可以按 code 分支处理。 */
export class PluginApiError extends Error {
  readonly code: string;
  readonly details: Record<string, string>;

  constructor(code: string, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = "PluginApiError";
    this.code = code;
    this.details = details;
  }
}

export function deserializeError(error: SerializedError | undefined): PluginApiError {
  if (!error) {
    return new PluginApiError("pluginError", "插件调用失败");
  }
  return new PluginApiError(error.code, error.message, error.details ?? {});
}
