/**
 * 编辑操作：把「光标 + 输入」翻译成 XML 改动，再重解析受影响的段落。
 *
 * 每个操作返回 `{ dirtyKeys, caretAfter }`：`caretAfter` 用**段落文本偏移**表示，
 * 这样重解析后即使 item 被拆开 / 合并，也能把光标放回同一个字。
 */

import { parseParagraphElement, replaceDocumentXml, reparseBlock } from "../docx/parse.js";
import { refreshNumbering, rebuildBlockIndices } from "../docx/parse.js";
import {
  changeListLevel,
  createTable,
  deleteRange,
  insertLineBreak,
  insertTab,
  insertText,
  materializeParagraph,
  mergeParagraphs,
  removeListNumbering,
  runFormatState,
  runsInRange,
  setRunFormat,
  splitParagraphAt,
  splitRunsAtOffset,
} from "./ooxml.js";
import {
  adjacentEditableBlock,
  blockByKey,
  blockEndCaret,
  blockOffsetCaret,
  blockTextOffset,
  isEditableBlock,
  itemLength,
  selectionOrdered,
  stepCaret,
} from "./source-map.js";

const textLength = (text) => Array.from(text ?? "").length;

function nextKey(doc) {
  doc.nextKey = Math.max(doc.nextKey ?? 0, doc.blocks.length);
  return `p${doc.nextKey++}`;
}

function requireEditable(doc, caret) {
  const block = blockByKey(doc, caret?.blockKey);
  if (!block || !isEditableBlock(block)) return null;
  return block;
}

/** 空文档的唯一占位块第一次被编辑时，物化成真正的 `w:p`。 */
async function ensureEditableParagraph(doc, block) {
  if (block?.synthetic !== "empty-body") return block;
  const element = materializeParagraph(doc.source.body);
  const parsed = await parseParagraphElement(
    element,
    doc.source.context,
    0,
    block.key,
  );
  parsed.editable = true;
  parsed.synthetic = null;
  doc.blocks[0] = parsed;
  rebuildBlockIndices(doc);
  return parsed;
}

/**
 * 在光标处插入文字；返回重解析后的段落与新光标。
 * 调用方负责先处理选区。
 */
export async function insertTextAt(doc, caret, text) {
  let block = requireEditable(doc, caret);
  if (!block) {
    const candidate = blockByKey(doc, caret?.blockKey);
    if (candidate?.synthetic === "empty-body") {
      block = await ensureEditableParagraph(doc, candidate);
      caret = blockOffsetCaret(block, 0);
    }
  }
  if (!block || !text) return null;

  const offset = blockTextOffset(block, caret);
  insertText(block, caret, text);
  const parsed = await reparseBlock(doc, block);
  return {
    dirtyKeys: [parsed.key],
    caretAfter: blockOffsetCaret(parsed, offset + textLength(text)),
    block: parsed,
  };
}

/**
 * 给选区里的文字设置字符格式。
 *
 * 先在两端的字符偏移处切开 run，保证格式只落在选中的那段文字上；然后逐个 run
 * 写 `w:rPr`。`bold / italic / underline / strike` 是开关：选区里不是全带这个格式
 * 就统一加上，全带就去掉。
 */
export async function applyRunFormat(doc, selection, format) {
  const ordered = selectionOrdered(doc, selection);
  if (!ordered || ordered.collapsed) {
    return { unsupported: "empty-selection" };
  }

  const startBlock = blockByKey(doc, ordered.start.blockKey);
  const endBlock = blockByKey(doc, ordered.end.blockKey);
  const sameCell =
    startBlock?.container &&
    endBlock?.container &&
    startBlock.container.cell === endBlock.container.cell;
  const ranges = [];

  if (sameCell) {
    const collection = startBlock.container.cell.blocks;
    const startIndex = startBlock.container.index;
    const endIndex = endBlock.container.index;
    for (let index = startIndex; index <= endIndex; index += 1) {
      const block = collection[index];
      if (!isEditableBlock(block)) continue;
      ranges.push({
        block,
        start: index === startIndex ? blockTextOffset(block, ordered.start) : 0,
        end: index === endIndex
          ? blockTextOffset(block, ordered.end)
          : blockTextOffset(block, blockEndCaret(block)),
      });
    }
  } else {
    const startIndex = doc.keyToIndex?.get(ordered.start.blockKey);
    const endIndex = doc.keyToIndex?.get(ordered.end.blockKey);
    if (startIndex == null || endIndex == null) {
      return { unsupported: "no-format-range" };
    }
    for (let index = startIndex; index <= endIndex; index += 1) {
      const block = doc.blocks[index];
      if (!isEditableBlock(block)) continue;
      ranges.push({
        block,
        start: index === startIndex ? blockTextOffset(block, ordered.start) : 0,
        end: index === endIndex
          ? blockTextOffset(block, ordered.end)
          : blockTextOffset(block, blockEndCaret(block)),
      });
    }
  }

  const toggleKeys = new Set(["bold", "italic", "underline", "strike"]);
  const dirtyKeys = [];

  for (const { block, start, end } of ranges) {
    if (end <= start) continue;

    // 超链接 / 修订里的 run 是嵌套结构，当前只做顶层 run 的边界切分。
    let itemOffset = 0;
    for (const item of block.items ?? []) {
      const length = itemLength(item);
      if (item.nested && itemOffset + length > start && itemOffset < end) {
        return { unsupported: "nested" };
      }
      itemOffset += length;
    }

    // 先把选区边界切成 run 边界；切完再按字符范围收集 run。
    splitRunsAtOffset(block, start);
    splitRunsAtOffset(block, end);
    const runs = runsInRange(block, start, end);
    if (runs.length === 0) continue;

    let value = format.value;
    if (toggleKeys.has(format.key) && value === undefined) {
      value = !runs.every((run) => runFormatState(run, format.key));
    }
    for (const run of runs) setRunFormat(run, { key: format.key, value });

    const parsed = await reparseBlock(doc, block);
    dirtyKeys.push(parsed.key);
  }

  if (dirtyKeys.length === 0) {
    return { unsupported: "no-format-range" };
  }
  return {
    dirtyKeys,
    caretAfter: ordered.end,
    selectionAfter: { anchor: selection.anchor, focus: selection.focus },
  };
}

/** 删除同一段内的 `[start, end)`。 */
export async function deleteWithinBlock(doc, block, start, end) {
  if (!block || !isEditableBlock(block)) return null;
  const startOffset = blockTextOffset(block, start);
  const endOffset = blockTextOffset(block, end);
  if (endOffset <= startOffset) {
    return { dirtyKeys: [], caretAfter: blockOffsetCaret(block, startOffset), block };
  }

  deleteRange(block, startOffset, endOffset);
  const parsed = await reparseBlock(doc, block);
  return {
    dirtyKeys: [parsed.key],
    caretAfter: blockOffsetCaret(parsed, startOffset),
    block: parsed,
  };
}

/**
 * 退格：同段内删一个字；落到段首时交给调用方做段合并（M5.4）。
 */
/** 列表属性改动后：重解析这一段、重新编号，光标留在段首。 */
async function refreshListParagraph(doc, block) {
  const parsed = await reparseBlock(doc, block);
  return {
    // 去掉一项编号后，后面的编号都会变，整篇重排最稳。
    dirtyKeys: doc.blocks.map((candidate) => candidate.key),
    caretAfter: blockOffsetCaret(parsed, 0),
  };
}

export async function deleteBackward(doc, caret) {
  const block = requireEditable(doc, caret);
  if (!block) return null;
  if (blockTextOffset(block, caret) === 0) {
    // Word：列表项开头第一次退格只去掉列表格式（多级列表先降一级），
    // 文字保留；再按一次才会并到上一段。
    const numPr = block.propsBase?.numPr ?? block.props?.numPr;
    if (numPr) {
      const level = numPr.ilvl ?? 0;
      const changed =
        level > 0 ? changeListLevel(block, -1) : removeListNumbering(block);
      if (changed) return refreshListParagraph(doc, block);
    }
    return { merge: "backward", block, caret };
  }
  const before = stepCaret(doc, caret, -1);
  if (!before || before.blockKey !== block.key) {
    return { merge: "backward", block, caret };
  }
  return deleteWithinBlock(doc, block, before, caret);
}

/** Delete：同段内删一个字；落到段尾时交给调用方做段合并（M5.4）。 */
export async function deleteForward(doc, caret) {
  const block = requireEditable(doc, caret);
  if (!block) return null;
  const endOffset = blockTextOffset(block, blockEndCaret(block));
  if (blockTextOffset(block, caret) >= endOffset) {
    return { merge: "forward", block, caret };
  }
  const after = stepCaret(doc, caret, 1);
  if (!after || after.blockKey !== block.key) {
    return { merge: "forward", block, caret };
  }
  return deleteWithinBlock(doc, block, caret, after);
}

/**
 * 替换选区（同段或跨段）。
 * 返回 `{ unsupported: ... }` 时由编辑器 toast 提示，不破坏文档。
 */
export async function replaceSelection(doc, selection, text) {
  const { anchor, focus } = selection ?? {};
  if (!anchor || !focus) return null;
  const block = requireEditable(doc, anchor);
  if (!block) return null;

  if (anchor.blockKey !== focus.blockKey) {
    return replaceCrossBlockSelection(doc, selection, text);
  }

  const start = blockTextOffset(block, anchor) <= blockTextOffset(block, focus) ? anchor : focus;
  const end = start === anchor ? focus : anchor;
  const deleted = await deleteWithinBlock(doc, block, start, end);
  if (!deleted) return null;

  if (text) {
    const inserted = await insertTextAt(doc, deleted.caretAfter, text);
    if (inserted) inserted.dirtyKeys = [block.key];
    return inserted;
  }
  return deleted;
}

/**
 * 跨段删除 / 替换：删掉起点段尾、中间整段、终点段首，再把终点段剩下内容并回起点段。
 * Word 里跨段选中后按退格就是这个结果。
 */
async function replaceCrossBlockSelection(doc, selection, text) {
  const ordered = selectionOrdered(doc, selection);
  if (!ordered || ordered.collapsed) return null;

  const startBlock = blockByKey(doc, ordered.start.blockKey);
  const endBlock = blockByKey(doc, ordered.end.blockKey);
  if (!isEditableBlock(startBlock) || !isEditableBlock(endBlock)) {
    return { unsupported: "not-adjacent" };
  }

  const sameCell =
    startBlock.container &&
    endBlock.container &&
    startBlock.container.cell === endBlock.container.cell;
  const collection = sameCell ? startBlock.container.cell.blocks : doc.blocks;
  const startIndex = sameCell
    ? startBlock.container.index
    : doc.keyToIndex.get(startBlock.key);
  const endIndex = sameCell
    ? endBlock.container.index
    : doc.keyToIndex.get(endBlock.key);
  if (startIndex == null || endIndex == null || endIndex <= startIndex) {
    return { unsupported: "not-adjacent" };
  }

  // 中间隔着表格 / 不可编辑结构：先不做结构合并。
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    if (!isEditableBlock(collection[index])) return { unsupported: "not-adjacent" };
  }
  if (!startBlock.node?.parentNode || endBlock.node?.parentNode !== startBlock.node.parentNode) {
    return { unsupported: "not-adjacent" };
  }

  const startOffset = blockTextOffset(startBlock, ordered.start);
  const endOffset = blockTextOffset(endBlock, ordered.end);
  const startLength = blockTextOffset(startBlock, blockEndCaret(startBlock));

  if (startOffset < startLength) deleteRange(startBlock, startOffset, startLength);
  if (endOffset > 0) deleteRange(endBlock, 0, endOffset);

  // 中间整段直接删节点；它们已经全部落在选区里。
  for (let index = endIndex - 1; index > startIndex; index -= 1) {
    const block = collection[index];
    block.node?.parentNode?.removeChild(block.node);
    collection.splice(index, 1);
  }

  const merged = mergeParagraphs(startBlock, endBlock);
  if (merged?.unsupported) return { unsupported: merged.unsupported };
  collection.splice(startIndex + 1, 1);

  const parsed = await reparseBlock(doc, startBlock);
  refreshNumbering(doc);
  rebuildBlockIndices(doc);

  let caretAfter = blockOffsetCaret(parsed, startOffset);
  if (text) {
    const inserted = await insertTextAt(doc, caretAfter, text);
    if (inserted) caretAfter = inserted.caretAfter;
  }

  return {
    // 结构变化会影响后面所有编号，整篇重排最稳。
    dirtyKeys: doc.blocks.map((candidate) => candidate.key),
    caretAfter,
  };
}

/** 回车：在光标处拆成两段。返回新段落里的光标。 */
export async function splitParagraph(doc, caret) {
  let block = requireEditable(doc, caret);
  if (!block) {
    const candidate = blockByKey(doc, caret?.blockKey);
    if (candidate?.synthetic === "empty-body") {
      block = await ensureEditableParagraph(doc, candidate);
      caret = blockOffsetCaret(block, 0);
    }
  }
  if (!block) return null;

  // 空列表项按回车也照常分段：当前这一项保留编号，下面继续生成下一个编号项。
  // 要退出列表，用这一项开头的 Backspace（去掉编号），而不是靠回车。
  const result = splitParagraphAt(block, caret);
  if (result?.unsupported) return { unsupported: result.unsupported };

  const key = nextKey(doc);
  const container = block.container;
  const index = container ? container.index + 1 : block.index + 1;
  await reparseBlock(doc, block);
  const created = await parseParagraphElement(
    result.node,
    doc.source.context,
    index,
    key,
  );
  if (container) {
    created.container = {
      table: container.table,
      row: container.row,
      cell: container.cell,
      index,
    };
    container.cell.blocks.splice(index, 0, created);
  } else {
    doc.blocks.splice(index, 0, created);
  }
  refreshNumbering(doc);
  rebuildBlockIndices(doc);

  return {
    // 分段会改后面所有编号段落的标签，干脆全部重排；结构编辑不常发生。
    dirtyKeys: doc.blocks.map((candidate) => candidate.key),
    caretAfter: { blockKey: created.key, itemIndex: 0, offset: 0 },
  };
}

/** Shift+Enter：段内手动换行。 */
export async function insertSoftBreak(doc, caret) {
  const block = requireEditable(doc, caret);
  if (!block) return null;
  const offset = blockTextOffset(block, caret);
  insertLineBreak(block, caret);
  const parsed = await reparseBlock(doc, block);
  return {
    dirtyKeys: [parsed.key],
    caretAfter: blockOffsetCaret(parsed, offset + 1),
  };
}

/** 把下一段并进当前段；光标停在接缝处。 */
export async function mergeWithNext(doc, block) {
  const next = adjacentEditableBlock(doc, block.key, 1);
  if (!next) return null;

  const joinOffset = blockTextOffset(block, blockEndCaret(block));
  const result = mergeParagraphs(block, next);
  if (result?.unsupported) return { unsupported: result.unsupported };

  const parsed = await reparseBlock(doc, block);
  if (next.container) {
    const cell = next.container.cell;
    const nextIndex = cell.blocks.findIndex((candidate) => candidate.key === next.key);
    if (nextIndex >= 0) cell.blocks.splice(nextIndex, 1);
  } else {
    const nextIndex = doc.blocks.findIndex((candidate) => candidate.key === next.key);
    if (nextIndex >= 0) doc.blocks.splice(nextIndex, 1);
  }
  refreshNumbering(doc);
  rebuildBlockIndices(doc);

  return {
    dirtyKeys: doc.blocks.map((candidate) => candidate.key),
    caretAfter: blockOffsetCaret(parsed, joinOffset),
  };
}

/** 段首退格：把当前段并进上一段。 */
export async function mergeWithPrevious(doc, block) {
  const previous = adjacentEditableBlock(doc, block.key, -1);
  if (!previous) return null;
  return mergeWithNext(doc, previous);
}

async function insertTabAt(doc, caret) {
  const block = requireEditable(doc, caret);
  if (!block) return null;
  const offset = blockTextOffset(block, caret);
  insertTab(block, caret);
  const parsed = await reparseBlock(doc, block);
  return { dirtyKeys: [parsed.key], caretAfter: blockOffsetCaret(parsed, offset + 1) };
}

/**
 * 粘贴纯文本：`\n` 分段、`\t` 变 `w:tab`。
 *
 * 每次插入都会重解析，但整次粘贴在调用方看来是**一个**事务（一次撤销）。
 */
export async function insertPlainText(doc, caret, text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 1 && lines[0] === "") return null;

  let current = caret;
  let last = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) {
      last = await splitParagraph(doc, current);
      if (!last || last.unsupported) return last;
      current = last.caretAfter;
    }
    const parts = lines[index].split("\t");
    for (let part = 0; part < parts.length; part += 1) {
      if (part > 0) {
        last = await insertTabAt(doc, current);
        if (!last) return null;
        current = last.caretAfter;
      }
      if (parts[part]) {
        last = await insertTextAt(doc, current, parts[part]);
        if (!last) return null;
        current = last.caretAfter;
      }
    }
  }

  return {
    dirtyKeys: doc.blocks.map((block) => block.key),
    caretAfter: current,
  };
}

/**
 * 在光标所在段落之后插入一张新表格。
 *
 * 插入后整篇重解析（表格创建不常发生）；光标落到第一个单元格里，随后
 * 走和普通表格编辑完全相同的链路。
 */
export async function insertTableAt(doc, caret, rows, cols) {
  const block = requireEditable(doc, caret);
  if (!block) return null;
  if (block.container) return { unsupported: "nested-table" };
  const paragraph = block.node;
  if (!paragraph?.parentNode) return null;

  const table = createTable(
    doc.source.documentXml,
    Math.max(1, Math.min(20, rows)),
    Math.max(1, Math.min(12, cols)),
    doc.section?.contentWidth ?? 415,
  );
  paragraph.parentNode.insertBefore(table, paragraph.nextSibling);

  // 表格落在文档末尾时补一个空段落，方便继续在表格外输入（Word 也这么做）。
  let next = table.nextSibling;
  while (next && next.nodeType !== 1) next = next.nextSibling;
  if (!next || next.localName === "sectPr") {
    const trailing = doc.source.documentXml.createElementNS(paragraph.namespaceURI, "w:p");
    table.parentNode.insertBefore(trailing, table.nextSibling);
  }

  const tableIndex = block.index + 1;
  await replaceDocumentXml(
    doc,
    new XMLSerializer().serializeToString(doc.source.documentXml),
  );

  const tableBlock =
    doc.blocks[tableIndex]?.kind === "table"
      ? doc.blocks[tableIndex]
      : doc.blocks.find((candidate) => candidate.kind === "table");
  const cellParagraph = tableBlock?.rows?.[0]?.cells?.[0]?.blocks?.[0];
  if (!cellParagraph) return null;

  return {
    dirtyKeys: doc.blocks.map((candidate) => candidate.key),
    caretAfter: { blockKey: cellParagraph.key, itemIndex: 0, offset: 0 },
  };
}
