/**
 * 文本测量。
 *
 * 行排版不能交给浏览器自己换行：我们要知道每个词的宽度、每一行的行高，才能按 Word 的
 * 规则分页。这里用 Canvas 2D 的 `measureText`，并按「字体 + 文本」缓存。
 *
 * ⚠️ 测量与最终 DOM 渲染必须用**同一套字体栈**，否则量出来 100px、画出来 103px，
 * 行尾就会溢出或者留下一条缝。`fontFamily()` 是唯一的字体栈来源。
 */

import { ptToPx } from "../units.js";

let canvas = null;
let context = null;
const widthCache = new Map();
const metricsCache = new Map();
const browserMetricsCache = new Map();

function getContext() {
  if (!context) {
    canvas = document.createElement("canvas");
    context = canvas.getContext("2d");
    // Word 默认不做字距调整（kerning），关掉才能与逐词相加的宽度一致。
    if ("fontKerning" in context) context.fontKerning = "none";
  }
  return context;
}

function quoted(name) {
  if (!name) return "";
  const trimmed = String(name).trim();
  if (!trimmed) return "";
  if (trimmed.includes(",")) return trimmed;
  return `"${trimmed.replace(/"/g, "")}"`;
}

function looksSerif(name) {
  return /times|georgia|garamond|cambria|宋体|仿宋|楷体|serif/i.test(name ?? "");
}

export function fontFamily(style, isCJK, options = {}) {
  if (options.fontOverride) {
    const name = quoted(options.fontOverride);
    const fallback = isCJK
      ? '"SimSun", "宋体", "Microsoft YaHei", serif'
      : looksSerif(options.fontOverride)
        ? '"Times New Roman", serif'
        : '"Arial", "Helvetica", sans-serif';
    return `${name}, ${fallback}`;
  }

  const name = quoted(isCJK ? style.fontEastAsia : style.fontLatin);
  const fallback = isCJK
    ? '"SimSun", "宋体", "Microsoft YaHei", serif'
    : looksSerif(style.fontLatin)
      ? '"Times New Roman", serif'
      : '"Arial", "Helvetica", sans-serif';
  return `${name}, ${fallback}`;
}

export function effectiveSizePx(style, options = {}) {
  const base = options.sizeOverridePt != null ? ptToPx(options.sizeOverridePt) : style.sizePx;
  return Math.max(1, base * (style.sizeFactor ?? 1));
}

export function fontString(style, isCJK, options = {}) {
  const size = effectiveSizePx(style, options);
  const italic = style.italic ? "italic " : "";
  const weight = style.bold ? "700" : "400";
  return `${italic}${weight} ${size}px ${fontFamily(style, isCJK, options)}`;
}

export function measureText(text, style, isCJK, options = {}) {
  if (!text) return 0;
  const font = fontString(style, isCJK, options);
  const key = `${font}\u0000${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;

  const ctx = getContext();
  ctx.font = font;
  const width = ctx.measureText(text).width;
  // 缓存别无限长：长文档里每换一次字号都会产生一整批新键。
  if (widthCache.size > 120000) widthCache.clear();
  widthCache.set(key, width);
  return width;
}

/**
 * 中文字体的「单倍行高 / 字号」系数。
 *
 * 这些值来自 differential/out/calibration.md（WPS PDF 反推）：
 * 宋体 13.68/10.5、黑体 15.72/1.15/10.45、仿宋 15.60/1.15/10.45、
 * 楷体 15.72/1.15/10.45、微软雅黑 20.76/1.15/10.45。
 *
 * Canvas 的 `fontBoundingBox*` 对宋体只报 ~0.95em，比 WPS 小一大截；
 * 中文字体统一按字体族查表，西文继续用 Canvas。
 */
const CJK_FONT_METRICS = [
  // [字体匹配, 单倍行高/字号, ascent/字号]
  [/simsun|宋体|songti/i, 1.303, 1.0],
  [/simhei|黑体|heiti/i, 1.308, 0.977],
  [/fangsong|仿宋/i, 1.298, 0.977],
  [/kaiti|楷体/i, 1.308, 0.989],
  [/yahei|雅黑/i, 1.727, 1.241],
];

function cjkMetrics(family) {
  for (const [pattern, lineFactor, ascentFactor] of CJK_FONT_METRICS) {
    if (pattern.test(family ?? "")) return { lineFactor, ascentFactor };
  }
  // 没校准过的中文字体：先用一个接近宋体的保守值。
  return { lineFactor: 1.303, ascentFactor: 1.0 };
}

export function fontMetrics(style, isCJK, options = {}) {
  const font = fontString(style, isCJK, options);
  const key = `${font}\u0000metrics`;
  const cached = metricsCache.get(key);
  if (cached) return cached;

  const size = effectiveSizePx(style, options);
  let result;

  if (isCJK) {
    // 中文：行高与 ascent 都按字体族查 WPS 校准值；baseline 不是统一的 1em
    // （微软雅黑明显更高，宋体约 1em）。
    const { lineFactor, ascentFactor } = cjkMetrics(style.fontEastAsia);
    const lineHeight = size * lineFactor;
    const ascent = size * ascentFactor;
    result = {
      ascent,
      descent: Math.max(0, lineHeight - ascent),
      lineHeight,
      size,
    };
  } else {
    const ctx = getContext();
    ctx.font = font;
    const measured = ctx.measureText("国Ag");
    const ascent = measured.fontBoundingBoxAscent || size * 0.82;
    const descent = measured.fontBoundingBoxDescent || size * 0.22;
    result = {
      ascent,
      descent,
      lineHeight: ascent + descent,
      size,
    };
  }

  if (metricsCache.size > 4000) metricsCache.clear();
  metricsCache.set(key, result);
  return result;
}

/**
 * 浏览器实际排版时用的字体度量。
 *
 * `fontMetrics()` 是按 WPS 校准过的**逻辑**度量（宋体 1em ascent），不能直接
 * 拿来算 DOM 里文字落在哪：CSS 行盒用的是字体文件自己的 ascent/descent。
 * 渲染器需要后者来把行盒基线挪到 `line.baseline`。
 */
export function browserFontMetrics(style, isCJK, options = {}) {
  const font = fontString(style, isCJK, options);
  const cached = browserMetricsCache.get(font);
  if (cached) return cached;

  const ctx = getContext();
  ctx.font = font;
  const measured = ctx.measureText("国Ag");
  const size = effectiveSizePx(style, options);
  const ascent = measured.fontBoundingBoxAscent || size * 0.82;
  const descent = measured.fontBoundingBoxDescent || size * 0.22;
  const result = { ascent, descent };
  if (browserMetricsCache.size > 4000) browserMetricsCache.clear();
  browserMetricsCache.set(font, result);
  return result;
}

export function clearMeasureCache() {
  widthCache.clear();
  metricsCache.clear();
  browserMetricsCache.clear();
}
