import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginView } from "./PluginView";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const noop = () => undefined;

function render() {
  return renderToStaticMarkup(
    <PluginView
      document="<!doctype html><p>视图</p>"
      name="a.pdf"
      path="C:\\a.pdf"
      theme="light"
      tokens={{ "--color-paper": "#fbf9f4" }}
      loadBytes={async () => new ArrayBuffer(0)}
      dataPlugins={["pdf-annotations"]}
      loadData={async () => null}
      onSaveData={noop}
      onSaveFile={noop}
      onState={noop}
      onToast={noop}
      onLog={noop}
    />,
  );
}

/**
 * 这几条是**安全回归测试**，不是普通渲染测试。
 *
 * 插件视图的隔离全靠 `sandbox="allow-scripts"` 这一个属性：加上 `allow-same-origin`
 * 就会让帧拿到真实 origin，而 Windows 上同源的 iframe 能够到 Tauri 的 IPC。所以这里把
 * 那个字符串**逐字**钉死 —— 以后谁想「顺手放宽一下」，先得让这条测试红。
 * 完整的实测依据见 `Docs/plugin-view-sandbox.md`。
 */
describe("插件视图的沙箱属性", () => {
  test("sandbox 逐字是 allow-scripts", () => {
    const markup = render();

    expect(markup).toContain('sandbox="allow-scripts"');
  });

  test("绝不能出现 allow-same-origin", () => {
    expect(render()).not.toContain("allow-same-origin");
  });

  test("也绝不能干脆不给 sandbox —— 那样帧会拿到应用的真实 origin", () => {
    expect(render()).toMatch(/<iframe[^>]*\ssandbox=/);
  });

  test("视图内容走 srcdoc（不做同源的 iframe src）", () => {
    // 注意属性名大小写：`renderToStaticMarkup` 输出的是 React 的属性名 `srcDoc`，
    // 浏览器 DOM 里才会落成 `srcdoc`。而且 `src` 绝不能出现 —— 那会是一次真实导航。
    const markup = render();

    expect(markup.toLowerCase()).toContain("srcdoc=");
    expect(markup).not.toMatch(/\ssrc=/);
  });
});
