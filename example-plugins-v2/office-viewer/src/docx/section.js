/**
 * 页面设置与全局设置。
 *
 * M1 只取**最后一个 sectPr**（绝大多数文档只有一个节）。分节符、分栏、页眉页脚
 * 的位置先留着，等分页引擎稳定后再接。
 */

import { attr, child, children, numAttr, val } from "../xml.js";
import { twipsToPx } from "../units.js";

const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;

function lastSectionElement(bodyElement) {
  const direct = children(bodyElement, "sectPr");
  if (direct.length > 0) return direct[direct.length - 1];

  let found = null;
  for (const paragraph of children(bodyElement, "p")) {
    const section = child(child(paragraph, "pPr"), "sectPr");
    if (section) found = section;
  }
  return found;
}

export function parseSection(bodyElement) {
  const sectPr = lastSectionElement(bodyElement);
  const pageSize = child(sectPr, "pgSz");
  const margins = child(sectPr, "pgMar");
  const columns = child(sectPr, "cols");
  const grid = child(sectPr, "docGrid");

  let widthTwips = numAttr(pageSize, "w", A4_WIDTH_TWIPS) ?? A4_WIDTH_TWIPS;
  let heightTwips = numAttr(pageSize, "h", A4_HEIGHT_TWIPS) ?? A4_HEIGHT_TWIPS;
  if (attr(pageSize, "orient") === "landscape" && widthTwips < heightTwips) {
    [widthTwips, heightTwips] = [heightTwips, widthTwips];
  }

  const margin = {
    top: twipsToPx(numAttr(margins, "top", 1440)),
    right: twipsToPx(numAttr(margins, "right", 1800)),
    bottom: twipsToPx(numAttr(margins, "bottom", 1440)),
    left: twipsToPx(numAttr(margins, "left", 1800)),
    header: twipsToPx(numAttr(margins, "header", 851)),
    footer: twipsToPx(numAttr(margins, "footer", 992)),
    gutter: twipsToPx(numAttr(margins, "gutter", 0)),
  };

  const pageWidth = twipsToPx(widthTwips);
  const pageHeight = twipsToPx(heightTwips);
  const columnCount = Math.max(1, numAttr(columns, "num", 1) ?? 1);
  const columnSpace = twipsToPx(numAttr(columns, "space", 425));
  const contentWidth =
    pageWidth - margin.left - margin.right - margin.gutter;

  return {
    pageWidth,
    pageHeight,
    margin,
    contentWidth: columnCount > 1
      ? (contentWidth - columnSpace * (columnCount - 1)) / columnCount
      : contentWidth,
    contentHeight: pageHeight - margin.top - margin.bottom,
    columns: { count: columnCount, space: columnSpace },
    docGrid: {
      type: attr(grid, "type") ?? "default",
      linePitch: twipsToPx(numAttr(grid, "linePitch", 312)),
      charSpace: numAttr(grid, "charSpace", 0) ?? 0,
      snapsLines:
        attr(grid, "type") === "lines" || attr(grid, "type") === "linesAndChars",
    },
  };
}

export function parseSettings(settingsDocument) {
  if (!settingsDocument) {
    return { defaultTabStop: twipsToPx(420) };
  }
  const root = settingsDocument.documentElement;
  return {
    defaultTabStop: twipsToPx(numAttr(child(root, "defaultTabStop"), "val", 420)),
    characterSpacingControl: val(child(root, "characterSpacingControl")),
  };
}
