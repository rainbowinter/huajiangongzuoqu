/**
 * 宿主主题 → 视图变量。
 *
 * 视图是独立文档，拿不到宿主的 CSS 变量；宿主在 `init` 与 `theme` 消息里把
 * `--color-*` 的解析值递进来。这里只把它们接到视图自己的变量名上。
 */

const TOKEN_MAP = {
  "--bg": "--color-paper-warm",
  "--panel": "--color-paper",
  "--ink": "--color-ink",
  "--ink-soft": "--color-ink-soft",
  "--ink-ghost": "--color-ink-ghost",
  "--line": "--color-paper-deep",
  "--accent": "--color-bamboo",
  "--shadow": "--color-shadow-deep",
};

export function applyTheme(message) {
  if (message.theme === "light" || message.theme === "dark") {
    document.documentElement.dataset.theme = message.theme;
  }
  const tokens = message.tokens;
  if (!tokens) return;

  for (const [target, source] of Object.entries(TOKEN_MAP)) {
    const value = tokens[source];
    // 空值宁可不动：设成空串会让 var(--bg) 变成无效值，整条声明直接失效。
    if (typeof value === "string" && value.length > 0) {
      document.documentElement.style.setProperty(target, value);
    }
  }
}
