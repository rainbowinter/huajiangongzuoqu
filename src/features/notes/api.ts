import { t, type TFunction } from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { describeNetworkFailure } from "../errors/network";
import type { Note, NoteMetadata, SaveNoteRequest } from "./types";

interface SerializedAppError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

type ErrorDetails = Record<string, string>;

const LOCALIZED_ERROR_CODES = new Set([
  "categoryAlreadyExists",
  "categoryNameEmpty",
  "categoryNameInvalidChars",
  "categoryNotFound",
  "desktopConfig",
  "duplicateShortcut",
  "noPool",
  "noteNotFound",
  "unsupportedFile",
  "unsupportedShortcut",
]);

export function listNotes(): Promise<NoteMetadata[]> {
  return invoke("notes_list");
}

export function getNote(id: string): Promise<Note> {
  return invoke("notes_get", { id });
}

export function createNote(request: SaveNoteRequest): Promise<Note> {
  return invoke("notes_create", { request });
}

export function updateNote(id: string, request: SaveNoteRequest): Promise<Note> {
  return invoke("notes_update", { id, request });
}

export function deleteNote(id: string): Promise<void> {
  return invoke("notes_delete", { id });
}

export function moveNoteCategory(id: string, category: string): Promise<NoteMetadata> {
  return invoke("notes_move_category", { id, category });
}

export function listCategories(): Promise<string[]> {
  return invoke("categories_list");
}

export function createCategory(name: string): Promise<void> {
  return invoke("categories_create", { name });
}

export function renameCategory(oldName: string, newName: string): Promise<void> {
  return invoke("categories_rename", { oldName, newName });
}

export function deleteCategory(name: string): Promise<void> {
  return invoke("categories_delete", { name });
}

export function readExternalFile(path: string): Promise<string> {
  return invoke("read_external_file", { path });
}

/** 读外部文件的原始字节。见 `readWorkspaceFileBytes` 的说明。 */
export function readExternalFileBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_external_file_bytes", { path });
}

export function saveExternalFile(path: string, content: string): Promise<void> {
  return invoke("save_external_file", { path, content });
}

/**
 * 把**字节**写到用户选好的路径（插件视图的「另存为」）。
 *
 * ⚠️ 路径走**请求头**：body 已经被字节占满了，而 Tauri 的 raw payload 只能整份当 body。
 * 头里只能装 ASCII，所以先 `encodeURIComponent`，Rust 那边再解回来（中文路径要靠这一步）。
 * 这是 Tauri 自己也在用的路子（见它 `ipc/channel.rs` 里传 channel id 那几处）。
 *
 * 不走 JSON 数组：一份 10MB 的 PDF 那样会变成几十 MB 的文本，慢得肉眼可见。
 */
export function saveExternalFileBytes(path: string, bytes: ArrayBuffer): Promise<void> {
  return invoke("save_external_file_bytes", bytes, {
    headers: { "x-floral-path": encodeURIComponent(path) },
  });
}

export function getFileModifiedTime(path: string): Promise<number> {
  return invoke("get_file_modified_time", { path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeErrorDetails(value: unknown): ErrorDetails {
  if (!isRecord(value)) {
    return {};
  }

  const details: ErrorDetails = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      details[key] = entry;
    }
  }

  return details;
}

function parseAppError(error: unknown): {
  code?: string;
  message?: string;
  details: ErrorDetails;
} | null {
  if (!isRecord(error)) {
    return null;
  }

  return {
    code: typeof error.code === "string" ? error.code : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
    details: normalizeErrorDetails(error.details),
  };
}

function shortcutFieldLabel(field: string | undefined, translate: TFunction): string | null {
  if (field === "globalShortcut") {
    return translate("settings.quickNoteShortcut", { defaultValue: "呼出小窗快捷键" });
  }

  if (field === "toggleVisibilityShortcut") {
    return translate("settings.visibilityShortcut", { defaultValue: "显示/隐藏窗口快捷键" });
  }

  return null;
}

function getLocalizedAppErrorMessage(
  appError: ReturnType<typeof parseAppError>,
  translate: TFunction,
): string | null {
  if (!appError?.code) {
    return null;
  }

  switch (appError.code) {
    case "unsupportedFile":
      return translate("errors.unsupportedFile", { defaultValue: "只支持导入 .md 文件" });
    case "categoryNameEmpty":
      return translate("errors.categoryNameEmpty", { defaultValue: "分类名不能为空" });
    case "categoryNameInvalidChars":
      return translate("errors.categoryNameInvalidChars", {
        defaultValue: "分类名不能包含特殊字符",
      });
    case "categoryNotFound":
      if (!appError.details.category) {
        return appError.message ?? null;
      }
      return translate("errors.categoryNotFound", {
        category: appError.details.category,
        defaultValue: "分类「{{category}}」不存在",
      });
    case "categoryAlreadyExists":
      if (!appError.details.category) {
        return appError.message ?? null;
      }
      return translate("errors.categoryAlreadyExists", {
        category: appError.details.category,
        defaultValue: "分类「{{category}}」已存在",
      });
    case "noteNotFound":
      return translate("errors.noteNotFound", { defaultValue: "找不到该笔记" });
    case "duplicateShortcut":
      return translate("errors.duplicateShortcut", {
        defaultValue: "显示/隐藏窗口快捷键不能与呼出小窗快捷键重复",
      });
    case "unsupportedShortcut": {
      const fieldLabel = shortcutFieldLabel(appError.details.field, translate);
      if (!fieldLabel) {
        return translate("errors.unsupportedShortcutGeneric", {
          defaultValue: "快捷键配置无效",
        });
      }
      return translate("errors.unsupportedShortcut", {
        field: fieldLabel,
        defaultValue: "{{field}} 配置无效",
      });
    }
    case "desktopConfig":
      return translate("errors.desktopConfig", { defaultValue: "桌面配置更新失败" });
    case "noPool":
      return translate("errors.noPool", { defaultValue: "便签窗口池尚未初始化" });
    default:
      return null;
  }
}

function parseSerializedAppErrorDetails(code: string, rawMessage: string): ErrorDetails {
  switch (code) {
    case "categoryNotFound":
    case "categoryAlreadyExists": {
      const categoryMatch = /^分类「(.+)」(?:不存在|已存在)$/.exec(rawMessage);
      return categoryMatch ? { category: categoryMatch[1] } : {};
    }
    default:
      return {};
  }
}

function parseSerializedAppError(message: string, translate: TFunction): string | null {
  const match = /^([A-Za-z][A-Za-z0-9]*):\s+(.+)$/.exec(message);
  if (!match) {
    return null;
  }

  const [, code, rawMessage] = match;
  if (!LOCALIZED_ERROR_CODES.has(code)) {
    return null;
  }

  return getLocalizedAppErrorMessage(
    { code, message: rawMessage, details: parseSerializedAppErrorDetails(code, rawMessage) },
    translate,
  );
}

export function getErrorMessage(error: unknown, translate: TFunction = t): string {
  // 网络类的失败在这里统一补一句结论（超时 / 连不上），见 `describeNetworkFailure`。
  // 放在这一个出口上，更新器与市场两边都会受益，不必逐个调用点去补。
  return describeNetworkFailure(rawErrorMessage(error, translate));
}

function rawErrorMessage(error: unknown, translate: TFunction): string {
  if (typeof error === "string") {
    return parseSerializedAppError(error, translate) ?? error;
  }

  const appError = parseAppError(error);
  const localizedMessage = getLocalizedAppErrorMessage(appError, translate);
  if (localizedMessage) {
    return localizedMessage;
  }

  if (appError?.message) {
    return appError.message;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String((error as SerializedAppError).message);
  }

  return translate("common.operationFailed", { defaultValue: "操作失败" });
}
