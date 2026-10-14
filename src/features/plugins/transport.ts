/**
 * 宿主与插件运行时之间的消息传输抽象。
 *
 * 两个实现：
 *
 * * `WorkerTransport` —— 真·沙箱，包一个 `Worker`。
 * * `InProcessTransport`（环回）—— 同步微任务队列，在**同一个 JS realm** 里把消息
 *   投递给对端。
 *
 * 环回实现一石三鸟：**单测**（vitest 跑在 node 环境，既没有 `Worker` 全局也没有
 * jsdom）、**降级兜底**（WebView 不支持模块 Worker 时，插件退回主线程运行，但
 * **仍然走同一套权限门**，只是失去崩溃隔离与真隔离）、以及让 RPC 层完全不必知道
 * 自己在跟什么说话。
 *
 * 所有投递都是**异步**的（`queueMicrotask`），刻意模拟 `postMessage` 的语义：
 * 若做成同步，宿主会遭遇真实 Worker 下不存在的重入，测试也就失去了意义。
 */

import type { HostToWorker, WorkerToHost } from "./protocol";

export interface Transport<TOut, TIn> {
  post(message: TOut): void;
  subscribe(handler: (message: TIn) => void): () => void;
  dispose(): void;
  readonly disposed: boolean;
}

export type HostSideTransport = Transport<HostToWorker, WorkerToHost>;
export type WorkerSideTransport = Transport<WorkerToHost, HostToWorker>;

class Endpoint<TOut, TIn> implements Transport<TOut, TIn> {
  private handlers = new Set<(message: TIn) => void>();
  private isDisposed = false;

  constructor(
    private readonly send: (message: TOut) => void,
    private readonly teardown: () => void,
  ) {}

  get disposed(): boolean {
    return this.isDisposed;
  }

  post(message: TOut): void {
    if (this.isDisposed) return;
    this.send(message);
  }

  subscribe(handler: (message: TIn) => void): () => void {
    if (this.isDisposed) return () => {};
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 由对端调用：把消息投递给本端的订阅者。复制一份再遍历，避免回调里退订出错。 */
  deliver(message: TIn): void {
    if (this.isDisposed) return;
    for (const handler of [...this.handlers]) {
      try {
        handler(message);
      } catch (error) {
        console.error("[plugins] 传输层订阅回调抛错", error);
      }
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.handlers.clear();
    this.teardown();
  }
}

export interface LoopbackPair {
  host: HostSideTransport;
  worker: WorkerSideTransport;
  /** 两端一起销毁。 */
  dispose(): void;
}

/**
 * 造一对互相连通的进程内端点。
 *
 * `host.post(msg)` 会在一个微任务后到达 `worker` 的订阅者，反之亦然。
 */
export function createLoopbackPair(): LoopbackPair {
  // 两个端点互相持有引用，先声明后接线，避免构造顺序死结。
  let hostEndpoint: Endpoint<HostToWorker, WorkerToHost>;
  let workerEndpoint: Endpoint<WorkerToHost, HostToWorker>;

  // 宿主发出的 HostToWorker 最终抵达 worker 端点的订阅者，反之亦然。
  hostEndpoint = new Endpoint<HostToWorker, WorkerToHost>(
    (message) => queueMicrotask(() => workerEndpoint.deliver(message)),
    () => workerEndpoint.dispose(),
  );
  workerEndpoint = new Endpoint<WorkerToHost, HostToWorker>(
    (message) => queueMicrotask(() => hostEndpoint.deliver(message)),
    () => hostEndpoint.dispose(),
  );

  return {
    host: hostEndpoint,
    worker: workerEndpoint,
    dispose() {
      hostEndpoint.dispose();
      workerEndpoint.dispose();
    },
  };
}

/** 把一个 `Worker` 包成宿主侧传输。 */
export function createWorkerTransport(worker: Worker): HostSideTransport {
  let disposed = false;

  return {
    get disposed() {
      return disposed;
    },
    post(message: HostToWorker) {
      if (disposed) return;
      worker.postMessage(message);
    },
    subscribe(handler: (message: WorkerToHost) => void) {
      if (disposed) return () => {};
      const listener = (event: MessageEvent<WorkerToHost>) => handler(event.data);
      const errorListener = (event: ErrorEvent) => {
        handler({
          t: "log",
          level: "error",
          message: event.message || "插件 Worker 发生未捕获错误",
          stack: event.error instanceof Error ? event.error.stack : undefined,
        });
      };
      worker.addEventListener("message", listener);
      worker.addEventListener("error", errorListener);
      return () => {
        worker.removeEventListener("message", listener);
        worker.removeEventListener("error", errorListener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      worker.terminate();
    },
  };
}

/**
 * 探测当前环境能否起模块 Worker。
 *
 * 在 vitest 的 node 环境里 `Worker` 不存在，会走环回降级；某些 WebView 上
 * 构造也可能抛错，一并兜住。
 */
export function canUseWorker(): boolean {
  return typeof Worker !== "undefined" && typeof URL !== "undefined";
}
