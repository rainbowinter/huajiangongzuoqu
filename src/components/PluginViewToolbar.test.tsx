import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginViewToolbar } from "./PluginViewToolbar";
import { parseViewToolbar } from "../features/workspace/fileTypes";

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

  test("输入框把 placeholder 与宽度带上了", () => {
    const markup = render();

    expect(markup).toContain('placeholder="跳转"');
    expect(markup).toContain("width:44px");
    expect(markup).toContain('title="跳转到页"');
  });
});
