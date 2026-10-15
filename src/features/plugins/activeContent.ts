/**
 * 当前窗口活动编辑器的访问桥。
 *
 * 两个变化相对原实现：
 *
 * 1. **从 4 个方法扩到完整的读写 API**（插入、包裹、按范围替换、设置选区、聚焦、取光标）。
 *    原来只有「整篇替换」与「替换选区」两个粗粒度操作，插件想插一段文本都做不到。
 * 2. **实现被抽成 `createEditorAccessor`**。原先 `MainWindow.tsx` 与 `NotePad.tsx`
 *    各自逐字重复了一份实现，扩展写入 API 时两处必然漂移。
 *
 * 写入统一走 `setNativeValue`（原生 value setter + 派发 input 事件），这是项目里
 * 既有的手法：React 受控 textarea 在直接改 DOM 后需要一次原生 input 事件才会把状态
 * 同步过来，否则光标位置会跳。改完立刻 `setSelectionRange`，因为在同一个 tick 内
 * DOM 值已经是新的了。
 */

import type { Selection } from "./types";

export interface EditorCursor {
  /** 0 起始的行号。 */
  line: number;
  /** 0 起始的列号。 */
  column: number;
  /** 绝对偏移，与 `Selection.start/end` 同一坐标系。 */
  offset: number;
}

export interface ActiveContentAccessor {
  getContent(): string;
  setContent(content: string): void;
  getSelection(): Selection | null;
  replaceSelection(replacement: string): boolean;
  /** 在光标处或文末插入文本。 */
  insertText(text: string, at?: "cursor" | "docEnd"): boolean;
  /** 用 before/after 包裹选区；无选区时插入占位。 */
  wrapSelection(before: string, after: string): boolean;
  replaceRange(start: number, end: number, text: string): boolean;
  setSelection(start: number, end: number): void;
  focus(): void;
  getCursor(): EditorCursor | null;
}

/**
 * 用原生 setter 写入 textarea 并派发 input，让 React 受控组件感知到变化。
 *
 * 直接赋值 `textarea.value` 不会触发 React 的 onChange；而 React 又会在下一次渲染时
 * 用 state 覆盖回旧值，表现为"插件改了内容但立刻被还原"。
 */
export function setNativeValue(textarea: HTMLTextAreaElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 走浏览器**原生撤销栈**的区间替换。返回 `false` 表示当前环境不支持。
 *
 * 为什么不能直接改 `value`：`setNativeValue` 用的是原型上的 value setter，只会把值
 * 换掉再补发一个合成 `input` 事件，让 React 受控组件同步过来——但它**不会向撤销栈
 * 压入一条可撤销的编辑**。于是所有经它写入的内容（内置 Markdown 快捷键、插件调用的
 * `editor.*`）都撤不掉；工具栏的格式化按钮因为走 `execCommand("insertText")`，一直
 * 都是可以撤销的。
 *
 * `execCommand` 只能作用于**当前选区**，所以必须先 `setSelectionRange` 把选区设成
 * 目标区间——要替换整篇就设 `(0, value.length)`。
 *
 * 副作用是会 `focus()` 编辑器：`execCommand` 作用于焦点元素，不聚焦就不生效。工具栏
 * 格式化早就这么做，插件写入落到当前编辑器上也是合理语义。
 */
export function replaceRangeUndoable(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
): boolean {
  try {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    return document.execCommand("insertText", false, text);
  } catch (error) {
    console.error("[editor] execCommand 写入失败，回退到直接赋值", error);
    return false;
  }
}

export function cursorFromOffset(value: string, offset: number): EditorCursor {
  const clamped = Math.max(0, Math.min(offset, value.length));
  const before = value.slice(0, clamped);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length - 1,
    column: clamped - (lastNewline + 1),
    offset: clamped,
  };
}

export interface EditorAccessorOptions {
  /** 取当前编辑器的 textarea；预览模式或小窗未就绪时返回 null。 */
  getTextArea: () => HTMLTextAreaElement | null;
  getContent: () => string;
  setContent: (content: string) => void;
  /** 内容被改写后通知宿主标脏（进入待保存状态）。 */
  markDirty: () => void;
}

export function createEditorAccessor(options: EditorAccessorOptions): ActiveContentAccessor {
  const { getTextArea, getContent, setContent, markDirty } = options;

  /** 统一的写入路径：优先改 textarea（能顺带控制光标），退化时改 React state。 */
  const write = (next: string, caret: { start: number; end?: number } | null): void => {
    const textarea = getTextArea();
    markDirty();

    if (textarea && document.contains(textarea)) {
      if (textarea.value !== next) {
        // 优先走可撤销路径；环境不支持时再退回直接赋值（撤销失效，但内容不丢）。
        if (!replaceRangeUndoable(textarea, 0, textarea.value.length, next)) {
          setNativeValue(textarea, next);
        }
      }
      if (caret) {
        const start = Math.max(0, Math.min(caret.start, next.length));
        const end = Math.max(start, Math.min(caret.end ?? start, next.length));
        textarea.setSelectionRange(start, end);
      }
      return;
    }

    setContent(next);
  };

  return {
    getContent,

    setContent(next) {
      write(next, null);
    },

    getSelection() {
      const textarea = getTextArea();
      if (!textarea) return null;
      const { selectionStart: start, selectionEnd: end } = textarea;
      return { text: textarea.value.slice(start, end), start, end };
    },

    replaceSelection(replacement) {
      const textarea = getTextArea();
      const value = textarea ? textarea.value : getContent();
      const start = textarea ? textarea.selectionStart : value.length;
      const end = textarea ? textarea.selectionEnd : value.length;

      write(value.slice(0, start) + replacement + value.slice(end), {
        start: start + replacement.length,
      });
      return true;
    },

    insertText(text, at = "cursor") {
      const textarea = getTextArea();
      const value = textarea ? textarea.value : getContent();
      const start = at === "docEnd" ? value.length : (textarea?.selectionStart ?? value.length);
      const end = at === "docEnd" ? value.length : (textarea?.selectionEnd ?? value.length);

      write(value.slice(0, start) + text + value.slice(end), {
        start: start + text.length,
      });
      return true;
    },

    wrapSelection(before, after) {
      const textarea = getTextArea();
      const value = textarea ? textarea.value : getContent();
      const start = textarea ? textarea.selectionStart : value.length;
      const end = textarea ? textarea.selectionEnd : value.length;
      const selected = value.slice(start, end);

      write(
        value.slice(0, start) + before + selected + after + value.slice(end),
        selected.length > 0
          ? { start: start + before.length, end: start + before.length + selected.length }
          : { start: start + before.length },
      );
      return true;
    },

    replaceRange(start, end, text) {
      const textarea = getTextArea();
      const value = textarea ? textarea.value : getContent();
      const from = Math.max(0, Math.min(start, value.length));
      const to = Math.max(from, Math.min(end, value.length));

      write(value.slice(0, from) + text + value.slice(to), { start: from + text.length });
      return true;
    },

    setSelection(start, end) {
      const textarea = getTextArea();
      if (!textarea) return;
      const length = textarea.value.length;
      const from = Math.max(0, Math.min(start, length));
      const to = Math.max(from, Math.min(end, length));
      textarea.setSelectionRange(from, to);
    },

    focus() {
      getTextArea()?.focus();
    },

    getCursor() {
      const textarea = getTextArea();
      if (!textarea) return null;
      return cursorFromOffset(textarea.value, textarea.selectionStart);
    },
  };
}

// --------------------------------------------------------------- 访问器注册

let accessor: ActiveContentAccessor | null = null;

export function registerActiveContent(next: ActiveContentAccessor | null): void {
  accessor = next;
}

export function getActiveContent(): string | null {
  return accessor?.getContent() ?? null;
}

export function setActiveContent(content: string): boolean {
  if (!accessor) return false;
  accessor.setContent(content);
  return true;
}

export function getActiveSelection(): Selection | null {
  return accessor?.getSelection() ?? null;
}

export function replaceActiveSelection(replacement: string): boolean {
  if (!accessor) return false;
  return accessor.replaceSelection(replacement);
}

/** v2 API 用的原始访问器（v1 的扁平 API 不适合暴露这些）。 */
export function getActiveContentAccessor(): ActiveContentAccessor | null {
  return accessor;
}
