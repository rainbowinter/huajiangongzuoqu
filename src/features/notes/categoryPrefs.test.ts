import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readCollapsedCategories, writeCollapsedCategories } from "./categoryPrefs";

describe("categoryPrefs", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("没有记录时全部收起", () => {
    expect([...readCollapsedCategories(["a", "b"])]).toEqual(["a", "b"]);
  });

  test("记住哪些收起，新分类默认收起", () => {
    writeCollapsedCategories(new Set(["a"]), ["a", "b"]);
    expect([...readCollapsedCategories(["a", "b", "c"])].sort()).toEqual(["a", "c"]);
  });

  test("展开过的分类不会被重新收起", () => {
    writeCollapsedCategories(new Set(), ["a", "b"]);
    expect(readCollapsedCategories(["a", "b"]).size).toBe(0);
  });
});
