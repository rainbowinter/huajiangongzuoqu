import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginIcon } from "./PluginIcon";

describe("插件图标", () => {
  test("给了 data URL 就渲染图片", () => {
    const markup = renderToStaticMarkup(
      <PluginIcon icon="data:image/svg+xml;base64,PHN2Zy8+" size={16} />,
    );

    expect(markup).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
    expect(markup).toContain('width="16"');
    // 图标是装饰：插件名就在旁边，读屏软件不该在这里念一句「图片」。
    expect(markup).toContain('alt=""');
  });

  test("没给图标就用默认图标 —— 不提供图标是正常的，不该让那一行看起来像坏了", () => {
    for (const nothing of [undefined, null, ""]) {
      const markup = renderToStaticMarkup(<PluginIcon icon={nothing} size={16} />);

      expect(markup).not.toContain("<img");
      expect(markup).toContain("<svg");
      // 默认图标要能跟着主题走（用 currentColor），否则深色主题下会看不见。
      expect(markup).toContain('stroke="currentColor"');
    }
  });

  test("默认图标与插件图标占一样大的地方，行高不会跳", () => {
    const withIcon = renderToStaticMarkup(<PluginIcon icon="data:image/png;base64,AA" size={16} />);
    const without = renderToStaticMarkup(<PluginIcon size={16} />);

    expect(withIcon).toContain('width="16"');
    expect(withIcon).toContain('height="16"');
    expect(without).toContain('width="16"');
    expect(without).toContain('height="16"');
  });
});
