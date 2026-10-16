/**
 * 视图工具栏上，一颗按钮**真正该画出来的文字**。
 *
 * ## 为什么需要它
 *
 * `view.toolbar` 的按钮既可以给 `icon`（插件目录里的一份 SVG），也可以给 `label`。
 * 两者都给的时候，主机原先**两个都画** —— 而 `label` 在这种场合经常是**图标的文字替身**：
 * pdf-viewer 就这么写过
 *
 * ```js
 * { kind: "button", id: "page-next", label: "›", title: "下一页", icon: "icons/page-next.svg" }
 * ```
 *
 * 于是「下一页」那颗按钮上并排出现了一个 14px 的箭头图标和一个 11px 的 `›` 字符，
 * 看着就是**同一个图标画了两遍**（用户报的「一个按钮里面有两个 `>`」）。
 *
 * 判据取「**只有一个字符**」：一个字符的 `label` 不可能是按钮的文案，它只可能是画不出
 * 图标时的那份替代品 —— 有了图标它就该让位。多字符的 `label`（`适应宽度`、`单页 / 连续`）
 * 是**真的文案**，跟图标各说各的，照旧一起显示。
 *
 * ⚠️ 别把这条判据挪进 `parseViewToolbar`：那里是**协议解析**，丢掉 `label` 会让
 * `title` / 无障碍名字跟着一起丢。这层只管「画什么」。
 */

/** 一个字符就是「字形替身」，两个起才是文案。用 `[...]` 数，别用 `.length`（代理对）。 */
const GLYPH_REPLACEMENT_MAX = 1;

export interface ButtonTextInput {
  /** 插件声明的 `label`。 */
  label: string;
  /** 视图报上来的实时值（`state.values[id]`）。给了就**永远**用它 —— 它是内容，不是替身。 */
  value?: string;
  /** 这一项有没有画图标（`icons` 里查得到）。 */
  hasIcon: boolean;
}

export function visibleButtonText({ label, value, hasIcon }: ButtonTextInput): string {
  if (value !== undefined) return value;
  if (hasIcon && [...label].length <= GLYPH_REPLACEMENT_MAX) return "";
  return label;
}
