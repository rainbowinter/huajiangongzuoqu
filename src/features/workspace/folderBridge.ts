/**
 * 「把某个文件夹加进左侧工作区」的**能力口**。
 *
 * ## 为什么要有这么一层
 *
 * 插件（v2 的 worker 沙箱）想让宿主把 `<数据目录>/styles` 加进工作区 —— 但**加工作区是
 * 主窗口的状态**（`activeExplorer` / `sidebarCollapsed` 都是 `MainWindow` 的 `useState`），
 * 而调用方在 `v2Host` 那一层，两者之间隔着几十个 hook，没有现成的引用可传。
 *
 * 于是走**模块级 sink**：`MainWindow` 挂载时把自己的实现登记进来，卸载时清掉；
 * 插件侧只管调 `openWorkspaceFolder(path)`。这与 `activeView.ts`（视图命令转发）是同
 * 一个套路 —— 那个也是「宿主一侧才有、插件一侧要调」的东西。
 *
 * ⚠️ 卸载时必须清掉。否则窗口关了之后插件再调，回调会去打一个已经作废的
 * `setState`，弹的提示还会落在看不见的地方。
 */

/**
 * 允许插件指定的目标。**只有哨兵值，没有绝对路径**。
 *
 * 理由：插件住在数据目录里，数据目录搬到哪、叫什么名字都不是它能知道也不该猜的；
 * 反过来说，允许任意路径就等于给了一个「把 `C:\` 挂进侧栏」的能力，对用户没有任何好处。
 * 用户真想挂哪个目录，活动栏那颗 `+` 本来就是干这个的。
 */
export const WORKSPACE_FOLDER_TARGETS = ["@data", "@data/styles"] as const;

export type WorkspaceFolderTarget = (typeof WORKSPACE_FOLDER_TARGETS)[number];

const TARGET_SET: ReadonlySet<string> = new Set(WORKSPACE_FOLDER_TARGETS);

export function isWorkspaceFolderTarget(value: string): value is WorkspaceFolderTarget {
  return TARGET_SET.has(value);
}

/**
 * 两个路径是不是同一个目录。
 *
 * 为什么不能直接 `===`：加进列表的是后端 `canonicalize()` 之后再转成普通形式的路径，
 * 而调用方手里那份是从 `styles_dir()` 拼出来的 —— 同一个目录，写法可能差一个大小写、
 * 一个尾斜杠、或者正反斜杠。比错了的后果不是加两次（后端会去重），而是**跳不过去**：
 * 「已经在列表里」那条路要靠它找出该跳哪一个。
 *
 * 只做这三样归一化，**不做** `..` / 符号链接解析 —— 那是后端的事，前端再判一遍只会
 * 变成第二套规则。
 */
export function sameFolderPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/** 宿主的实现：把路径加进工作区（幂等）并跳过去。 */
export type WorkspaceFolderOpener = (path: string) => Promise<void>;

let opener: WorkspaceFolderOpener | null = null;

export function setWorkspaceFolderOpener(next: WorkspaceFolderOpener | null): void {
  opener = next;
}

/**
 * 请宿主打开这个文件夹。
 *
 * 没有宿主时**抛错而不是静默**：那说明调用发生在窗口关闭之后，静默会让人以为点生效了。
 */
export async function openWorkspaceFolder(path: string): Promise<void> {
  if (!opener) {
    throw new Error("当前窗口还没有准备好工作区（可能已经关闭）");
  }
  await opener(path);
}
