import { describe, expect, test } from "vitest";
// 与 codeOutline.test.ts 同样的手法：用 Vite 的 `?raw` 读插件源码，求值后拿桩 api 驱动。
import PLUGIN_SOURCE from "../../../example-plugins-v2/math-symbols/index.js?raw";

/**
 * 符号插件的测试。
 *
 * 不经过 Worker、也不经过宿主 —— 直接求值插件源码，桩住 `api` 驱动 `render()` / `onClick()`。
 * 这个插件的全部价值在「渲染出正确的 HTML」和「对光标位置判得对」两件事上，两者都没有宿主
 * 依赖，起一整个沙箱只会让断言更难写。
 *
 * 宿主侧的接线另有覆盖：面板 HTML 的消毒、`onClick` 描述符的还原、写入的可撤销路径，都是
 * 既有基础设施，各自的测试已经在跑。
 */
interface ElementShape {
  attrs: Record<string, string>;
}

interface PluginPanel {
  id: string;
  title: string;
  standalone?: boolean;
  render: () => string;
  onClick: (ref: {
    closestClass: (name: string) => ElementShape | null;
    data: (key: string) => string | null;
  }) => void;
}

interface StubOptions {
  content: string;
  /** 选区，缺省是「光标在文末」。 */
  start?: number;
  end?: number;
  wrapInMath?: boolean;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadPlugin(options: StubOptions) {
  let definition: { onLoad: (api: unknown) => void } | null = null;
  new Function("floral", PLUGIN_SOURCE)({
    register: (candidate: { onLoad: (api: unknown) => void }) => {
      definition = candidate;
    },
  });
  expect(definition).not.toBeNull();

  const panels: PluginPanel[] = [];
  const styles: Array<{ id: string; css: string }> = [];
  const writes: Array<{ start: number; end: number; text: string }> = [];
  const carets: Array<{ start: number; end: number }> = [];

  const start = options.start ?? options.content.length;
  const end = options.end ?? start;

  const api = {
    ui: {
      registerPanel: (panel: PluginPanel) => panels.push(panel),
      registerStyle: (style: { id: string; css: string }) => styles.push(style),
    },
    editor: {
      getContent: async () => options.content,
      getSelection: async () => ({ text: options.content.slice(start, end), start, end }),
      replaceRange: async (from: number, to: number, text: string) => {
        writes.push({ start: from, end: to, text });
        return true;
      },
      setSelection: async (from: number, to: number) => {
        carets.push({ start: from, end: to });
        return true;
      },
    },
    settings: {
      get: async () => ({ wrapInMath: options.wrapInMath !== false }),
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  definition!.onLoad(api);

  /**
   * 点一个符号。
   *
   * `data()` 故意恒返回 null —— 它模拟的是**点击落在格子内部的 `<span>` 上**：那个 span
   * 身上没有 `data-value`，所以插件只能靠 `closestClass("msym-cell")` 往上找到按钮，
   * 再从 `shape.attrs` 取值。这正是「点在文字上没反应」那类接线 bug 的防线。
   */
  const click = async (latex: string) => {
    panels[0].onClick({
      closestClass: (name) => (name === "msym-cell" ? { attrs: { "data-value": latex } } : null),
      data: () => null,
    });
    await settle();
  };

  /** 点一个结构模板。模板按钮同时带 `msym-cell` 与 `msym-tpl`，这里照着真实 DOM 返回。 */
  const clickTemplate = async (index: number) => {
    const shape = { attrs: { "data-value": String(index) } };
    panels[0].onClick({
      closestClass: (name) => (name === "msym-tpl" || name === "msym-cell" ? shape : null),
      data: () => null,
    });
    await settle();
  };

  return { panel: panels[0], styles, writes, carets, click, clickTemplate };
}

// ------------------------------------------------------------------ 面板内容

describe("面板 HTML", () => {
  test("每个分类的标题都在，格子数与符号总数一致", () => {
    const { panel } = loadPlugin({ content: "" });
    const html = panel.render();

    for (const title of [
      "希腊字母 · 小写",
      "希腊字母 · 大写",
      "运算与算术",
      "关系与比较",
      "集合与逻辑",
      "箭头",
      "大型运算符与微积分",
      "括号与定界符",
      "数集与花体",
      "特殊字符与省略号",
    ]) {
      expect(html).toContain(title);
    }

    // 符号格子的 data-value 就是 LaTeX；结构模板的格子是下标（见下一条测试）。
    const values = Array.from(html.matchAll(/data-value="([^"]*)"/g), (match) => match[1]);
    const symbolValues = values.filter((value) => value.startsWith("\\"));
    expect(symbolValues.length).toBeGreaterThan(140);
    for (const expected of ["\\alpha", "\\sum", "\\mathbb{R}", "\\to", "\\emptyset"]) {
      expect(symbolValues).toContain(expected);
    }
  });

  test("同一个字符串返回两次 —— 宿主据此短路，面板滚动位置才不会被打字打断", () => {
    const { panel } = loadPlugin({ content: "" });

    expect(panel.render()).toBe(panel.render());
  });

  test("只用宿主消毒器放行的标签与属性", () => {
    const { panel } = loadPlugin({ content: "" });
    const html = panel.render();

    // 事件处理属性、脚本、SVG 一律会被消毒器剥掉；主动断在插件侧，
    // 免得「渲染出来了但宿主悄悄丢掉一半」这种最难查的故障。
    for (const forbidden of ["<script", "<svg", "<iframe", "<style"]) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).not.toMatch(/\son[a-z]+=/i);

    const attrs = new Set(
      Array.from(html.matchAll(/\s([a-zA-Z-]+)=/g), (match) => match[1].toLowerCase()),
    );
    expect([...attrs].sort()).toEqual(["class", "data-value", "title", "type"]);
  });

  test("注册了自带样式（悬停反馈只能靠注入的 CSS 表达）", () => {
    const { styles } = loadPlugin({ content: "" });

    expect(styles).toHaveLength(1);
    expect(styles[0].css).toContain(".msym-cell:hover");
  });

  test("HTML 里抠出来的 data-value 就是点击时插入的那个符号", async () => {
    const { panel, writes, click } = loadPlugin({ content: "正文", start: 2 });
    const first = panel.render().match(/data-value="([^"]*)"/)?.[1];

    expect(first).toBeTruthy();
    await click(first!);

    expect(writes[0].text).toBe(`$${first}$`);
  });
});

// ------------------------------------------------------------------ 结构模板

describe("结构模板", () => {
  test("面板里排在符号前面，格子数是下标不是 LaTeX", () => {
    const { panel } = loadPlugin({ content: "" });
    const html = panel.render();

    expect(html).toContain("结构模板");
    // 模板在符号分组之前 —— 写公式时先要的是「一个分数」。
    expect(html.indexOf("结构模板")).toBeLessThan(html.indexOf("希腊字母 · 小写"));

    const templateValues = Array.from(
      html.matchAll(/class="msym-cell msym-tpl" data-value="([^"]*)"/g),
      (match) => match[1],
    );
    expect(templateValues.length).toBeGreaterThan(20);
    expect(templateValues.every((value) => /^\d+$/.test(value))).toBe(true);
  });

  test("插入骨架，光标落在第一个占位符里", async () => {
    const { writes, carets, clickTemplate } = loadPlugin({ content: "", start: 0 });

    await clickTemplate(0); // 分式

    expect(writes[0].text).toBe("$\\frac{}{}$");
    // `\frac{` 是 6 个字符，外面再套一层 `$` → 光标落在第 7 个位置（分子位置）。
    expect(carets[0]).toEqual({ start: 7, end: 7 });
  });

  test("已经在数学环境里就不再补 $", async () => {
    const { writes, clickTemplate } = loadPlugin({ content: "$x$", start: 2 });

    await clickTemplate(0);

    expect(writes[0].text).toBe("\\frac{}{}");
  });

  test("行间公式自带 $$，不再被包裹一次", async () => {
    const { writes, clickTemplate } = loadPlugin({ content: "正文", start: 2 });

    // 最后一条是「多行对齐」，属于自带 $$ 的那类
    await clickTemplate(27);

    const text = writes[0].text;
    expect(text.startsWith("\n$$\n")).toBe(true);
    expect(text.trim().endsWith("$$")).toBe(true);
    expect(text).toContain("\\begin{aligned}");
    // 只应有一层 $$，不能再套出 `$ $` 这种
    expect(text.match(/\$\$/g)).toHaveLength(2);
  });

  test("模板里的反斜杠没有被吃掉（踩过的坑：转义层多，写坏了会静默变字符）", async () => {
    const { writes, clickTemplate } = loadPlugin({ content: "$x$", start: 2 });

    await clickTemplate(6); // 求和，带上下限
    expect(writes[0].text).toBe("\\sum_{}^{}");

    await clickTemplate(21); // 自适应花括号
    expect(writes[1].text).toBe("\\left\\{  \\right\\}");
  });
});

// -------------------------------------------------------------- 数学环境判断

describe("是否已经在数学环境里", () => {
  const cases: Array<{ name: string; content: string; start: number; wrapped: boolean }> = [
    { name: "空文档", content: "", start: 0, wrapped: true },
    { name: "普通正文里", content: "这是一段话", start: 5, wrapped: true },
    { name: "行内公式 $x$ 内", content: "$x$", start: 2, wrapped: false },
    { name: "行间公式 $$…$$ 内", content: "$$x$$", start: 3, wrapped: false },
    { name: "刚才的 $ 是转义的 \\$", content: "价格 \\$5", start: 6, wrapped: true },
    { name: "前一个行内公式已经闭合", content: "$a$ 之后", start: 5, wrapped: true },
    { name: "夹在两个行内公式之间", content: "$a$ 和 $b$", start: 4, wrapped: true },
    { name: "第二个行内公式里", content: "$a$ 和 $b$", start: 8, wrapped: false },
  ];

  for (const scenario of cases) {
    test(scenario.name, async () => {
      const { writes, click } = loadPlugin({
        content: scenario.content,
        start: scenario.start,
      });

      await click("\\alpha");

      expect(writes[0].text).toBe(scenario.wrapped ? "$\\alpha$" : "\\alpha");
    });
  }
});

// ------------------------------------------------------------------ 插入细节

describe("插入", () => {
  test("环境外自动补 $…$，光标停在收尾的 $ 之前", async () => {
    const { writes, carets, click } = loadPlugin({ content: "ab", start: 2 });

    await click("\\alpha");

    expect(writes).toEqual([{ start: 2, end: 2, text: "$\\alpha$" }]);
    // 插入的是 `$\alpha$`（8 个字符，落在 2..9），收尾的 $ 在下标 9；
    // 光标停在它之前 —— 连着点第二个符号时才不会又补一层 $。
    expect(carets).toEqual([{ start: 9, end: 9 }]);
  });

  test("环境内只插命令", async () => {
    const { writes, carets, click } = loadPlugin({ content: "$x$", start: 2 });

    await click("\\alpha");

    expect(writes).toEqual([{ start: 2, end: 2, text: "\\alpha" }]);
    expect(carets).toEqual([{ start: 8, end: 8 }]);
  });

  test("关掉自动包裹后，环境外也只插命令", async () => {
    const { writes, carets, click } = loadPlugin({ content: "ab", start: 2, wrapInMath: false });

    await click("\\alpha");

    expect(writes).toEqual([{ start: 2, end: 2, text: "\\alpha" }]);
    expect(carets).toEqual([{ start: 8, end: 8 }]);
  });

  test("有选区时按替换处理", async () => {
    const { writes, click } = loadPlugin({ content: "abcdef", start: 1, end: 3 });

    await click("\\beta");

    expect(writes).toEqual([{ start: 1, end: 3, text: "$\\beta$" }]);
  });

  test("连点两个符号：第二个不再补 $", async () => {
    const content = "x";
    const { writes, click } = loadPlugin({ content, start: 1 });

    await click("\\alpha");
    // 宿主此时把正文改成了 `x$\alpha$`，光标停在收尾的 $ 之前。
    const next = "x$\\alpha$";
    expect(next.slice(0, 8)).toBe("x$\\alpha");

    const second = loadPlugin({ content: next, start: 8 });
    await second.click("\\beta");

    expect(second.writes).toEqual([{ start: 8, end: 8, text: "\\beta" }]);
    expect(writes).toHaveLength(1);
  });

  test("点到的不是格子时什么都不做", async () => {
    const { writes, panel } = loadPlugin({ content: "ab", start: 2 });

    panel.onClick({ closestClass: () => null, data: () => "\\alpha" });
    await settle();

    expect(writes).toEqual([]);
  });
});
