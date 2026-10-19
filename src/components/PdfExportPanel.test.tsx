import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PdfExportPanel } from "./PdfExportPanel";

/**
 * 导出面板的冒烟测试。
 *
 * 面板里**没有预览** —— 分页与排版都交给浏览器（点「打印…」才看得到）。这里盯的是
 * **面板本身画不画得出来**、以及几组设置项都在。
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
    for (const label of ["缩放", "纸张", "页边距", "页眉页脚", "标题", "颜色"]) {
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

  test("配色两档：彩色 / 黑白，默认「彩色」", () => {
    const html = render();
    expect(html).toContain("彩色");
    expect(html).toContain("黑白");
    expect(html).not.toContain("白底");
    // 默认那一档是选中的（aria-pressed="true" 出现在「彩色」那个按钮上）
    const color = html.slice(html.indexOf("彩色") - 200, html.indexOf("彩色") + 10);
    expect(color).toContain('aria-pressed="true"');
  });

  test("保存与打印两个出口都在", () => {
    const html = render();
    expect(html).toContain("保存为 PDF");
    expect(html).toContain("打印…");
  });
});
