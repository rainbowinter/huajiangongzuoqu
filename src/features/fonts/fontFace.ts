/**
 * 字体文件 → `@font-face`。
 *
 * 插件「把字体丢进文件夹就完事」的前提是**宿主自己能把文件名翻译成一条 `@font-face`**：
 * 插件给不出族名（它读不了二进制、也不该去解析字体内部的 name 表），所以这里按**文件名**
 * 推导。字体文件名乱是常态，推导规则因此要有明确的兜底，并且允许插件用 `overrides`
 * 覆盖个别文件。
 *
 * 本模块是**纯函数**：不碰 DOM、不碰 Tauri。URL 由调用方传进来（主世界用
 * `convertFileSrc`），这样推导与 CSS 生成都能在 node 环境里直接测。
 */

/** 插件字体文件夹的默认名字：`api.fonts.register()` 不传 `dir` 时用这个。 */
export const DEFAULT_FONT_DIR = "fonts";

/** 宿主从 Rust 拿到的字体文件描述（对应 `plugins::assets::FontAsset`）。 */
export interface FontAsset {
  /** 文件名（含扩展名），例如 `JetBrainsMono-Regular.ttf`。 */
  file: string;
  /** 绝对路径。**只用于生成 asset URL**，不要再往下传给插件。 */
  path: string;
  /** 字体内部 `name` 表里的真实族名；读不出来（WOFF、损坏文件）时为 `null`。 */
  family: string | null;
  /** `OS/2.usWeightClass`。 */
  weight: number | null;
  /** `"italic"` 或 `"normal"`。 */
  style: string | null;
}

/** 已经解析成可加载 URL 的字体来源。 */
export interface FontSource {
  file: string;
  url: string;
  /**
   * 宿主从字体**文件内部**读出的族名 / 字重 / 字形
   * （Rust 侧 `plugins/fontmeta.rs` 拆的 `name` 与 `OS/2` 表）。
   *
   * 读不出来（WOFF 压缩容器、损坏文件）时留空，由下面的文件名推导兜底。
   */
  family?: string | null;
  weight?: number | null;
  style?: string | null;
}

/** 插件可以按文件名覆盖推导结果。 */
export interface FontFaceOverride {
  family?: string;
  weight?: number;
  style?: "normal" | "italic";
}

export interface FontFaceSpec {
  family: string;
  weight: number;
  style: "normal" | "italic";
  /** 来源文件名，仅用于排错。 */
  file: string;
  url: string;
}

/** 扩展名 → `format()` 提示。`ttc` 是字体集合，给不出单一格式，留空。 */
const FORMAT_HINTS: Record<string, string> = {
  ttf: "truetype",
  otf: "opentype",
  woff: "woff",
  woff2: "woff2",
};

/** 变体词 → 字重。键是**归一化后**的写法（小写、只剩字母）。 */
const WEIGHT_WORDS: ReadonlyMap<string, number> = new Map([
  ["thin", 100],
  ["hairline", 100],
  ["extralight", 200],
  ["ultralight", 200],
  ["light", 300],
  ["regular", 400],
  ["normal", 400],
  ["book", 400],
  ["roman", 400],
  ["medium", 500],
  ["semibold", 600],
  ["demibold", 600],
  ["bold", 700],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["black", 900],
  ["heavy", 900],
]);

const STYLE_WORDS: ReadonlyArray<[string, "italic"]> = [
  ["italic", "italic"],
  ["oblique", "italic"],
];

/**
 * 认一个「变体词」。
 *
 * 必须**完全**由已知的字重词与 italic/oblique 组成才认，否则返回 `null` —— 否则
 * `FiraCode-Retina.ttf` 里的 `Retina` 会被当成变体剥掉，族名变成 `Fira Code`，
 * 与另一个真正的 `Fira Code` 撞在一起。
 */
export function parseVariantToken(token: string): { weight: number; style: "normal" | "italic" } | null {
  const normalized = token.toLowerCase().replace(/[^a-z]/g, "");
  if (!normalized) return null;

  let style: "normal" | "italic" = "normal";
  let rest = normalized;
  for (const [word, value] of STYLE_WORDS) {
    if (rest.includes(word)) {
      style = value;
      rest = rest.split(word).join("");
    }
  }

  // 纯样式词：`-Italic` / `-Oblique`
  if (!rest) return { weight: 400, style };

  const weight = WEIGHT_WORDS.get(rest);
  if (weight === undefined) return null;

  return { weight, style };
}

/** `JB Mono` 之类的连写拆成词：`JetBrainsMono` → `JetBrains Mono`，`IBMPlexMono` → `IBM Plex Mono`。 */
function splitCamelCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/** 全小写的词首字母大写：`iosevka` → `Iosevka`。带大写的词原样保留，免得毁掉 `IBM`。 */
function capitalizeWords(value: string): string {
  return value.replace(/\b[a-z][a-z0-9]*/g, (word) => word[0].toUpperCase() + word.slice(1));
}

/** 去掉扩展名。 */
function stemOf(file: string): string {
  return file.replace(/\.[^.]+$/, "");
}

function extensionOf(file: string): string {
  const match = /\.([^.]+)$/.exec(file);
  return match ? match[1].toLowerCase() : "";
}

/**
 * 从一个文件名推导族名与变体。
 *
 * 规则：按 `-` / `_` / 空格 分词，**最后一段**如果是变体词就剥出来当字重/字形，
 * 前面所有部分拼起来当族名。这样 `SourceCodePro-Regular.otf` 与
 * `Source Code Pro Bold.ttf` 都能落到同一个族。
 */
export function deriveFamily(file: string): {
  family: string;
  weight: number;
  style: "normal" | "italic";
} {
  const stem = stemOf(file);
  const parts = stem.split(/[-_\s]+/).filter(Boolean);

  let variant: { weight: number; style: "normal" | "italic" } | null = null;
  if (parts.length >= 2) {
    variant = parseVariantToken(parts[parts.length - 1]);
    if (variant) parts.pop();
  }

  const joined = parts.join(" ").trim();
  const family = capitalizeWords(splitCamelCase(joined)).trim();

  return {
    family: family || stem || "未命名字体",
    weight: variant?.weight ?? 400,
    style: variant?.style ?? "normal",
  };
}

/** 把宿主读出来的 `style` 字符串收窄；不认识的值一律当作没读到。 */
function asFontStyle(value: string | null | undefined): "normal" | "italic" | undefined {
  return value === "italic" || value === "normal" ? value : undefined;
}

/**
 * 把一组来源推导成 `@font-face` 规格。
 *
 * 取值优先级是 **插件给的 `overrides` > 字体文件自己声明的 > 按文件名猜**。中间那一档
 * 才是常态：文件名不可靠（`JetBrainsMono-Regular.ttf` 会被猜成 "Jet Brains Mono"），
 * 而字体内部 `name` 表里的才是权威。
 */
export function deriveFontFaceSpecs(
  sources: readonly FontSource[],
  overrides?: Readonly<Record<string, FontFaceOverride>>,
): FontFaceSpec[] {
  return sources.map((source) => {
    const fallback = deriveFamily(source.file);
    const override = overrides?.[source.file];

    const family = override?.family?.trim() || source.family?.trim() || fallback.family;
    const weight = override?.weight ?? source.weight ?? fallback.weight;
    const style = override?.style ?? asFontStyle(source.style) ?? fallback.style;

    return { family, weight, style, file: source.file, url: source.url };
  });
}

/** CSS 字符串字面量里的引号与反斜杠要转义，换行会让整条规则失效。 */
function escapeCssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, "");
}

/** 生成 `@font-face` 规则。 */
export function buildFontFaceCss(specs: readonly FontFaceSpec[]): string {
  return specs
    .map((spec) => {
      const hint = FORMAT_HINTS[extensionOf(spec.file)];
      const url = `url("${escapeCssString(spec.url)}")`;
      const source = hint ? `${url} format("${hint}")` : url;

      // font-display: swap —— 字体要从磁盘读，先用手头字体顶上，加载完再换。
      return (
        `@font-face{font-family:"${escapeCssString(spec.family)}";src:${source};` +
        `font-weight:${spec.weight};font-style:${spec.style};font-display:swap;}`
      );
    })
    .join("\n");
}

/**
 * 供代码字体选择器使用：把族名补成一条完整字体栈。
 *
 * ⚠️ 尾部**必须**接真实等宽兜底。插件被停用、或字体文件被删之后，`@font-face` 就没了，
 * 那时只剩栈尾；若直接接中文字体（应用自带的比例字体），代码会悄悄变成非等宽的
 * —— 这正是本项目刚修过的那个毛病。
 */
export function stackForPluginFamily(family: string, fallbackMono: string): string {
  return `"${escapeCssString(family)}", ${fallbackMono}`;
}
