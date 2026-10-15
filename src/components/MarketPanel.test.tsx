import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmInstall, ConfirmUninstall } from "./MarketPanel";
import type { MarketPlugin, MarketRelease } from "../features/market/types";

// `MarketPanel` 会把 Toast 一起拖进来，而那个模块在挂载时会碰 window。
vi.mock("./Toast", () => ({ showToast: vi.fn() }));

const noop = () => undefined;

function release(overrides: Partial<MarketRelease> = {}): MarketRelease {
  return {
    version: "1.0.0",
    apiVersion: 2,
    url: "https://example.com/a.zip",
    sha256: "a".repeat(64),
    permissions: [],
    ...overrides,
  };
}

function plugin(overrides: Partial<MarketPlugin> = {}): MarketPlugin {
  return { name: "pdf-viewer", description: "", releases: [release()], ...overrides };
}

/**
 * 安装确认框的这两条是**需求本身的回归测试**：用户要的是「装之前列清楚、我确认」。
 *
 * 所以断言的是「每一项权限都真的出现在界面上」，而不是「渲染没报错」。
 */
describe("安装确认框把权限列清楚", () => {
  const target = release({
    version: "1.2.0",
    permissions: ["workspace:read", "editor:write", "system:clipboard:read"],
    notes: "修了几个崩溃",
  });

  function render(): string {
    return renderToStaticMarkup(
      <ConfirmInstall
        plugin={plugin()}
        release={target}
        busy={false}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
  }

  test("每一项权限都列出：人话说明 + 原始权限名", () => {
    const markup = render();

    for (const permission of target.permissions) {
      expect(markup).toContain(permission);
    }
    // 只给用户看 `workspace:read` 这种串等于什么都没说，所以人话那半也要在。
    expect(markup).toContain("读取工作区里的文件");
    expect(markup).toContain("修改当前笔记的内容");
    expect(markup).toContain("读取系统剪贴板");
  });

  test("没声明的权限一个字都不出现", () => {
    expect(render()).not.toContain("修改工作区里的文件");
  });

  test("标题里有插件名与版本号 —— 别让人对着一个不知道是什么的东西点确认", () => {
    const markup = render();
    expect(markup).toContain("pdf-viewer");
    expect(markup).toContain("1.2.0");
    expect(markup).toContain("修了几个崩溃");
  });

  test("一个权限都不要时也说清楚，而不是留一片空白", () => {
    const markup = renderToStaticMarkup(
      <ConfirmInstall
        plugin={plugin()}
        release={release()}
        busy={false}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(markup).toContain("没有声明任何权限");
  });

  test("宿主不认识的新权限要单独点出来", () => {
    const markup = renderToStaticMarkup(
      <ConfirmInstall
        plugin={plugin()}
        release={release({ permissions: ["editor:read", "future:telepathy"] })}
        busy={false}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(markup).toContain("future:telepathy");
    expect(markup).toContain("不认识");
  });

  test("确认按钮上写的是「安装」，不能是含糊的「确定」", () => {
    expect(render()).toContain("安装");
  });

  test("更新时单独摆出「这次多要了哪些权限」", () => {
    const markup = renderToStaticMarkup(
      <ConfirmInstall
        plugin={plugin()}
        release={release({ version: "2.0.0", permissions: ["editor:read", "workspace:read"] })}
        installed={{ version: "1.0.0", grantedPermissions: ["editor:read"] }}
        busy={false}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(markup).toContain("新的");
    expect(markup).toContain("workspace:read");
    expect(markup).toContain("读取工作区里的文件");
    // 按钮要说「更新」而不是「安装」—— 用户得知道自己在覆盖一个已经装好的东西。
    expect(markup).toContain("更新");
    expect(markup).toContain("1.0.0");
    expect(markup).toContain("2.0.0");
  });

  test("权限没变时明说「权限没有变化」，不留白让人猜", () => {
    const markup = renderToStaticMarkup(
      <ConfirmInstall
        plugin={plugin()}
        release={release({ version: "1.1.0", permissions: ["editor:read"] })}
        installed={{ version: "1.0.0", grantedPermissions: ["editor:read"] }}
        busy={false}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(markup).toContain("权限没有变化");
  });
});

describe("卸载确认框问清数据怎么办", () => {
  test("两个选项都在，且说清后果", () => {
    const markup = renderToStaticMarkup(
      <ConfirmUninstall
        plugin={plugin()}
        installedVersion="1.0.0"
        busy={false}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(markup).toContain("保留数据并卸载");
    expect(markup).toContain("连数据一起删");
    // 默认那一边要说明「重装能恢复」，删那一边要说明「不可恢复」。
    expect(markup).toContain("还在");
    expect(markup).toContain("不可恢复");
  });
});
