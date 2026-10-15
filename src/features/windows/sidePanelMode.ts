/**
 * 右侧栏有哪几种。
 *
 * `standalone` 是个**统称**：插件贡献的独立面板（公式表、大纲…）都归到它，
 * 具体是哪一个由 `activePanelId` 里的 `standalone:<面板 id>` 前缀带出来。
 */
export type SidePanelMode = "settings" | "plugins" | "about" | "standalone";

/**
 * 内建的那几个面板 —— 各自占一整层、由主窗口直接渲染。
 *
 * ⚠️ **新增一个内建侧栏时，必须往这里补一个词。** 漏了的话它会掉进 `standalone`
 * 那一层，而那一层只认插件贡献的面板、找不到就渲染成 null —— 现象是
 * **「按钮点亮了、侧栏也拉开了、里面什么都没有」**，没有任何报错。（这个坑踩过一次：
 * 「关于」加上去的时候漏了。）
 */
const BUILT_IN: readonly string[] = ["settings", "plugins", "about"];

/**
 * `activePanelId` → 该挂哪一层。
 *
 * 抽成纯函数是为了能直接测：这段映射错了只表现为「面板空白」，不报错、不崩，
 * 靠肉眼很难在代码里看出来。
 */
export function sidePanelModeOf(activePanelId: string | null): SidePanelMode | null {
  if (!activePanelId) return null;
  return BUILT_IN.includes(activePanelId) ? (activePanelId as SidePanelMode) : "standalone";
}
