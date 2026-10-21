/**
 * `w:rPr` / `w:pPr` 的解析与合并。
 *
 * 这里只把 **实际写出来的属性** 放进对象（没写就是 `undefined`），
 * 因为样式级联靠的就是「后一层覆盖前一层」；把所有默认值先填满会把「没写」和
 * 「显式写了默认值」混为一谈。
 */

import { attr, child, children, numAttr, val } from "../xml.js";

function toggle(element, fallback = true) {
  if (!element) return fallback;
  const value = attr(element, "val");
  if (value === null) return true;
  return !(value === "0" || value === "false" || value === "off");
}

function nonNull(object) {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result;
}

export function parseRunProps(rPr) {
  const props = {};
  if (!rPr) return props;

  const style = child(rPr, "rStyle");
  if (style) props.styleId = val(style);

  const fonts = child(rPr, "rFonts");
  if (fonts) {
    const parsed = nonNull({
      ascii: attr(fonts, "ascii"),
      hAnsi: attr(fonts, "hAnsi"),
      eastAsia: attr(fonts, "eastAsia"),
      cs: attr(fonts, "cs"),
      asciiTheme: attr(fonts, "asciiTheme"),
      hAnsiTheme: attr(fonts, "hAnsiTheme"),
      eastAsiaTheme: attr(fonts, "eastAsiaTheme"),
      cstheme: attr(fonts, "cstheme"),
    });
    if (Object.keys(parsed).length > 0) props.fonts = parsed;
  }

  const sz = child(rPr, "sz");
  if (sz) props.size = numAttr(sz, "val");
  const szCs = child(rPr, "szCs");
  if (szCs) props.sizeCs = numAttr(szCs, "val");

  if (child(rPr, "b")) props.bold = toggle(child(rPr, "b"));
  if (child(rPr, "i")) props.italic = toggle(child(rPr, "i"));
  if (child(rPr, "caps")) props.caps = toggle(child(rPr, "caps"));
  if (child(rPr, "smallCaps")) props.smallCaps = toggle(child(rPr, "smallCaps"));
  if (child(rPr, "strike")) props.strike = toggle(child(rPr, "strike"));
  if (child(rPr, "dstrike")) props.doubleStrike = toggle(child(rPr, "dstrike"));
  if (child(rPr, "vanish")) props.vanish = toggle(child(rPr, "vanish"));

  const underline = child(rPr, "u");
  if (underline) props.underline = val(underline, "single");

  const color = child(rPr, "color");
  if (color) props.color = val(color, "auto");

  const highlight = child(rPr, "highlight");
  if (highlight) props.highlight = val(highlight);

  const shading = child(rPr, "shd");
  if (shading) {
    const fill = attr(shading, "fill");
    if (fill && fill !== "auto" && fill !== "none") props.shading = fill;
  }

  const vertAlign = child(rPr, "vertAlign");
  if (vertAlign) props.vertAlign = val(vertAlign);

  const spacing = child(rPr, "spacing");
  if (spacing) props.spacing = numAttr(spacing, "val");

  const position = child(rPr, "position");
  if (position) props.position = numAttr(position, "val");

  const lang = child(rPr, "lang");
  if (lang) {
    props.lang = nonNull({
      val: attr(lang, "val"),
      eastAsia: attr(lang, "eastAsia"),
    });
  }

  const eastAsianLayout = child(rPr, "eastAsianLayout");
  if (eastAsianLayout) {
    props.vert = attr(eastAsianLayout, "vert");
    props.vertCompress = toggle(child(eastAsianLayout, "vertCompress"));
  }

  return props;
}

function parseIndent(element) {
  if (!element) return undefined;
  const parsed = nonNull({
    left: numAttr(element, "left") ?? numAttr(element, "start"),
    right: numAttr(element, "right") ?? numAttr(element, "end"),
    firstLine: numAttr(element, "firstLine"),
    hanging: numAttr(element, "hanging"),
    leftChars: numAttr(element, "leftChars") ?? numAttr(element, "startChars"),
    rightChars: numAttr(element, "rightChars") ?? numAttr(element, "endChars"),
    firstLineChars: numAttr(element, "firstLineChars"),
    hangingChars: numAttr(element, "hangingChars"),
  });
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseSpacing(element) {
  if (!element) return undefined;
  const parsed = nonNull({
    before: numAttr(element, "before"),
    after: numAttr(element, "after"),
    beforeLines: numAttr(element, "beforeLines"),
    afterLines: numAttr(element, "afterLines"),
    line: numAttr(element, "line"),
    lineRule: attr(element, "lineRule"),
  });
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseNumPr(element) {
  if (!element) return undefined;
  const ilvl = child(element, "ilvl");
  const numId = child(element, "numId");
  const parsed = nonNull({
    ilvl: ilvl ? numAttr(ilvl, "val", 0) : undefined,
    numId: numId ? numAttr(numId, "val") : undefined,
  });
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseTabs(element) {
  if (!element) return undefined;
  const tabs = [];
  for (const tab of children(element, "tab")) {
    tabs.push({
      val: attr(tab, "val", "left") ?? "left",
      pos: numAttr(tab, "pos", 0) ?? 0,
      leader: attr(tab, "leader") ?? null,
    });
  }
  return tabs.length > 0 ? tabs : undefined;
}

export function parseParagraphProps(pPr) {
  const props = {};
  if (!pPr) return props;

  const style = child(pPr, "pStyle");
  if (style) props.styleId = val(style);

  const jc = child(pPr, "jc");
  if (jc) props.jc = val(jc);

  const ind = parseIndent(child(pPr, "ind"));
  if (ind) props.ind = ind;

  const spacing = parseSpacing(child(pPr, "spacing"));
  if (spacing) props.spacing = spacing;

  const numPr = parseNumPr(child(pPr, "numPr"));
  if (numPr) props.numPr = numPr;

  const tabs = parseTabs(child(pPr, "tabs"));
  if (tabs) props.tabs = tabs;

  if (child(pPr, "keepNext")) props.keepNext = toggle(child(pPr, "keepNext"));
  if (child(pPr, "keepLines")) props.keepLines = toggle(child(pPr, "keepLines"));
  if (child(pPr, "pageBreakBefore")) props.pageBreakBefore = toggle(child(pPr, "pageBreakBefore"));
  if (child(pPr, "widowControl")) props.widowControl = toggle(child(pPr, "widowControl"));
  if (child(pPr, "contextualSpacing")) props.contextualSpacing = toggle(child(pPr, "contextualSpacing"));
  if (child(pPr, "snapToGrid")) props.snapToGrid = toggle(child(pPr, "snapToGrid"));
  if (child(pPr, "kinsoku")) props.kinsoku = toggle(child(pPr, "kinsoku"));
  if (child(pPr, "overflowPunct")) props.overflowPunct = toggle(child(pPr, "overflowPunct"));
  if (child(pPr, "topLinePunct")) props.topLinePunct = toggle(child(pPr, "topLinePunct"));
  if (child(pPr, "autoSpaceDE")) props.autoSpaceDE = toggle(child(pPr, "autoSpaceDE"));
  if (child(pPr, "autoSpaceDN")) props.autoSpaceDN = toggle(child(pPr, "autoSpaceDN"));

  const outline = child(pPr, "outlineLvl");
  if (outline) props.outlineLvl = numAttr(outline, "val");

  const textAlignment = child(pPr, "textAlignment");
  if (textAlignment) props.textAlignment = val(textAlignment);

  return props;
}

export function mergeRunProps(target, source) {
  if (!source) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (key === "fonts") {
      target.fonts = { ...target.fonts };
      for (const [fontKey, fontValue] of Object.entries(value)) {
        if (fontValue !== null && fontValue !== undefined) target.fonts[fontKey] = fontValue;
      }
      continue;
    }
    target[key] = value;
  }
  return target;
}

export function mergeParagraphProps(target, source) {
  if (!source) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (key === "ind" || key === "spacing" || key === "numPr") {
      target[key] = { ...target[key], ...value };
      continue;
    }
    target[key] = value;
  }
  return target;
}

/** `w:docDefaults` 里的两个默认属性块。 */
export function parseDocDefaults(stylesElement) {
  const defaults = child(stylesElement, "docDefaults");
  const rPrDefault = child(defaults, "rPrDefault");
  const pPrDefault = child(defaults, "pPrDefault");
  return {
    rPr: parseRunProps(child(rPrDefault, "rPr")),
    pPr: parseParagraphProps(child(pPrDefault, "pPr")),
  };
}

export { toggle as toggleValue };
