/**
 * Markdown 编辑快捷键工具
 *
 * 为 textarea 提供 Ctrl+B / Ctrl+I / Ctrl+/ / Ctrl+\ 等快捷操作。
 * 设计为纯函数，不依赖组件状态，可在 MainWindow 和 NotePad 中复用。
 */

import { setNativeValue } from "../plugins/activeContent";
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
 * 快速表格：有选区时交给插件的选区转换器（如 markdown-table），否则插入 3x3 模板。
 *
 * ⚠️ 这里是全文件**唯一异步**的快捷键路径。转换器可能由沙箱插件提供，必须跨线程
 * 往返，因此无法同步拿到结果。调用方 `handleMarkdownShortcut` 已经在同步阶段完成了
 * `preventDefault()`，所以浏览器不会再把这次按键当作输入处理。
 *
 * 续体里**必须重新读取 textarea 的实时值**：从捕获偏移到回调执行之间隔了一个
 * microtask 加至少一次 RPC，期间用户可能已经继续输入，沿用旧 value/偏移会把内容写坏。
 */
function applyTableShortcut(textarea: HTMLTextAreaElement): void {
  const { selectionStart, selectionEnd } = textarea;

  if (selectionStart === selectionEnd) {
    insertTableTemplate(textarea);
    return;
  }

  // 记下发起时的选区，用它定位；但内容本身在续体里重新读取。
  const from = selectionStart;
  const to = selectionEnd;
  const selected = textarea.value.slice(from, to);

  transformSelection(selected)
    .then((transformed) => {
      if (transformed == null) {
        insertTableTemplate(textarea);
        return;
      }

      const current = textarea.value;
      const start = Math.min(from, current.length);
      const end = Math.min(Math.max(to, start), current.length);

      textarea.focus();
      setNativeValue(textarea, current.slice(0, start) + transformed + current.slice(end));
      const caret = start + transformed.length;
      textarea.setSelectionRange(caret, caret);
    })
    .catch((error) => {
      console.error("[plugins] 选区转换失败", error);
      insertTableTemplate(textarea);
    });
}

/** 插入 3x3 表格模板，并把光标停在表头首格上。 */
function insertTableTemplate(textarea: HTMLTextAreaElement): void {
  const { selectionStart, value } = textarea;

  const table = [
    "| 列1 | 列2 | 列3 |",
    "| --- | --- | --- |",
    "|     |     |     |",
    "|     |     |     |",
  ].join("\n");

  const insertion = "\n" + table + "\n";
  const newValue = value.slice(0, selectionStart) + insertion + value.slice(selectionStart);

  textarea.focus();
  setNativeValue(textarea, newValue);

  const cursorPos = selectionStart + insertion.indexOf("列1");
  textarea.setSelectionRange(cursorPos, cursorPos + 2);
}
