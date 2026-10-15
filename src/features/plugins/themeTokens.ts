/**
 * 把应用主题的调色板递进插件视图。
 *
 * 视图是**独立文档**（沙箱帧），拿不到宿主的 CSS 变量 —— 用户改了深浅色、换了强调色、
 * 甚至改了 `src/styles/custom.css`，插件视图里全看不见。于是宿主在 `init` 里把解析后的
 * 值递过去，插件自己决定怎么用（PDF 查看器就把它接到自己的 `--bg` / `--ink` 上）。
 *
 * **为什么是一整份调色板而不是「主题名 + 几个颜色」**：视图要画的东西五花八门（页面底衬、
 * 分隔线、悬停底、强调色），少给一个，插件就只能自己写死一个颜色 —— 那正是这次要修的问题。
 *
 * ⚠️ 别把 `--color-ink-faint` 当成「次级正文」：这一版里它是**荧光笔的黄**（给选区标记用的），
 * 真正的小字灰是 `--color-ink-ghost`。这份误会足以让插件视图在浅色主题下糊成一片黄。
 *
 * 给的是 `--color-shadow-deep` 而不是 `--color-shadow`：后者（0.06 的透明度）铺在正文底下
 * 看不出来，插件拿去做「浮起来的纸」那种投影会像是没生效。
 */

/**
 * 交给视图的那几个 token。**写死一张清单**，不做「把所有 `--color-*` 都倒出去」：
 * 视图能拿到的应当是稳定的、有语义的一小组，宿主加了新的内部变量也不必惊动插件。
 */
export const VIEW_THEME_TOKENS = [
  "--color-paper",
  "--color-paper-warm",
  "--color-paper-deep",
  "--color-cloud",
  "--color-ink",
  "--color-ink-soft",
  "--color-ink-ghost",
  "--color-bamboo",
  "--color-bamboo-mist",
  "--color-shadow-deep",
] as const;

/** 单个颜色值的上限。够装下 `rgba(26, 26, 24, 0.06)` 这种，又不至于被塞进一整张图。 */
const MAX_TOKEN_LENGTH = 64;

/**
 * 从「按名字取值」的函数里挑出那份调色板。抽出来是为了能单测 —— `getComputedStyle`
 * 在测试环境里没有（没有 jsdom），而这个函数的逻辑（空值怎么办、超长怎么办）才是要测的。
 */
export function pickThemeTokens(read: (name: string) => string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const name of VIEW_THEME_TOKENS) {
    const value = read(name).trim();
    // 空值**一个都不发**：视图那边拿到空串会让 `var(--bg)` 变成无效值，整条声明连同
    // 同组里后面那些一起失效 —— 比「这个键不存在」更糟（那种情况下回退还能生效）。
    if (value.length > 0) tokens[name] = value.slice(0, MAX_TOKEN_LENGTH);
  }
  return tokens;
}

/** 宿主侧的真身：从根元素上读当前（已解析、已按主题与自定义覆盖过）的值。 */
export function readThemeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return pickThemeTokens((name) => style.getPropertyValue(name));
}
