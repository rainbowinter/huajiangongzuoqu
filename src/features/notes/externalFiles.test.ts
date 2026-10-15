import { describe, expect, test } from "vitest";
import { listableExternalFiles } from "./externalFiles";
import type { ExternalFile } from "./types";

/**
 * 「外部文件」侧栏该列哪些条目。
 *
 * 这条规则本身只有一行，但它定的是用户看到的东西：从工作区树点开的文件**不该**在
 * 「笔记」面板里冒出来（否则看起来像凭空多了篇笔记），从系统拖进来/用花笺打开的才该列。
 * `MainWindow.tsx` 挂满 Tauri API、测试环境导入不进来，所以规则单独成模块在这里钉住。
 */
function file(overrides: Partial<ExternalFile>): ExternalFile {
  return { id: "X:/a.md", title: "a", filePath: "X:/a.md", ...overrides };
}

describe("侧栏「外部文件」的过滤", () => {
  test("从系统打开的文件照常列出来", () => {
    const system = file({ id: "X:/notes/a.md", filePath: "X:/notes/a.md" });
    expect(listableExternalFiles([system])).toEqual([system]);
  });

  test("从工作区树点开的不列出来", () => {
    const workspace = file({
      id: "X:/proj/src/main.py",
      filePath: "X:/proj/src/main.py",
      fromWorkspace: true,
    });
    expect(listableExternalFiles([workspace])).toEqual([]);
  });

  test("两种混在一起时只留下从系统打开的那些", () => {
    const system = file({ id: "X:/a.md", filePath: "X:/a.md" });
    const workspace = file({ id: "X:/proj/b.md", filePath: "X:/proj/b.md", fromWorkspace: true });
    const dropped = file({ id: "X:/c.md", filePath: "X:/c.md" });

    expect(listableExternalFiles([workspace, system, dropped])).toEqual([system, dropped]);
  });

  test("保持原有顺序 —— 列表顺序就是打开顺序", () => {
    const first = file({ id: "X:/1.md", filePath: "X:/1.md" });
    const second = file({ id: "X:/2.md", filePath: "X:/2.md" });

    expect(listableExternalFiles([first, second]).map((f) => f.id)).toEqual([
      "X:/1.md",
      "X:/2.md",
    ]);
  });

  test("空列表还是空列表", () => {
    expect(listableExternalFiles([])).toEqual([]);
  });
});
