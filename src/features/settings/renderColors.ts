/**
 * 预览配色 → `:root` 上的 CSS 自定义属性。
 *
 * 为什么要多这一层：颜色项如果直接以 prop 形式穿透组件树，得一路传到
 * `MarkdownPreview` 的每个子渲染器；而预览的样式全是静态 Tailwind 类，本来也没法
 * 按配置改。改成把颜色写成变量，样式规则用 `var(--md-x, <主题回退>)` 读取：
 *
 * * **没配**就回退到主题变量（`--color-ink-soft` 等），所以默认观感不变；
 * * **配了**就覆盖，且因为写在 `:root` 上，**所有窗口**（主窗口 / 小窗 / 磁贴）
 *   一次性生效，不需要各自接线。
 *
 * ⚠️ 空值必须**移除**变量，而不是写入空串：`var(--md-x, fallback)` 只有在变量
 * 「未定义」时才取回退值；若变量存在但为空串，整个声明会失效，颜色直接丢失。
 */

export interface RenderColorConfig {
  tableColor?: string;
  dividerColor?: string;
  quoteColor?: string;
  captionColor?: string;
}

/** 配置字段 → CSS 变量名。 */
/**
 * 注意这里**没有**正文颜色。历史上有一项「文字渲染颜色」，但它存的是固定色值，
 * 切成深色主题不会跟着变 —— 已移除。正文颜色现在直接取主题变量，明暗自动跟随。
 * （`--md-text-color` 这个口子仍留着，插件可以用 `ui:style` 覆盖。）
 */
const COLOR_VARIABLES: ReadonlyArray<[keyof RenderColorConfig, string]> = [
  ["tableColor", "--md-table-color"],
  ["dividerColor", "--md-divider-color"],
  ["quoteColor", "--md-quote-color"],
  ["captionColor", "--md-caption-color"],
];

export function applyRenderColors(config: RenderColorConfig | null | undefined): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement.style;
  for (const [field, variable] of COLOR_VARIABLES) {
    const raw = config?.[field];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) {
      root.setProperty(variable, value);
    } else {
      root.removeProperty(variable);
    }
  }
}
