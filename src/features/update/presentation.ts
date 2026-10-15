/**
 * 更新流程里可以直接测的纯逻辑。
 *
 * 单独成模块的原因：`useUpdate.ts` 拖着 `@tauri-apps/plugin-updater`，`UpdateBadge.tsx`
 * 拖着 React 与 i18n —— 而这个仓库的测试环境里没有 @testing-library（没有 jsdom），
 * hook 和组件都挂不起来。所以「什么时候该露出提示」这类**判据**要放在没有依赖的地方，
 * 才能被真正钉住。
 */

/** 更新流程的状态机。定义在这里，好让纯函数与 hook 共用同一份类型。 */
export type UpdateState =
  | { stage: "idle" }
  | { stage: "checking" }
  | { stage: "available"; version: string; notes: string }
  | { stage: "downloading"; version: string; notes: string; downloaded: number; total: number | null }
  | { stage: "ready"; version: string; notes: string }
  | { stage: "installing"; version: string; notes: string }
  | { stage: "error"; message: string };

/**
 * 右上角那颗胶囊该不该出现。
 *
 * **只有「有事可做」才出现**：`idle`（没配端点、或已是最新）与 `checking`（启动时那次
 * 静默检查）都不出现。这一条很要紧 —— 它决定了这个功能在大多数时候是否**完全隐形**。
 */
export function isUpdateVisible(state: UpdateState): boolean {
  return (
    state.stage === "available" ||
    state.stage === "downloading" ||
    state.stage === "ready" ||
    state.stage === "installing" ||
    state.stage === "error"
  );
}

/**
 * 下载进度百分比（整数）。算不出来时返回 `null`。
 *
 * 端点没给 `Content-Length` 时 `total` 是 `null`，此时**不能**当成 0% —— 那会显示出
 * 一个一直停在 0 的进度条，比不显示进度更让人以为卡死了。
 */
export function downloadPercent(downloaded: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  const percent = Math.floor((downloaded / total) * 100);
  return Math.max(0, Math.min(100, percent));
}
