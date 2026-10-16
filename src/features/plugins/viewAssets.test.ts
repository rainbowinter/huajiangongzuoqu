import { describe, expect, test } from "vitest";
import { registerViewExtension } from "./registry";
import { ownerOfFileType, viewExtensionOwners, viewToolbarFor } from "./viewAssets";

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

// ---------------------------------------------------------------- 扩展合并

/**
 * `viewToolbarFor` 把「被扩展的视图」与「扩展它的插件」声明的控件合成一条。
 *
 * 这条合并有两处要紧的规则：**顺序**（基础插件在前，扩展接在后面）与**重名**
 * （id 同时是命令名与状态名，撞了分不清谁是谁 —— 基础插件赢）。
 */
describe("视图工具栏的合并", () => {
  function type(id: string, toolbar?: unknown[]) {
    return {
      id,
      extensions: ["pdf"],
      label: "PDF",
      badge: "PDF",
      color: "#000",
      kind: "view" as const,
      view: { html: "a.html", ...(toolbar ? { toolbar: toolbar as never } : {}) },
    };
  }

  const base = [
    { kind: "button" as const, id: "zoom-in", label: "+" },
    { kind: "separator" as const },
  ];

  test("没有扩展时原样返回基础插件那几项", () => {
    expect(viewToolbarFor(type("pdf-viewer:pdf", base))).toEqual(base);
  });

  test("扩展的接在后面，分隔线照收", () => {
    const dispose = registerViewExtension({
      typeId: "pdf-viewer:pdf",
      plugin: "pdf-annotations",
      css: [],
      js: [],
      toolbar: [
        { kind: "separator" },
        { kind: "button", id: "marker", label: "标注" },
      ],
    });
    try {
      expect(
        viewToolbarFor(type("pdf-viewer:pdf", base)).map((item) =>
          item.kind === "separator" ? "---" : item.id,
        ),
      ).toEqual(["zoom-in", "---", "---", "marker"]);
    } finally {
      dispose.dispose();
    }
  });

  test("id 撞了基础插件赢 —— 扩展那一项丢掉", () => {
    const dispose = registerViewExtension({
      typeId: "pdf-viewer:pdf",
      plugin: "pdf-annotations",
      css: [],
      js: [],
      toolbar: [
        { kind: "button", id: "zoom-in", label: "抢同一个 id" },
        { kind: "button", id: "marker", label: "标注" },
      ],
    });
    try {
      const merged = viewToolbarFor(type("pdf-viewer:pdf", base));
      const claimed = merged.find((item) => item.kind === "button" && item.id === "zoom-in");
      expect(claimed).toMatchObject({ label: "+" });
      expect(merged.some((item) => item.kind === "button" && item.id === "marker")).toBe(true);
    } finally {
      dispose.dispose();
    }
  });

  test("扩展的是**别的**视图时，这个视图一点不受影响", () => {
    const dispose = registerViewExtension({
      typeId: "别的插件:docx",
      plugin: "pdf-annotations",
      css: [],
      js: [],
      toolbar: [{ kind: "button", id: "marker", label: "标注" }],
    });
    try {
      expect(viewToolbarFor(type("pdf-viewer:pdf", base))).toEqual(base);
      expect(viewExtensionOwners(type("pdf-viewer:pdf"))).toEqual([]);
    } finally {
      dispose.dispose();
    }
  });

  test("扩展的插件名按注册顺序列出来 —— 视图那边按它各开一条数据通道", () => {
    const one = registerViewExtension({
      typeId: "pdf-viewer:pdf",
      plugin: "alpha",
      css: [],
      js: [],
      toolbar: [],
    });
    const two = registerViewExtension({
      typeId: "pdf-viewer:pdf",
      plugin: "beta",
      css: [],
      js: [],
      toolbar: [],
    });
    try {
      expect(viewExtensionOwners(type("pdf-viewer:pdf"))).toEqual(["alpha", "beta"]);
    } finally {
      one.dispose();
      two.dispose();
    }
  });
});
