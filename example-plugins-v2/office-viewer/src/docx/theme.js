/**
 * `word/theme/theme1.xml` 的字体方案。
 *
 * 文档里的 `w:rFonts` 经常不写具体字体，而是写 `w:asciiTheme="minorHAnsi"` /
 * `w:eastAsiaTheme="minorEastAsia"`。真正用哪套字体由主题决定 —— 不解析这个文件，
 * 中文文档很容易全部掉回默认字体。
 */

import { allDescendants, firstDescendant } from "../xml.js";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

const FALLBACK = {
  major: { latin: "Calibri Light", eastAsia: "宋体", cs: "Arial" },
  minor: { latin: "Calibri", eastAsia: "宋体", cs: "Arial" },
};

function typefaceOf(element) {
  if (!element) return "";
  return (element.getAttribute("typeface") ?? "").trim();
}

function easternTypeface(fontElement, fallback) {
  if (!fontElement) return fallback;
  const ea = firstDescendant(fontElement, "ea", A_NS);
  const direct = typefaceOf(ea);
  if (direct) return direct;

  // `a:ea` 为空时，Word 通常把具体文种写在 `a:font script="Hans"` 里。
  const fonts = allDescendants(fontElement, "font", A_NS);
  for (const script of ["Hans", "Hant", "Jpan", "Hang"]) {
    const match = fonts.find((element) => element.getAttribute("script") === script);
    const value = typefaceOf(match);
    if (value) return value;
  }
  return fallback;
}

function readFont(fontElement, fallback) {
  if (!fontElement) return fallback;
  return {
    latin: typefaceOf(firstDescendant(fontElement, "latin", A_NS)) || fallback.latin,
    eastAsia: easternTypeface(fontElement, fallback.eastAsia),
    cs: typefaceOf(firstDescendant(fontElement, "cs", A_NS)) || fallback.cs,
  };
}

export function parseTheme(themeDocument) {
  if (!themeDocument) return FALLBACK;
  const fontScheme = firstDescendant(themeDocument.documentElement, "fontScheme");
  if (!fontScheme) return FALLBACK;
  return {
    major: readFont(firstDescendant(fontScheme, "majorFont"), FALLBACK.major),
    minor: readFont(firstDescendant(fontScheme, "minorFont"), FALLBACK.minor),
  };
}

/** `w:asciiTheme="minorHAnsi"` → 主题里对应的字体名。 */
export function resolveThemeFont(theme, key) {
  if (!key) return null;
  const value = String(key).toLowerCase();
  if (value.includes("eastasia")) {
    return value.startsWith("major") ? theme.major.eastAsia : theme.minor.eastAsia;
  }
  if (value.includes("bidi")) {
    return value.startsWith("major") ? theme.major.cs : theme.minor.cs;
  }
  return value.startsWith("major") ? theme.major.latin : theme.minor.latin;
}
