/**
 * 插件沙箱 Worker 的入口。
 *
 * 只负责把 Worker 全局包成一个 `WorkerSideTransport`，然后交给传输无关的
 * `runPluginSandbox`。真正的沙箱逻辑在 `workerBootstrap.ts` 里——同一份代码也被
 * 进程内环回（测试用）复用。
 *
 * 这里**故意不用** `/// <reference lib="webworker" />`：`tsconfig.json` 的 `lib`
 * 已经包含 `DOM`，再叠加 `WebWorker` 会让 `self`、`postMessage`、`Event` 等标识符
 * 重复声明而编译报错。改为把 `self` 窄化成所需的最小形状，既避开冲突，也不需要
 * 改动 tsconfig。
 */

import { runPluginSandbox } from "../workerBootstrap";
import type { HostToWorker, WorkerToHost } from "../protocol";
import type { WorkerSideTransport } from "../transport";

/** 只声明真正用到的三个成员，避免引入整套 WebWorker 全局类型。 */
interface WorkerGlobalLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerGlobalLike;

const transport: WorkerSideTransport = {
  get disposed() {
    return false;
  },
  post(message: WorkerToHost) {
    scope.postMessage(message);
  },
  subscribe(handler: (message: HostToWorker) => void) {
    const listener = (event: MessageEvent) => handler(event.data as HostToWorker);
    scope.addEventListener("message", listener);
    return () => scope.removeEventListener("message", listener);
  },
  dispose() {
    // Worker 的销毁由宿主侧 terminate() 完成，这里无需额外动作。
  },
};

void runPluginSandbox(transport);
