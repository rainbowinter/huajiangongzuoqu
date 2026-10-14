import { describe, expect, test, vi } from "vitest";
import { DisposableStore, isDisposable, toDisposable } from "./disposable";

describe("toDisposable", () => {
  test("幂等：重复 dispose 只触发一次清理", () => {
    const cleanup = vi.fn();
    const disposable = toDisposable(cleanup);

    disposable.dispose();
    disposable.dispose();
    disposable.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("isDisposable 识别形状", () => {
    expect(isDisposable(toDisposable(() => {}))).toBe(true);
    expect(isDisposable(null)).toBe(false);
    expect(isDisposable({})).toBe(false);
    expect(isDisposable({ dispose: 1 })).toBe(false);
  });
});

describe("DisposableStore", () => {
  test("dispose 释放全部并保持幂等", () => {
    const store = new DisposableStore();
    const a = vi.fn();
    const b = vi.fn();

    store.addFn(a);
    store.addFn(b);
    store.dispose();
    store.dispose();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(store.isDisposed).toBe(true);
  });

  test("已释放之后加进来的项会立刻被释放（防止卸载途中注册导致泄漏）", () => {
    const store = new DisposableStore();
    store.dispose();

    const late = vi.fn();
    store.addFn(late);

    expect(late).toHaveBeenCalledTimes(1);
  });

  test("remove 释放单项并从列表摘除", () => {
    const store = new DisposableStore();
    const keep = vi.fn();
    const drop = vi.fn();

    store.addFn(keep);
    const disposable = store.addFn(drop);
    store.remove(disposable);

    expect(drop).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);

    store.dispose();
    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledTimes(1);
  });

  test("单项释放抛错不阻断其余项", () => {
    const store = new DisposableStore();
    const after = vi.fn();

    store.addFn(() => {
      throw new Error("boom");
    });
    store.addFn(after);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => store.dispose()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  test("clear 后可继续使用", () => {
    const store = new DisposableStore();
    const first = vi.fn();

    store.addFn(first);
    store.clear();
    expect(first).toHaveBeenCalledTimes(1);
    expect(store.isDisposed).toBe(false);

    const second = vi.fn();
    store.addFn(second);
    store.dispose();

    expect(second).toHaveBeenCalledTimes(1);
  });
});
