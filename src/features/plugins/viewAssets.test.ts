import { describe, expect, test } from "vitest";
import { ownerOfFileType } from "./viewAssets";

describe("从文件类型 id 里取插件名", () => {
  test("v2Host 加的前缀", () => {
    expect(ownerOfFileType("pdf-viewer:pdf")).toBe("pdf-viewer");
    expect(ownerOfFileType("file-reader:python")).toBe("file-reader");
  });

  test("名字里带冒号也只认第一段 —— 插件名本身不含冒号", () => {
    expect(ownerOfFileType("a:b:c")).toBe("a");
  });

  test("没有前缀就不是插件注册的（宿主内置的 markdown 就是这种）", () => {
    expect(ownerOfFileType("markdown")).toBeNull();
    expect(ownerOfFileType(":leading")).toBeNull();
  });
});
