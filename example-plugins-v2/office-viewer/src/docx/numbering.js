/**
 * 自动编号（`word/numbering.xml`）。
 *
 * M1 只做「把编号文字算出来并插到段落开头」：计数器、`%1.%2` 模板、常见数字格式、
 * 缩进级别。复杂的 `lvlOverride` / 重新开始规则 / 多级列表重启，等 M7 再细做。
 */

import { attr, child, children, numAttr, val } from "../xml.js";
import { parseParagraphProps, parseRunProps } from "./props.js";

function parseLevel(levelElement) {
  const ilvl = numAttr(levelElement, "ilvl", 0) ?? 0;
  return {
    ilvl,
    start: numAttr(levelElement, "start", 1) ?? 1,
    numFmt: val(child(levelElement, "numFmt"), "decimal") ?? "decimal",
    lvlText: val(child(levelElement, "lvlText"), "") ?? "",
    suff: val(child(levelElement, "suff"), "tab") ?? "tab",
    pStyle: val(child(levelElement, "pStyle")),
    pPr: parseParagraphProps(child(levelElement, "pPr")),
    rPr: parseRunProps(child(levelElement, "rPr")),
  };
}

export function parseNumbering(numberingDocument) {
  const abstractNums = new Map();
  const nums = new Map();
  if (!numberingDocument) return { abstractNums, nums };

  const root = numberingDocument.documentElement;
  for (const abstractElement of children(root, "abstractNum")) {
    const id = attr(abstractElement, "abstractNumId");
    if (!id) continue;
    const levels = new Map();
    for (const levelElement of children(abstractElement, "lvl")) {
      const level = parseLevel(levelElement);
      levels.set(level.ilvl, level);
    }
    abstractNums.set(id, { id, levels });
  }

  for (const numElement of children(root, "num")) {
    const id = attr(numElement, "numId");
    if (!id) continue;
    const abstractNumId = val(child(numElement, "abstractNumId"));
    const overrides = new Map();
    for (const overrideElement of children(numElement, "lvlOverride")) {
      const ilvl = numAttr(overrideElement, "ilvl", 0) ?? 0;
      const startElement = child(overrideElement, "startOverride");
      const levelElement = child(overrideElement, "lvl");
      overrides.set(ilvl, {
        start: startElement ? numAttr(startElement, "val") : null,
        level: levelElement ? parseLevel(levelElement) : null,
      });
    }
    nums.set(id, { id, abstractNumId, overrides });
  }

  return { abstractNums, nums };
}

export function resolveNumberingLevel(numbering, numId, ilvl) {
  const num = numbering.nums.get(String(numId));
  if (!num) return null;
  const abstract = numbering.abstractNums.get(num.abstractNumId);
  if (!abstract) return null;
  const override = num.overrides.get(ilvl);
  if (override?.level) return override.level;
  return abstract.levels.get(ilvl) ?? null;
}

export function createNumberingState() {
  // 按 **numId** 存计数器：同一个 numId 是一次列表实例，Word 就是按它重新开始的。
  return { counters: new Map() };
}

const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const UNITS = ["", "十", "百", "千"];
const TRADITIONAL = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];

function chineseNumber(value) {
  const number = Math.floor(value);
  if (number <= 0) return "零";
  if (number < 10) return DIGITS[number];
  if (number < 20) return `十${number % 10 === 0 ? "" : DIGITS[number % 10]}`;
  if (number < 10000) {
    let result = "";
    let rest = number;
    for (let unit = 3; unit >= 0; unit -= 1) {
      const digit = Math.floor(rest / 10 ** unit);
      rest %= 10 ** unit;
      if (digit === 0) {
        if (result && rest > 0 && !result.endsWith("零")) result += "零";
        continue;
      }
      result += DIGITS[digit] + UNITS[unit];
    }
    return result.replace(/零+$/, "");
  }
  return String(number);
}

function romanNumber(value) {
  const table = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let number = Math.max(0, Math.floor(value));
  let result = "";
  for (const [amount, glyph] of table) {
    while (number >= amount) {
      result += glyph;
      number -= amount;
    }
  }
  return result;
}

function letters(value) {
  let number = Math.max(1, Math.floor(value));
  let result = "";
  while (number > 0) {
    const digit = (number - 1) % 26;
    result = String.fromCharCode(97 + digit) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

export function formatCounter(value, numFmt) {
  switch (numFmt) {
    case "decimal":
      return String(value);
    case "decimalZero":
      return String(value).padStart(2, "0");
    case "lowerLetter":
      return letters(value);
    case "upperLetter":
      return letters(value).toUpperCase();
    case "lowerRoman":
      return romanNumber(value);
    case "upperRoman":
      return romanNumber(value).toUpperCase();
    case "chineseCounting":
    case "chineseCountingThousand":
    case "ideographDigital":
      return chineseNumber(value);
    case "ideographTraditional":
      return TRADITIONAL[(value - 1) % 10] ?? String(value);
    case "none":
      return "";
    case "bullet":
      return "";
    default:
      return String(value);
  }
}

function formatLevelText(level, counters, numbering, numId) {
  if (level.numFmt === "bullet") return level.lvlText || "•";
  if (level.numFmt === "none") return "";
  return level.lvlText.replace(/%([1-9])/g, (_, digit) => {
    const index = Number(digit) - 1;
    const counter = counters[index];
    if (counter === undefined) return "";
    // `%1` 的格式取**那一层**的 numFmt，不是当前层的。
    const definition = resolveNumberingLevel(numbering, numId, index);
    return formatCounter(counter, definition?.numFmt ?? "decimal");
  });
}

/**
 * 给一个带 `numPr` 的段落算出编号文字（不含后缀）。
 *
 * 返回 `{ text, level, suffix }`；`numId=0` / 找不到定义时返回 `null`。
 */
export function nextNumberingLabel(state, numbering, numPr) {
  if (!numPr || numPr.numId === undefined || numPr.numId === null) return null;
  const numId = String(numPr.numId);
  if (numId === "0") return null;

  const num = numbering.nums.get(numId);
  if (!num) return null;
  const abstract = numbering.abstractNums.get(num.abstractNumId);
  if (!abstract) return null;

  const ilvl = Math.max(0, numPr.ilvl ?? 0);
  const level = resolveNumberingLevel(numbering, numId, ilvl);
  if (!level) return null;

  let counters = state.counters.get(numId);
  if (!counters) {
    counters = [];
    state.counters.set(numId, counters);
  }

  // 补齐到当前层，并按 start 初始化。上层没有走过时也给它一个起点。
  for (let index = 0; index <= ilvl; index += 1) {
    if (counters[index] === undefined) {
      const definition = resolveNumberingLevel(numbering, numId, index);
      counters[index] = (definition?.start ?? 1) - 1;
    }
  }
  counters[ilvl] += 1;
  for (let index = ilvl + 1; index < counters.length; index += 1) counters[index] = undefined;

  const text = formatLevelText(level, counters, numbering, numId);
  return { text, level, suffix: level.suff };
}

export function numberingSuffix(suffix) {
  if (suffix === "space") return " ";
  if (suffix === "nothing") return "";
  return "\t";
}
