import a11yDark from "highlight.js/styles/a11y-dark.css?raw";
import a11yLight from "highlight.js/styles/a11y-light.css?raw";
import agate from "highlight.js/styles/agate.css?raw";
import atomOneDark from "highlight.js/styles/atom-one-dark.css?raw";
import atomOneLight from "highlight.js/styles/atom-one-light.css?raw";
import colorBrewer from "highlight.js/styles/color-brewer.css?raw";
import github from "highlight.js/styles/github.css?raw";
import githubDark from "highlight.js/styles/github-dark.css?raw";
import intellijLight from "highlight.js/styles/intellij-light.css?raw";
import monokai from "highlight.js/styles/monokai.css?raw";
import stackoverflowDark from "highlight.js/styles/stackoverflow-dark.css?raw";
import stackoverflowLight from "highlight.js/styles/stackoverflow-light.css?raw";
import vs from "highlight.js/styles/vs.css?raw";
import vs2015 from "highlight.js/styles/vs2015.css?raw";
import xcode from "highlight.js/styles/xcode.css?raw";

/**
 * 代码着色的主题。
 *
 * 原先 `MarkdownPreview.tsx` 里写死了一句 `import "highlight.js/styles/github.css"` ——
 * 于是**深色模式下代码块永远是浅色**，一直是这个项目里最明显的观感问题之一。
 *
 * 现在改成运行时注入：所有候选主题以 `?raw` 读成字符串，只有当前生效的那一份会被写进
 * 一个 `<style>` 元素。之所以能这样切，是因为 highlight.js 的主题全靠 `.hljs-*` 这套
 * 全局类名 —— 同时注入两份会互相打架，所以同一刻只能有一份生效。
 *
 * 主题名与文件名一一对应，插件声明 `highlightTheme` 时用的就是这些名字。
 */
export const CODE_THEMES: Readonly<Record<string, string>> = Object.freeze({
  github,
  "github-dark": githubDark,
  "atom-one-light": atomOneLight,
  "atom-one-dark": atomOneDark,
  "stackoverflow-light": stackoverflowLight,
  "stackoverflow-dark": stackoverflowDark,
  "a11y-light": a11yLight,
  "a11y-dark": a11yDark,
  "intellij-light": intellijLight,
  "color-brewer": colorBrewer,
  xcode,
  monokai,
  agate,
  vs,
  vs2015,
});

export const DEFAULT_CODE_THEME_LIGHT = "github";
export const DEFAULT_CODE_THEME_DARK = "github-dark";

export function isKnownCodeTheme(name: string): boolean {
  return name in CODE_THEMES;
}

/**
 * 插件可以给某个格式单独指定主题：
 *
 * - 给一个字符串 → 明暗两种模式都用它；
 * - 给 `{ light, dark }` → 各自跟随应用主题。
 *
 * 两种写法都提供，是因为大多数格式只需要「一个稳定的观感」，而少数（例如配色对背景
 * 明暗敏感的）需要两套。
 */
export type CodeThemePreference = string | { light: string; dark: string };

export function resolveCodeTheme(
  preference: CodeThemePreference | undefined,
  isDark: boolean,
): string {
  const fallback = isDark ? DEFAULT_CODE_THEME_DARK : DEFAULT_CODE_THEME_LIGHT;
  if (!preference) return fallback;

  const name =
    typeof preference === "string" ? preference : isDark ? preference.dark : preference.light;

  // 插件写了个不存在的主题名时回落到默认，而不是让代码块完全没样式。
  return isKnownCodeTheme(name) ? name : fallback;
}

/** 当前应用主题是不是深色。`data-theme` 里存的是**解析后**的值（light / dark）。 */
export function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

let styleElement: HTMLStyleElement | null = null;
let activeTheme: string | null = null;
let override: CodeThemePreference | undefined;

/**
 * 当前文件类型声明的主题覆盖。由打开文件的那一层设置（见 MainWindow）。
 *
 * 做成模块级的「覆盖值」而不是让各窗口各自 apply，是因为主题是**进程内全局**的
 * （所有窗口共用同一套 `.hljs-*` 类名），而小窗/磁贴也要有样式。集中到 App 统一
 * `syncCodeTheme()`，就不会出现「主窗口有主题、小窗没有」。
 */
export function setCodeThemeOverride(preference: CodeThemePreference | undefined): void {
  override = preference;
  syncCodeTheme();
}

/** 按当前的应用主题 + 覆盖值重新决定用哪套代码主题。 */
export function syncCodeTheme(): void {
  applyCodeTheme(resolveCodeTheme(override, isDarkTheme()));
}

/**
 * 切换代码主题。同名重复调用是空操作，所以可以放心地放在 effect 里。
 */
export function applyCodeTheme(name: string): void {
  const theme = isKnownCodeTheme(name) ? name : DEFAULT_CODE_THEME_LIGHT;
  if (theme === activeTheme) return;
  activeTheme = theme;

  if (typeof document === "undefined") return;

  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.id = "__floral_code_theme__";
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = CODE_THEMES[theme];
}

/** 仅供测试：清掉注入状态。 */
export function resetCodeTheme(): void {
  activeTheme = null;
  override = undefined;
  styleElement?.remove();
  styleElement = null;
}
