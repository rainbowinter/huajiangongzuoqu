import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPluginFonts,
  listPluginFonts,
  resetPluginFontsForTests,
  subscribePluginFonts,
} from "./pluginFonts";
import type { FontFaceSpec } from "./fontFace";

/**
 * vitest 跑在 node 环境，没有 DOM。这里顶上最小的假 `document`：只需要
 * `createElement("style")` 与 `head.appendChild`，够 `installPluginFonts` 用。
 */
interface FakeStyle {
  dataset: Record<string, string>;
  textContent: string;
  removed: boolean;
}

let injected: FakeStyle[] = [];

beforeEach(() => {
  injected = [];
  resetPluginFontsForTests();
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const element: FakeStyle = {
        dataset: {},
        textContent: "",
        removed: false,
        remove() {
          element.removed = true;
          injected = injected.filter((item) => item !== element);
        },
      } as FakeStyle;
      return element;
    },
    head: {
      appendChild: (element: FakeStyle) => {
        injected.push(element);
      },
    },
  };
});

function spec(family: string): FontFaceSpec {
  return { family, weight: 400, style: "normal", file: `${family}.ttf`, url: `asset:///${family}` };
}

function restoreDocument(): void {
  delete (globalThis as { document?: unknown }).document;
}

describe("installPluginFonts", () => {
  it("注入一条 <style> 并登记族名", () => {
    installPluginFonts("font-pack", [spec("Fira Code"), spec("Hack")]);

    expect(injected).toHaveLength(1);
    expect(injected[0].textContent).toContain('font-family:"Fira Code"');
    expect(injected[0].dataset.pluginFonts).toBe("font-pack");
    expect(listPluginFonts().map((item) => item.family)).toEqual(["Fira Code", "Hack"]);
  });

  it("同一个族出现多次只登记一次", () => {
    installPluginFonts("font-pack", [spec("Fira Code"), spec("Fira Code")]);

    expect(listPluginFonts()).toHaveLength(1);
  });

  it("撤销时移除 <style> 与族名", () => {
    const dispose = installPluginFonts("font-pack", [spec("Fira Code")]);
    expect(listPluginFonts()).toHaveLength(1);

    dispose();

    expect(injected).toHaveLength(0);
    expect(listPluginFonts()).toEqual([]);
  });

  it("重复调用撤销函数是幂等的", () => {
    const dispose = installPluginFonts("font-pack", [spec("Fira Code")]);
    dispose();
    dispose();

    expect(listPluginFonts()).toEqual([]);
  });

  it("多个插件的字体合并，撤销其一不影响另一个", () => {
    const disposeA = installPluginFonts("a", [spec("Alpha")]);
    installPluginFonts("b", [spec("Beta")]);

    disposeA();

    expect(listPluginFonts().map((item) => item.family)).toEqual(["Beta"]);
  });

  it("同一个插件重新登记会替换掉旧的一组", () => {
    const disposeOld = installPluginFonts("a", [spec("Alpha")]);
    const disposeNew = installPluginFonts("a", [spec("Beta"), spec("Gamma")]);

    expect(listPluginFonts().map((item) => item.family)).toEqual(["Beta", "Gamma"]);

    // 撤销**旧**的那一次不该把新登记的一组也带走 —— 否则先注册的被释放时，
    // 字体列表会整个空掉。
    disposeOld();
    expect(listPluginFonts().map((item) => item.family)).toEqual(["Beta", "Gamma"]);

    disposeNew();
    expect(listPluginFonts()).toEqual([]);
  });

  it("没有 document 时抛错（它是纯 DOM 操作）", () => {
    restoreDocument();

    expect(() => installPluginFonts("a", [spec("Alpha")])).toThrow();
  });
});

describe("快照引用稳定性", () => {
  /**
   * `listPluginFonts()` 会被 `useSyncExternalStore` 直接消费：内容没变却换了引用，
   * React 会认为快照一直在变，直接无限重渲染。这个坑项目里踩过一次。
   */
  it("内容没变时保持同一个引用", () => {
    installPluginFonts("a", [spec("Alpha")]);
    const stable = listPluginFonts();

    // 另一个插件登记了空列表：族名集合没变，引用就必须没变。
    installPluginFonts("b", []);

    expect(listPluginFonts()).toBe(stable);
  });

  it("内容变了才换引用", () => {
    installPluginFonts("a", [spec("Alpha")]);
    const before = listPluginFonts();

    installPluginFonts("b", [spec("Beta")]);

    expect(listPluginFonts()).not.toBe(before);
  });

  it("撤销回原状后引用也会更新", () => {
    installPluginFonts("a", [spec("Alpha")]);
    const withAlpha = listPluginFonts();

    const dispose = installPluginFonts("b", [spec("Beta")]);
    dispose();

    // 内容回到了 withAlpha 的样子，但这是一次真实变化，应该换引用（否则订阅者收不到通知）。
    expect(listPluginFonts()).not.toBe(withAlpha);
    expect(listPluginFonts().map((item) => item.family)).toEqual(["Alpha"]);
  });
});

describe("subscribePluginFonts", () => {
  it("变化时通知订阅者", () => {
    const listener = vi.fn();
    subscribePluginFonts(listener);

    installPluginFonts("a", [spec("Alpha")]);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("内容没变时不通知", () => {
    installPluginFonts("a", [spec("Alpha")]);
    const listener = vi.fn();
    subscribePluginFonts(listener);

    installPluginFonts("b", []);

    expect(listener).not.toHaveBeenCalled();
  });

  it("退订之后不再收到通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePluginFonts(listener);
    unsubscribe();

    installPluginFonts("a", [spec("Alpha")]);

    expect(listener).not.toHaveBeenCalled();
  });
});
