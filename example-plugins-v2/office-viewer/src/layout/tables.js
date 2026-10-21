/**
 * 表格排版。
 *
 * 表格不参与普通的「段落 → 行」装箱：一行表格的高度由**所有单元格内容的最大值**
 * 决定，单元格内部仍然复用 `layoutParagraph`。分页器把每一行当作不可分割的块
 * （`cantSplit` 目前只影响行是否允许拆，第一版统一不拆行）。
 */

import { layoutParagraph } from "./lines.js";
import { fontMetrics } from "./measure.js";

/**
 * 表格行在 WPS 里比同样文字的正文行多约 0.48pt（13.56 → 14.04）。
 * 这是表格单元格自己的行距口径，不是段前/段后；不加上它，跨页表格
 * 每 20 多行就会差出一整行的分页点（TB3）。
 */
const TABLE_CELL_LEADING_PX = 0.64;

/**
 * 单元格里 Word 会把**段落标记**的字体也算进行高/基线（内容只有数字时尤其明显：
 * 基线仍按正文宋体的 1em 落，不按 Times 的 ascent）。这里把默认样式的度量
 * 并进每一行。
 */
function applyParagraphMark(line, paragraph, context) {
  const style = paragraph.defaultStyle;
  if (!style) return;
  const metrics = fontMetrics(style, Boolean(style.fontEastAsia), context.options);
  line.height = Math.max(line.height, metrics.lineHeight);
  line.baseline = Math.max(line.baseline ?? 0, metrics.ascent);
}

function layoutCellParagraphs(paragraphs, context) {
  const lines = [];
  let height = 0;

  for (const paragraph of paragraphs) {
    const cellLines = layoutParagraph(paragraph, context);
    paragraph.lines = cellLines;
    for (const line of cellLines) {
      applyParagraphMark(line, paragraph, context);
      line.blockKey = paragraph.key;
    }
    for (const [index, line] of cellLines.entries()) {
      const before = index === 0 ? line.spaceBefore ?? 0 : 0;
      line.top = height + before;
      height = line.top + line.height;
      if (index === cellLines.length - 1) height += line.spaceAfter ?? 0;
      lines.push(line);
    }
  }

  return { lines, height };
}

/**
 * @returns {object} 带 `x` / `width` / `rows` 的表格块；`rows[].cells[].lines`
 *   的行 `top` 是相对单元格内容区顶部的坐标。
 */
export function layoutTable(block, context) {
  const { section } = context;
  const props = block.props ?? {};
  const tableWidth = props.width ?? section.contentWidth;
  let x = 0;
  if (props.alignment === "center") x = (section.contentWidth - tableWidth) / 2;
  else if (props.alignment === "right" || props.alignment === "end") {
    x = section.contentWidth - tableWidth;
  }

  const rows = [];
  for (const sourceRow of block.rows ?? []) {
    const row = { ...sourceRow, cells: [] };
    let contentHeight = 0;
    let cursor = 0;

    for (const sourceCell of sourceRow.cells) {
      const cell = { ...sourceCell };
      const margins = cell.margins ?? { left: 0, right: 0, top: 0, bottom: 0 };
      const contentWidth = Math.max(1, cell.width - margins.left - margins.right);
      const cellContext = {
        ...context,
        section: { ...section, contentWidth },
      };
      if (cell.continuation) {
        cell.hidden = true;
        cell.lines = [];
        cell.contentHeight = 0;
      } else {
        const laidOut = layoutCellParagraphs(cell.blocks ?? [], cellContext);
        cell.lines = laidOut.lines;
        cell.contentHeight = laidOut.height;
        contentHeight = Math.max(
          contentHeight,
          laidOut.height + margins.top + margins.bottom,
        );
      }
      cell.x = cursor;
      cursor += cell.width;
      for (const line of cell.lines) {
        line.tableCell = cell;
        line.tableKey = block.key;
      }
      row.cells.push(cell);
    }

    row.contentHeight = contentHeight;
    // 固定行高：内容超出也按指定高度画（和 Word 一样会溢出/裁切）。
    if (!(row.heightRule === "exact" && row.height > 0)) {
      row.height = Math.max(row.height ?? 0, contentHeight + TABLE_CELL_LEADING_PX);
    }
    rows.push(row);
  }

  // 纵向合并的单元格要覆盖多行：高度取这几行的总和。
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (const cell of rows[rowIndex].cells) {
      if (!cell.rowSpan || cell.rowSpan <= 1) continue;
      let spanHeight = 0;
      for (let index = rowIndex; index < rowIndex + cell.rowSpan && index < rows.length; index += 1) {
        spanHeight += rows[index].height;
      }
      cell.spanHeight = spanHeight;
    }
  }

  // 单元格垂直对齐：多出来的空间按 top / center / bottom 分配。
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.hidden) continue;
      const margins = cell.margins ?? { left: 0, right: 0, top: 0, bottom: 0 };
      const boxHeight = cell.spanHeight ?? row.height;
      let offset = margins.top;
      if (cell.verticalAlign === "center") offset = (boxHeight - cell.contentHeight) / 2;
      else if (cell.verticalAlign === "bottom") {
        offset = boxHeight - cell.contentHeight - margins.bottom;
      }
      cell.contentTop = Math.max(0, offset);
      cell.height = boxHeight;
    }
  }

  return {
    ...block,
    layout: "table",
    x,
    width: tableWidth,
    rows,
  };
}
