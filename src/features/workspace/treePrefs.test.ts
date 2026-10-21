import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  expandAncestors,
  filterExpandedPaths,
  readAutoRefresh,
  readDisplayMode,
  readExpanded,
  writeAutoRefresh,
  writeDisplayMode,
  writeExpanded,
} from "./treePrefs";

describe("treePrefs", () => {
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

  test("展开状态按工作区根分别保存", () => {
    writeExpanded("E:\\a", ["E:\\a\\src", "E:\\a\\docs"]);
    writeExpanded("E:\\b", ["E:\\b\\x"]);

    expect(readExpanded("E:\\a")).toEqual(["E:\\a\\src", "E:\\a\\docs"]);
    expect(readExpanded("E:\\b")).toEqual(["E:\\b\\x"]);
    expect(readExpanded("E:\\c")).toEqual([]);
  });

  test("空集合会删掉这个根的记录", () => {
    writeExpanded("E:\\a", ["E:\\a\\src"]);
    writeExpanded("E:\\a", []);
    expect(store.has("floral.workspace.expanded")).toBe(true);
    expect(readExpanded("E:\\a")).toEqual([]);
  });

  test("显示方式默认是卡片，另外两档会记住", () => {
    expect(readDisplayMode("E:\\a")).toBe("cards");
    writeDisplayMode("E:\\a", "list");
    expect(readDisplayMode("E:\\a")).toBe("list");
    writeDisplayMode("E:\\a", "icons");
    expect(readDisplayMode("E:\\a")).toBe("icons");
    writeDisplayMode("E:\\a", "cards");
    expect(readDisplayMode("E:\\a")).toBe("cards");
  });

  test("旧版的 details / compact 会迁移到新名字", () => {
    localStorage.setItem("floral.workspace.displayMode", JSON.stringify({ "E:\\a": "compact" }));
    expect(readDisplayMode("E:\\a")).toBe("list");
    localStorage.setItem("floral.workspace.displayMode", JSON.stringify({ "E:\\b": "details" }));
    expect(readDisplayMode("E:\\b")).toBe("cards");
  });

  test("自动检测默认关闭，按工作区分别记住", () => {
    expect(readAutoRefresh("E:\\a")).toBe(false);
    writeAutoRefresh("E:\\a", true);
    expect(readAutoRefresh("E:\\a")).toBe(true);
    expect(readAutoRefresh("E:\\b")).toBe(false);

    writeAutoRefresh("E:\\a", false);
    expect(readAutoRefresh("E:\\a")).toBe(false);
  });

  test("关闭时不留下记录", () => {
    writeAutoRefresh("E:\\a", true);
    expect(store.has("floral.workspace.autoRefresh")).toBe(true);
    writeAutoRefresh("E:\\a", false);
    const record = JSON.parse(store.get("floral.workspace.autoRefresh") ?? "{}");
    expect(record).toEqual({});
  });

  test("过滤掉别的根与根本身", () => {
    const result = filterExpandedPaths("E:\\a", [
      "E:\\a\\src",
      "E:\\a",
      "E:\\b\\x",
      "E:\\ab\\y",
    ]);
    expect([...result]).toEqual(["E:\\a\\src"]);
  });

  test("expandAncestors 补齐所有父目录", () => {
    const result = expandAncestors("E:\\a", ["E:\\a\\src\\deep\\file"]);
    expect([...result]).toEqual(["E:\\a\\src", "E:\\a\\src\\deep", "E:\\a\\src\\deep\\file"]);
  });

  test("斜杠风格的前缀也能处理", () => {
    const result = expandAncestors("E:/a/", ["E:/a/src/deep"]);
    expect([...result]).toEqual(["E:/a/src", "E:/a/src/deep"]);
  });
});
