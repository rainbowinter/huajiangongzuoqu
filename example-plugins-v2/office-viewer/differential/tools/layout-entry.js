/**
 * 排版指纹入口：把插件的解析 + 排版内核打成独立模块，供 headless Edge 调用。
 *
 * 不 import 任何 DOM / 宿主桥接代码，只依赖：
 *   parseDocx(bytes)  -> IR model
 *   layoutDocument()  -> 按 Word 规则排好的行 / 页
 *
 * 输出的 fingerprint 是"可比对的笨数据"：
 *   page -> line -> { text, x, y, width, height, fonts }
 * x / y 是页面坐标（pt），已经加上页边距；断行点用字符下标表示。
 */

import { parseDocx } from "../../src/docx/parse.js";
import { defaultLayoutOptions, layoutDocument } from "../../src/layout/index.js";
const PT_PER_PX = 0.75;

function pxToPt(value) {
  return Math.round(value * PT_PER_PX * 100) / 100;
}

function lineText(line) {
  return line.atoms.map((atom) => atom.text ?? "").join("");
}

function atomFont(atom) {
  if (!atom?.style) return "";
  return (atom.isCJK ? atom.style.fontEastAsia : atom.style.fontLatin) || "";
}

function lineFonts(line) {
  const fonts = [];
  for (const atom of line.atoms) {
    const font = atomFont(atom);
    if (font && fonts[fonts.length - 1] !== font) fonts.push(font);
  }
  return fonts;
}

/** 行内每个原子的起点 x（页面坐标，pt），用来定位断行点两侧的字符。 */
function atomPositions(line) {
  const out = [];
  let offset = 0;
  let x = line.paddingLeft;
  for (const atom of line.atoms) {
    const text = atom.text ?? "";
    out.push({
      offset,
      char: text,
      x: pxToPt(x),
      w: pxToPt(atom.width ?? 0),
      font: atomFont(atom),
    });
    offset += Array.from(text).length;
    x += atom.width ?? 0;
  }
  return out;
}

/** 一行在页面坐标里的指纹；`originX/Y` 是这一行所在容器（正文 / 单元格）的页面原点。 */
function lineEntry(line, lineIndex, originX, originY) {
  const baseline = line.baseline
    ?? Math.max(0, ...line.atoms.map((atom) => atom.ascent ?? 0));
  let x = originX + line.paddingLeft;
  if (line.alignment === "center") {
    x += (line.availableWidth - line.naturalWidth) / 2;
  } else if (line.alignment === "right" || line.alignment === "end") {
    x += line.availableWidth - line.naturalWidth;
  }
  return {
    index: lineIndex,
    blockKey: line.blockKey ?? line.paragraphIndex,
    para: line.paragraphIndex,
    lineInPara: line.lineIndex,
    text: lineText(line),
    x: pxToPt(x),
    y: pxToPt(originY + line.top),
    baseline: pxToPt(originY + line.top + baseline),
    width: pxToPt(line.naturalWidth),
    available: pxToPt(line.availableWidth),
    height: pxToPt(line.height),
    size: pxToPt(Math.max(0, ...line.atoms.map((atom) => atom.size ?? 0))),
    fonts: lineFonts(line),
    alignment: line.alignment,
    justified: line.justified,
    letterSpacing: pxToPt(line.letterSpacing ?? 0),
    spaceBefore: pxToPt(line.spaceBeforeApplied ?? 0),
    atoms: atomPositions(line),
  };
}

function pageLines(page, section) {
  const out = [];
  const items = page.items ?? page.lines.map((line) => ({ kind: "line", line }));
  for (const item of items) {
    if (item.kind === "line") {
      out.push(lineEntry(item.line, out.length, section.margin.left, section.margin.top));
      continue;
    }
    if (item.kind !== "table-row") continue;
    const table = item.table;
    for (const cell of item.row.cells) {
      if (cell.hidden) continue;
      const originX = section.margin.left + table.x + cell.x + (cell.margins?.left ?? 0);
      const originY = section.margin.top + item.top + (cell.contentTop ?? 0);
      for (const line of cell.lines ?? []) {
        out.push(lineEntry(line, out.length, originX, originY));
      }
    }
  }
  return out;
}

function fingerprint(layout) {
  const section = layout.section;
  const pages = layout.pages.map((page, pageIndex) => ({
    index: pageIndex,
    width: pxToPt(section.pageWidth),
    height: pxToPt(section.pageHeight),
    lines: pageLines(page, section),
  }));

  return {
    engine: "office-viewer",
    section: {
      pageWidth: pxToPt(section.pageWidth),
      pageHeight: pxToPt(section.pageHeight),
      margin: {
        top: pxToPt(section.margin.top),
        right: pxToPt(section.margin.right),
        bottom: pxToPt(section.margin.bottom),
        left: pxToPt(section.margin.left),
      },
      contentWidth: pxToPt(section.contentWidth),
      contentHeight: pxToPt(section.contentHeight),
      docGrid: section.docGrid,
    },
    stats: layout.laidOut,
    tables: layout.blocks.filter((block) => block.kind === "table").map((block) => ({
      x: block.x,
      width: block.width,
      rows: block.rows.map((row) => ({
        height: row.height,
        cells: row.cells.map((cell) => ({
          x: cell.x,
          width: cell.width,
          span: cell.span,
          rowSpan: cell.rowSpan,
          contentHeight: cell.contentHeight,
          contentTop: cell.contentTop,
          height: cell.height,
          hidden: cell.hidden,
          lines: (cell.lines ?? []).map((line) => ({ top: line.top, text: lineText(line) })),
        })),
      })),
    })),
    pages,
  };
}

/**
 * @param {ArrayBuffer} bytes
 * @param {object} [options] 阅读覆盖（字体/字号/行距…），差分默认全空。
 */
export async function runLayout(bytes, options = {}) {
  const model = await parseDocx(bytes);
  const layout = layoutDocument(model, {
    ...defaultLayoutOptions(),
    ...options,
  });
  return fingerprint(layout);
}

globalThis.runLayout = runLayout;
