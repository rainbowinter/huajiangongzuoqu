import { describe, expect, test, vi } from "vitest";
import type { HostToWorker, WorkerToHost } from "./protocol";
import { canUseWorker, createLoopbackPair } from "./transport";

describe("环回传输", () => {
  test("投递是异步的（模拟 postMessage，避免同步重入）", async () => {
    const pair = createLoopbackPair();
    const received: HostToWorker[] = [];
    pair.worker.subscribe((message) => received.push(message));

    pair.host.post({ t: "dispose", reason: "unload" });
    // 同步阶段不应该收到——真实 Worker 下也不可能
    expect(received).toHaveLength(0);

    await Promise.resolve();
    expect(received).toHaveLength(1);

    pair.dispose();
  });

  test("双向连通且顺序保持", async () => {
    const pair = createLoopbackPair();
    const toWorker: HostToWorker[] = [];
    const toHost: WorkerToHost[] = [];

    pair.worker.subscribe((message) => toWorker.push(message));
    pair.host.subscribe((message) => toHost.push(message));

    pair.host.post({ t: "dispose", reason: "unload" });
    pair.host.post({ t: "dispose", reason: "reload" });
    pair.worker.post({ t: "ready" });
    pair.worker.post({ t: "loaded" });

    await Promise.resolve();

    expect(toWorker.map((m) => m.t)).toEqual(["dispose", "dispose"]);
    expect(toHost.map((m) => m.t)).toEqual(["ready", "loaded"]);

    pair.dispose();
  });

  test("多个订阅者都收到消息", async () => {
    const pair = createLoopbackPair();
    const first = vi.fn();
    const second = vi.fn();

    pair.worker.subscribe(first);
    pair.worker.subscribe(second);
    pair.host.post({ t: "ready" } as unknown as HostToWorker);

    await Promise.resolve();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    pair.dispose();
  });

  test("退订后不再收到", async () => {
    const pair = createLoopbackPair();
    const handler = vi.fn();
    const unsubscribe = pair.worker.subscribe(handler);

    unsubscribe();
    pair.host.post({ t: "dispose", reason: "unload" });
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    pair.dispose();
  });

  test("dispose 之后 post 无效", async () => {
    const pair = createLoopbackPair();
    const handler = vi.fn();
    pair.worker.subscribe(handler);

    pair.host.dispose();
    expect(pair.host.disposed).toBe(true);

    pair.host.post({ t: "dispose", reason: "unload" });
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
  });

  test("一端 dispose 会带动另一端", () => {
    const pair = createLoopbackPair();
    pair.host.dispose();
    expect(pair.worker.disposed).toBe(true);
  });

  test("订阅者抛错不影响其他订阅者", async () => {
    const pair = createLoopbackPair();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();

    pair.worker.subscribe(() => {
      throw new Error("bad subscriber");
    });
    pair.worker.subscribe(good);

    pair.host.post({ t: "dispose", reason: "unload" });
    await Promise.resolve();

    expect(good).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
    pair.dispose();
  });
});

describe("Worker 可用性探测", () => {
  test("node 测试环境下没有 Worker 全局，探测为 false", () => {
    // 这正是环回实现存在的理由：测试环境起不了真 Worker。
    expect(typeof Worker).toBe("undefined");
    expect(canUseWorker()).toBe(false);
  });
});
