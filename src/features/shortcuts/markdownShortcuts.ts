/**
 * Markdown 编辑快捷键工具
 *
 * 为 textarea 提供 Ctrl+B / Ctrl+I / Ctrl+/ / Ctrl+\ 等快捷操作。
 * 设计为纯函数，不依赖组件状态，可在 MainWindow 和 NotePad 中复用。
 */

import { transformSelection } from "../plugins/registry";

export interface ShortcutAction {
  /** 插入到光标前的文本（替换选中内容时用 prefix + selected + suffix） */
  prefix: string;
  /** 插入到光标后的文本 */
  suffix: string;
  /** 未选中文本时的默认占位内容 */
  placeholder: string;
}

const SHORTCUT_MAP: Record<string, ShortcutAction> = {
  b: {
    prefix: "**",
    suffix: "**",
    placeholder: "粗体文本",
  },
  i: {
    prefix: "*",
    suffix: "*",
    placeholder: "斜体文本",
  },
};

/**
 * 处理 textarea 内的 Markdown 快捷键。
 * 在 textarea 的 onKeyDown 中调用，返回 true 表示已处理该事件。
 */
export function handleMarkdownShortcut(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
): boolean {
  const { ctrlKey, metaKey, key, shiftKey } = event;

  // 只处理 Ctrl/Cmd + 字母 或 Ctrl/Cmd + Shift + 字母
  if (!ctrlKey && !metaKey) return false;

  const normalizedKey = key.toLowerCase();

  // Ctrl+B / Ctrl+I — 粗体 / 斜体（包裹选中文本）
  if (normalizedKey === "b" || normalizedKey === "i") {
    event.preventDefault();
    const action = SHORTCUT_MAP[normalizedKey];
    applyWrapShortcut(event.target as HTMLTextAreaElement, action);
    return true;
  }

  // Ctrl+/ — 快速标题（在当前行前插入 # ）
  if (key === "/" && !shiftKey) {
    event.preventDefault();
    applyHeadingShortcut(event.target as HTMLTextAreaElement);
    return true;
  }

  // Ctrl+Shift+/ — 多级标题（增加 # 层级）
  if (key === "/" && shiftKey) {
    event.preventDefault();
    applyHeadingIncreaseShortcut(event.target as HTMLTextAreaElement);
    return true;
  }

  // Ctrl+\ — 快速表格
  if (key === "\\") {
    event.preventDefault();
    applyTableShortcut(event.target as HTMLTextAreaElement);
    return true;
  }

  // Ctrl+` — 行内代码
  if (key === "`") {
    event.preventDefault();
    applyWrapShortcut(event.target as HTMLTextAreaElement, {
      prefix: "`",
      suffix: "`",
      placeholder: "代码",
    });
    return true;
  }

  // Ctrl+Shift+K — 删除线
  if (normalizedKey === "k" && shiftKey) {
    event.preventDefault();
    applyWrapShortcut(event.target as HTMLTextAreaElement, {
      prefix: "~~",
      suffix: "~~",
      placeholder: "删除文本",
    });
    return true;
  }

  return false;
}

/**
 * 包裹选中文本（如 **粗体**、*斜体* 等）
 * 使用原生 value setter 方式，兼容 React 受控组件且不会引入额外字符
 */
function applyWrapShortcut(
  textarea: HTMLTextAreaElement,
  action: ShortcutAction,
): void {
  const { selectionStart, selectionEnd, value } = textarea;
  const hasSelection = selectionStart !== selectionEnd;

  textarea.focus();

  if (hasSelection) {
    const selected = value.slice(selectionStart, selectionEnd);
    const newText =
      value.slice(0, selectionStart) +
      action.prefix +
      selected +
      action.suffix +
      value.slice(selectionEnd);

    setNativeValue(textarea, newText);

    const newStart = selectionStart + action.prefix.length;
    const newEnd = newStart + selected.length;
    textarea.setSelectionRange(newStart, newEnd);
  } else {
    const insertion = action.prefix + action.placeholder + action.suffix;
    const newText =
      value.slice(0, selectionStart) +
      insertion +
      value.slice(selectionEnd);

    setNativeValue(textarea, newText);

    const newStart = selectionStart + action.prefix.length;
    const newEnd = newStart + action.placeholder.length;
    textarea.setSelectionRange(newStart, newEnd);
  }
}

/**
 * 用原生方式设置 textarea 值并触发 React onChange，
 * 避免 execCommand 引入的额外字符问题
 */
function setNativeValue(textarea: HTMLTextAreaElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 快速标题：在当前行前插入 "# " 或增加一级 #
 */
function applyHeadingShortcut(textarea: HTMLTextAreaElement): void {
  const { selectionStart, value } = textarea;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;

  const lineEnd = value.indexOf("\n", selectionStart);
  const currentLine = value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const match = currentLine.match(/^(#{1,6})\s/);

  textarea.focus();

  if (match) {
    const newLevel = Math.min(match[1].length + 1, 6);
    const newLine = "#".repeat(newLevel) + " " + currentLine.slice(match[0].length);
    const newValue =
      value.slice(0, lineStart) + newLine +
      (lineEnd === -1 ? "" : value.slice(lineEnd));

    setNativeValue(textarea, newValue);

    const cursorOffset = lineStart + newLevel + 1 + (selectionStart - lineStart - match[0].length);
    textarea.setSelectionRange(cursorOffset, cursorOffset);
  } else {
    const newValue =
      value.slice(0, lineStart) + "# " +
      value.slice(lineStart);

    setNativeValue(textarea, newValue);

    const cursorPos = lineStart + 2 + (selectionStart - lineStart);
    textarea.setSelectionRange(cursorPos, cursorPos);
  }
}

/**
 * Ctrl+Shift+/ — 增加一级标题 #
 */
function applyHeadingIncreaseShortcut(textarea: HTMLTextAreaElement): void {
  const { selectionStart, value } = textarea;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;

  const lineEnd = value.indexOf("\n", selectionStart);
  const currentLine = value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const match = currentLine.match(/^(#{1,6})\s/);

  const newLevel = match ? Math.min(match[1].length + 1, 6) : 1;
  const prefix = "#".repeat(newLevel) + " ";
  const lineContent = match ? currentLine.slice(match[0].length) : currentLine.replace(/^#*\s*/, "");

  const newValue =
    value.slice(0, lineStart) + prefix + lineContent +
    (lineEnd === -1 ? "" : value.slice(lineEnd));

  textarea.focus();
  setNativeValue(textarea, newValue);

  const cursorOffset = lineStart + prefix.length + (selectionStart - lineStart - (match ? match[0].length : 0));
  const safePos = Math.max(lineStart + prefix.length, cursorOffset);
  textarea.setSelectionRange(safePos, safePos);
}

/**
 * 快速表格：插入 3x3 Markdown 表格模板
 */
function applyTableShortcut(textarea: HTMLTextAreaElement): void {
  const { selectionStart, selectionEnd, value } = textarea;

  // 有选区时：把选中的文本转成 Markdown 表格
  if (selectionStart !== selectionEnd) {
    const selected = value.slice(selectionStart, selectionEnd);
    const transformed = transformSelection(selected);
    if (transformed != null) {
      textarea.focus();
      const newValue =
        value.slice(0, selectionStart) + transformed + value.slice(selectionEnd);
      setNativeValue(textarea, newValue);
      const newEnd = selectionStart + transformed.length;
      textarea.setSelectionRange(newEnd, newEnd);
      return;
    }
  }

  // 无选区或无法转换：插入 3x3 表格模板
  const table = [
    "| 列1 | 列2 | 列3 |",
    "| --- | --- | --- |",
    "|     |     |     |",
    "|     |     |     |",
  ].join("\n");

  const insertion = "\n" + table + "\n";
  const newValue =
    value.slice(0, selectionStart) + insertion + value.slice(selectionStart);

  textarea.focus();
  setNativeValue(textarea, newValue);

  const cursorPos = selectionStart + insertion.indexOf("列1");
  textarea.setSelectionRange(cursorPos, cursorPos + 2);
}
