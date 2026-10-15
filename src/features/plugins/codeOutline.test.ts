import { describe, expect, test } from "vitest";
// 用 Vite 的 `?raw` 而不是 node:fs：这个项目的 tsconfig 不带 node 类型，
// 而且 `?raw` 走的是同一条构建管线，测试读到的与运行时加载的是同一份文本。
import PLUGIN_SOURCE from "../../../example-plugins-v2/outline/index.js?raw";

/**
 * 目录插件的**解析分派**测试。
 *
 * 这里不经过 Worker、也不经过宿主：直接把插件源码当纯脚本求值，用桩 `api` 驱动它的
 * `render()` / `onClick()`。理由是这个插件的核心价值全在「按文件类型选对解析器」上，
 * 而那部分没有任何宿主依赖 —— 起一整个沙箱只会让断言变难，测到的东西却一样。
 *
 * 宿主那一侧的接线（镜像里有没有文件身份、换文件时会不会重渲染）另有 `v2Host.test.ts`
 * 覆盖。两边都要有：上一轮 `closestClass` 的教训正是「单元各自都对，中间的接线没人管」。
 */
interface PluginPanel {
  id: string;
  title: string;
  standalone?: boolean;
  render: () => string;
  onClick: (ref: {
    closestClass: (name: string) => unknown;
    data: (key: string) => string | null;
  }) => void;
}

interface FileInfo {
  path: string | null;
  typeId: string | null;
  kind: string | null;
  language: string | null;
}

/** 把插件挂到一个最小的桩宿主上，返回它注册的面板与它做过的滚动调用。 */
function loadOutline(content: string, file: FileInfo | null) {
  let definition: { onLoad: (api: unknown) => void } | null = null;
  new Function("floral", PLUGIN_SOURCE)({
    register: (candidate: { onLoad: (api: unknown) => void }) => {
      definition = candidate;
    },
  });
  expect(definition).not.toBeNull();

  const panels: PluginPanel[] = [];
  const scrolls: number[] = [];

  const api = {
    ui: { registerPanel: (panel: PluginPanel) => panels.push(panel) },
    editor: {
      getContentSync: () => content,
      getFileSync: () => file,
      scrollTo: (offset: number) => scrolls.push(offset),
      scrollPreviewTo: () => undefined,
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  definition!.onLoad(api);

  return { panel: panels[0], scrolls };
}

/** 从面板 HTML 里抠出 (缩进, 文本) —— 缩进是层级唯一的可见证据。 */
const ROW = /padding:4px 8px 4px (\d+)px[^>]*>(.*?)<\/button>/g;

function rows(html: string): Array<{ pad: number; text: string }> {
  return Array.from(html.matchAll(ROW), (match) => ({
    pad: Number(match[1]),
    text: match[2].replace(/<span[^>]*>.*?<\/span>/g, "").trim(),
  }));
}

const CODE_FILE = (language: string, typeId = language): FileInfo => ({
  path: `/tmp/sample.${typeId}`,
  typeId,
  kind: "code",
  language,
});

describe("Markdown（回归）", () => {
  test("笔记（file 为 null）仍然按 # 层级出目录", () => {
    const { panel } = loadOutline("# 一\n正文\n## 一之一\n# 二\n", null);

    expect(rows(panel.render())).toEqual([
      { pad: 8, text: "一" },
      { pad: 20, text: "一之一" },
      { pad: 8, text: "二" },
    ]);
  });

  test("没有标题时给出提示，而不是空白面板", () => {
    const { panel } = loadOutline("正文而已\n", null);

    expect(panel.render()).toContain("暂无标题");
  });
});

describe("Python：按缩进定嵌套", () => {
  const SOURCE = [
    "import os",
    "",
    "class Alpha:",
    "    def one(self):",
    "        def inner():",
    "            pass",
    "",
    "    async def two(self):",
    "        pass",
    "",
    "def top():",
    "    pass",
    "",
  ].join("\n");

  test("类 → 方法 → 嵌套函数 逐层缩进，回到顶层也收得回来", () => {
    const { panel } = loadOutline(SOURCE, CODE_FILE("python"));

    expect(rows(panel.render())).toEqual([
      { pad: 8, text: "Alpha" },
      { pad: 20, text: "one" },
      { pad: 32, text: "inner" },
      { pad: 20, text: "two" },
      { pad: 8, text: "top" },
    ]);
  });

  test("三引号字符串里的 def 不算定义", () => {
    const source = 'DOC = """\ndef not_a_real_function():\n"""\n\n\ndef real():\n    pass\n';
    const { panel } = loadOutline(source, CODE_FILE("python"));

    expect(rows(panel.render()).map((row) => row.text)).toEqual(["real"]);
  });

  test("点击带的是那一定义的字符偏移", () => {
    const { panel, scrolls } = loadOutline(SOURCE, CODE_FILE("python"));

    // 条目顺序是 [Alpha, one, inner, two, top]，取顶层的类与最深的那层各点一次。
    panel.onClick({ closestClass: () => ({}), data: () => "0" });
    panel.onClick({ closestClass: () => ({}), data: () => "2" });

    expect(scrolls).toEqual([SOURCE.indexOf("class Alpha"), SOURCE.indexOf("        def inner")]);
  });

  test("点到的不是目录项时什么都不做", () => {
    const { panel, scrolls } = loadOutline(SOURCE, CODE_FILE("python"));

    panel.onClick({ closestClass: () => null, data: () => "0" });

    expect(scrolls).toEqual([]);
  });
});

describe("JS / TS：按花括号定嵌套", () => {
  test("类、方法、函数、箭头函数都认得出来", () => {
    const source = [
      "const helper = (x) => {",
      "  return x;",
      "};",
      "",
      "class Box {",
      "  constructor() {",
      "    if (true) {",
      "      console.log(1);",
      "    }",
      "  }",
      "",
      "  render() {",
      "    return null;",
      "  }",
      "}",
      "",
      "function standalone() {}",
      "",
    ].join("\n");

    const { panel } = loadOutline(source, CODE_FILE("typescript", "ts"));

    // 注意 `if` / `console.log` 不能混进来 —— 那是控制流与方法调用。
    expect(rows(panel.render())).toEqual([
      { pad: 8, text: "helper" },
      { pad: 8, text: "Box" },
      { pad: 20, text: "constructor" },
      { pad: 20, text: "render" },
      { pad: 8, text: "standalone" },
    ]);
  });
});

describe("JSON：按键嵌套", () => {
  test("数组不额外算一层，数组里的对象与同级键齐平", () => {
    const source = [
      "{",
      '  "name": "demo",',
      '  "list": [',
      "    {",
      '      "id": 1',
      "    }",
      "  ],",
      '  "nested": {',
      '    "deep": {',
      '      "leaf": true',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");

    const { panel } = loadOutline(source, CODE_FILE("json"));

    expect(rows(panel.render())).toEqual([
      { pad: 8, text: "name" },
      { pad: 8, text: "list" },
      { pad: 20, text: "id" },
      { pad: 8, text: "nested" },
      { pad: 20, text: "deep" },
      { pad: 32, text: "leaf" },
    ]);
  });
});

describe("CSS：只列规则", () => {
  test("规则按花括号定层级，声明一概不进目录", () => {
    const source = [
      ":root {",
      "  --color-paper: #fbf9f4;",
      "  --font-mono: ui-monospace, Menlo;",
      "}",
      ".a,",
      ".b { padding: 0; }",
      "@media (prefers-color-scheme: dark) {",
      "  :root { --color-paper: #222120; }",
      "}",
      '@import "x.css";',
      "",
    ].join("\n");

    const { panel } = loadOutline(source, CODE_FILE("css"));

    expect(rows(panel.render())).toEqual([
      { pad: 8, text: ":root" },
      // 铺成两行的选择器列表压成一行 —— 结构比排版原样更重要。
      { pad: 8, text: ".a, .b" },
      { pad: 8, text: "@media (prefers-color-scheme: dark)" },
      { pad: 20, text: ":root" },
      // 顶层没有块、以分号收尾的 @ 规则。
      { pad: 8, text: '@import "x.css"' },
    ]);
  });

  test("声明不进目录 —— 连 --x 这类自定义属性也不收", () => {
    const source = [
      ".card {",
      "  color: red;",
      "  padding: 4px;",
      "  --gap: 8px;",
      "}",
      ":root {",
      "  --color-paper: #fbf9f4;",
      "}",
      "",
    ].join("\n");

    const { panel } = loadOutline(source, CODE_FILE("css"));

    // 面板要的是**结构**。一个 App.css 里变量几十个、声明几百条，都列出来只会
    // 把真正要跳转的规则淹掉。
    expect(rows(panel.render())).toEqual([
      { pad: 8, text: ".card" },
      { pad: 8, text: ":root" },
    ]);
  });

  test("注释与字符串里的花括号不会把结构带偏", () => {
    // 这三样在真实的 App.css 里都存在：带 { 的注释块、字符串里的 {、
    // 内联 SVG 的 data URI。漏掉任何一处，后面的层级就全错。
    const source = [
      "/* 分节注释，里面写了 { 和 }，还有 ; */",
      ".a {",
      '  content: "{";',
      '  background: url("data:image/svg+xml,%3Csvg%3E");',
      "}",
      "",
      "/* 末尾又一段带 } 的注释 */",
      ".b { --x: 1; }",
      "",
    ].join("\n");

    const { panel } = loadOutline(source, CODE_FILE("css"));

    expect(rows(panel.render())).toEqual([
      { pad: 8, text: ".a" },
      { pad: 8, text: ".b" },
    ]);
  });

  test("语句开头的注释不会跟着规则头一起显示", () => {
    const source = ["/* 文件头 */", ":root {", "  --a: 1;", "}", ""].join("\n");

    const { panel } = loadOutline(source, CODE_FILE("css"));

    expect(rows(panel.render())[0]).toEqual({ pad: 8, text: ":root" });
  });

  test("SCSS 走同一条路（语言是 scss 不是 css），嵌套规则照样分层", () => {
    const source = [".outer {", "  $gap: 8px;", "  .inner { padding: $gap; }", "}", ""].join("\n");

    const { panel } = loadOutline(source, CODE_FILE("scss"));

    expect(rows(panel.render())).toEqual([
      { pad: 8, text: ".outer" },
      { pad: 20, text: ".inner" },
    ]);
  });

  test("没有规则时明说，而不是给一张空面板", () => {
    const { panel } = loadOutline("/* 只有注释 */\n", CODE_FILE("css"));

    expect(panel.render()).toContain("没有样式规则");
  });
});

describe("其它格式", () => {
  test("别的代码语言走通用兜底，认得出 Go 的 func", () => {
    const source = ["package main", "", "func main() {", "\tprintln(1)", "}", ""].join("\n");
    const { panel } = loadOutline(source, CODE_FILE("go"));

    expect(rows(panel.render())).toEqual([{ pad: 8, text: "main" }]);
  });

  test("不是代码也不是 Markdown 的格式，明说不支持", () => {
    const { panel } = loadOutline("hello\nworld\n", {
      path: "/tmp/a.txt",
      typeId: "prose",
      kind: "text",
      language: null,
    });

    expect(panel.render()).toContain("该格式没有目录");
  });

  test("认不出的代码语言且没有定义时，给的是解析器的提示而不是空白", () => {
    const { panel } = loadOutline("// 只有注释\n", CODE_FILE("rust"));

    expect(panel.render()).toContain("没有找到类或函数定义");
  });
});
