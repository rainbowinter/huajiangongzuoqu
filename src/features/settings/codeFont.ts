/**
 * 代码字体 —— 影响**一切走 `font-mono` 的地方**：代码 / 文本编辑器、Markdown 代码块、
 * 行内 `code`，以及工具栏里那些等宽小标签。
 *
 * 为什么值得单独做一项：`--font-mono` 是一条**按名字回退**的字体栈，最终落到哪一款
 * 完全取决于本机装了什么。原栈以 `"SF Mono" / "Menlo"` 打头，这两个只在 macOS 上存在；
 * `"JetBrains Mono" / "Fira Code"` 又要用户自己装。于是在 Windows 上整条栈会一路掉到
 * 栈尾的 `HarmonyOS Sans SC` —— 那是应用自带的**比例**中文字体，一旦由它兜底，代码就
 * 不再等宽（数字不齐、缩进对不上）。所以这里做两件事：
 *
 * 1. `App.css` 的默认栈改成「各平台一定存在的等宽字体优先」，不再赌用户装没装；
 * 2. 给出可选预设，让装了 JetBrains Mono 之类的人能真正用上。
 *
 * 写法与 `renderColors` 同构：把选中的字体写成 `:root` 上的 `--font-mono`。区别是这里走
 * **内联样式**（`documentElement.style`）—— 内联优先级高于 Tailwind `@theme` 生成的
 * `:root` 规则，一次赋值就盖掉全局，所有窗口、所有 `font-mono` 用法一起换。
 *
 * ⚠️ 这一项**不进 `AppConfig`**：它只是本机的显示偏好，跟着 WebView 的 localStorage 走
 * 就够了（与 `uiZoom` 同一套做法），Rust 侧的配置结构与迁移逻辑不必知道它。
 */

export const CODE_FONT_STORAGE_KEY = "floral-code-font";

/**
 * 中文字体兜底。
 *
 * `HarmonyOS Sans SC` 是应用**自带**的，一定存在，所以代码注释里的汉字不会掉成方框。
 * 但它必须排在所有西文等宽字体**之后** —— 它的拉丁字形是比例的，排在前面会把等宽
 * 字形整个吃掉，那正是这次要修的毛病。
 */
const CJK_FALLBACK = '"HarmonyOS Sans SC", monospace';

/** 把一串候选字体补成完整字体栈：候选字体 → 中文兜底 → 通用族。 */
function stackOf(...families: string[]): string {
  return [...families, CJK_FALLBACK].join(", ");
}

export interface CodeFontPreset {
  id: string;
  /** 设置面板下拉里显示的名字。 */
  label: string;
  /** 完整 CSS `font-family` 值；空串表示「不覆盖」，用 `App.css` 里的默认栈。 */
  stack: string;
}

/**
 * 预设一览。
 *
 * 每一项都在首选字体后面接上「本机八成也有的等宽字体」（macOS 的 Menlo、Windows 的
 * Consolas），最后才轮到中文兜底 —— 这样即使首选那款没装，也仍然是等宽的，而不是
 * 掉进比例字体里。顺序大致按流行度排，`跟随系统` 放最前面。
 */
export const CODE_FONT_PRESETS: readonly CodeFontPreset[] = Object.freeze([
  { id: "system", label: "跟随系统（默认）", stack: "" },
  {
    id: "cascadia",
    label: "Cascadia Code",
    stack: stackOf('"Cascadia Code"', '"Cascadia Mono"', "Consolas", "Menlo"),
  },
  { id: "consolas", label: "Consolas", stack: stackOf("Consolas", '"Cascadia Mono"', "Menlo") },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    stack: stackOf('"JetBrains Mono"', "Consolas", "Menlo"),
  },
  { id: "fira", label: "Fira Code", stack: stackOf('"Fira Code"', "Consolas", "Menlo") },
  {
    id: "monaspace",
    label: "Monaspace Neon",
    stack: stackOf('"Monaspace Neon"', '"Monaspace Argon"', "Consolas", "Menlo"),
  },
  { id: "victor", label: "Victor Mono", stack: stackOf('"Victor Mono"', "Consolas", "Menlo") },
  { id: "iosevka", label: "Iosevka", stack: stackOf("Iosevka", '"Iosevka Term"', "Consolas", "Menlo") },
  { id: "plex", label: "IBM Plex Mono", stack: stackOf('"IBM Plex Mono"', "Consolas", "Menlo") },
  {
    id: "source-code-pro",
    label: "Source Code Pro",
    stack: stackOf('"Source Code Pro"', "Consolas", "Menlo"),
  },
  { id: "hack", label: "Hack", stack: stackOf("Hack", "Consolas", "Menlo") },
]);

/**
 * `App.css` 里 `@theme --font-mono` 的副本，**两处必须保持一致**。
 *
 * 只用于设置面板的预览：选「跟随系统」时这一项没有自己的栈，得拿默认栈才能显示出
 * 实际字形。真正生效的路径始终是 CSS —— 这里漂了顶多预览不准，但改 `App.css` 时
 * 记得同步。
 */
export const DEFAULT_CODE_FONT_STACK = stackOf(
  "ui-monospace",
  '"SF Mono"',
  "SFMono-Regular",
  "Menlo",
  '"Cascadia Code"',
  "Consolas",
  '"Liberation Mono"',
  '"JetBrains Mono"',
  '"Fira Code"',
);

/**
 * 等宽兜底尾巴。
 *
 * 任何「首选字体可能不存在」的字体栈都该接上它 —— 插件自带的字体尤其如此：插件一被
 * 停用 `@font-face` 就没了，那时栈里只剩这一段。如果它打头就是中文字体（应用自带的是
 * **比例**字形），代码会悄悄变成非等宽，正是这个文件开头描述的那个毛病。
 */
export const MONO_FALLBACK_TAIL =
  'ui-monospace, Menlo, Consolas, "HarmonyOS Sans SC", monospace';

function normalize(stack: string): string {
  return stack.trim();
}

/** 读已保存的字体栈。没存过、或存储不可用（隐私模式）时返回空串，即「用默认」。 */
export function getCodeFont(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return normalize(localStorage.getItem(CODE_FONT_STORAGE_KEY) ?? "");
  } catch {
    return "";
  }
}

/**
 * 只改 CSS，不碰存储。
 *
 * ⚠️ 清除时必须 **`removeProperty`** 而不是写空串：`--font-mono` 在 `@theme` 里本来就有
 * 定义，只有内联那条**不存在**时才会回落到它；写成空串会把整条 `font-family` 声明废掉。
 */
export function applyCodeFont(stack: string): void {
  if (typeof document === "undefined") return;
  const value = normalize(stack);
  const root = document.documentElement.style;
  if (value) {
    root.setProperty("--font-mono", value);
  } else {
    root.removeProperty("--font-mono");
  }
}

/** 写入偏好并立即生效。传空串即恢复默认（会清掉存储项）。 */
export function setCodeFont(stack: string): void {
  const value = normalize(stack);
  try {
    if (value) {
      localStorage.setItem(CODE_FONT_STORAGE_KEY, value);
    } else {
      localStorage.removeItem(CODE_FONT_STORAGE_KEY);
    }
  } catch {
    // 存储不可用不该连带「这次设置不生效」，继续往下走。
  }
  applyCodeFont(value);
}

/** 开机调用一次：把已保存的偏好写到 `:root`。 */
export function restoreCodeFont(): void {
  applyCodeFont(getCodeFont());
}

/**
 * 这个值对应哪个预设；是手填的自定义字体栈则返回 `null`。
 *
 * 空串对应「跟随系统」那条预设 —— 所以调用方用「返回 null」判断是不是自定义。
 */
export function matchCodeFontPreset(stack: string): CodeFontPreset | null {
  const value = normalize(stack);
  return CODE_FONT_PRESETS.find((preset) => preset.stack === value) ?? null;
}

/** 预览用：把空串换成默认栈，这样「跟随系统」也能看见实际字形。 */
export function previewCodeFontStack(stack: string): string {
  return normalize(stack) || DEFAULT_CODE_FONT_STACK;
}

/**
 * 从预设里滤掉「插件已经提供了同名字体」的那些。
 *
 * 不滤的话同一个名字会在下拉里出现两次（`JetBrains Mono` 既是预设又是插件字体），而
 * 两者实际渲染的是同一个字形 —— 插件注入的 `@font-face` 本来就**盖过**系统字体，
 * 预设那条栈落到哪儿都一样。纯噪音。
 *
 * `selectedStack` 是那个不显然的例外：**当前正选中的预设即使被盖掉也要留着**。否则
 * 下拉里找不到匹配的 option，浏览器会退回显示第一项「跟随系统」，而真正生效的还是
 * 那条旧栈 —— 界面跟实际对不上。
 */
export function visibleCodeFontPresets(
  selectedStack: string,
  pluginFamilies: readonly string[],
): readonly CodeFontPreset[] {
  const selected = normalize(selectedStack);
  return CODE_FONT_PRESETS.filter(
    (preset) => !pluginFamilies.includes(preset.label) || preset.stack === selected,
  );
}
