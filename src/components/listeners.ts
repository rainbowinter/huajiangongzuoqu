import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * 安全卸载一个 `listen()` / `onResized()` 返回的监听器。
 *
 * 这段代码**全部跑在 effect 的清理函数里**，而清理函数绝不能抛：
 *
 * - 窗口正在销毁、或 Vite HMR 整体重载时，IPC 可能已经断了，`listen()` 会以非函数
 *   的形态兑现 —— `unlisten.then((fn) => fn())` 当场炸成一条未处理拒绝；
 * - 就算兑现值没问题，调用它本身也可能抛（监听器已经随窗口一起没了）。
 *
 * 这两种情况都没有任何补救动作可做，抛出只会往控制台刷噪音、掩盖真正的错误，
 * 所以两头都兜住。
 */
export function disposeListener(unlisten: Promise<UnlistenFn>): void {
  void unlisten.then(
    (fn) => {
      if (typeof fn !== "function") return;
      try {
        fn();
      } catch {
        // 监听器已经没了，无事可做。
      }
    },
    () => undefined,
  );
}
