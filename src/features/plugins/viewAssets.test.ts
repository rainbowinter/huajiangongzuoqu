import { describe, expect, test } from "vitest";
import { registerViewExtension } from "./registry";
import {
  isIconAssetPath,
  mergeToolbarStates,
  ownerOfFileType,
  toolbarIconKey,
  viewDataPlugins,
  viewToolbarFor,
  viewToolbarIcons,
} from "./viewAssets";

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
      data: false,
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
      data: false,
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
      data: false,
      css: [],
      js: [],
      toolbar: [{ kind: "button", id: "marker", label: "标注" }],
    });
    try {
      expect(viewToolbarFor(type("pdf-viewer:pdf", base))).toEqual(base);
      expect(viewDataPlugins(type("pdf-viewer:pdf"))).toEqual([]);
    } finally {
      dispose.dispose();
    }
  });

  test("要数据通道的插件按注册顺序列出来 —— 只有声明了 data:true 的才算", () => {
    const one = registerViewExtension({
      typeId: "pdf-viewer:pdf",
      plugin: "alpha",
      data: true,
      css: [],
      js: [],
      toolbar: [],
    });
    const two = registerViewExtension({
      typeId: "pdf-viewer:pdf",
      plugin: "beta",
      // 只叠样式、不碰磁盘的扩展**不该**出现在这里。
      data: false,
      css: [],
      js: [],
      toolbar: [],
    });
    const three = registerViewExtension({
      typeId: "pdf-viewer:pdf",
      plugin: "gamma",
      data: true,
      css: [],
      js: [],
      toolbar: [],
    });
    try {
      expect(viewDataPlugins(type("pdf-viewer:pdf"))).toEqual(["alpha", "gamma"]);
    } finally {
      one.dispose();
      two.dispose();
      three.dispose();
    }
  });
});

// ---------------------------------------------------------------- 状态合并

/**
 * 视图里两个插件**各报各的**状态（`{ t: "state", plugin }`），所以宿主这边也按插件各存
 * 一份、用的时候摊开。合并前是「后报的盖掉先报的」，症状是查看器的「缩放 103% / 1 / 14」
 * 在小字上报出来又忽然空掉 —— 因为批注插件刚报了一份只有 tool/color 的表。
 */
describe("按插件的工具栏状态合并", () => {
  test("各报各的，谁也不盖谁", () => {
    expect(
      mergeToolbarStates({
        base: { values: { zoom: "103%", page: "1 / 14" }, pressed: ["fit-width"] },
        "pdf-annotations": { values: { tool: "rect", color: "#ffd400" }, pressed: [] },
      }),
    ).toEqual({
      values: { zoom: "103%", page: "1 / 14", tool: "rect", color: "#ffd400" },
      pressed: ["fit-width"],
    });
  });

  test("一个插件都还没报 / 只有一个报了，都成立", () => {
    expect(mergeToolbarStates({})).toEqual({ values: {}, pressed: [] });
    expect(
      mergeToolbarStates({ "pdf-annotations": { values: { tool: "ink" }, pressed: [] } }),
    ).toEqual({ values: { tool: "ink" }, pressed: [] });
  });

  test("pressed 取并集（两个插件都可能点亮自己那个开关）", () => {
    expect(
      mergeToolbarStates({
        base: { values: {}, pressed: ["fit-width"] },
        other: { values: {}, pressed: ["marker"] },
      }).pressed,
    ).toEqual(["fit-width", "marker"]);
  });
});

// ---------------------------------------------------------------- 图标从哪读

/**
 * `viewToolbarIcons` 说「这一项（或这一项里某个选项）的图标，去**哪个插件目录**读哪个文件」。
 *
 * 最容易错的是**归属**：扩展插件声明的控件，图标在它自己目录里，不在被扩展的那个插件里。
 * 读错了只会「图标不显示」，而那正是最难查的一类问题 —— 所以这里钉住。
 */
describe("工具栏图标的来源", () => {
  function typeWithToolbar(toolbar: unknown[]) {
    return {
      id: "pdf-viewer:pdf",
      extensions: ["pdf"],
      label: "PDF",
      badge: "PDF",
      color: "#000",
      kind: "view" as const,
      view: { html: "a.html", toolbar: toolbar as never },
    };
  }

  test("基础插件的图标按它自己的目录读；没写 icon 的项不出现", () => {
    const requests = viewToolbarIcons(
      typeWithToolbar([
        { kind: "button", id: "zoom-in", label: "+", icon: "icons/zoom-in.svg" },
        { kind: "button", id: "zoom-out", label: "−" },
        { kind: "readout", id: "zoom" },
      ]),
    );
    expect(requests).toEqual([
      { key: "zoom-in", owner: "pdf-viewer", path: "icons/zoom-in.svg" },
    ]);
  });

  test("扩展插件的图标去**它自己**的目录找", () => {
    const dispose = registerViewExtension({
      typeId: "pdf-viewer:pdf",
      plugin: "pdf-annotations",
      data: true,
      css: [],
      js: [],
      toolbar: [{ kind: "button", id: "export-pdf", label: "导出", icon: "icons/export.svg" }],
    });
    try {
      const requests = viewToolbarIcons(typeWithToolbar([]));
      expect(requests).toEqual([
        { key: "export-pdf", owner: "pdf-annotations", path: "icons/export.svg" },
      ]);
    } finally {
      dispose.dispose();
    }
  });

  test("菜单里每个选项都能有自己的图标，键带上 value 区分", () => {
    const requests = viewToolbarIcons(
      typeWithToolbar([
        {
          kind: "menu",
          id: "tool",
          label: "指针",
          options: [
            { value: "pointer", label: "指针", icon: "icons/pointer.svg" },
            { value: "rect", label: "矩形", icon: "icons/rect.svg" },
            { value: "ink", label: "自由笔" },
          ],
        },
      ]),
    );
    expect(requests).toEqual([
      { key: "tool:pointer", owner: "pdf-viewer", path: "icons/pointer.svg" },
      { key: "tool:rect", owner: "pdf-viewer", path: "icons/rect.svg" },
    ]);
    // 渲染那一层用同一个函数算键 —— 对不上就等于图标永远取不到。
    expect(toolbarIconKey("tool", "pointer")).toBe("tool:pointer");
    expect(toolbarIconKey("zoom-in")).toBe("zoom-in");
  });

  test("非插件注册的类型（宿主内置的）没有目录可读", () => {
    const requests = viewToolbarIcons({
      id: "markdown",
      extensions: ["md"],
      label: "Markdown",
      badge: "MD",
      color: "#000",
      kind: "view" as const,
      view: {
        html: "a.html",
        toolbar: [{ kind: "button", id: "b", label: "甲", icon: "icons/x.svg" }] as never,
      },
    });
    expect(requests).toEqual([]);
  });
});

/**
 * `icon` 一个字段两种含义：插件目录下的 `.svg` 路径，或者一个文字字形。
 * 判错方向的后果不对称 —— 把字形判成路径，按钮上会显示一串半截路径。
 */
describe("图标是路径还是字形", () => {
  test("像路径的算路径", () => {
    expect(isIconAssetPath("icons/export.svg")).toBe(true);
    expect(isIconAssetPath("export.svg")).toBe(true);
    expect(isIconAssetPath("icons/EXPORT.SVG")).toBe(true);
    // 反斜杠也算路径（Windows 写法）。⚠️ 用 `String.raw`：普通字符串里 `\e` 会退化成 `e`，
    // 那样测到的其实是 `.svg` 那一条分支，反斜杠那条永远绿 —— 一条什么都没测的断言。
    expect(isIconAssetPath(String.raw`icons\export`)).toBe(true);
    expect(isIconAssetPath("icons\\export")).toBe(true);
  });

  test("字形、空串、光一个文件名的都不算", () => {
    for (const glyph of ["导出", "⤓", "⟳", "PDF", "", "   "]) {
      expect(isIconAssetPath(glyph)).toBe(false);
    }
  });
});
