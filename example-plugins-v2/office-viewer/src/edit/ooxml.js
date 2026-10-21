/**
 * 直接改 `word/document.xml` 的低层助手。
 *
 * 原则：**只动编辑命中的那些 `w:r` / `w:t`**，不重建段落、不碰未知内容。
 * 域代码、批注范围、书签、图片这些不认识的子元素原样留着。
 */

import { W_NS, attr, isW } from "../xml.js";
import { XML_NS } from "../xml.js";

/** 创建 `w:<name>`；沿用文档已有的 `w` 前缀（XMLSerializer 会补声明）。 */
export function createW(document, localName) {
  return document.createElementNS(W_NS, `w:${localName}`);
}

export function paragraphOf(block) {
  const node = block?.node;
  return isW(node, "p") ? node : null;
}

export function runPropsOf(runNode) {
  if (!runNode) return null;
  for (const child of runNode.children) {
    if (isW(child, "rPr")) return child;
  }
  return null;
}

/** 克隆一段 run 的 `w:rPr`；没有就返回 null（继承段落/文档默认）。 */
export function cloneRunProps(runNode) {
  const props = runPropsOf(runNode);
  return props ? props.cloneNode(true) : null;
}

/** `w:rPr` 子元素的 schema 顺序；插入新属性时按它排，Word 才不会挑刺。 */
const RPR_ORDER = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps",
  "strike", "dstrike", "color", "spacing", "w", "kern", "position",
  "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText",
  "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
  "specVanish", "oMath",
];

export function ensureRunProps(runNode) {
  const existing = runPropsOf(runNode);
  if (existing) return existing;
  const props = createW(runNode.ownerDocument, "rPr");
  runNode.insertBefore(props, runNode.firstChild);
  return props;
}

function rprChild(props, name) {
  for (const child of props.children) {
    if (isW(child, name)) return child;
  }
  return null;
}

function ensureRprChild(props, name) {
  const existing = rprChild(props, name);
  if (existing) return existing;
  const element = createW(props.ownerDocument, name);
  const order = RPR_ORDER.indexOf(name);
  const next = Array.from(props.children).find((child) => {
    const index = RPR_ORDER.indexOf(child.localName);
    return index >= 0 && order >= 0 && index > order;
  });
  props.insertBefore(element, next ?? null);
  return element;
}

function removeRprChild(props, name) {
  for (const child of Array.from(props.children)) {
    if (isW(child, name)) props.removeChild(child);
  }
}

function toggleValue(element) {
  if (!element) return false;
  const value = attr(element, "val");
  return value === null || !["0", "false", "off", "none"].includes(value);
}

/** 某一段 run 当前有没有这个字符格式。 */
export function runFormatState(runNode, key) {
  const props = runPropsOf(runNode);
  if (!props) return false;
  if (key === "bold") return toggleValue(rprChild(props, "b"));
  if (key === "italic") return toggleValue(rprChild(props, "i"));
  if (key === "underline") return toggleValue(rprChild(props, "u"));
  if (key === "strike") return toggleValue(rprChild(props, "strike"));
  if (key === "vertAlign") {
    const element = rprChild(props, "vertAlign");
    return element ? attr(element, "val") : null;
  }
  return false;
}

/**
 * 把一种字符格式写到 run 上。
 *
 * `format = { key, value? }`；bold / italic / underline / strike 不带 value 时
 * 由调用方先算好“开还是关”，这里只负责写。
 */
export function setRunFormat(runNode, format) {
  const props = ensureRunProps(runNode);
  const { key, value } = format;

  if (key === "bold" || key === "italic") {
    const name = key === "bold" ? "b" : "i";
    const alias = `${name}Cs`;
    if (value) {
      ensureRprChild(props, name);
      ensureRprChild(props, alias);
    } else {
      removeRprChild(props, name);
      removeRprChild(props, alias);
    }
    return;
  }

  if (key === "underline" || key === "strike") {
    if (value) {
      const element = ensureRprChild(props, key === "underline" ? "u" : "strike");
      if (key === "underline") element.setAttributeNS(W_NS, "w:val", "single");
    } else {
      removeRprChild(props, key === "underline" ? "u" : "strike");
    }
    return;
  }

  if (key === "vertAlign") {
    if (value === "superscript" || value === "subscript") {
      ensureRprChild(props, "vertAlign").setAttributeNS(W_NS, "w:val", value);
    } else {
      removeRprChild(props, "vertAlign");
    }
    return;
  }

  if (key === "color") {
    if (value) {
      ensureRprChild(props, "color").setAttributeNS(W_NS, "w:val", String(value));
    } else {
      removeRprChild(props, "color");
    }
    return;
  }
}

/** 只统计顶层 run 里的文字长度（tab / 换行 / 图片按 1 个位置算）。 */
function runTextLength(run) {
  let length = 0;
  for (const child of run.children) {
    if (isW(child, "rPr")) continue;
    if (isW(child, "t")) length += Array.from(child.textContent ?? "").length;
    else length += 1;
  }
  return length;
}

/** 在 run 内部的某个字符位置拆成两个 run（右边克隆 rPr）。 */
function splitRunAtLocal(paragraph, run, localOffset) {
  let remaining = localOffset;
  let first = true;
  for (const child of Array.from(run.childNodes)) {
    if (child.nodeType === 1 && isW(child, "rPr")) continue;
    const length = isW(child, "t")
      ? Array.from(child.textContent ?? "").length
      : 1;

    if (remaining === 0) {
      if (!first) splitRunBefore(paragraph, run, child);
      return;
    }
    if (remaining < length) {
      if (isW(child, "t")) {
        const right = splitTextNode(child, remaining);
        if (right) splitRunBefore(paragraph, run, right);
      }
      return;
    }
    remaining -= length;
    first = false;
  }
}

/**
 * 在段落的某个文本偏移处把 run 切开，让选区边界落在 run 边界上。
 * 只处理顶层的 `w:r`；超链接 / 修订里的嵌套 run 暂不支持结构化切分。
 */
export function splitRunsAtOffset(block, offset) {
  const paragraph = paragraphOf(block);
  if (!paragraph || offset <= 0) return;
  let position = 0;
  for (const run of paragraph.children) {
    if (!isW(run, "r")) continue;
    const length = runTextLength(run);
    if (offset > position && offset < position + length) {
      splitRunAtLocal(paragraph, run, offset - position);
      return;
    }
    if (offset === position + length) return;
    position += length;
  }
}

/** 选区覆盖到的顶层 run。 */
export function runsInRange(block, start, end) {
  const paragraph = paragraphOf(block);
  if (!paragraph) return [];
  const result = [];
  let position = 0;
  for (const run of paragraph.children) {
    if (!isW(run, "r")) continue;
    const length = runTextLength(run);
    if (length > 0 && position + length > start && position < end) result.push(run);
    position += length;
  }
  return result;
}

/** 设置 `w:t` 文本，并保留前后空格。 */
export function setTextNode(textNode, text) {
  if (!textNode) return;
  textNode.textContent = text;
  textNode.setAttributeNS(XML_NS, "xml:space", "preserve");
}

function makeTextNode(document, text) {
  const node = createW(document, "t");
  setTextNode(node, text);
  return node;
}

/** 新建一个 run：可选克隆来源 run 的 rPr，再放入一段文字。 */
export function makeTextRun(document, text, rPrSourceRun = null, rPrSourceNode = null) {
  const run = createW(document, "r");
  const props = rPrSourceNode
    ? rPrSourceNode.cloneNode(true)
    : cloneRunProps(rPrSourceRun);
  if (props) run.appendChild(props);
  run.appendChild(makeTextNode(document, text));
  return run;
}

/** 把节点插在 `reference` 之前 / 之后；reference 为空时放到段落末尾。 */
export function insertNear(paragraph, reference, node, before) {
  if (reference?.parentNode) {
    reference.parentNode.insertBefore(node, before ? reference : reference.nextSibling);
    return node;
  }
  paragraph.appendChild(node);
  return node;
}

function previousItem(items, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (items[cursor]?.runNode) return items[cursor];
  }
  return null;
}

/** 在光标处插入文字；返回被改动的 `w:t`（或新建的 run）。 */
export function insertText(block, caret, text) {
  const paragraph = paragraphOf(block);
  if (!paragraph || !text) return null;

  const items = block.items ?? [];
  const item = items[caret.itemIndex];
  if (item?.kind === "text" && item.node?.parentNode) {
    const chars = Array.from(item.node.textContent ?? "");
    const offset = Math.max(0, Math.min(caret.offset ?? 0, chars.length));
    chars.splice(offset, 0, ...Array.from(text));
    setTextNode(item.node, chars.join(""));
    return item.node;
  }

  const document = paragraph.ownerDocument;
  const styleSource = item?.runNode ?? previousItem(items, caret.itemIndex)?.runNode ?? null;
  const run = makeTextRun(document, text, styleSource);

  if (item?.runNode) {
    insertNear(paragraph, item.runNode, run, true);
  } else {
    const last = items[items.length - 1];
    if (last?.runNode) insertNear(paragraph, last.runNode, run, false);
    else paragraph.appendChild(run);
  }
  return run;
}

/** run 里除了 `w:rPr` 之外还有内容吗？ */
function runHasContent(runNode) {
  for (const child of runNode.childNodes) {
    if (child.nodeType === 3 && child.textContent.trim()) return true;
    if (child.nodeType === 1 && !isW(child, "rPr")) return true;
  }
  return false;
}

/** 清掉空 run；域代码 / 批注范围等未知子元素会让 run 保留下来。 */
export function cleanupRun(runNode) {
  if (!runNode?.parentNode) return;
  if (!runHasContent(runNode)) runNode.parentNode.removeChild(runNode);
}

function removeNode(node) {
  if (!node?.parentNode) return;
  const run = node.parentNode;
  run.removeChild(node);
  if (isW(run, "r")) cleanupRun(run);
}

/**
 * 删除同一段内的半开区间 `[start, end)`（段落文本偏移）。
 *
 * 从后往前删：前面的 item 偏移不会因为后面的删除而改变。
 */
export function deleteRange(block, start, end) {
  const items = block.items ?? [];
  const ranges = [];
  let offset = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const length = item.kind === "text" ? Array.from(item.text ?? "").length : 1;
    ranges.push({ item, start: offset, end: offset + length });
    offset += length;
  }

  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    const from = Math.max(start, range.start);
    const to = Math.min(end, range.end);
    if (to <= from) continue;

    const item = range.item;
    if (item.kind === "text" && item.node) {
      const chars = Array.from(item.node.textContent ?? "");
      const localFrom = from - range.start;
      const localTo = to - range.start;
      chars.splice(localFrom, localTo - localFrom);
      setTextNode(item.node, chars.join(""));
      if (chars.length === 0) removeNode(item.node);
      continue;
    }
    // 制表符 / 换行 / 图片 / 符号：整颗删掉。
    removeNode(item.node);
  }
}

/** 光标所在的 `w:t`；不在文本 item 上时返回 null。 */
export function textNodeAt(block, caret) {
  const item = block?.items?.[caret?.itemIndex];
  return item?.kind === "text" ? item.node : null;
}

// ---------------------------------------------------------------- 列表

function directParagraphProps(paragraph) {
  return paragraph?.children
    ? Array.from(paragraph.children).find((node) => isW(node, "pPr")) ?? null
    : null;
}

function numberingProperties(paragraph) {
  const pPr = directParagraphProps(paragraph);
  if (!pPr?.children) return null;
  return Array.from(pPr.children).find((node) => isW(node, "numPr")) ?? null;
}

/**
 * 去掉这一段的列表属性（项目符号 / 编号）。
 *
 * Word 的行为：光标在列表项开头按退格，第一次只取消列表格式、文字留下；
 * 再按一次才会并到上一段。`w:ind` 里如果只是编号带来的缩进，会随编号一起失效。
 */
export function removeListNumbering(block) {
  const paragraph = paragraphOf(block);
  if (!paragraph) return false;
  const pPr = directParagraphProps(paragraph);
  const numPr = numberingProperties(paragraph);
  if (!pPr || !numPr) return false;
  pPr.removeChild(numPr);
  return true;
}

/** 多级列表：把当前段升/降一级（`w:ilvl`）。返回是否真的改了。 */
export function changeListLevel(block, delta) {
  const paragraph = paragraphOf(block);
  if (!paragraph) return false;
  const numPr = numberingProperties(paragraph);
  if (!numPr) return false;

  const ilvl = Array.from(numPr.children).find((node) => isW(node, "ilvl"));
  const current = ilvl ? Number(attr(ilvl, "val") ?? 0) : 0;
  const next = current + delta;
  if (!Number.isFinite(next) || next < 0) return false;

  if (ilvl) {
    ilvl.setAttributeNS(W_NS, "w:val", String(next));
  } else {
    const created = createW(paragraph.ownerDocument, "ilvl");
    created.setAttributeNS(W_NS, "w:val", String(next));
    numPr.insertBefore(created, numPr.firstChild);
  }
  return true;
}

// ---------------------------------------------------------------- 分段 / 合并

function splitTextNode(textNode, offset) {
  const chars = Array.from(textNode.textContent ?? "");
  if (offset <= 0 || offset >= chars.length) return null;
  const right = textNode.cloneNode(false);
  setTextNode(textNode, chars.slice(0, offset).join(""));
  setTextNode(right, chars.slice(offset).join(""));
  textNode.parentNode.insertBefore(right, textNode.nextSibling);
  return right;
}

/**
 * 在 `run` 里的 `node` 之前把 run 拆成两半，返回新的右半边 run。
 * 右半边会克隆原 run 的 `w:rPr`，并接收 `node` 及其后的所有兄弟。
 */
function splitRunBefore(paragraph, run, node) {
  const right = createW(paragraph.ownerDocument, "r");
  const props = runPropsOf(run);
  if (props) right.appendChild(props.cloneNode(true));

  let moving = false;
  for (const child of Array.from(run.childNodes)) {
    if (moving) {
      right.appendChild(child);
      continue;
    }
    if (child === node) {
      moving = true;
      right.appendChild(child);
    }
  }
  run.parentNode.insertBefore(right, run.nextSibling);
  return right;
}

function cloneParagraphProperties(paragraph) {
  for (const child of paragraph.children) {
    if (!isW(child, "pPr")) continue;
    const clone = child.cloneNode(true);
    // 分节符只留在原段落上，不能复制到新段落。
    for (const section of Array.from(clone.children)) {
      if (isW(section, "sectPr")) clone.removeChild(section);
    }
    return clone;
  }
  return null;
}

function paragraphHasSectionBreak(paragraph) {
  for (const child of paragraph.children) {
    if (!isW(child, "pPr")) continue;
    for (const inner of child.children) {
      if (isW(inner, "sectPr")) return true;
    }
  }
  return false;
}

/**
 * 在光标处把段落拆成两段。
 *
 * 返回新段落的 `w:p` 节点；调用方负责重解析与插入 block。
 * 不支持：表格拍平行、嵌套容器（超链接/修订/sdt）里的光标、带分节符的段落。
 */
export function splitParagraphAt(block, caret) {
  const paragraph = paragraphOf(block);
  if (!paragraph) return { unsupported: "not-paragraph" };
  if (paragraphHasSectionBreak(paragraph)) return { unsupported: "section" };

  const items = block.items ?? [];
  const item = items[caret.itemIndex];
  if (item?.nested) return { unsupported: "nested" };

  let anchor = null;
  let splitNode = null;

  if (item?.kind === "text" && item.node?.parentNode) {
    const chars = Array.from(item.node.textContent ?? "");
    const offset = Math.max(0, Math.min(caret.offset ?? 0, chars.length));
    splitNode = item.node;
    if (offset > 0 && offset < chars.length) {
      const rightText = splitTextNode(item.node, offset);
      splitNode = rightText;
      anchor = splitRunBefore(paragraph, item.node.parentNode, rightText);
    } else if (offset === 0) {
      anchor = splitRunBefore(paragraph, item.node.parentNode, item.node);
    } else {
      // 在文本末尾回车：切点就在这个 run 之后。
      const after = item.node.parentNode.nextSibling;
      anchor = after ?? null;
    }
  } else if (item?.node?.parentNode) {
    // 制表符 / 换行 / 图片 / 符号：切在它前面。
    anchor = splitRunBefore(paragraph, item.node.parentNode, item.node);
  } else {
    anchor = null;
  }

  if (splitNode && !anchor) {
    // offset === 0 时 splitRunBefore 已经处理；其它情况 anchor 就是右半边。
  }

  const document = paragraph.ownerDocument;
  const created = createW(document, "p");
  const props = cloneParagraphProperties(paragraph);
  if (props) created.appendChild(props);
  paragraph.parentNode.insertBefore(created, paragraph.nextSibling);

  if (anchor) {
    let moving = false;
    for (const child of Array.from(paragraph.childNodes)) {
      if (isW(child, "pPr")) continue;
      if (!moving) {
        if (child === anchor) moving = true;
        else continue;
      }
      created.appendChild(child);
    }
  }

  return { node: created, element: paragraph };
}

function nextParagraphElement(block) {
  let node = block?.node?.nextSibling ?? null;
  // 跳过元素之间的空白文本；只要碰到任何非 `w:p` 的元素（表格、sectPr…）就拒绝合并。
  while (node && node.nodeType !== 1) node = node.nextSibling;
  return isW(node, "p") ? node : null;
}

/** 把 `next` 段落并进 `block`（段首退格）；返回被删掉的段落节点。 */
export function mergeParagraphs(block, nextBlock) {
  const paragraph = paragraphOf(block);
  const next = paragraphOf(nextBlock);
  if (!paragraph || !next) return { unsupported: "not-paragraph" };
  if (paragraph.parentNode !== next.parentNode) return { unsupported: "different-parent" };
  if (paragraphHasSectionBreak(next)) return { unsupported: "section" };
  if (nextParagraphElement(block) !== next) return { unsupported: "not-adjacent" };

  for (const child of Array.from(next.childNodes)) {
    if (isW(child, "pPr")) continue;
    paragraph.appendChild(child);
  }
  next.parentNode.removeChild(next);
  return { node: paragraph };
}

/** 空文档（node 是 w:body）物化成真正的段落，插在末尾 sectPr 之前。 */
export function materializeParagraph(body) {
  const document = body.ownerDocument;
  const paragraph = createW(document, "p");
  let reference = null;
  for (const child of body.children) {
    if (isW(child, "sectPr")) {
      reference = child;
      break;
    }
  }
  body.insertBefore(paragraph, reference);
  return paragraph;
}

/** 在光标处插入一个原子 run（`w:br` / `w:tab`）。 */
function insertAtomic(block, caret, localName) {
  const paragraph = paragraphOf(block);
  if (!paragraph) return null;
  const items = block.items ?? [];
  const item = items[caret.itemIndex];
  const document = paragraph.ownerDocument;
  const run = createW(document, "r");
  const source = item?.runNode ?? items[caret.itemIndex - 1]?.runNode ?? null;
  const props = cloneRunProps(source);
  if (props) run.appendChild(props);
  run.appendChild(createW(document, localName));

  if (item?.kind === "text" && item.node?.parentNode) {
    const chars = Array.from(item.node.textContent ?? "");
    const offset = Math.max(0, Math.min(caret.offset ?? 0, chars.length));
    if (offset > 0 && offset < chars.length) {
      // 光标在一个 `w:t` 中间：把文字拆成左右两半，原子放在中间。
      const rightText = splitTextNode(item.node, offset);
      const rightRun = splitRunBefore(paragraph, item.node.parentNode, rightText);
      insertNear(paragraph, rightRun, run, true);
      return run;
    }
    const atEnd = offset >= chars.length;
    insertNear(paragraph, item.runNode, run, !atEnd);
  } else if (item?.runNode) {
    insertNear(paragraph, item.runNode, run, true);
  } else {
    const last = items[items.length - 1];
    if (last?.runNode) insertNear(paragraph, last.runNode, run, false);
    else paragraph.appendChild(run);
  }
  return run;
}

export function insertLineBreak(block, caret) {
  return insertAtomic(block, caret, "br");
}

export function insertTab(block, caret) {
  return insertAtomic(block, caret, "tab");
}

function element(document, localName, attrs = {}) {
  const node = createW(document, localName);
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttributeNS(W_NS, `w:${name}`, String(value));
  }
  return node;
}

/**
 * 新建一张最基本的表格：等宽列、单线边框、普通单元格。
 *
 * `widthPx` 是正文栏宽；列宽按 twip 均分（1px = 15twip）。
 */
export function createTable(document, rows, cols, widthPx) {
  const table = createW(document, "tbl");

  const props = createW(document, "tblPr");
  props.appendChild(element(document, "tblW", { w: 5000, type: "pct" }));
  props.appendChild(element(document, "jc", { val: "left" }));

  const borders = createW(document, "tblBorders");
  for (const edge of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
    borders.appendChild(
      element(document, edge, { val: "single", sz: 4, space: 0, color: "000000" }),
    );
  }
  props.appendChild(borders);

  const margins = createW(document, "tblCellMar");
  margins.appendChild(element(document, "top", { w: 0, type: "dxa" }));
  margins.appendChild(element(document, "left", { w: 108, type: "dxa" }));
  margins.appendChild(element(document, "bottom", { w: 0, type: "dxa" }));
  margins.appendChild(element(document, "right", { w: 108, type: "dxa" }));
  props.appendChild(margins);
  table.appendChild(props);

  const columnTwips = Math.max(600, Math.round((widthPx / 15) / cols));
  const grid = createW(document, "tblGrid");
  for (let col = 0; col < cols; col += 1) {
    grid.appendChild(element(document, "gridCol", { w: columnTwips }));
  }
  table.appendChild(grid);

  for (let row = 0; row < rows; row += 1) {
    const tr = createW(document, "tr");
    for (let col = 0; col < cols; col += 1) {
      const tc = createW(document, "tc");
      const tcPr = createW(document, "tcPr");
      tcPr.appendChild(element(document, "tcW", { w: columnTwips, type: "dxa" }));
      tc.appendChild(tcPr);
      tc.appendChild(createW(document, "p"));
      tr.appendChild(tc);
    }
    table.appendChild(tr);
  }

  return table;
}
