import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginViewToolbar } from "./PluginViewToolbar";
import { parseViewToolbar } from "../features/workspace/fileTypes";
import { toolbarIconKey } from "../features/plugins/viewAssets";

/**
 * 这一排是**宿主**画的，所以能直接拿 `renderToStaticMarkup` 验（测试环境里没有 jsdom，
 * 组件测的就是「渲染出什么 HTML」）。点击行为走 `onCommand`，不在这一层测。
 */

const ITEMS = parseViewToolbar([
  { kind: "button", id: "zoom-out", label: "−", title: "缩小" },
  { kind: "readout", id: "zoom", title: "缩放比例" },
  { kind: "button", id: "fit-width", label: "适应宽度", toggle: true },
  { kind: "separator" },
  { kind: "input", id: "goto", title: "跳转到页", placeholder: "跳转", width: 44 },
  { kind: "button", id: "spread", label: "连续", title: "单页 / 连续", toggle: true },
])!;

function render(state: Parameters<typeof PluginViewToolbar>[0]["state"] = { values: {}, pressed: [] }) {
  return renderToStaticMarkup(
    <PluginViewToolbar items={ITEMS} state={state} onCommand={vi.fn()} />,
  );
}

describe("视图工具栏", () => {
  test("一项都没声明就不渲染 —— 预览区与从前一模一样", () => {
    expect(
      renderToStaticMarkup(
        <PluginViewToolbar items={[]} state={{ values: {}, pressed: [] }} onCommand={vi.fn()} />,
      ),
    ).toBe("");
  });

  test("按钮用声明的 label，state.values 能盖掉它", () => {
    expect(render()).toContain("适应宽度");
    // 「单页 / 连续」就是一个按钮两种文字：视图把当前模式当值报上来。
    expect(render({ values: { spread: "单页" }, pressed: [] })).toContain("单页");
    // 没被覆盖的按钮仍用它自己的 label。
    expect(render({ values: { spread: "单页" }, pressed: [] })).toContain("适应宽度");
  });

  test("只读小字的文本全部来自 state.values —— 宿主不自己猜", () => {
    expect(render({ values: { zoom: "120%" }, pressed: [] })).toContain("120%");
    expect(render()).not.toContain("100%");
  });

  test("pressed 只点亮声明了 toggle 的按钮", () => {
    const lit = render({ values: {}, pressed: ["fit-width", "zoom-out"] });

    // 适应宽度：亮。缩小：没声明 toggle，仍是常态样式 —— 一个「常亮」的瞬时按钮
    // 看起来就像坏了。（`bg-bamboo-mist/60` 只在点亮那一档出现。）
    expect(lit.match(/bg-bamboo-mist\/60/g)).toHaveLength(1);
    expect(lit).toMatch(/aria-pressed="true"[^>]*>适应宽度</);
    // 开关没点亮时是显式的 `false`（这是个开关，只是现在关着）……
    expect(lit).toMatch(/aria-pressed="false"[^>]*>连续</);
    // ……而没有声明 toggle 的按钮**连属性都没有** —— 别报一个不存在的开关状态。
    expect(lit).not.toMatch(/aria-pressed[^>]*>−</);
  });

  test("❗窄的时候整排折行，不把每一项揉扁", () => {
    // 这一条表面上只是在看类名，但它守的是一个**肉眼在宽窗口里永远看不出**的毛病：
    // 中文没有空格，flex 一旦把按钮压到内容宽度以下，文字就按**字**换行 ——
    // 「适应宽度」竖成一列，`1 / 42` 断成两行，而且还看不出是布局问题。
    // 修法是容器 `flex-wrap` + 每一项 `shrink-0 whitespace-nowrap`（与顶上那一行
    // `doc-toolbar` 同一套）。真机对比见报告里的 A/B 量测。
    const markup = render();

    expect(markup).toMatch(/class="view-toolbar[^"]*\bflex-wrap\b/);

    // 每一个控件（按钮 / 读数 / 输入框 / 分隔线）都不许被压缩。
    const classes = [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);
    const controls = classes.filter(
      (value) =>
        value.includes("view-toolbar-button") ||
        value.includes("tabular-nums") ||
        value.includes("w-px"),
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const value of controls) {
      expect(value).toContain("shrink-0");
    }
  });

  test("输入框把 placeholder 与宽度带上了", () => {
    const markup = render();

    expect(markup).toContain('placeholder="跳转"');
    expect(markup).toContain("width:44px");
    expect(markup).toContain('title="跳转到页"');
  });
});

/**
 * 下拉菜单（`kind: "menu"`）：选工具、选颜色都用它。
 *
 * 下拉本体是点开才渲染的，所以静态渲染只能验「**没点开时按钮上写着什么**」——
 * 那恰好是最要紧的一条：当前用的是什么工具 / 什么颜色，不点开就该看得见。
 */
describe("视图工具栏的下拉菜单", () => {
  const MENU = parseViewToolbar([
    {
      kind: "menu",
      id: "tool",
      label: "标注",
      title: "标注方式",
      options: [
        { value: "rect", label: "矩形" },
        { value: "ellipse", label: "圆形" },
      ],
    },
    {
      kind: "menu",
      id: "color",
      label: "颜色",
      options: [
        { value: "yellow", label: "黄", color: "#ffd400" },
        { value: "green", label: "绿", color: "#9bd67c" },
      ],
    },
  ])!;

  function render(values: Record<string, string>): string {
    return renderToStaticMarkup(
      <PluginViewToolbar items={MENU} state={{ values, pressed: [] }} onCommand={vi.fn()} />,
    );
  }

  test("没选过任何一项时显示声明里的 label", () => {
    const markup = render({});

    expect(markup).toContain(">标注<");
    expect(markup).toContain(">颜色<");
  });

  test("选中之后按钮上写的是**那一项的文字** —— 不点开就知道现在用的是什么", () => {
    const markup = render({ tool: "ellipse", color: "green" });

    expect(markup).toContain("圆形");
    expect(markup).toContain("绿");
    // 声明里的兜底 label 只剩在 title 上，按钮正文换成了当前项。
    expect(markup).not.toContain(">标注<");
  });

  test("带颜色的那一项在按钮上画成色块，颜色原样落进内联样式", () => {
    const markup = render({ color: "yellow" });

    expect(markup).toContain("background-color:#ffd400");
  });

  test("没点开时不渲染下拉本体", () => {
    const markup = render({ tool: "rect" });

    expect(markup).not.toContain("menuitemradio");
    expect(markup).toContain('aria-expanded="false"');
  });
});

/**
 * 图标。
 *
 * 渲染这一层拿到的是**已经消毒过的内联 SVG 文本**（消毒在 `PluginFileView` 那个 hook 里
 * 做，`sanitizeSvg`），这里验的是「它有没有落到该落的地方」：按钮里、下拉项的左边。
 * 顺带钉住两条底线：没有图标时与从前一模一样；图标不会把按钮的文字挤掉。
 */
describe("工具栏图标", () => {
  const WITH_ICON = parseViewToolbar([
    { kind: "button", id: "zoom-in", label: "放大", icon: "icons/zoom-in.svg" },
    { kind: "button", id: "rotate", label: "旋转" },
    {
      kind: "menu",
      id: "tool",
      label: "指针",
      options: [
        { value: "pointer", label: "指针", icon: "icons/pointer.svg" },
        { value: "rect", label: "矩形" },
      ],
    },
  ])!;

  const ICON = '<svg viewBox="0 0 24 24"><path d="M4 5v14"/></svg>';

  function draw(icons?: Map<string, string>, state = { values: {}, pressed: [] }) {
    return renderToStaticMarkup(
      <PluginViewToolbar items={WITH_ICON} state={state} onCommand={vi.fn()} icons={icons} />,
    );
  }

  test("有图标的按钮：图在内联 SVG 里，文字照旧在旁边", () => {
    const markup = draw(new Map([[toolbarIconKey("zoom-in"), ICON]]));

    expect(markup).toContain('d="M4 5v14"');
    expect(markup).toContain("放大");
    // 没给图标的那一项一点都不受影响
    expect(markup).toContain("旋转");
  });

  test("一个图标都没读到 = 与从前一样（图标是加法，不是前提）", () => {
    const bare = draw(undefined);
    expect(bare).toContain("放大");
    expect(bare).not.toContain("M4 5v14");
  });

  test("菜单的触发按钮显示**当前那一项**的图标，不是菜单自己的", () => {
    const icons = new Map([
      [toolbarIconKey("tool", "pointer"), '<svg viewBox="0 0 24 24"><path d="M1 1h1"/></svg>'],
      [toolbarIconKey("tool", "rect"), '<svg viewBox="0 0 24 24"><path d="M2 2h2"/></svg>'],
    ]);

    // 点开的时候才画下拉本体，所以这里用 state 把「当前项」指成 rect
    const markup = draw(icons, { values: { tool: "rect" }, pressed: [] });
    expect(markup).toContain('d="M2 2h2"');
    expect(markup).not.toContain('d="M1 1h1"');
  });

  test("单字符的 label 是图标的文字替身：有图标就不再画第二遍", () => {
    // 用户报的「一个按钮里面有两个 >」——pdf-viewer 的「下一页」同时给了
    // `label: "›"` 和一件箭头图标，两个都画就成了 14px 图形 + 11px 字符。
    const next = parseViewToolbar([
      { kind: "button", id: "page-next", label: "›", title: "下一页", icon: "icons/page-next.svg" },
      { kind: "button", id: "fit-width", label: "适应宽度", icon: "icons/fit-width.svg" },
      { kind: "button", id: "bare", label: "›" },
    ])!;
    const icons = new Map([
      [toolbarIconKey("page-next"), ICON],
      [toolbarIconKey("fit-width"), ICON],
    ]);
    const markup = renderToStaticMarkup(
      <PluginViewToolbar
        items={next}
        state={{ values: {}, pressed: [] }}
        onCommand={vi.fn()}
        icons={icons}
      />,
    );

    // 图标画了，那个字符没跟着画 —— `>›<` 是「那个字符成了按钮正文」的形状，
    // 整份输出里只剩一处，就是没图标的 `bare`。
    expect(markup).toContain('d="M4 5v14"');
    expect(markup.match(/>›</g)).toHaveLength(1);
    // 文案型的 label 照旧（它是内容，不是替身）。
    expect(markup).toContain("适应宽度");
  });

  test("图标不会漏进 readout / input 那几项", () => {
    const items = parseViewToolbar([
      { kind: "readout", id: "zoom" },
      { kind: "input", id: "goto" },
    ])!;
    const markup = renderToStaticMarkup(
      <PluginViewToolbar
        items={items}
        state={{ values: {}, pressed: [] }}
        onCommand={vi.fn()}
        icons={new Map([["zoom", ICON], ["goto", ICON]])}
      />,
    );
    expect(markup).not.toContain('d="M4 5v14"');
  });
});
