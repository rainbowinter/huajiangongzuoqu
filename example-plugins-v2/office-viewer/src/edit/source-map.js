/**
 * 光标 / 选区 ↔ 段落 item 的换算。
 *
 * 光标形状是 `{ blockKey, itemIndex, offset }`：
 *
 * * `blockKey` 是段落稳定 id —— 分段、合并会让 `block.index` 变，key 不变；
 * * `itemIndex` 是 `block.items` 的下标（编号标签在 `labelItems` 里，不参与）；
 * * `offset` 是 item 文本内的**码点**偏移；制表符 / 换行 / 图片这类原子 item
 *   只能落在它前面（`itemIndex,0`）或后面（`itemIndex+1,0`）。
 *
 * 这个模块不碰 DOM，可以在 Node 里单测。
 */

/** 一个 item 在“段落文本偏移”里占几个字符。 */
export function itemLength(item) {
  if (!item) return 0;
  if (item.kind === "text") return Array.from(item.text ?? "").length;
  // tab / 换行 / 图片都按 1 个位置算；图片虽然不可编辑，但光标可以停在它两侧。
  return 1;
}

export function isEditableBlock(block) {
  return Boolean(block) && block.editable !== false && block.synthetic == null;
}

export function blockByKey(doc, key) {
  if (!doc || !key) return null;
  const direct = doc.keyToBlock?.get(key);
  if (direct) return direct;
  const index = doc.keyToIndex?.get(key);
  if (index == null) return null;
  return doc.blocks[index] ?? null;
}

export function blockStartCaret(block) {
  return { blockKey: block.key, itemIndex: 0, offset: 0 };
}

export function blockEndCaret(block) {
  const items = block.items ?? [];
  if (items.length === 0) return blockStartCaret(block);
  const last = items.length - 1;
  const item = items[last];
  if (item.kind === "text") {
    return {
      blockKey: block.key,
      itemIndex: last,
      offset: Array.from(item.text ?? "").length,
    };
  }
  return { blockKey: block.key, itemIndex: last + 1, offset: 0 };
}

/** 同一段内比较两个 item 位置。 */
export function compareInBlock(a, b) {
  if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
  return (a.offset ?? 0) - (b.offset ?? 0);
}

export function compareCaret(doc, a, b) {
  if (!a || !b) return 0;
  if (a.blockKey !== b.blockKey) {
    const ai =
      doc.keyOrder?.get(a.blockKey) ??
      doc.keyToIndex?.get(a.blockKey) ??
      Number.MAX_SAFE_INTEGER;
    const bi =
      doc.keyOrder?.get(b.blockKey) ??
      doc.keyToIndex?.get(b.blockKey) ??
      Number.MAX_SAFE_INTEGER;
    return ai - bi;
  }
  return compareInBlock(a, b);
}

export function selectionOrdered(doc, selection) {
  if (!selection?.anchor || !selection.focus) return null;
  const order = compareCaret(doc, selection.anchor, selection.focus);
  if (order <= 0) return { start: selection.anchor, end: selection.focus, collapsed: order === 0 };
  return { start: selection.focus, end: selection.anchor, collapsed: false };
}

/** 段落纯文本偏移：itemLength 累加，文本 item 再加 offset。 */
export function blockTextOffset(block, caret) {
  const items = block.items ?? [];
  const itemIndex = Math.max(0, Math.min(caret.itemIndex ?? 0, items.length));
  let offset = 0;
  for (let index = 0; index < itemIndex; index += 1) {
    offset += itemLength(items[index]);
  }
  const item = items[itemIndex];
  if (item?.kind === "text") offset += Math.max(0, caret.offset ?? 0);
  return offset;
}

/** 段落纯文本偏移 → 光标；用于重解析后把光标挪回原来的文字位置。 */
export function blockOffsetCaret(block, offset) {
  const items = block.items ?? [];
  let remaining = Math.max(0, offset ?? 0);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const length = itemLength(item);
    if (remaining < length) {
      if (item.kind === "text") {
        return { blockKey: block.key, itemIndex: index, offset: remaining };
      }
      // 原子 item：偏移落在它内部时，停在它前面。
      return { blockKey: block.key, itemIndex: index, offset: 0 };
    }
    if (remaining === length) {
      if (item.kind === "text") {
        return { blockKey: block.key, itemIndex: index, offset: length };
      }
      // 原子 item 的“后面”是下一个 item 的开头。
      return { blockKey: block.key, itemIndex: index + 1, offset: 0 };
    }
    remaining -= length;
  }
  return blockEndCaret(block);
}

/** 找到 key 之后（dir=1）或之前（dir=-1）最近的可编辑段落。 */
export function adjacentEditableBlock(doc, key, dir) {
  const current = blockByKey(doc, key);
  if (current?.container) {
    // 单元格段落只在当前单元格里前后移动，不能跨到表外。
    const { cell, index } = current.container;
    for (let cursor = index + dir; cursor >= 0 && cursor < cell.blocks.length; cursor += dir) {
      const block = cell.blocks[cursor];
      if (isEditableBlock(block)) return block;
    }
    return null;
  }
  const start = doc.keyToIndex?.get(key);
  if (start == null) return null;
  for (let index = start + dir; index >= 0 && index < doc.blocks.length; index += dir) {
    const block = doc.blocks[index];
    if (isEditableBlock(block)) return block;
  }
  return null;
}

/** 把可能越界 / 落在不可编辑 item 里的光标收回到合法位置。 */
export function normalizeCaret(doc, caret) {
  if (!caret) return null;
  let block = blockByKey(doc, caret.blockKey);
  if (!block || !isEditableBlock(block)) {
    block = adjacentEditableBlock(doc, caret.blockKey, 1);
    if (!block) {
      // 一个可编辑段落都没有：退回第一个块（打开空文档等极端情况）。
      block = doc.blocks.find((candidate) => candidate.key) ?? null;
    }
    if (!block) return null;
    return blockStartCaret(block);
  }

  const items = block.items ?? [];
  let itemIndex = Math.max(0, Math.min(caret.itemIndex ?? 0, items.length));
  let offset = Math.max(0, caret.offset ?? 0);

  if (itemIndex === items.length) return { blockKey: block.key, itemIndex, offset: 0 };

  const item = items[itemIndex];
  if (item.kind === "text") {
    const length = Array.from(item.text ?? "").length;
    offset = Math.min(offset, length);
  } else if (offset > 0) {
    // 原子 item 没有“内部”：任何正偏移都归到它的后面。
    itemIndex += 1;
    offset = 0;
  }

  return { blockKey: block.key, itemIndex, offset };
}

/** 前一个 / 后一个光标位置（不处理上下行）。 */
export function stepCaret(doc, caret, dir) {
  const normalized = normalizeCaret(doc, caret);
  if (!normalized) return null;
  const block = blockByKey(doc, normalized.blockKey);
  if (!block) return null;

  if (dir > 0) {
    if (normalized.itemIndex < block.items.length) {
      const item = block.items[normalized.itemIndex];
      if (item.kind === "text") {
        const length = Array.from(item.text ?? "").length;
        if (normalized.offset < length) {
          return { ...normalized, offset: normalized.offset + 1 };
        }
      }
      return { blockKey: block.key, itemIndex: normalized.itemIndex + 1, offset: 0 };
    }
    const next = adjacentEditableBlock(doc, block.key, 1);
    return next ? blockStartCaret(next) : normalized;
  }

  if (normalized.offset > 0) {
    return { ...normalized, offset: normalized.offset - 1 };
  }
  if (normalized.itemIndex > 0) {
    const previous = block.items[normalized.itemIndex - 1];
    if (previous.kind === "text") {
      return {
        blockKey: block.key,
        itemIndex: normalized.itemIndex - 1,
        offset: Array.from(previous.text ?? "").length,
      };
    }
    // 两个原子挨着时，“后一个的前面”和“前一个的后面”是同一个位置；
    // 再往左必须越过前一个原子。
    return { blockKey: block.key, itemIndex: normalized.itemIndex - 1, offset: 0 };
  }
  const before = adjacentEditableBlock(doc, block.key, -1);
  return before ? blockEndCaret(before) : normalized;
}

/** 选区文字；跨段时用换行连接。 */
export function selectionText(doc, selection) {
  const ordered = selectionOrdered(doc, selection);
  if (!ordered || ordered.collapsed) return "";
  const startIndex = doc.keyToIndex?.get(ordered.start.blockKey);
  const endIndex = doc.keyToIndex?.get(ordered.end.blockKey);
  if (startIndex == null || endIndex == null) return "";

  const parts = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const block = doc.blocks[index];
    if (!isEditableBlock(block)) continue;
    const text = blockText(block);
    const from = index === startIndex ? blockTextOffset(block, ordered.start) : 0;
    const to = index === endIndex ? blockTextOffset(block, ordered.end) : text.length;
    parts.push(text.slice(from, Math.max(from, to)));
  }
  return parts.join("\n");
}

/** 双击选词：返回光标所在词的范围；点在空白/标点上返回 null。 */
export function wordRangeAt(doc, caret) {
  const block = blockByKey(doc, caret?.blockKey);
  if (!block || !isEditableBlock(block)) return null;
  const item = block.items?.[caret.itemIndex];
  if (!item) return null;

  if (item.kind !== "text") {
    // 图片 / 制表符 / 换行：选中这一个原子。
    return {
      anchor: { blockKey: block.key, itemIndex: caret.itemIndex, offset: 0 },
      focus: { blockKey: block.key, itemIndex: caret.itemIndex + 1, offset: 0 },
    };
  }

  const chars = Array.from(item.text ?? "");
  const isWord = (char) => Boolean(char) && /[\p{L}\p{N}_'’-]/u.test(char);
  let start = Math.max(0, Math.min(caret.offset ?? 0, chars.length));
  let end = start;
  while (start > 0 && isWord(chars[start - 1])) start -= 1;
  while (end < chars.length && isWord(chars[end])) end += 1;
  if (start === end) return null;

  return {
    anchor: { blockKey: block.key, itemIndex: caret.itemIndex, offset: start },
    focus: { blockKey: block.key, itemIndex: caret.itemIndex, offset: end },
  };
}

/** 段落里的可编辑文字（tab 变 \t，换行变 \n，图片不计）。 */
export function blockText(block) {
  let text = "";
  for (const item of block.items ?? []) {
    if (item.kind === "text") text += item.text;
    else if (item.kind === "tab") text += "\t";
    else if (item.kind === "lineBreak") text += "\n";
  }
  return text;
}
