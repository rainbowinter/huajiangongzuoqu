/**
 * 样式表与级联。
 *
 * Word 的规则是：
 *
 *   docDefaults → 默认段落样式 → 段落样式 basedOn 链 → 字符样式 basedOn 链 → 直接格式
 *
 * 段落样式里的 `w:rPr` 会作用到这一段的所有 run，字符样式再在上面覆盖。
 * `basedOn` 可能是环，链要走成有环检测。
 */

import { attr, boolAttr, child, children, val } from "../xml.js";
import {
  mergeParagraphProps,
  mergeRunProps,
  parseDocDefaults,
  parseParagraphProps,
  parseRunProps,
} from "./props.js";

export function parseStyles(stylesDocument) {
  if (!stylesDocument) {
    return { defaults: { rPr: {}, pPr: {} }, byId: new Map(), defaultsByType: {} };
  }

  const root = stylesDocument.documentElement;
  const defaults = parseDocDefaults(root);
  const byId = new Map();
  const defaultsByType = {};

  for (const styleElement of children(root, "style")) {
    const id = attr(styleElement, "styleId");
    if (!id) continue;
    const type = attr(styleElement, "type") ?? "paragraph";
    const entry = {
      id,
      type,
      isDefault: boolAttr(styleElement, "default", false),
      name: val(child(styleElement, "name")),
      basedOn: val(child(styleElement, "basedOn")),
      next: val(child(styleElement, "next")),
      link: val(child(styleElement, "link")),
      pPr: parseParagraphProps(child(styleElement, "pPr")),
      rPr: parseRunProps(child(styleElement, "rPr")),
    };
    byId.set(id, entry);
    if (entry.isDefault && !defaultsByType[type]) defaultsByType[type] = id;
  }

  return { defaults, byId, defaultsByType };
}

export function styleChain(styles, styleId) {
  const chain = [];
  const seen = new Set();
  let current = styleId;
  while (current && styles.byId.has(current) && !seen.has(current)) {
    seen.add(current);
    const style = styles.byId.get(current);
    chain.push(style);
    current = style.basedOn;
  }
  return chain.reverse();
}

function mergedParagraphStyles(styles, styleId) {
  const chain = [];
  const seen = new Set();
  const candidates = [
    ...styleChain(styles, styles.defaultsByType.paragraph),
    ...(styleId ? styleChain(styles, styleId) : []),
  ];
  for (const style of candidates) {
    if (seen.has(style.id)) continue;
    seen.add(style.id);
    chain.push(style);
  }
  return chain;
}

/**
 * 解析一个 `w:p`。
 *
 * 返回 `{ props, styleChain }` —— 后一项要给这一段里的 run 用（段落样式里的 rPr
 * 会作用到所有 run）。
 */
export function resolveParagraph(pElement, styles) {
  const direct = parseParagraphProps(child(pElement, "pPr"));
  const chain = mergedParagraphStyles(styles, direct.styleId);

  const props = mergeParagraphProps({}, styles.defaults.pPr);
  for (const style of chain) mergeParagraphProps(props, style.pPr);
  mergeParagraphProps(props, direct);

  return { props, styleChain: chain };
}

/** 解析一个 `w:r`。`paragraphStyleChain` 来自 `resolveParagraph`。 */
export function resolveRun(rElement, paragraphStyleChain, styles) {
  const direct = parseRunProps(child(rElement, "rPr"));
  const props = mergeRunProps({}, styles.defaults.rPr);

  for (const style of paragraphStyleChain) mergeRunProps(props, style.rPr);

  const characterStyleId = direct.styleId ?? styles.defaultsByType.character;
  for (const style of styleChain(styles, characterStyleId)) {
    mergeRunProps(props, style.rPr);
  }

  mergeRunProps(props, direct);
  return props;
}

/** 没有 run 的段落（或编号标签）用的基础字符属性。 */
export function defaultRunProps(styles, paragraphStyleChain) {
  const props = mergeRunProps({}, styles.defaults.rPr);
  for (const style of paragraphStyleChain) mergeRunProps(props, style.rPr);
  for (const style of styleChain(styles, styles.defaultsByType.character)) {
    mergeRunProps(props, style.rPr);
  }
  return props;
}
