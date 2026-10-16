import { describe, expect, test } from "vitest";
import type { PluginManifest, PluginRuntimeRecord } from "../plugins/types";
import { buildPluginDetails, type PluginDetailsInput } from "./pluginDetails";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "math-symbols",
    version: "1.1.1",
    main: "index.js",
    description: "公式面板：结构模板 + 分类符号表",
    apiVersion: 2,
    author: "花笺",
    permissions: ["ui:panel", "editor:write"],
    grantedPermissions: ["ui:panel", "editor:write"],
    enabled: true,
    requires: [],
    autoUpdate: false,
    valid: true,
    warnings: [],
    dirPath: "C:\\Users\\me\\Documents\\花笺\\plugins\\math-symbols",
    ...overrides,
  };
}

function build(overrides: Partial<PluginDetailsInput> = {}): string {
  const record: PluginRuntimeRecord = {
    manifest: manifest(),
    status: "loaded",
    sandboxed: true,
  };

  return buildPluginDetails({
    record,
    contributions: [],
    settings: [],
    ...overrides,
  });
}

describe("插件说明文档", () => {
  test("标题与描述来自清单", () => {
    const markdown = build();

    expect(markdown).toContain("# math-symbols");
    expect(markdown).toContain("公式面板：结构模板 + 分类符号表");
  });

  test("基本信息表里有版本、作者、安装目录", () => {
    const markdown = build();

    expect(markdown).toContain("`1.1.1`");
    expect(markdown).toContain("花笺");
    expect(markdown).toContain("math-symbols");
    // 目录在表格里，路径两边的反斜杠不该把表格撑破。
    expect(markdown).toContain("| 安装目录 |");
  });

  test("沙箱状态说人话，不写 apiVersion", () => {
    expect(build()).toContain("独立运行环境");
    expect(build()).not.toContain("apiVersion");

    const legacy = build({
      record: { manifest: manifest({ apiVersion: 1 }), status: "legacy", sandboxed: false },
    });
    expect(legacy).toContain("没有隔离");
  });

  test("权限列出机器名，没生效的单独标出来", () => {
    const markdown = build({
      record: {
        manifest: manifest({
          permissions: ["ui:panel", "fs:read"],
          grantedPermissions: ["ui:panel"],
        }),
        status: "loaded",
        sandboxed: true,
      },
    });

    expect(markdown).toContain("- ui:panel");
    expect(markdown).toContain("- fs:read（未生效）");
  });

  test("没声明权限时说清楚，而不是留一段空白", () => {
    const markdown = build({
      record: {
        manifest: manifest({ permissions: [], grantedPermissions: [] }),
        status: "loaded",
        sandboxed: true,
      },
    });

    expect(markdown).toContain("没有声明任何权限");
  });

  test("贡献点分门别类列出来", () => {
    const markdown = build({
      contributions: [
        { label: "面板", items: ["公式面板"] },
        { label: "工具栏按钮", items: ["插入时间戳"] },
        { label: "行内装饰", items: [] },
      ],
    });

    expect(markdown).toContain("**面板**");
    expect(markdown).toContain("- 公式面板");
    expect(markdown).toContain("**工具栏按钮**");
    // 空的那一类整块不出现 —— 「行内装饰：无」只是噪音。
    expect(markdown).not.toContain("行内装饰");
  });

  test("没有任何贡献点时也给出解释", () => {
    expect(build()).toContain("没有往界面上加东西");
  });

  test("设置项列 key 与类型", () => {
    const markdown = build({
      settings: [
        {
          key: "wrapInMath",
          title: "自动包裹 $…$",
          type: "boolean",
          description: "关掉则只插原始 LaTeX。",
        },
      ],
    });

    expect(markdown).toContain("自动包裹 $…$");
    expect(markdown).toContain("`wrapInMath`");
    expect(markdown).toContain("boolean");
    expect(markdown).toContain("关掉则只插原始 LaTeX。");
  });

  test("出错的插件把错误原文贴出来", () => {
    const markdown = build({
      record: {
        manifest: manifest(),
        status: "failed",
        sandboxed: true,
        error: "ReferenceError: floral is not defined",
      },
    });

    expect(markdown).toContain("加载时出错");
    expect(markdown).toContain("ReferenceError: floral is not defined");
  });

  test("清单里的提醒（warnings）不会被吞掉", () => {
    const markdown = build({
      record: {
        manifest: manifest({ warnings: ["manifest 里的 main 指向不存在的文件"] }),
        status: "loaded",
        sandboxed: true,
      },
    });

    expect(markdown).toContain("manifest 里的 main 指向不存在的文件");
  });

  test("每一段之间空一行 —— 否则 Markdown 渲染出来会粘成一坨", () => {
    const markdown = build();

    expect(markdown).not.toMatch(/\n\*\*/);
    expect(markdown.endsWith("\n")).toBe(true);
  });
});
