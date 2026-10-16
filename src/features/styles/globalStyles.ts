import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 全局样式表 —— `<数据目录>/styles/*.css`。
 *
 * 目录里的每一份 `.css` 都注入**每一个窗口**，**没有开关**（想让它不生效就把文件移走）。
 * 数据侧的一切（列目录、读内容、路径校验、轮询）都在 Rust 的 `src-tauri/src/styles.rs`，
 * 这里只做「拿回来 → 塞进 `<head>`」。
 *
 * ## 时机与生命周期
 *
 * `installGlobalStyles()` 挂在 `src/App.tsx` —— 那是主窗口 / 小窗 / 磁贴**共用的外壳**，
 * 一处接线三个窗口全覆盖。每个窗口各注入自己的一份，因为 `document.head` 本来就是
 * 各窗口独立的。
 *
 * 「改了文件怎么办」由 Rust 那边的**轮询**负责：它每 2 秒比一次指纹，变了就广播
 * `global-styles-changed`，三个窗口一起收到、一起重注入。所以小窗和磁贴**不需要**
 * 各自轮询，也不需要互相通知。
 */

/** 与 Rust 的 `styles::StyleSheet` 一一对应。 */
export interface StyleSheet {
  name: string;
  mtimeMs: number;
  size: number;
  css: string;
}

/** 注入用的标记属性。值就是文件名 —— 出问题时在 DevTools 里一眼看得出是谁。 */
export const STYLE_ATTR = "data-floral-style";

/** Rust 广播「样式变了」用的主题。 */
export const STYLES_CHANGED_EVENT = "global-styles-changed";

/** 一次取回目录里全部样式表（连内容）。 */
export function bundleStyles(): Promise<StyleSheet[]> {
  return invoke<StyleSheet[]>("global_styles_bundle");
}

/** 样式目录的绝对路径（会给界面显示）。 */
export function stylesDirPath(): Promise<string> {
  return invoke<string>("global_styles_dir_path");
}

/** 在系统文件管理器里打开样式目录，返回值是那个路径。 */
export function openStylesDir(): Promise<string> {
  return invoke<string>("global_styles_open_dir");
}

/**
 * 把一批样式表压成一个签名 —— 一样就说明不必重新注入。
 *
 * **纯函数**（可单测）。先把名字排序，所以只比较「有哪些文件、各自什么状态」，
 * 与传入顺序无关。任一文件的名字、修改时间或大小变了，签名就变。
 *
 * ⚠️ 用「修改时间 + 大小」而不是内容：这是每次轮询都要跑的东西（Rust 侧同款口径），
 * 读内容意味着每 2 秒把整个目录读一遍。二者的组合已经足够 —— 同一秒里改动且大小
 * 恰好不变的情况极罕见，真撞上也只是晚 2 秒生效，「重新加载」按钮还能兜底。
 */
export function styleSignature(sheets: readonly StyleSheet[]): string {
  return [...sheets]
    .sort(compareByName)
    .map((sheet) => `${sheet.name}:${sheet.mtimeMs}:${sheet.size}`)
    .join("|");
}

/**
 * 按文件名比较。**Rust 侧也是这个口径**（`list_stamps` 里 `String::cmp`，即码点序），
 * 所以两边排出来的顺序一致 —— 别换成 `localeCompare`：它会按语言排序规则来，
 * 中文文件名两边就可能排出不同的顺序，「签名相同但注入顺序不同」这种事很难查。
 *
 * ⚠️ 注入顺序**必须自己排**，不能指望后端给的就是排好的：Rust 现在确实排了，
 * 但「文件名字典序决定套用顺序」是前端公开的契约（文档里教用户用 `10-` / `20-`
 * 前缀控制先后），把它挂在后端的实现细节上迟早出事。
 */
function compareByName(left: { name: string }, right: { name: string }): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/**
 * 当前生效的样式表。
 *
 * ⚠️ **快照必须是稳定引用**：界面用 `useSyncExternalStore` 直接消费它，每次新建数组
 * 会让 React 认为快照一直在变、进而无限重渲染。`pluginFonts.ts` 踩过这个坑，
 * 这里的做法同样是「只有内容真的变了才换引用」。
 */
let sheets: readonly StyleSheet[] = Object.freeze([]);
/** 与 `sheets` 同步的签名，同时兼作「上一次注入了什么」的判据。 */
let appliedSignature = "";

const listeners = new Set<() => void>();

export function listGlobalStyles(): readonly StyleSheet[] {
  return sheets;
}

export function subscribeGlobalStyles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 内容真的变了才换引用并通知订阅者。 */
function publish(next: readonly StyleSheet[]): void {
  if (styleSignature(next) === appliedSignature) return;
  appliedSignature = styleSignature(next);
  sheets = Object.freeze([...next]);
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[styles] 全局样式订阅回调抛错", error);
    }
  }
}

/** 撤掉上一次注入的那批（只撤我们自己注入的，插件的 `data-plugin-style` 不碰）。 */
function clearInjected(): void {
  for (const element of document.querySelectorAll(`style[${STYLE_ATTR}]`)) {
    element.remove();
  }
}

/**
 * 取回并注入。签名没变就直接返回，什么都不碰。
 *
 * `force` 是给界面上的「重新加载」按钮用的：内容其实没动时也会重注入一遍，
 * 好让用户确信按钮生效了（否则点下去毫无反馈）。
 */
export async function refreshGlobalStyles(force = false): Promise<readonly StyleSheet[]> {
  let next: StyleSheet[];
  try {
    next = await bundleStyles();
  } catch {
    // 读不出来（数据目录刚被换掉、盘一时不可用……）就保持现状，**不清空已有样式** ——
    // 「界面突然全白」比「还是旧的」糟糕得多。
    return sheets;
  }

  const signature = styleSignature(next);
  if (!force && signature === appliedSignature) return sheets;

  clearInjected();

  // 按文件名排序后逐个 append —— 顺序稳定，且都落在 `<head>` 末尾，
  // 于是排在 `App.css` 之后，能盖住它（`custom.css` 以前靠 import 顺序拿到的那点优势，
  // 这里靠 append 位置保住）。
  //
  // 一份一个 `<style>` 而不是拼成一大份：某一份写坏了语法只是那一份失效，不会把后面的
  // 全带走；DevTools 里也能一眼看出哪条规则来自哪个文件。
  for (const sheet of [...next].sort(compareByName)) {
    const element = document.createElement("style");
    element.setAttribute(STYLE_ATTR, sheet.name);
    element.textContent = sheet.css;
    document.head.appendChild(element);
  }

  publish(next);
  return sheets;
}

/**
 * 挂载：立刻注入一次，然后订阅 Rust 的变更广播。
 *
 * 返回卸载函数（`useEffect` 直接写 `useEffect(() => installGlobalStyles(), [])`）。
 */
export function installGlobalStyles(): () => void {
  void refreshGlobalStyles();

  // Rust 侧轮询到变化就会广播，三个窗口都会收到 —— 这里各自重注入自己那份。
  const onChanged = listen(STYLES_CHANGED_EVENT, () => {
    void refreshGlobalStyles();
  });
  // 数据目录可以被用户迁移，样式表跟着换地方 —— 顺手再对一次签名即可，
  // 换了目录签名自然不同，不会白跑。
  const onConfig = listen("config-changed", () => {
    void refreshGlobalStyles();
  });

  return () => {
    void onChanged.then((off) => off());
    void onConfig.then((off) => off());
    // 刻意**不**清掉已注入的 `<style>`：窗口正在关闭，而且清掉会让界面闪一下白。
  };
}
