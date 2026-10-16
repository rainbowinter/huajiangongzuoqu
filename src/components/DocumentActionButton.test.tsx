import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentActionButton } from "./DocumentActionButton";
import type { PluginDocumentAction } from "../features/plugins/registry";

/**
 * 顶上那一行是**宿主**画的，所以能直接拿 `renderToStaticMarkup` 验（测试环境里没有
 * jsdom，组件测的就是「渲染出什么 HTML」）。点开下拉要真指针，不在这一层测 ——
 * 这里只钉住「同一份声明在两种形态下各画成什么」。
 */

function action(overrides: Partial<PluginDocumentAction> = {}): PluginDocumentAction {
  return {
    id: "pdf-annotations:export",
    title: "导出",
    plugin: "pdf-annotations",
    contexts: [],
    typeIds: ["pdf-viewer:pdf"],
    ...overrides,
  };
}

function render(item: PluginDocumentAction, icon?: string): string {
  return renderToStaticMarkup(
    <DocumentActionButton action={item} {...(icon ? { icon } : {})} onRun={vi.fn()} />,
  );
}

describe("文档动作按钮", () => {
  test("没有 items 就是一颗普通按钮，画的是 icon 或 title", () => {
    // 字形图标：原样当文字画。
    expect(render(action({ icon: "导出" }))).toContain(">导出</button>");
    // 没有 icon：退回 title。
    expect(render(action())).toContain(">导出</button>");
    // 读好的 SVG：内联进去（而不是当文字）。
    const markup = render(action({ icon: "icons/export.svg" }), '<svg><path d="M4 5v14"/></svg>');
    expect(markup).toContain('d="M4 5v14"');
    expect(markup).not.toContain("icons/export.svg");
    // 普通按钮**不是**菜单：读屏软件不该被告知「这里有个菜单」。
    expect(markup).not.toContain("aria-haspopup");
  });

  test("声明了 items 就是下拉：标题 + 一个展开箭头 + aria-haspopup", () => {
    const markup = render(
      action({
        items: [
          { id: "original", title: "导出原始 PDF", viewCommand: "export-original-pdf" },
          { id: "annotated", title: "导出带批注的 PDF", viewCommand: "export-annotated-pdf" },
        ],
      }),
    );

    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("导出");
    // 收起状态**不画菜单本体** —— 那两个选项要等点开才出现。
    expect(markup).not.toContain("导出原始 PDF");
    expect(markup).not.toContain("导出带批注的 PDF");
  });

  test("下拉不画文字字形 —— 按钮上已经有 title 了，再摆一个多半和它一字不差", () => {
    const items = [{ id: "a", title: "导出原始 PDF", viewCommand: "x" }];
    // 字形图标 + 同名 title：按钮正文里只出现一次，不会「导出 导出」。
    // （`>导出<` 是「它成了某个标签的文字」的形状 —— 裸字形会紧挨着 `<span>` 再多一次。）
    const glyph = render(action({ icon: "导出", items }));
    expect(glyph.match(/>导出</g)).toHaveLength(1);

    // SVG 图标照旧画（它与 title 不是一回事）。
    const svg = render(action({ icon: "icons/export.svg", items }), "<svg></svg>");
    expect(svg).toContain("<svg");
  });

  test("空 items 数组按「没有下拉」处理，不会变成点开是空的菜单", () => {
    const markup = render(action({ items: [] }));
    expect(markup).not.toContain("aria-haspopup");
  });

  test("图标走 inlin SVG 时不会把未消毒的东西漏出去（消毒是调用方的责任，这里只验尺寸被钉死）", () => {
    const markup = render(action({ icon: "icons/x.svg" }), "<svg></svg>");
    // 尺寸写死在包裹元素上：插件自己写 200px 也不算数。
    expect(markup).toContain("w-[13px] h-[13px]");
  });
});
