/**
 * 「往**当前那个**沙箱视图发一条命令」的小信箱。
 *
 * ## 为什么需要它
 *
 * 视图类插件的真身住在 `sandbox="allow-scripts"` 的 iframe 里（拿得到画布、pdf.js、
 * 文字层、选区），而它的 index.js 跑在 Worker 沙箱里 —— **两边隔着一条边界，宿主是唯一
 * 的传话人**。宿主 → 帧的那条现成通道是 `PluginViewApi.post({ t: "command", id })`，
 * 由 `PluginFileView` 持有。
 *
 * 文档级动作（比如「导出批注」）与插件面板（比如 Word 阅读器的「开始」格式栏）都在
 * **主窗口的界面层**，它们既不知道当前是哪个视图、也拿不到那份 api。于是这里放一个
 * **只有一个格子**的信箱：`PluginFileView` 挂载时把 `post` 交出来，卸载时收回去。
 *
 * ## 为什么是「一个格子」而不是一张表
 *
 * 同一时刻**只可能有一个视图是「当前」的那个** —— 别的窗口（记事本、磁贴）各有各的
 * 主窗口实例，各自有自己的这一份模块状态。要是留一张按 path 索引的表，就得自己回答
 * 「哪一条是活的」，而那个答案随时会过期。
 *
 * ## 为什么带 `owner`
 *
 * 插件面板可以通过 `api.ui.sendToView()` 往当前视图发命令。要是不认插件名，任何一个
 * 有 `files:view` 的插件都能往**别人**的视图里发命令 —— 那是一个跨插件的权限口子。
 * 宿主内部的文档动作不带 `owner`（它已经按当前文件类型筛过），插件侧则必须带。
 *
 * ⚠️ **卸载时必须收回**（`setActiveViewCommandSink(null)`）。留着一个死帧的 `post`，
 * 点按钮会往一个已经拆掉的 iframe 里发消息 —— 静默无反应，最难查。
 */

export interface ViewCommandSink {
  /** 这个视图属于哪个插件（文件类型 id 的前缀，例如 `office-viewer`）。 */
  owner: string;
  post: (commandId: string, value?: string) => void;
}

let sink: ViewCommandSink | null = null;

/** 由 `PluginFileView` 在挂载 / 卸载时调用。传 `null` 表示收回。 */
export function setActiveViewCommandSink(next: ViewCommandSink | null): void {
  sink = next;
}

/**
 * 往当前视图发一条命令。没有活着的视图（或它还没就绪）时**什么都不做**。
 *
 * 不抛错是刻意的：调用方是界面上的一个按钮，命令发不出去只说明「现在没有可以接它的
 * 视图」，那不是用户的错，弹一个错误框反而莫名其妙。
 *
 * @param owner 插件名。给了就必须与当前视图的 owner 一致；宿主内部调用可以省略。
 * @returns 有没有真的发出去。
 */
export function postActiveViewCommand(
  commandId: string,
  value?: string,
  owner?: string,
): boolean {
  if (!sink) return false;
  if (owner !== undefined && sink.owner !== owner) return false;
  sink.post(commandId, value);
  return true;
}
