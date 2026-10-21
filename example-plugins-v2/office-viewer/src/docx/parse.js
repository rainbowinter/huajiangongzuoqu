/**
 * DOCX → 渲染用的文档模型。
 *
 * 输出尽量「扁」：
 *
 *   blocks: [{ kind: "paragraph", props, items, numbering, ... }]
 *   items:  [{ kind: "text" | "tab" | "lineBreak" | "pageBreak" | "image", ... }]
 *
 * 排版引擎只需要认识 `items`，不需要再碰 OOXML。编辑层以后会在这之上加一层
 * 「段落 / run ↔ 原 XML 节点」的指针，所以这里保留 `block.node` 与 `run.node`。
 */

import { halfPointsToPx, twipsToPx } from "../units.js";
import {
  A_NS,
  R_NS,
  V_NS,
  W_NS,
  WP_NS,
  attr,
  child,
  children,
  firstDescendant,
  numAttr,
  parseXml,
} from "../xml.js";
import { ZipArchive } from "../zip.js";
import { numberingSuffix, nextNumberingLabel, parseNumbering } from "./numbering.js";
import { defaultRunProps, parseStyles, resolveParagraph, resolveRun } from "./styles.js";
import { parseSection, parseSettings } from "./section.js";
import { parseTheme, resolveThemeFont } from "./theme.js";

const HIGHLIGHT_COLORS = {
  black: "#000000",
  blue: "#0000ff",
  cyan: "#00ffff",
  green: "#00ff00",
  magenta: "#ff00ff",
  red: "#ff0000",
  yellow: "#ffff00",
  white: "#ffffff",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
};

const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function normalizeColor(value) {
  if (!value || value === "auto") return null;
  const match = /^([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value);
  return match ? `#${match[1].toLowerCase()}` : null;
}

function effectiveRunStyle(props, theme) {
  const fonts = props.fonts ?? {};
  const latin =
    fonts.ascii ??
    resolveThemeFont(theme, fonts.asciiTheme) ??
    fonts.hAnsi ??
    resolveThemeFont(theme, fonts.hAnsiTheme) ??
    theme.minor.latin;
  const eastAsia =
    fonts.eastAsia ??
    resolveThemeFont(theme, fonts.eastAsiaTheme) ??
    theme.minor.eastAsia;

  return {
    fontLatin: latin || "Calibri",
    fontEastAsia: eastAsia || "宋体",
    sizePx: halfPointsToPx(props.size ?? 21),
    bold: props.bold === true,
    italic: props.italic === true,
    underline: Boolean(props.underline) && props.underline !== "none",
    underlineStyle: props.underline ?? null,
    strike: props.strike === true,
    doubleStrike: props.doubleStrike === true,
    color: normalizeColor(props.color),
    background: props.highlight
      ? HIGHLIGHT_COLORS[props.highlight] ?? null
      : normalizeColor(props.shading),
    vertAlign: props.vertAlign ?? null,
    letterSpacingPx: twipsToPx(props.spacing ?? 0),
    caps: props.caps === true,
    smallCaps: props.smallCaps === true,
    lang: props.lang ?? null,
  };
}

/**
 * 文本 item 的来源信息。
 *
 * `node` / `runNode` 是编辑层写回 XML 的锚点；`nested` 表示这个 run 不直接挂在段落上
 * （超链接、修订、sdt 里），结构性分段/合并要绕开它。`editable:false` 的是合成内容
 * （编号、符号、表格拍平行）或图片，光标不能落进去、保存也不会写回。
 */
function sourceOf(node, runNode, nested, extra = {}) {
  return {
    node,
    runNode,
    nested,
    editable: true,
    synthetic: null,
    ...extra,
  };
}

function textItem(text, style, source = {}) {
  return text ? { kind: "text", text, style, ...source } : null;
}

function resolveTarget(baseDir, target) {
  if (/^[a-z]+:/i.test(target)) return null;
  const parts = `${baseDir}/${target}`.split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function parseRelationships(relationshipDocument) {
  const map = new Map();
  if (!relationshipDocument) return map;
  const root = relationshipDocument.documentElement;
  for (const element of root.children) {
    if (element.localName !== "Relationship") continue;
    const id = element.getAttribute("Id");
    const target = element.getAttribute("Target");
    if (!id || !target) continue;
    map.set(id, {
      target,
      type: element.getAttribute("Type") ?? "",
      external: element.getAttribute("TargetMode") === "External",
    });
  }
  return map;
}

function parseStyleValue(value) {
  const match = /^\s*([\d.]+)\s*(pt|px|in|cm|mm)?\s*$/i.exec(value ?? "");
  if (!match) return 0;
  const number = Number(match[1]);
  switch ((match[2] ?? "px").toLowerCase()) {
    case "pt":
      return (number * 4) / 3;
    case "in":
      return number * 96;
    case "cm":
      return (number * 96) / 2.54;
    case "mm":
      return (number * 96) / 25.4;
    default:
      return number;
  }
}

function vmlSize(shape) {
  const style = shape?.getAttribute("style") ?? "";
  const width = /(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style)?.[1];
  const height = /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(style)?.[1];
  return {
    width: parseStyleValue(width),
    height: parseStyleValue(height),
  };
}

function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function loadImage(context, relationshipId) {
  const relationship = context.relationships.get(relationshipId);
  if (!relationship || relationship.external) return null;
  const path = resolveTarget("word", relationship.target);
  if (!path) return null;
  if (context.imageCache.has(path)) return context.imageCache.get(path);

  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_TYPES[extension];
  if (!mime || !context.zip.has(path)) {
    const missing = { src: null, label: `[${extension ? extension.toUpperCase() : "图片"}]` };
    context.imageCache.set(path, missing);
    return missing;
  }

  try {
    const bytes = await context.zip.read(path);
    const result = { src: `data:${mime};base64,${arrayBufferToBase64(bytes)}`, label: null };
    context.imageCache.set(path, result);
    return result;
  } catch (error) {
    context.warnings.push(`图片 ${path} 读取失败：${error?.message ?? error}`);
    const failed = { src: null, label: "[图片读取失败]" };
    context.imageCache.set(path, failed);
    return failed;
  }
}

async function parseImage(element, style, context) {
  let relationshipId = null;
  let width = 0;
  let height = 0;
  let alt = "";
  let anchor = null;

  if (element.localName === "drawing") {
    const extent = firstDescendant(element, "extent", WP_NS);
    width = extent ? Number(extent.getAttribute("cx") ?? 0) / 9525 : 0;
    height = extent ? Number(extent.getAttribute("cy") ?? 0) / 9525 : 0;
    const blip = firstDescendant(element, "blip", A_NS);
    relationshipId = blip?.getAttributeNS(R_NS, "embed") ?? null;
    const docPr = firstDescendant(element, "docPr", WP_NS);
    alt = docPr?.getAttribute("descr") || docPr?.getAttribute("title") || "";

    const anchorElement = firstDescendant(element, "anchor", WP_NS);
    if (anchorElement) {
      const offset = (name) => {
        const position = firstDescendant(anchorElement, name, WP_NS);
        const value = firstDescendant(position, "posOffset", WP_NS);
        return {
          value: value ? Number(value.textContent ?? 0) / 9525 : 0,
          relativeFrom: position?.getAttribute("relativeFrom") ?? "",
        };
      };
      const horizontal = offset("positionH");
      const vertical = offset("positionV");
      const wrapNames = ["wrapNone", "wrapSquare", "wrapTight", "wrapThrough", "wrapTopAndBottom"];
      const wrap = wrapNames.find((name) => firstDescendant(anchorElement, name, WP_NS)) ?? "wrapNone";
      anchor = {
        x: horizontal.value,
        y: vertical.value,
        relativeH: horizontal.relativeFrom,
        relativeV: vertical.relativeFrom,
        behindDoc: anchorElement.getAttribute("behindDoc") === "1",
        wrap,
      };
    }
  } else if (element.localName === "pict") {
    const shape = firstDescendant(element, "shape", V_NS);
    const size = vmlSize(shape);
    width = size.width;
    height = size.height;
    const imageData = firstDescendant(element, "imagedata", V_NS);
    relationshipId = imageData?.getAttributeNS(R_NS, "id") ?? null;
    alt = imageData?.getAttribute("alt") ?? "";
  }

  if (!relationshipId) return null;
  const image = await loadImage(context, relationshipId);
  if (!image) return null;

  return {
    kind: "image",
    src: image.src,
    label: image.label,
    alt,
    width: width > 0 ? width : 240,
    height: height > 0 ? height : 180,
    anchor,
    style,
  };
}

async function parseRun(runElement, context, paragraphStyleChain, paragraphElement) {
  const props = resolveRun(runElement, paragraphStyleChain, context.styles);
  const style = effectiveRunStyle(props, context.theme);
  const items = [];
  const nested = runElement.parentElement !== paragraphElement;
  const source = (node, extra) => sourceOf(node, runElement, nested, extra);

  for (const element of runElement.children) {
    switch (element.localName) {
      case "t": {
        const item = textItem(element.textContent ?? "", style, source(element));
        if (item) items.push(item);
        break;
      }
      case "tab":
        items.push({ kind: "tab", style, ...source(element) });
        break;
      case "br": {
        const type = attr(element, "type");
        items.push({
          kind: type === "page" ? "pageBreak" : "lineBreak",
          ...source(element),
        });
        break;
      }
      case "cr":
        items.push({ kind: "lineBreak", ...source(element) });
        break;
      case "noBreakHyphen":
        items.push({
          kind: "text",
          text: "‑",
          style,
          ...source(element, { editable: false, synthetic: "symbol" }),
        });
        break;
      case "softHyphen":
        items.push({
          kind: "text",
          text: "­",
          style,
          ...source(element, { editable: false, synthetic: "symbol" }),
        });
        break;
      case "sym": {
        const code = attr(element, "char");
        if (code) {
          const font = attr(element, "font");
          items.push({
            kind: "text",
            text: String.fromCharCode(Number.parseInt(code, 16)),
            style: font
              ? {
                  ...style,
                  fontLatin: font,
                  fontEastAsia: font,
                }
              : style,
            ...source(element, { editable: false, synthetic: "symbol" }),
          });
        }
        break;
      }
      case "drawing":
      case "pict": {
        const image = await parseImage(element, style, context);
        if (image) {
          items.push({
            ...image,
            ...source(element, { editable: false }),
          });
        }
        break;
      }
      case "instrText":
      case "delText":
      case "fldChar":
      case "lastRenderedPageBreak":
      case "footnoteReference":
      case "endnoteReference":
      case "commentReference":
        break;
      default:
        // `w:t` 的兄弟元素里还有 `w:rPr`、`w:object` 等；M1 不认识的直接跳过，
        // 不往正文里塞占位符（那比少一点内容更容易让人误以为文档坏了）。
        break;
    }
  }

  return items;
}

async function parseParagraphItems(paragraphElement, context, paragraphStyleChain) {
  const items = [];

  const visit = async (element) => {
    for (const node of element.children) {
      if (node.namespaceURI !== W_NS) continue;
      switch (node.localName) {
        case "pPr":
        case "bookmarkStart":
        case "bookmarkEnd":
        case "proofErr":
        case "commentRangeStart":
        case "commentRangeEnd":
        case "commentReference":
          break;
        case "r":
          items.push(
            ...(await parseRun(node, context, paragraphStyleChain, paragraphElement)),
          );
          break;
        case "hyperlink":
        case "fldSimple":
        case "ins":
        case "smartTag":
        case "customXml":
          await visit(node);
          break;
        case "sdt":
          await visit(child(node, "sdtContent") ?? node);
          break;
        case "del":
          break;
        case "drawing":
        case "pict": {
          const image = await parseImage(node, null, context);
          if (image) items.push(image);
          break;
        }
        default:
          break;
      }
    }
  };

  await visit(paragraphElement);
  return items;
}

function collectPlainText(element) {
  let text = "";
  for (const node of element.getElementsByTagName("*")) {
    if (node.namespaceURI !== W_NS) continue;
    if (node.localName === "t") text += node.textContent ?? "";
    else if (node.localName === "tab") text += "\t";
    else if (node.localName === "br" || node.localName === "cr") text += "\n";
  }
  return text;
}

function borderFrom(element) {
  if (!element) return null;
  const style = attr(element, "val") ?? "single";
  if (style === "nil" || style === "none") return { style: "none", widthPx: 0 };
  return {
    style: "single",
    widthPx: (numAttr(element, "sz", 4) ?? 4) / 8 * (4 / 3),
    color: attr(element, "color") ?? "000000",
  };
}

function parseBorders(container) {
  if (!container) return null;
  const edges = ["top", "left", "bottom", "right", "insideH", "insideV"];
  const out = {};
  for (const edge of edges) {
    const border = borderFrom(child(container, edge));
    if (border) out[edge] = border;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseTableWidth(tblPr, contentWidth, gridWidths) {
  const widthElement = child(tblPr, "tblW");
  const type = attr(widthElement, "type") ?? "auto";
  const value = numAttr(widthElement, "w", 0) ?? 0;
  if (type === "pct") return (contentWidth * value) / 5000;
  if (type === "dxa" && value > 0) return twipsToPx(value);
  const sum = gridWidths.reduce((total, width) => total + width, 0);
  return sum > 0 ? sum : contentWidth;
}

function parseCellMargins(tblPr) {
  const margins = child(tblPr, "tblCellMar");
  const margin = { left: 108, right: 108, top: 0, bottom: 0 };
  if (!margins) return { ...margin, left: twipsToPx(108), right: twipsToPx(108) };
  for (const edge of ["left", "right", "top", "bottom"]) {
    const element = child(margins, edge);
    if (element) margin[edge] = numAttr(element, "w", 108) ?? 108;
  }
  return {
    left: twipsToPx(margin.left),
    right: twipsToPx(margin.right),
    top: twipsToPx(margin.top),
    bottom: twipsToPx(margin.bottom),
  };
}

/** 解析表格；单元格里的段落仍走完整的段落解析（字体 / 编号 / 图片）。 */
async function parseTable(tableElement, context, paragraphIndex, contentWidth) {
  const tblPr = child(tableElement, "tblPr");
  const gridWidths = children(child(tableElement, "tblGrid"), "gridCol").map(
    (column) => twipsToPx(numAttr(column, "w", 0) ?? 0),
  );
  let tableWidth = parseTableWidth(tblPr, contentWidth, gridWidths);
  if (gridWidths.length === 0) {
    const columnCount = Math.max(1, ...children(tableElement, "tr").map(
      (row) => children(row, "tc").reduce(
        (sum, cell) => sum + (numAttr(child(child(cell, "tcPr"), "gridSpan"), "val", 1) ?? 1),
        0,
      ),
    ));
    tableWidth = tableWidth > 0 ? tableWidth : contentWidth;
    gridWidths.push(...Array.from({ length: columnCount }, () => tableWidth / columnCount));
  }
  const gridSum = gridWidths.reduce((sum, width) => sum + width, 0);
  if (!(tableWidth > 0)) tableWidth = gridSum;
  // 列宽按 tblGrid；与 tblW 不一致时按比例缩放，保证整张表宽度自洽。
  const scale = gridSum > 0 ? tableWidth / gridSum : 1;
  const columnWidths = gridWidths.map((width) => width * scale);

  const alignment = attr(child(tblPr, "jc"), "val") ?? "left";
  const tableBorders = parseBorders(child(tblPr, "tblBorders"));
  const styleId = attr(child(tblPr, "tblStyle"), "val") ?? "";
  const borders = tableBorders ?? (/TableGrid/i.test(styleId)
    ? {
        top: { style: "single", widthPx: 0.5, color: "000000" },
        left: { style: "single", widthPx: 0.5, color: "000000" },
        bottom: { style: "single", widthPx: 0.5, color: "000000" },
        right: { style: "single", widthPx: 0.5, color: "000000" },
        insideH: { style: "single", widthPx: 0.5, color: "000000" },
        insideV: { style: "single", widthPx: 0.5, color: "000000" },
      }
    : null);
  const cellMargins = parseCellMargins(tblPr);

  const rows = [];
  let cellParagraphIndex = 0;
  for (const [rowIndex, rowElement] of children(tableElement, "tr").entries()) {
    const trPr = child(rowElement, "trPr");
    const cantSplitElement = trPr ? child(trPr, "cantSplit") : null;
    const row = {
      index: rowIndex,
      cantSplit: Boolean(cantSplitElement) && attr(cantSplitElement, "val") !== "0",
      tableHeader: Boolean(trPr ? child(trPr, "tblHeader") : null),
      height: null,
      heightRule: null,
      cells: [],
    };
    const heightElement = child(trPr, "trHeight");
    if (heightElement) {
      row.height = twipsToPx(numAttr(heightElement, "val", 0) ?? 0);
      row.heightRule = attr(heightElement, "hRule") ?? "atLeast";
    }

    let gridColumn = 0;
    for (const cellElement of children(rowElement, "tc")) {
      const tcPr = child(cellElement, "tcPr");
      const span = Math.max(1, numAttr(child(tcPr, "gridSpan"), "val", 1) ?? 1);
      const vMergeElement = child(tcPr, "vMerge");
      const vMerge = vMergeElement
        ? (attr(vMergeElement, "val") === "restart" ? "restart" : "continue")
        : null;
      if (gridColumn >= columnWidths.length) {
        // 超出 tblGrid 的单元格在 Word 里也会被忽略；顺手挡住不规范的生成器。
        context.warnings.push("表格行里的单元格数超过了 tblGrid，多出的单元格已忽略。");
        continue;
      }
      const tcWidthElement = child(tcPr, "tcW");
      const tcWidth = numAttr(tcWidthElement, "w", 0) ?? 0;
      const cellWidth = tcWidth > 0 && attr(tcWidthElement, "type") !== "pct"
        ? twipsToPx(tcWidth)
        : columnWidths
            .slice(gridColumn, gridColumn + span)
            .reduce((sum, width) => sum + width, 0);
      const paragraphs = [];
      for (const contentElement of cellElement.children) {
        if (contentElement.namespaceURI !== W_NS) continue;
        if (contentElement.localName === "p") {
          paragraphs.push(
            await parseParagraphElement(
              contentElement,
              context,
              cellParagraphIndex,
              `t${paragraphIndex}r${rowIndex}c${gridColumn}p${paragraphs.length}`,
            ),
          );
          cellParagraphIndex += 1;
        } else if (contentElement.localName === "tbl") {
          // 嵌套表格第一版按行拍平成段落，至少不丢文字；真正的嵌套布局留到后面。
          context.warnings.push("单元格里的嵌套表格暂时按行拍平成文本。");
          const style = effectiveRunStyle({}, context.theme);
          for (const nestedRow of children(contentElement, "tr")) {
            const text = children(nestedRow, "tc")
              .map((nestedCell) =>
                children(nestedCell, "p").map(collectPlainText).join(" ").trim(),
              )
              .filter(Boolean)
              .join("  |  ");
            if (!text) continue;
            const props = { jc: "left", spacing: { line: 240, lineRule: "auto" } };
            paragraphs.push({
              kind: "paragraph",
              index: cellParagraphIndex,
              key: `t${paragraphIndex}r${rowIndex}c${gridColumn}n${paragraphs.length}`,
              props,
              propsBase: props,
              items: [{ kind: "text", text, style }],
              labelItems: [],
              defaultStyle: style,
              numbering: null,
              outlineLevel: null,
              node: nestedRow,
              editable: false,
              synthetic: "nested-table",
            });
            cellParagraphIndex += 1;
          }
        }
      }
      const cellBorders = parseBorders(child(tcPr, "tcBorders"));
      const margins = { ...cellMargins };
      const cellMarginElement = child(tcPr, "tcMar");
      if (cellMarginElement) {
        for (const edge of ["left", "right", "top", "bottom"]) {
          const element = child(cellMarginElement, edge);
          if (element) margins[edge] = twipsToPx(numAttr(element, "w", 108) ?? 108);
        }
      }
      row.cells.push({
        gridColumn,
        span,
        vMerge,
        width: cellWidth,
        // 单元格段落按单元格可用宽度排版，渲染器再按 margins 内缩。
        blocks: paragraphs,
        fill: attr(child(tcPr, "shd"), "fill") ?? null,
        verticalAlign: attr(child(tcPr, "vAlign"), "val") ?? "top",
        borders: cellBorders,
        margins,
      });
      gridColumn += span;
    }

    rows.push(row);
  }
  // tcW / tblGrid 经常和 tblW 对不上（尤其是自动调整的表格）。以 tblW 为准，
  // 把每一行的单元格宽度按比例缩放到表宽，避免“表格 100%、单元格只占 90%”。
  for (const row of rows) {
    const sum = row.cells.reduce((total, cell) => total + cell.width, 0);
    if (!(sum > 0) || Math.abs(sum - tableWidth) <= 0.5) continue;
    const factor = tableWidth / sum;
    for (const cell of row.cells) cell.width *= factor;
  }

  // 纵向合并：restart 单元格统计后面同列的 continue，并把这些占位格标出来。
  // 必须等所有行都解析完再扫，否则看不到后面的行。
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (const cell of rows[rowIndex].cells) {
      if (cell.vMerge !== "restart") continue;
      cell.rowSpan = 1;
      for (let nextIndex = rowIndex + 1; nextIndex < rows.length; nextIndex += 1) {
        const target = rows[nextIndex].cells.find(
          (candidate) => candidate.gridColumn === cell.gridColumn,
        );
        if (!target || target.vMerge !== "continue") break;
        target.continuation = true;
        cell.rowSpan += 1;
      }
    }
  }

  return {
    kind: "table",
    index: paragraphIndex,
    key: `t${paragraphIndex}`,
    rows,
    props: {
      width: tableWidth,
      alignment,
      columnWidths,
      cellMargins,
      borders,
      styleId,
    },
    node: tableElement,
    editable: false,
    synthetic: null,
  };
}

function mergeNumberingIndent(props, level) {
  const source = level?.pPr?.ind;
  if (!source) return props;
  const target = { ...props.ind };
  for (const key of [
    "left", "right", "firstLine", "hanging",
    "leftChars", "rightChars", "firstLineChars", "hangingChars",
  ]) {
    if (target[key] === undefined && source[key] !== undefined) target[key] = source[key];
  }
  return { ...props, ind: target };
}

/**
 * 解析一个 `w:p`。编号标签**不在这里生成** —— 它依赖文档顺序上的计数器，
 * 单段重解析时算不准；统一交给 `refreshNumbering(doc)`。
 */
export async function parseParagraphElement(paragraphElement, context, index, key) {
  const resolved = resolveParagraph(paragraphElement, context.styles);
  const baseProps = resolved.props;
  const items = await parseParagraphItems(
    paragraphElement,
    context,
    resolved.styleChain,
  );

  return {
    kind: "paragraph",
    index,
    key,
    props: baseProps,
    propsBase: baseProps,
    items,
    labelItems: [],
    defaultStyle: effectiveRunStyle(
      defaultRunProps(context.styles, resolved.styleChain),
      context.theme,
    ),
    numbering: null,
    outlineLevel: baseProps.outlineLvl ?? null,
    node: paragraphElement,
    styleChain: resolved.styleChain,
    editable: true,
    synthetic: null,
  };
}

/** 段落文本（不含编号标签），用于统计与保存校验。 */
export function blockPlainText(block) {
  let text = "";
  for (const item of block.items ?? []) {
    if (item.kind === "text") text += item.text;
    else if (item.kind === "tab") text += "\t";
    else if (item.kind === "lineBreak") text += "\n";
  }
  return text;
}

/**
 * 按文档顺序重建所有编号标签与编号带来的缩进。
 *
 * 编号文字只存在于 `block.labelItems`，永远不写进 `items` / XML；分段、合并、撤销之后
 * 调一次即可，不必重解析整篇文档。
 */
export function refreshNumbering(doc) {
  const state = { counters: new Map() };
  for (const block of doc.blocks) {
    block.labelItems = [];
    block.numbering = null;
    if (block.propsBase) block.props = block.propsBase;

    const numPr = block.propsBase?.numPr;
    if (!numPr || block.editable === false) continue;

    const numbering = nextNumberingLabel(state, doc.numbering, numPr);
    if (!numbering) continue;

    block.props = mergeNumberingIndent(block.propsBase, numbering.level);
    const labelProps = defaultRunProps(doc.styles, block.styleChain ?? []);
    // 编号自己的 rPr 优先；没有就用段落的基础字符样式。
    const labelStyle = effectiveRunStyle(
      {
        ...labelProps,
        ...numbering.level?.rPr,
        fonts: {
          ...labelProps.fonts,
          ...numbering.level?.rPr?.fonts,
        },
      },
      doc.theme,
    );
    const suffix = numberingSuffix(numbering.suffix);
    const prefix = [];
    const source = {
      node: null,
      runNode: null,
      nested: false,
      editable: false,
      synthetic: "numbering",
    };
    if (numbering.text) {
      prefix.push({ kind: "text", text: numbering.text, style: labelStyle, ...source });
    }
    if (suffix === "\t") prefix.push({ kind: "tab", style: labelStyle, ...source });
    else if (suffix) prefix.push({ kind: "text", text: suffix, style: labelStyle, ...source });

    block.labelItems = prefix;
    block.numbering = { text: numbering.text, suffix: numbering.suffix };
    block.outlineLevel = block.props.outlineLvl ?? null;
  }
}

/**
 * 重新解析单个段落（XML 改完之后调）。
 *
 * 只替换这一块，不动其它块；编号与索引随后统一刷新。
 */
export async function reparseBlock(doc, block) {
  if (!block?.node || block.node.localName !== "p") return block;
  const parsed = await parseParagraphElement(
    block.node,
    doc.source.context,
    block.index,
    block.key,
  );
  parsed.editable = true;
  parsed.synthetic = null;
  if (block.container) {
    // 单元格段落不在 doc.blocks 里，替换回它所属的 cell.blocks。
    parsed.container = block.container;
    block.container.cell.blocks[block.container.index] = parsed;
  } else {
    doc.blocks[block.index] = parsed;
  }
  refreshNumbering(doc);
  rebuildBlockIndices(doc);
  return parsed;
}

/** 编辑后重算状态栏用的统计（表格数沿用解析时的值）。 */
export function recountStats(doc) {
  const stats = {
    paragraphs: 0,
    runs: 0,
    tables: doc.blocks.filter((block) => block.kind === "table").length,
    images: 0,
    chars: 0,
  };
  for (const block of doc.blocks) {
    if (block.synthetic || block.kind !== "paragraph") continue;
    stats.paragraphs += 1;
    for (const item of block.items ?? []) {
      if (item.kind === "text") {
        stats.runs += 1;
        stats.chars += item.text.length;
      } else if (item.kind === "image") {
        stats.images += 1;
      }
    }
  }
  doc.stats = stats;
  return stats;
}

/** 分段 / 合并之后重排 `index` 与 `keyToIndex`。 */
export function rebuildBlockIndices(doc) {
  doc.keyToIndex = new Map();
  doc.keyToBlock = new Map();
  doc.keyOrder = new Map();
  let order = 0;
  for (const [index, block] of doc.blocks.entries()) {
    block.index = index;
    if (block.key) {
      doc.keyToIndex.set(block.key, index);
      doc.keyToBlock.set(block.key, block);
    }
    if (block.kind !== "table") {
      if (block.key) doc.keyOrder.set(block.key, order++);
      continue;
    }
    for (const row of block.rows ?? []) {
      for (const cell of row.cells ?? []) {
        for (const [paragraphIndex, paragraph] of cell.blocks.entries()) {
          paragraph.index = paragraphIndex;
          paragraph.container = { table: block, row, cell, index: paragraphIndex };
          doc.keyToBlock.set(paragraph.key, paragraph);
          doc.keyOrder.set(paragraph.key, order);
          order += 1;
        }
      }
    }
  }
  return doc;
}

/** 遍历 `w:body` 生成段落 / 表格块；初次解析与撤销快照恢复共用。 */
async function buildBlocks(body, context, stats) {
  const blocks = [];

  const visitBody = async (parent) => {
    for (const element of parent.children) {
      if (element.namespaceURI !== W_NS) continue;
      if (element.localName === "p") {
        const paragraph = await parseParagraphElement(
          element,
          context,
          blocks.length,
          `p${blocks.length}`,
        );
        blocks.push(paragraph);
        stats.paragraphs += 1;
        stats.runs += paragraph.items.filter((item) => item.kind === "text").length;
        stats.images += paragraph.items.filter((item) => item.kind === "image").length;
        stats.chars += paragraph.items
          .filter((item) => item.kind === "text")
          .reduce((sum, item) => sum + item.text.length, 0);
      } else if (element.localName === "tbl") {
        stats.tables += 1;
        const table = await parseTable(
          element,
          context,
          blocks.length,
          context.section.contentWidth,
        );
        for (const row of table.rows) {
          for (const cell of row.cells) {
            for (const [paragraphIndex, paragraph] of cell.blocks.entries()) {
              // 单元格段落也参与编辑：记住自己在哪个表 / 行 / 单元格里。
              paragraph.index = paragraphIndex;
              paragraph.container = { table, row, cell, index: paragraphIndex };
              stats.paragraphs += 1;
              stats.chars += paragraph.items
                .filter((item) => item.kind === "text")
                .reduce((sum, item) => sum + item.text.length, 0);
              stats.images += paragraph.items.filter((item) => item.kind === "image").length;
            }
          }
        }
        blocks.push(table);
      } else if (element.localName === "sdt") {
        await visitBody(child(element, "sdtContent") ?? element);
      } else if (element.localName === "customXml" || element.localName === "altChunk") {
        if (element.localName === "customXml") await visitBody(element);
        else context.warnings.push("M1 不处理 altChunk（外部嵌入内容）。");
      }
    }
  };

  await visitBody(body);

  // 空文档也要有一页。占位段落的 node 是 `w:body`，第一次输入时再物化成真正的 `w:p`。
  if (blocks.length === 0) {
    blocks.push({
      kind: "paragraph",
      index: 0,
      key: "p0",
      props: {},
      propsBase: {},
      items: [],
      labelItems: [],
      defaultStyle: effectiveRunStyle({}, context.theme),
      numbering: null,
      outlineLevel: null,
      node: body,
      editable: false,
      synthetic: "empty-body",
    });
  }

  return blocks;
}

/**
 * 用一份新的 `document.xml` 重建整篇 IR。
 *
 * 撤销 / 重做用整份 XML 快照（第一版实现）；block key 按文档顺序重新分配，
 * 所以历史里记录的光标用「段落序号 + 文本偏移」，不能用 key。
 */
export async function replaceDocumentXml(doc, xmlText) {
  const documentXml = parseXml(xmlText, "word/document.xml");
  const body = child(documentXml.documentElement, "body");
  if (!body) throw new Error("快照里没有 w:body。");

  doc.source.documentXml = documentXml;
  doc.source.body = body;
  doc.source.context.warnings = [];

  const stats = { paragraphs: 0, runs: 0, tables: 0, images: 0, chars: 0 };
  doc.blocks = await buildBlocks(body, doc.source.context, stats);
  doc.stats = stats;
  doc.nextKey = doc.blocks.length;
  refreshNumbering(doc);
  rebuildBlockIndices(doc);
  return doc;
}

export async function parseDocx(bytes) {
  const zip = new ZipArchive(bytes);
  const documentXmlText = await zip.text("word/document.xml");
  // 保存时要保留原来那份 XML 声明；XMLSerializer 只给根元素，不给 prolog。
  const declaration = /^\s*(<\?xml[^>]*\?>)/.exec(documentXmlText)?.[1] ?? "";
  const documentXml = parseXml(documentXmlText, "word/document.xml");
  const stylesXml = await zip.textOrNull("word/styles.xml");
  const themeXml = await zip.textOrNull("word/theme/theme1.xml");
  const settingsXml = await zip.textOrNull("word/settings.xml");
  const numberingXml = await zip.textOrNull("word/numbering.xml");
  const relationshipsXml = await zip.textOrNull("word/_rels/document.xml.rels");

  const styles = parseStyles(stylesXml ? parseXml(stylesXml, "word/styles.xml") : null);
  const theme = parseTheme(themeXml ? parseXml(themeXml, "word/theme/theme1.xml") : null);
  const settings = parseSettings(settingsXml ? parseXml(settingsXml, "word/settings.xml") : null);
  const numbering = parseNumbering(
    numberingXml ? parseXml(numberingXml, "word/numbering.xml") : null,
  );
  const relationships = parseRelationships(
    relationshipsXml ? parseXml(relationshipsXml, "word/_rels/document.xml.rels") : null,
  );

  const body = child(documentXml.documentElement, "body");
  if (!body) throw new Error("这份 DOCX 没有 w:body。");

  const context = {
    zip,
    styles,
    theme,
    settings,
    numbering,
    relationships,
    section: parseSection(body),
    warnings: [],
    imageCache: new Map(),
  };

  const stats = { paragraphs: 0, runs: 0, tables: 0, images: 0, chars: 0 };
  const blocks = await buildBlocks(body, context, stats);

  const doc = {
    blocks,
    section: context.section,
    settings: context.settings,
    theme,
    styles,
    numbering,
    warnings: [...new Set(context.warnings)],
    stats,
    // 编辑与保存要用的「原件」：ZIP、document.xml 的 XMLDocument、解析上下文。
    source: { zip, documentXml, body, context, declaration },
    keyToIndex: new Map(),
    nextKey: blocks.length,
  };

  refreshNumbering(doc);
  rebuildBlockIndices(doc);
  return doc;
}
