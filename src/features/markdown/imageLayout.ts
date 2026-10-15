/**
 * 图片排版参数：`![说明|300](url)`。
 *
 * 为什么用竖线而不是花括号属性块（`{width=300}`）：竖线写在 **alt 里**，对不写参数的
 * 老图片完全兼容——`![说明](url)` 解析结果就是「说明」，没有任何额外语法的痕迹；
 * 而花括号会变成 alt 的一部分，得靠另一套规则再剥掉。
 *
 * ⚠️ 在 **表格单元格**里，`|` 是列分隔符，必须转义成 `\|`：`| ![说明\|300](a.png) |`。
 * 这是 GFM 表格本身的语法要求，不是本解析器的限制。
 *
 * 只有「整段恰好是一个尺寸或对齐关键字」才会被当作参数，因此
 * `![甲|乙](url)` 里的「乙」会原样保留为说明文字——不会误吃普通文本。
 */

export type ImageAlign = "left" | "center" | "right";

export interface ImageLayout {
  /** 剥掉排版参数后的纯说明文字。 */
  alt: string;
  /** 形如 `"300px"` / `"50%"`；未指定为 `null`。 */
  width: string | null;
  /** 形如 `"200px"`；未指定为 `null`。 */
  height: string | null;
  align: ImageAlign | null;
}

const ALIGN_KEYWORDS: ReadonlySet<string> = new Set(["left", "center", "right"]);

/** `300` / `300px` / `50%` / `300x200` / `300x200px`。单位缺省为 px。 */
const SIZE_PATTERN = /^(\d+(?:\.\d+)?)(px|%)?(?:[x×](\d+(?:\.\d+)?)(px|%)?)?$/i;

function toLength(value: string, unit: string | undefined): string {
  return `${value}${unit ?? "px"}`;
}

export function parseImageLayout(rawAlt: string | undefined | null): ImageLayout {
  const alt = typeof rawAlt === "string" ? rawAlt : "";
  const parts = alt.split("|");

  let width: string | null = null;
  let height: string | null = null;
  let align: ImageAlign | null = null;

  // 从尾部往前剥：只有整段恰好是参数时才算数，遇到普通文本立刻停下，
  // 这样 `![甲|乙](url)` 里的「乙」不会被吃掉。
  //
  // 至少要留一段做说明文字，所以条件是 `parts.length > 1`：
  // `![300](url)` 没有竖线，会被当成说明文字「300」而不是宽度。
  while (parts.length > 1) {
    const candidate = parts[parts.length - 1].trim();
    const lowered = candidate.toLowerCase();

    if (align === null && ALIGN_KEYWORDS.has(lowered)) {
      align = lowered as ImageAlign;
      parts.pop();
      continue;
    }

    const size = SIZE_PATTERN.exec(candidate);
    if (size && width === null) {
      width = toLength(size[1], size[2]);
      if (size[3]) {
        height = toLength(size[3], size[4]);
      }
      parts.pop();
      continue;
    }

    break;
  }

  return { alt: parts.join("|").trim(), width, height, align };
}
