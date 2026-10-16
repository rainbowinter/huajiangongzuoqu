import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_FOLDER_TARGETS,
  isWorkspaceFolderTarget,
  openWorkspaceFolder,
  sameFolderPath,
  setWorkspaceFolderOpener,
} from "./folderBridge";

afterEach(() => setWorkspaceFolderOpener(null));

describe("工作区文件夹哨兵", () => {
  it("只认这两个，绝对路径一律不算", () => {
    expect(WORKSPACE_FOLDER_TARGETS).toHaveLength(2);
    expect(isWorkspaceFolderTarget("@data")).toBe(true);
    expect(isWorkspaceFolderTarget("@data/styles")).toBe(true);

    // 插件住在数据目录里，不该去猜用户磁盘长什么样 —— 任意路径就是「把 C:\ 挂进侧栏」。
    for (const bad of ["C:/", "/etc", "@data/plugins", "@data/styles/", "@DATA", "styles"]) {
      expect(isWorkspaceFolderTarget(bad)).toBe(false);
    }
  });
});

describe("sameFolderPath", () => {
  it("大小写、正反斜杠、尾斜杠都不算差别", () => {
    expect(sameFolderPath(String.raw`C:\Users\A\花笺\styles`, "c:/users/a/花笺/styles")).toBe(true);
    expect(sameFolderPath("C:/a/styles/", "C:/a/styles")).toBe(true);
    expect(sameFolderPath("C:/a/styles//", "C:/a/styles")).toBe(true);
  });

  it("不同的目录各是各的", () => {
    expect(sameFolderPath("C:/a/styles", "C:/a/styles2")).toBe(false);
    expect(sameFolderPath("C:/a/styles", "C:/b/styles")).toBe(false);
    // 只归一化写法，**不做** `..` 解析 —— 那是后端的事。
    expect(sameFolderPath("C:/a/../b", "C:/b")).toBe(false);
  });
});

describe("openWorkspaceFolder", () => {
  it("把路径交给登记进来的宿主实现", async () => {
    const opener = vi.fn(async () => undefined);
    setWorkspaceFolderOpener(opener);

    await openWorkspaceFolder("@data/styles");
    expect(opener).toHaveBeenCalledWith("@data/styles");
  });

  it("宿主不在了（窗口已关）就抛错，而不是静默假装成功", async () => {
    setWorkspaceFolderOpener(null);
    await expect(openWorkspaceFolder("@data/styles")).rejects.toThrow();
  });

  it("换实现时旧的被顶掉，清空之后不再有人接", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    setWorkspaceFolderOpener(first);
    setWorkspaceFolderOpener(second);

    await openWorkspaceFolder("@data");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("@data");

    setWorkspaceFolderOpener(null);
    await expect(openWorkspaceFolder("@data")).rejects.toThrow();
  });
});
