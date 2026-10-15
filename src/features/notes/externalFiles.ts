import type { ExternalFile } from "./types";

/**
 * 侧栏「外部文件」那一栏**该显示**哪些条目。
 *
 * 从工作区树里点开的文件同样记在 `externalFiles` 里（保存路由与「这算不算外部文件」的
 * 判据都依赖它，见 `ExternalFile.fromWorkspace` 的说明），但它们**不该被列出来** ——
 * 工作区树本身就是它们的导航，再在「笔记」面板里冒一条，用户会以为凭空多了篇笔记。
 *
 * 抽成独立函数（而不是在组件里写个 `.filter`）是为了能直接测：`MainWindow.tsx` 一整个
 * 组件挂满了 Tauri API，测试环境里根本导入不进来。
 */
export function listableExternalFiles(files: readonly ExternalFile[]): ExternalFile[] {
  return files.filter((file) => !file.fromWorkspace);
}
