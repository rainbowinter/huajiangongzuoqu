/**
 * 排版入口：文档模型 → 行 → 页。
 */

import { layoutParagraph } from "./lines.js";
import { paginate } from "./paginate.js";
import { layoutTable } from "./tables.js";

export function defaultLayoutOptions() {
  return {
    /** 阅读覆盖：空字符串 = 跟随文档。 */
    fontOverride: "",
    /** 阅读覆盖：pt；null = 跟随文档。 */
    sizeOverridePt: null,
    /**
     * 阅读覆盖：null = 跟随文档；否则：
     * * auto: value 是倍数（1.15）
     * * exact / atLeast: value 是 pt
     */
    lineSpacingMode: null,
    lineSpacingValue: null,
    /** 阅读覆盖：pt；null = 跟随文档。 */
    spaceBeforePt: null,
    spaceAfterPt: null,
    /**
     * 阅读覆盖：null = 跟随文档；否则是 left / center / right / both / distribute。
     * 当前是整个视图的预览覆盖，按段落生效要等编辑模式（M5）。
     */
    alignOverride: null,
  };
}

/**
 * @param {object} [runtime]
 * @param {string[]} [runtime.dirtyKeys] 只重排这些段落；其余段落复用已有的 `lines`。
 *   不传就是全量重排（改字号 / 对齐这类整篇覆盖必须全量）。
 */
export function layoutDocument(model, options = defaultLayoutOptions(), runtime = {}) {
  const context = {
    section: model.section,
    settings: model.settings,
    options,
  };

  const dirty = runtime.dirtyKeys ? new Set(runtime.dirtyKeys) : null;
  const reuse = Boolean(dirty);
  const blocks = [];
  let lineCount = 0;
  for (const block of model.blocks) {
    if (block.kind === "table") {
      const table = layoutTable(block, context);
      for (const row of table.rows) {
        for (const cell of row.cells) lineCount += cell.lines?.length ?? 0;
      }
      blocks.push(table);
      continue;
    }
    let lines;
    if (reuse && !dirty.has(block.key) && block.lines) {
      lines = block.lines;
    } else {
      lines = layoutParagraph(block, context);
    }
    lineCount += lines.length;
    for (const line of lines) line.blockKey = block.key;
    blocks.push({ ...block, lines });
  }

  const pages = paginate(blocks, model.section);
  // 重排后主段落对象可能是新的，keyToBlock 要指向带 lines 的这一份。
  const keyToBlock = new Map(model.keyToBlock ?? []);
  for (const block of blocks) {
    if (block.key) keyToBlock.set(block.key, block);
    if (block.kind !== "table") continue;
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const paragraph of cell.blocks ?? []) keyToBlock.set(paragraph.key, paragraph);
      }
    }
  }
  return {
    ...model,
    blocks,
    keyToBlock,
    pages,
    laidOut: {
      lineCount,
      pageCount: pages.length,
    },
  };
}
