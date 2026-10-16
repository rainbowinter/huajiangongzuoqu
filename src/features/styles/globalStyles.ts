import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 全局样式表 —— `<数据目录>/styles/`。
 *
 * ## 哪几份生效
 *
 * 1. `custom.css` —— **常开**，它就是「我的界面」那份主样式表；
 * 2. **全局打开的**（在「样式」面板里挨个开）；
 * 3. **挂在当前打开文件上的**。
 *
 * 判据本身在 Rust（`styles::applied_names`），这里只认它给的 `applied` 标志 ——
 * **别在前端再算一遍**，两套规则迟早不一致（而且 R 侧那份有单测）。
 *
 * 数据侧的一切（列目录、读内容、路径校验、轮询）都在 `src-tauri/src/styles.rs`，
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
 *
 * 开关的翻转不是**文件**变化，轮询看不见，由那两条命令自己广播一次。
 */

/** 与 Rust 的 `styles::StyleSheet` 一一对应。 */
export interface StyleSheet {
  name: string;
  mtimeMs: number;
  size: number;
  css: string;
  /** 现在会不会被注入。**注入只看这一个字段。** */
  applied: boolean;
  /** 全局开关开着没有。 */
  global: boolean;
  /**
   * 挂在**当前打开的那个文件**上没有。与 `applied` 不是一回事 —— 一份既全局开着、
   * 又挂在这个文件上时两者同为真；而「当前文件」那一段显示的必须是「挂没挂」。
   */
  bound: boolean;
  /** 常开、界面上把开关钉死的那一份（`custom.css`）。 */
  locked: boolean;
}

/** Rust 的 `StylesConfig`：开关与按文件绑定的落盘形态。 */
export interface StylesConfig {
  global: string[];
  files: Record<string, string[]>;
}

/** 注入用的标记属性。值就是文件名 —— 出问题时在 DevTools 里一眼看得出是谁。 */
export const STYLE_ATTR = "data-floral-style";

/** Rust 广播「样式变了」用的主题。 */
export const STYLES_CHANGED_EVENT = "global-styles-changed";

/**
 * 现在打开的是哪个文件（外部文件的绝对路径，或者笔记 id）—— 与插件面板、工作区缓存
 * 用的是同一个 key。`null` = 没打开任何东西（只注入常开与全局那几份）。
 */
let activeFileKey: string | null = null;

/**
 * 告诉样式模块「现在打开的是谁」。由 `MainWindow` 在选中项变化时调。
 *
 * 变了才重新取一次：没变就返回，免得每次重新渲染都打一趟 IPC。**键变了不等于样式变了**
 * —— 签名一致时 `refreshGlobalStyles` 自己会跳过重注入，所以这里不必再判一次。
 */
export function setActiveStyleFile(key: string | null): void {
  const next = key && key.trim() ? key : null;
  if (next === activeFileKey) return;
  activeFileKey = next;
  void refreshGlobalStyles();
}

/** 一次取回目录里**全部**样式表（连内容），每份带当前文件视角下的三个状态位。 */
export function bundleStyles(): Promise<StyleSheet[]> {
  return invoke<StyleSheet[]>("global_styles_bundle", { fileKey: activeFileKey });
}

/** 把一份样式表开成 / 关掉全局。`custom.css` 会被后端拒绝。 */
export function setStyleGlobal(name: string, enabled: boolean): Promise<StylesConfig> {
  return invoke<StylesConfig>("global_styles_set_global", { name, enabled });
}

/** 把一份样式表挂到 / 摘离某一个文件。 */
export function bindStyleToFile(
  fileKey: string,
  name: string,
  enabled: boolean,
): Promise<StylesConfig> {
  return invoke<StylesConfig>("global_styles_bind", { fileKey, name, enabled });
}

/**
 * 界面上的开关点一下走的这条路：改完立刻重新取一遍清单。
 *
 * 后端那条命令也会广播 `global-styles-changed`（别的窗口要跟着变），但**不能只靠它** ——
 * 事件是异步投递的，点完开关到面板重画之间会空一拍，看着像没点动。自己再取一次是确定的；
 * 两条路撞上也无妨，签名一致就不会重复注入。
 */
async function applySwitch(action: () => Promise<StylesConfig>): Promise<void> {
  await action();
  await refreshGlobalStyles();
}

export function toggleStyleGlobal(name: string, enabled: boolean): Promise<void> {
  return applySwitch(() => setStyleGlobal(name, enabled));
}

export function toggleStyleForFile(
  fileKey: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  return applySwitch(() => bindStyleToFile(fileKey, name, enabled));
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
    // `applied` / `global` / `bound` 一并算进去：**翻了开关也是「内容变了」**，签名不带
    // 它们的话「关掉」这一步会被当成没变，样式还挂在那儿。
    .map(
      (sheet) =>
        `${sheet.name}:${sheet.mtimeMs}:${sheet.size}:${sheet.applied ? 1 : 0}:${sheet.global ? 1 : 0}:${sheet.bound ? 1 : 0}`,
    )
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
  } catch (error) {
    // 读不出来（数据目录刚被换掉、盘一时不可用……）就保持现状，**不清空已有样式** ——
    // 「界面突然全白」比「还是旧的」糟糕得多。
    //
    // ⚠️ 但也**不能一声不吭**：这条路上「保持现状」的表现是**面板里的清单停在旧的那一份**
    // ——用户看到的是「点了刷新没反应、新加的样式表不出现」，而日志里一个字都没有。
    // 上报一条 warn（经 Vite 会落到 dev-server 的输出里），下次一眼就能分辨。
    console.warn("[styles] 取回样式表失败，保持现状（清单可能停在上一次的结果）", error);
    return sheets;
  }

  const signature = styleSignature(next);
  if (!force && signature === appliedSignature) return sheets;

  clearInjected();

  // 只注入 `applied` 的那几份 —— 目录里的**其它**文件只是「存在」，不生效。
  //
  // 按文件名排序后逐个 append：顺序稳定，且都落在 `<head>` 末尾，于是排在 `App.css`
  // 之后，能盖住它（`custom.css` 以前靠 import 顺序拿到的那点优势，这里靠 append
  // 位置保住）。
  //
  // 一份一个 `<style>` 而不是拼成一大份：某一份写坏了语法只是那一份失效，不会把后面的
  // 全带走；DevTools 里也能一眼看出哪条规则来自哪个文件。
  for (const sheet of [...next].sort(compareByName)) {
    if (!sheet.applied) continue;
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
