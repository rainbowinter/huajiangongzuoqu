/**
 * 插件沙箱 Worker 的唯一构造点。
 *
 * ⚠️ `new Worker(new URL("...", import.meta.url), ...)` 只有在**参数是字面量相对
 * 路径**时才能被 Vite 静态分析并正确打包。因此这个调用必须集中在这一个文件里，
 * 不能把路径参数化、也不能改写成变量拼接，否则生产构建下 worker 会 404。
 *
 * `vite.config.ts` 里配了 `worker: { format: "es" }` 与 `{ type: "module" }` 配套。
 * 可行性依据：`tauri.conf.json` 的 `csp` 为 null（不限制 worker-src / unsafe-eval），
 * 且 `bundle.macOS.minimumSystemVersion` 为 15.0，WKWebView 足够新。
 */

import { createWorkerTransport, type HostSideTransport } from "../transport";

export interface SandboxWorkerHandle {
  transport: HostSideTransport;
  terminate(): void;
}

/**
 * 尝试创建一个模块 Worker。
 *
 * 环境不支持或构造失败时返回 `null`——调用方应据此把插件标记为
 * `sandboxUnavailable` 而**不是**退回主线程裸跑。降级意味着失去隔离，
 * 默认不能悄悄发生。
 */
export function createSandboxWorker(): SandboxWorkerHandle | null {
  if (typeof Worker === "undefined") return null;

  try {
    const worker = new Worker(new URL("../worker/sandbox.worker.ts", import.meta.url), {
      type: "module",
      name: "floral-plugin-sandbox",
    });

    const transport = createWorkerTransport(worker);
    return {
      transport,
      terminate() {
        transport.dispose();
      },
    };
  } catch (error) {
    console.error("[plugins] 无法创建沙箱 Worker", error);
    return null;
  }
}
