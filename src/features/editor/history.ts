/**
 * 按文件分开的撤销历史。
 *
 * **为什么不能直接用浏览器自带的撤销。** 编辑器从头到尾是**同一个** `<textarea>`，
 * 打开另一份内容只是把它的 `value` 换掉，而原生的撤销栈挂在**元素**上、不跟着文档走。
 * 于是：在 A 里打几个字 → 切到 B → 按 Ctrl+Z，撤掉的是 A 的那几个字，可屏幕上现在是
 * B —— 看起来就是 B 被莫名改掉了一块。反过来在 B 里编辑之后切回 A，A 的历史也已经被
 * B 冲掉了。所以这里自己按文件存快照，并把 Ctrl+Z 从浏览器手里接管过来。
 *
 * 几条取舍：
 *
 * - **快照而不是 diff。** 一步存一份完整正文，实现简单且永远不会因为拼接错位而崩。
 *   代价是内存，用两个上限兜住：每份内容最多 `maxSteps` 步，同时最多跟踪
 *   `maxDocuments` 份（超了按最久未动淘汰）。
 * - **连续输入并成一步。** 否则打二十个字就要按二十次撤销。
 * - **本次运行内一直保留**，切走再切回来还能接着撤；关掉应用就没了。
 */

export interface EditorHistory {
  /**
   * 记一次内容变化。
   *
   * `previous` 只在**这份内容还没登记过**时用得上（拿它当基线），所以调用方不必关心
   * 「文件是什么时候打开的」—— 第一次编辑自然会建立起点。
   */
  record(key: string, previous: string, next: string, coalesce?: boolean): void;
  /** 返回要显示的内容；没有可撤的就返回 `null`。 */
  undo(key: string): string | null;
  redo(key: string): string | null;
  canUndo(key: string): boolean;
  canRedo(key: string): boolean;
  /** 丢掉某份内容的全部历史（文件被删除、或内容被整体替换时）。 */
  forget(key: string): void;
  /** 仅供测试。 */
  reset(): void;
}

interface Stack {
  /** `states[index]` 是当前内容，左边是可撤销的历史，右边是可重做的。 */
  states: string[];
  index: number;
  /** 当前这一步是何时开始的 —— 用来判断后续输入要不要并进这一步。 */
  stepStartedAt: number;
}

export interface EditorHistoryOptions {
  maxSteps?: number;
  maxDocuments?: number;
  coalesceMs?: number;
  now?: () => number;
}

export function createEditorHistory(options: EditorHistoryOptions = {}): EditorHistory {
  const maxSteps = options.maxSteps ?? 100;
  const maxDocuments = options.maxDocuments ?? 24;
  const coalesceMs = options.coalesceMs ?? 700;
  const now = options.now ?? (() => Date.now());

  const stacks = new Map<string, Stack>();

  /** 用到谁就把它挪到队尾，队首即最久未动的那个。 */
  function touch(key: string, stack: Stack): void {
    stacks.delete(key);
    stacks.set(key, stack);
  }

  function evict(): void {
    while (stacks.size > maxDocuments) {
      const oldest = stacks.keys().next();
      if (oldest.done) return;
      stacks.delete(oldest.value);
    }
  }

  return {
    record(key, previous, next, coalesce = false) {
      if (previous === next) return;

      let stack = stacks.get(key);
      if (!stack) {
        // 这份内容还没登记过：把调用方给的「之前」当基线，于是这一步就是可撤的。
        stack = { states: [previous], index: 0, stepStartedAt: 0 };
        stacks.set(key, stack);
      }

      // 内容与我们记的当前状态一致（受控组件回填、或重复通知），无事可做。
      if (stack.states[stack.index] === next) {
        touch(key, stack);
        return;
      }

      // 新的一次编辑会砍掉原来的「重做」分支 —— 和所有编辑器的行为一致。
      stack.states.length = stack.index + 1;

      const at = now();
      if (coalesce && stack.index > 0 && at - stack.stepStartedAt < coalesceMs) {
        // 并入当前这一步：改的是「这一步的内容」，可撤销的目标仍是上一步。
        stack.states[stack.index] = next;
      } else {
        stack.states.push(next);
        stack.index += 1;
        stack.stepStartedAt = at;

        // 超出上限就从最老的一端丢，并同步把下标左移。
        while (stack.states.length > maxSteps + 1) {
          stack.states.shift();
          stack.index -= 1;
        }
      }

      touch(key, stack);
      evict();
    },

    undo(key) {
      const stack = stacks.get(key);
      if (!stack || stack.index === 0) return null;
      stack.index -= 1;
      touch(key, stack);
      return stack.states[stack.index] ?? null;
    },

    redo(key) {
      const stack = stacks.get(key);
      if (!stack || stack.index >= stack.states.length - 1) return null;
      stack.index += 1;
      touch(key, stack);
      return stack.states[stack.index] ?? null;
    },

    canUndo(key) {
      const stack = stacks.get(key);
      return stack !== undefined && stack.index > 0;
    },

    canRedo(key) {
      const stack = stacks.get(key);
      return stack !== undefined && stack.index < stack.states.length - 1;
    },

    forget(key) {
      stacks.delete(key);
    },

    reset() {
      stacks.clear();
    },
  };
}

/** 应用里共用的一份。窗口之间互相独立（各自一个 JS 上下文）。 */
export const editorHistory = createEditorHistory();

/**
 * 撤销 / 重做之后光标该放哪。
 *
 * 原生撤销会把光标送回改动处，而我们只能整份替换 `value`，不处理的话光标会跳到末尾
 * —— 撤一下就到文末，接着打字就跑到文末去了。这里取两段文本的公共前后缀，把光标放在
 * **改动区间的末尾**，观感与原生撤销接近。
 */
export function caretAfterChange(from: string, to: string): number {
  const shortest = Math.min(from.length, to.length);

  let start = 0;
  while (start < shortest && from[start] === to[start]) start += 1;

  let fromEnd = from.length;
  let toEnd = to.length;
  while (fromEnd > start && toEnd > start && from[fromEnd - 1] === to[toEnd - 1]) {
    fromEnd -= 1;
    toEnd -= 1;
  }

  return toEnd;
}
