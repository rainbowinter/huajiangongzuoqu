/**
 * 用排版结果做命中和几何计算。
 *
 * 不读 DOM 行：懒渲染的页面没有行元素，但布局数据一直都在。这样点击、拖选、
 * 光标绘制在「还没画出来的页」上也能工作。
 *
 * 坐标约定：`x` / `y` 都是**页面内容盒**坐标（已经过页面边距），`pageIndex` 是页号。
 */

import { measureText } from "../layout/measure.js";

function charCount(text) {
  return Array.from(text ?? "").length;
}

/** 默认测量：与排版使用同一个 Canvas 测量与字体栈。 */
export function defaultMeasure(text, style, isCJK) {
  return measureText(text, style, isCJK);
}

/** 一行里文字内容相对 `.line` 左端的起点（含对齐与编号标签）。 */
export function lineContentStart(line) {
  return (line.paddingLeft ?? 0) + alignmentOffset(line);
}

/** 第一颗可编辑字符的 x：编号标签占位，光标要落在它后面。 */
export function lineTextStart(line) {
  return lineContentStart(line) + (line.labelWidth ?? 0);
}

export function lineTextEnd(line) {
  const textWidth = line.naturalWidth - (line.labelWidth ?? 0);
  return lineTextStart(line) + textWidth + (line.letterSpacing ?? 0) * Math.max(0, line.charCount - 1);
}

function alignmentOffset(line) {
  const extra = (line.availableWidth ?? 0) - (line.naturalWidth ?? 0);
  if (extra <= 0) return 0;
  if (line.alignment === "center") return extra / 2;
  if (line.alignment === "right" || line.alignment === "end") return extra;
  return 0;
}

export function lineForCaret(block, caret) {
  const lines = block?.lines ?? [];
  if (lines.length === 0) return null;
  let best = lines[0];
  for (const line of lines) {
    const afterStart = compareCaretLike(caret, line.startCaret) >= 0;
    const beforeEnd = compareCaretLike(caret, line.endCaret) <= 0;
    if (afterStart && beforeEnd) return line;
    if (afterStart) best = line;
  }
  return best;
}

export function compareCaretLike(a, b) {
  if (!a || !b) return 0;
  if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
  return (a.offset ?? 0) - (b.offset ?? 0);
}

function atomEndX(line, atom, x) {
  return x + (atom.width ?? 0) + (atom.kind === "text" ? (line.letterSpacing ?? 0) * charCount(atom.text) : 0);
}

/** 文本 atom 内第 `count` 个码点处的宽度。 */
function prefixWidth(atom, count, line, measure) {
  if (count <= 0) return 0;
  const chars = Array.from(atom.text);
  const text = chars.slice(0, count).join("");
  const prefix = measure(text, atom.style, atom.isCJK) ?? 0;
  return prefix + (line.letterSpacing ?? 0) * count;
}

/**
 * 光标在某个（已知属于该行的）行里的 x。
 * 光标不在这一行时由调用方处理。
 */
export function caretX(line, caret, measure = defaultMeasure) {
  // 从内容起点开始走；编号标签由循环自己把宽度加进去（不能和 lineTextStart 重复加）。
  let x = lineContentStart(line);
  if (!caret) return x;
  const atoms = line.atoms ?? [];

  for (const atom of atoms) {
    if (atom.itemIndex == null || atom.itemIndex < 0) {
      // 编号标签：占宽度，但光标不会停在它内部。
      x += atom.width ?? 0;
      continue;
    }
    // 光标在当前原子之前：它的位置就是这里。
    if (caret.itemIndex < atom.itemIndex) return x;
    // 光标在当前原子之后（原子 item 的“后面”用 itemIndex + 1 表示）。
    if (caret.itemIndex > atom.itemIndex) {
      x = atomEndX(line, atom, x);
      continue;
    }

    if (atom.kind === "text") {
      const start = atom.charStart ?? 0;
      const end = atom.charEnd ?? start + charCount(atom.text);
      // 同一个 item 会被拆成多个原子（中文一字一个、西文一词一个）：
      // 不能一看到 itemIndex 相同就当成“在这一原子内”。
      if (caret.offset >= end) {
        x = atomEndX(line, atom, x);
        continue;
      }
      if (caret.offset <= start) return x;
      return x + prefixWidth(atom, caret.offset - start, line, measure);
    }
    return x;
  }

  return x;
}

/** 光标矩形（页面内容盒坐标）。 */
export function caretRect(layout, caret, measure = defaultMeasure) {
  if (!caret) return null;
  const block =
    layout.keyToBlock?.get(caret.blockKey) ??
    layout.blocks.find((candidate) => candidate.key === caret.blockKey);
  if (!block) return null;
  const line = lineForCaret(block, caret);
  if (!line) return null;
  const x = (line.tableOriginX ?? 0) + caretX(line, caret, measure);
  return {
    pageIndex: line.pageIndex,
    x,
    y: (line.tableOriginY ?? 0) + line.top,
    width: 1,
    height: line.height,
  };
}

/** 一页里所有视觉行（正文行 + 表格单元格行），都带页面内容盒坐标的原点。 */
function visualLines(page, layout) {
  const entries = [];
  const items = page.items ?? page.lines.map((line) => ({ kind: "line", line }));
  for (const item of items) {
    if (item.kind === "line") {
      const line = item.line;
      const block =
        layout.keyToBlock?.get(line.blockKey) ??
        layout.blocks[line.paragraphIndex];
      entries.push({ line, block, originX: 0, originY: 0 });
      continue;
    }
    if (item.kind !== "table-row") continue;
    for (const cell of item.row.cells) {
      if (cell.hidden) continue;
      const originX = item.table.x + cell.x + (cell.margins?.left ?? 0);
      const originY = item.top + (cell.contentTop ?? 0);
      for (const line of cell.lines ?? []) {
        entries.push({
          line,
          block: layout.keyToBlock?.get(line.blockKey),
          originX,
          originY,
        });
      }
    }
  }
  return entries;
}

/**
 * 文本点 → 光标。
 *
 * `pageIndex` 已确定；`x` / `y` 是页面内容盒坐标。`y` 落在行间时取最近的一行。
 */
export function hitTest(layout, pageIndex, x, y, measure = defaultMeasure) {
  const page = layout.pages[pageIndex];
  if (!page) return null;
  const entries = visualLines(page, layout).filter((entry) => entry.block);
  if (entries.length === 0) return null;

  // 同一 y 上可能有多行（表格一行的多个单元格）。先按纵向筛，再按横向选：
  // 落在哪一列的行盒里就选哪一格，列缝里取最近的一列。
  const scored = entries.map((candidate) => {
    const top = candidate.originY + candidate.line.top;
    const left = candidate.originX + (candidate.line.paddingLeft ?? 0);
    return {
      ...candidate,
      top,
      bottom: top + candidate.line.height,
      left,
      right: left + candidate.line.availableWidth,
    };
  });
  const vertical = scored.filter((candidate) => y >= candidate.top && y <= candidate.bottom);
  const dx = (candidate) =>
    x < candidate.left ? candidate.left - x : x > candidate.right ? x - candidate.right : 0;
  let entry;
  if (vertical.length > 0) {
    entry = vertical.find((candidate) => dx(candidate) === 0);
    if (!entry) {
      entry = vertical.reduce((best, candidate) =>
        dx(candidate) < dx(best) ? candidate : best
      );
    }
  } else {
    const dy = (candidate) =>
      y < candidate.top ? candidate.top - y : y - candidate.bottom;
    entry = scored.reduce((best, candidate) => {
      const distance = dy(candidate);
      const bestDistance = dy(best);
      if (distance < bestDistance) return candidate;
      if (distance === bestDistance && dx(candidate) < dx(best)) return candidate;
      return best;
    });
  }

  const { line, block, originX } = entry;
  const localX = x - originX;
  const toCaret = (itemIndex, offset) => ({ blockKey: block.key, itemIndex, offset });

  if (localX <= lineTextStart(line)) {
    return toCaret(line.startCaret.itemIndex, line.startCaret.offset);
  }

  let cursor = lineContentStart(line);
  for (const atom of line.atoms ?? []) {
    if (atom.itemIndex == null || atom.itemIndex < 0) {
      cursor += atom.width ?? 0;
      continue;
    }
    const width = atom.width ?? 0;
    if (localX <= cursor + width) {
      if (atom.kind === "text") {
        const chars = Array.from(atom.text);
        let local = chars.length;
        for (let count = 0; count <= chars.length; count += 1) {
          const left = cursor + prefixWidth(atom, count, line, measure);
          const right = cursor + prefixWidth(atom, count + 1, line, measure);
          if (localX < right) {
            local = localX - left <= right - localX ? count : count + 1;
            break;
          }
        }
        local = Math.max(0, Math.min(local, chars.length));
        return toCaret(atom.itemIndex, (atom.charStart ?? 0) + local);
      }
      return localX < cursor + width / 2
        ? toCaret(atom.itemIndex, 0)
        : toCaret(atom.itemIndex + 1, 0);
    }
    cursor += width;
  }

  return toCaret(line.endCaret.itemIndex, line.endCaret.offset);
}

/** 选区矩形（页面内容盒坐标）。跨页时每页各自返回。 */
export function selectionRects(layout, start, end, measure = defaultMeasure) {
  if (!start || !end) return [];
  if (start.blockKey === end.blockKey) {
    const block = layout.keyToBlock?.get(start.blockKey);
    if (!block?.lines) return [];
    const forward = compareCaretLike(start, end) <= 0;
    const fromCaret = forward ? start : end;
    const toCaret = forward ? end : start;
    const rects = [];
    for (const line of block.lines) {
      if (compareCaretLike(fromCaret, line.endCaret) > 0) continue;
      if (compareCaretLike(line.startCaret, toCaret) > 0) continue;
      const x1 = compareCaretLike(fromCaret, line.startCaret) <= 0
        ? lineTextStart(line)
        : caretX(line, fromCaret, measure);
      const x2 = compareCaretLike(toCaret, line.endCaret) >= 0
        ? lineTextEnd(line)
        : caretX(line, toCaret, measure);
      if (x2 <= x1 + 0.5) continue;
      rects.push({
        pageIndex: line.pageIndex,
        x: (line.tableOriginX ?? 0) + x1,
        y: (line.tableOriginY ?? 0) + line.top,
        width: x2 - x1,
        height: line.height,
      });
    }
    return rects;
  }

  const startBlock = layout.keyToBlock?.get(start.blockKey);
  const endBlock = layout.keyToBlock?.get(end.blockKey);
  if (
    startBlock?.container &&
    endBlock?.container &&
    startBlock.container.cell === endBlock.container.cell
  ) {
    const blocks = startBlock.container.cell.blocks;
    const a = startBlock.container.index;
    const b = endBlock.container.index;
    const forward = a < b || (a === b && compareCaretLike(start, end) <= 0);
    const fromIndex = forward ? a : b;
    const toIndex = forward ? b : a;
    const fromCaret = forward ? start : end;
    const toCaret = forward ? end : start;
    const rects = [];
    for (let index = fromIndex; index <= toIndex; index += 1) {
      const block = blocks[index];
      for (const line of block?.lines ?? []) {
        if (fromIndex === toIndex) {
          // 同段已在上面处理。
          continue;
        }
        const startsBeforeLineEnd =
          fromIndex < index || compareCaretLike(fromCaret, line.endCaret) <= 0;
        const endsAfterLineStart =
          toIndex > index || compareCaretLike(line.startCaret, toCaret) <= 0;
        if (!startsBeforeLineEnd || !endsAfterLineStart) continue;
        const x1 =
          fromIndex < index || compareCaretLike(fromCaret, line.startCaret) <= 0
            ? lineTextStart(line)
            : caretX(line, fromCaret, measure);
        const x2 =
          toIndex > index || compareCaretLike(toCaret, line.endCaret) >= 0
            ? lineTextEnd(line)
            : caretX(line, toCaret, measure);
        if (x2 <= x1 + 0.5) continue;
        rects.push({
          pageIndex: line.pageIndex,
          x: (line.tableOriginX ?? 0) + x1,
          y: (line.tableOriginY ?? 0) + line.top,
          width: x2 - x1,
          height: line.height,
        });
      }
    }
    return rects;
  }

  const startIndex = layout.keyToIndex?.get(start.blockKey);
  const endIndex = layout.keyToIndex?.get(end.blockKey);
  if (startIndex == null || endIndex == null) return [];

  const forward = startIndex < endIndex || (startIndex === endIndex && compareCaretLike(start, end) <= 0);
  const fromIndex = forward ? startIndex : endIndex;
  const toIndex = forward ? endIndex : startIndex;
  const fromCaret = forward ? start : end;
  const toCaret = forward ? end : start;

  const rects = [];
  for (let index = fromIndex; index <= toIndex; index += 1) {
    const block = layout.blocks[index];
    if (!block || block.editable === false || block.synthetic != null) continue;

    for (const line of block.lines ?? []) {
      // 选区是否盖到这一行：起点在行尾之前，终点在行首之后。
      const startsBeforeLineEnd =
        fromIndex < index || (fromIndex === index && compareCaretLike(fromCaret, line.endCaret) <= 0);
      const endsAfterLineStart =
        toIndex > index || (toIndex === index && compareCaretLike(line.startCaret, toCaret) <= 0);
      if (!startsBeforeLineEnd || !endsAfterLineStart) continue;

      const x1 =
        fromIndex < index || (fromIndex === index && compareCaretLike(fromCaret, line.startCaret) <= 0)
          ? lineTextStart(line)
          : caretX(line, fromCaret, measure);
      const x2 =
        toIndex > index || (toIndex === index && compareCaretLike(toCaret, line.endCaret) >= 0)
          ? lineTextEnd(line)
          : caretX(line, toCaret, measure);
      if (x2 <= x1 + 0.5) continue;
      rects.push({
        pageIndex: line.pageIndex,
        x: x1,
        y: line.top,
        width: x2 - x1,
        height: line.height,
      });
    }
  }
  return rects;
}

/**
 * 屏幕坐标 → `{ pageIndex, x, y }`（页面内容盒坐标）。
 *
 * 每页的 `getBoundingClientRect()` 已经把缩放和滚动算进去了，比手算页间距稳。
 */
export function pagePointFromClient({ clientX, clientY, renderer, section, zoom = 1 }) {
  const pages = renderer?.pageElements ?? [];
  if (pages.length === 0) return null;

  let pageIndex = 0;
  let best = Infinity;
  pages.forEach((element, index) => {
    const rect = element.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      pageIndex = index;
      best = 0;
    } else {
      const distance = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
      if (distance < best) {
        best = distance;
        pageIndex = index;
      }
    }
  });

  const rect = pages[pageIndex].getBoundingClientRect();
  return {
    pageIndex,
    x: (clientX - rect.left) / zoom - (section.margin?.left ?? 0),
    y: (clientY - rect.top) / zoom - (section.margin?.top ?? 0),
  };
}

/** 所有视觉行，按页、按 top 顺序；上下键用它跨段、跨页移动。 */
export function flatLines(layout) {
  const result = [];
  layout.blocks.forEach((block, blockIndex) => {
    if (block.editable === false || block.synthetic != null) return;
    for (const line of block.lines ?? []) {
      result.push({ block, blockIndex, line });
    }
  });
  // 布局已经按页顺序生成；再按页、top 排一次，防止分页把同一段拆开。
  result.sort((a, b) => {
    if (a.line.pageIndex !== b.line.pageIndex) return a.line.pageIndex - b.line.pageIndex;
    return a.line.top - b.line.top;
  });
  return result;
}

/** 上下移动：保持目标列，找相邻视觉行。 */
export function verticalCaret(layout, caret, direction, desiredX, measure = defaultMeasure) {
  const flat = flatLines(layout);
  if (flat.length === 0) return null;
  const rect = caretRect(layout, caret, measure);

  let current = -1;
  if (rect) {
    current = flat.findIndex(
      (entry) =>
        entry.line.pageIndex === rect.pageIndex &&
        rect.y >= entry.line.top - 0.5 &&
        rect.y < entry.line.top + entry.line.height,
    );
  }
  if (current < 0) return null;

  const target = flat[current + direction];
  if (!target) return null;

  const x = desiredX ?? rect.x;
  return hitTest(
    layout,
    target.line.pageIndex,
    x,
    target.line.top + Math.min(target.line.height / 2, 4),
    measure,
  );
}
