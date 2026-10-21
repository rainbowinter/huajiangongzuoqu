/**
 * 文本 → 排版原子。
 *
 * 原子是行排版的最小单位：
 *
 * * 中文按**单字**
 * * 西文按**词**（`Calibri` 不拆）
 * * 空格、制表符、图片各自一个原子
 *
 * 每个原子自带宽度与行高度量，行排版只做加法，不再回头碰字体。
 */

import { effectiveSizePx, fontMetrics, measureText } from "./measure.js";

const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/u;
const WHITESPACE_RE = /\s/u;
const WORD_CHAR_RE = /[A-Za-z0-9_'’-]/;

/**
 * 行首禁则：这些字符不能出现在一行的开头。
 * 中西文混排时两边都要管，否则「，」跑到行首会被用户一眼看出来。
 */
export const NO_START = new Set(
  Array.from("，。、；：？！）］｝〉》」』】〙〗〟’”｠»,.;:?!)]}»"),
);

/** 行尾禁则：这些字符不能留在一行的末尾。 */
export const NO_END = new Set(
  Array.from("（［｛〔〈《「『【〘〖〝‘“｟«([{«"),
);

const LATIN_CLOSING = new Set(Array.from(",.;:?!)]}»"));

/** 数字后面的单位：`9月`、`2026年` 不能拆成两行。 */
const NUMBER_UNIT = new Set(
  Array.from("年月日时分秒点号个只件条页章节次人元角米克升度倍期届岁天周"),
);

/** 数字前面的常见提示字：`第1章`、`共3个` 尽量别拆。 */
const NUMBER_PREFIX = new Set(Array.from("第共约超近至每前后"));

function scaledStyle(style) {
  if (style.vertAlign !== "superscript" && style.vertAlign !== "subscript") return style;
  return { ...style, sizeFactor: (style.sizeFactor ?? 1) * VERTICAL_SCALE };
}

/**
 * 上下标的纵向度量。
 *
 * Word/WPS 把上下标画成 65% 字号，并相对**原字号**的基线抬升 / 压低；
 * 但行高仍按原字号撑开（否则整段上下标会把行距压扁，C05 实测 WPS 19.92pt）。
 * `baselineShift` 为正表示基线上移（上标），为负表示下移（下标）。
 */
const VERTICAL_SCALE = 0.65;
const SUPERSCRIPT_SHIFT = 0.33;
const SUBSCRIPT_SHIFT = 0.14;

function verticalShift(style, size) {
  if (style.vertAlign === "superscript") return size * SUPERSCRIPT_SHIFT;
  if (style.vertAlign === "subscript") return -size * SUBSCRIPT_SHIFT;
  return 0;
}

/**
 * 原子的来源坐标。编辑层靠它把「点在第几个字」映射回 `block.items[itemIndex]`
 * 的第 `offset` 个码点。`itemIndex = -1` 是编号标签，不可编辑。
 */
function makeSource(itemIndex, charStart, charEnd, item) {
  return {
    itemIndex,
    charStart,
    charEnd,
    editable: item?.editable !== false,
    synthetic: item?.synthetic ?? null,
  };
}

function makeTextAtom(
  text,
  rawStyle,
  options,
  isSpace = false,
  alreadyScaled = false,
  source = null,
) {
  const style = isSpace || alreadyScaled ? rawStyle : scaledStyle(rawStyle);
  const isCJK = !isSpace && CJK_RE.test(text);
  const metrics = fontMetrics(style, isCJK, options);
  // 上下标的宽度用缩放后的字号，纵向却按原字号算：行高不能被压扁，
  // 基线的抬升/压低量也按原字号折算。
  const vertical = isSpace
    ? metrics
    : fontMetrics(rawStyle, isCJK, options);
  const shift = isSpace ? 0 : verticalShift(rawStyle, vertical.size);
  const ascent = vertical.ascent - shift;
  return {
    kind: "text",
    text,
    style,
    isCJK,
    isSpace,
    width: measureText(text, style, isCJK, options),
    lineHeight: vertical.lineHeight,
    ascent,
    descent: Math.max(0, vertical.lineHeight - ascent),
    baselineShift: shift,
    size: effectiveSizePx(style, options),
    ...source,
  };
}

function makeTabAtom(style, options, source = null) {
  const metrics = fontMetrics(style, false, options);
  return {
    kind: "tab",
    style,
    isTab: true,
    width: 0,
    lineHeight: metrics.lineHeight,
    ascent: metrics.ascent,
    descent: metrics.descent,
    size: effectiveSizePx(style, options),
    ...source,
  };
}

function pushTextAtoms(atoms, item, itemIndex, options) {
  const text = item.text;
  const style = item.style;
  const chars = Array.from(text);
  let word = "";
  let wordStart = 0;

  const source = (start) => makeSource(itemIndex, start, start + 1, item);

  const flushWord = () => {
    if (!word) return;
    const length = Array.from(word).length;
    atoms.push(
      makeTextAtom(
        word,
        style,
        options,
        false,
        false,
        makeSource(itemIndex, wordStart, wordStart + length, item),
      ),
    );
    word = "";
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];

    if (char === "\n") {
      flushWord();
      atoms.push({
        kind: "control",
        type: "lineBreak",
        ...source(index),
      });
      continue;
    }
    if (char === "\t") {
      flushWord();
      atoms.push(makeTabAtom(style, options, source(index)));
      continue;
    }
    if (WHITESPACE_RE.test(char)) {
      flushWord();
      atoms.push(makeTextAtom(char, style, options, true, false, source(index)));
      continue;
    }

    if (WORD_CHAR_RE.test(char)) {
      // 连字符 / 撇号只在词中间算词的一部分：`well-known` 是一个词，
      // 而 `-` 单独出现时仍然是可以断开的标点。
      const isInnerJoin = char === "-" || char === "'" || char === "’";
      if (
        isInnerJoin &&
        !(WORD_CHAR_RE.test(chars[index - 1] ?? "") && WORD_CHAR_RE.test(chars[index + 1] ?? ""))
      ) {
        flushWord();
        atoms.push(makeTextAtom(char, style, options, false, false, source(index)));
        continue;
      }
      if (!word) wordStart = index;
      word += char;
      continue;
    }

    flushWord();
    atoms.push(makeTextAtom(char, style, options, false, false, source(index)));
  }

  flushWord();
}

/**
 * 一个段落 → 原子序列。
 *
 * `paragraph.defaultStyle` 是这一段的「空行样式」（没有 run 时用它算行高）。
 */
export function atomize(paragraph, options) {
  const atoms = [];

  const pushItem = (item, itemIndex) => {
    if (item.kind === "text") {
      pushTextAtoms(atoms, item, itemIndex, options);
      return;
    }
    if (item.kind === "tab") {
      atoms.push(makeTabAtom(item.style, options, makeSource(itemIndex, 0, 0, item)));
      return;
    }
    if (item.kind === "lineBreak" || item.kind === "pageBreak") {
      atoms.push({
        kind: "control",
        type: item.kind,
        ...makeSource(itemIndex, 0, 0, item),
      });
      return;
    }
    if (item.kind === "image") {
      const style = item.style ?? paragraph.defaultStyle ?? { sizePx: 14 };
      const metrics = fontMetrics(style, false, options);
      if (item.anchor) {
        // 浮动图片不占行内宽度 / 行高；渲染层按锚点绝对定位。
        atoms.push({
          kind: "image",
          floating: true,
          anchor: item.anchor,
          src: item.src,
          label: item.label,
          alt: item.alt ?? "",
          width: 0,
          height: 0,
          drawWidth: item.width,
          drawHeight: item.height,
          style: scaledStyle(style),
          lineHeight: 0,
          ascent: 0,
          descent: 0,
          size: 0,
          ...makeSource(itemIndex, 0, 0, item),
        });
        return;
      }
      atoms.push({
        kind: "image",
        src: item.src,
        label: item.label,
        alt: item.alt ?? "",
        width: item.width,
        height: item.height,
        style: scaledStyle(style),
        lineHeight: Math.max(item.height, metrics.lineHeight),
        ascent: Math.max(item.height, metrics.ascent),
        descent: metrics.descent,
        size: effectiveSizePx(style, options),
        ...makeSource(itemIndex, 0, 0, item),
      });
    }
  };

  // 编号标签在正文之前，但 itemIndex = -1：它占视觉宽度，光标不能落进去。
  for (const item of paragraph.labelItems ?? []) pushItem(item, -1);
  for (const [itemIndex, item] of paragraph.items.entries()) pushItem(item, itemIndex);

  return atoms;
}

/** 原子起点对应的光标；编号标签（itemIndex < 0）没有可落的光标。 */
export function atomStartCaret(atom) {
  if (!atom || atom.itemIndex == null || atom.itemIndex < 0) return null;
  return {
    itemIndex: atom.itemIndex,
    offset: atom.kind === "text" ? (atom.charStart ?? 0) : 0,
  };
}

/** 原子终点对应的光标；图片 / 制表符 / 换行的“终点”是下一个 item 的开头。 */
export function atomEndCaret(atom) {
  if (!atom || atom.itemIndex == null || atom.itemIndex < 0) return null;
  if (atom.kind === "text") {
    return {
      itemIndex: atom.itemIndex,
      offset: atom.charEnd ?? (atom.charStart ?? 0) + Array.from(atom.text ?? "").length,
    };
  }
  return { itemIndex: atom.itemIndex + 1, offset: 0 };
}

/**
 * `index` 前能不能断行。
 *
 * 这是 UAX #14 的一个**务实子集**：空格后可以断；中文与中文、中文与西文之间可以断，
 * 但要服从禁则；西文只在词与词之间断。
 */
export function canBreakBefore(atoms, index, kinsoku = true) {
  if (index <= 0 || index >= atoms.length) return false;
  const previous = atoms[index - 1];
  const current = atoms[index];

  if (previous.kind === "control" || current.kind === "control") return true;
  if (previous.isSpace) return true;
  if (current.isSpace) return false;
  if (previous.isTab || current.isTab) return false;
  if (previous.kind === "image" || current.kind === "image") return true;

  const previousText = previous.text ?? "";
  const currentText = current.text ?? "";

  if (kinsoku) {
    if (NO_START.has(currentText)) return false;
    if (NO_END.has(previousText)) return false;
  }

  if (previous.isCJK && current.isCJK) return true;

  if (previous.isCJK !== current.isCJK) {
    // `2026年` / `9月` / `3个`：数字和它后面的单位要在一起。
    if (
      /[0-9]$/.test(previousText) &&
      current.isCJK &&
      NUMBER_UNIT.has(currentText)
    ) {
      return false;
    }
    // `第1章` / `共3个`：数字前面的提示字也别丢下。
    if (
      previous.isCJK &&
      NUMBER_PREFIX.has(previousText) &&
      /^[0-9]/.test(currentText)
    ) {
      return false;
    }
    return true;
  }

  if (!previous.isCJK && !current.isCJK) {
    if (LATIN_CLOSING.has(currentText)) return false;
    if (LATIN_CLOSING.has(previousText)) return true;
  }

  return false;
}

export function countCharacters(atoms) {
  let count = 0;
  for (const atom of atoms) {
    if (atom.kind === "text") count += Array.from(atom.text).length;
  }
  return count;
}

/** 把超长西文词拆成单字原子（只有整行都放不下时才用）。 */
export function splitTextAtom(atom, options) {
  let offset = atom.charStart ?? 0;
  return Array.from(atom.text).map((char) => {
    const piece = makeTextAtom(char, atom.style, options, false, true, {
      itemIndex: atom.itemIndex,
      charStart: offset,
      charEnd: offset + 1,
      editable: atom.editable,
      synthetic: atom.synthetic,
    });
    offset += 1;
    return piece;
  });
}
