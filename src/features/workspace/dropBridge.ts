/**
 * 「把系统拖进来的文件交给当前工作区树」的小信箱。
 *
 * 拖放事件由 `MainWindow` 的 Tauri 监听器统一接收（它本来负责把拖进来的文件当外部
 * 文件打开）。当落点在目录树里时，它需要换一条路：复制进那个文件夹。但「复制到哪里」
 * 只有 `WorkspaceTree` 知道（它持有展开状态、焦点目录与确认框）。
 *
 * 于是这里放一个只允许**一个**处理器的信箱 —— 同一时刻只有一棵树是活动的，留一张表
 * 反而要回答「哪一条是活的」。卸载时必须收回，否则落点判断会打到一个已经卸载的组件。
 */

type WorkspaceDropHandler = (paths: string[], targetDir: string | null) => void;

let handler: WorkspaceDropHandler | null = null;

export function setWorkspaceDropHandler(next: WorkspaceDropHandler | null): void {
  handler = next;
}

/**
 * 交给当前目录树处理。`targetDir` 为 `null` 表示落点在树的空白处 —— 由树自己决定
 * 用焦点目录。
 *
 * @returns 有没有树接住。`false` 时调用方继续走原来的「打开文件」逻辑。
 */
export function dropOntoWorkspace(paths: string[], targetDir: string | null): boolean {
  if (!handler || paths.length === 0) return false;
  handler(paths, targetDir);
  return true;
}
