import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PdfExportPanel } from "./PdfExportPanel";

/**
 * 导出面板的冒烟测试。
 *
 * 这里**验不到预览**：预览是 `mountPrintView` 在 `useEffect` 里摆的，而测试环境没有 DOM
 * （`renderToStaticMarkup` 只跑渲染、不跑副作用）。预览那半边靠 `%TEMP%\pdfproto\` 与真机
 * 手工验，这个测试盯的是**面板本身画不画得出来**、以及几组设置项都在。
 */

// `Toast` 一被 import 就会碰 window。
vi.mock("./Toast", () => ({ showToast: vi.fn() }));

function render(): string {
  return renderToStaticMarkup(
    <PdfExportPanel title="测试笔记" bodyHtml="<p>正文</p>" onClose={() => undefined} />,
  );
}

describe("导出面板", () => {
  test("画得出来：标题、正文名、几个设置分组都在", () => {
    const html = render();
    expect(html).toContain("导出 PDF");
    expect(html).toContain("测试笔记");
    for (const label of ["缩放", "纸张", "页边距", "页眉页脚", "标题", "颜色", "预览"]) {
      expect(html).toContain(label);
    }
  });

  test("纸张三选一 + 横向、缩放档位", () => {
    const html = render();
    expect(html).toContain("A4");
    expect(html).toContain("Letter");
    expect(html).toContain("横向");
    expect(html).toContain("100%");
  });

  test("配色三档，默认「原样」—— 用户要的就是「看到什么打什么」", () => {
    const html = render();
    expect(html).toContain("原样");
    expect(html).toContain("白底");
    expect(html).toContain("黑白");
    // 默认那一档是选中的（aria-pressed="true" 出现在「原样」那个按钮上）
    const asIs = html.slice(html.indexOf("原样") - 200, html.indexOf("原样") + 10);
    expect(asIs).toContain('aria-pressed="true"');
  });

  test("保存与打印机两个出口都在", () => {
    const html = render();
    expect(html).toContain("保存为 PDF");
    expect(html).toContain("用系统打印机");
  });
});
