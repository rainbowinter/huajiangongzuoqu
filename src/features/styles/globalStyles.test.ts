import { beforeEach, describe, expect, test, vi } from "vitest";
import { STYLE_ATTR, styleSignature, type StyleSheet } from "./globalStyles";

/**
 * `bundleStyles` 每次调用都真的去打 IPC，`node` 里没有 Tauri —— 挡掉它，
 * 让用例自己决定「这一轮目录里有什么」。
 */
const backend = vi.hoisted(() => ({
  bundle: async (): Promise<unknown[]> => [],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) =>
    command === "global_styles_bundle" ? backend.bundle() : Promise.resolve(null),
}));

/**
 * 签名是「要不要重新注入」的唯一判据 —— 判错方向都很难受：
 * 太敏感会在每次轮询里白白重注入，太迟钝就是**改了样式却不生效**。
 *
 * 这里只测这个纯函数；真正把 `<style>` 写进 `<head>` 的那段没有 jsdom，
 * 靠真应用里手工验（改一份 css 看约两秒后有没有变）。
 */
/**
 * 默认造一份**生效中**的普通样式表（`custom.css` 才是常开的，这里不是它）。
 * 开关状态与签名有关，所以三个状态位都能单点覆盖。
 */
function sheet(
  name: string,
  mtimeMs: number,
  size: number,
  flags: Partial<StyleSheet> = {},
): StyleSheet {
  return {
    name,
    mtimeMs,
    size,
    css: "/* 内容不参与签名 */",
    applied: true,
    global: false,
    bound: false,
    locked: false,
    ...flags,
  };
}

describe("样式表签名", () => {
  test("同一批文件、同一状态 → 签名相同（换个顺序也算相同）", () => {
    const a = [sheet("a.css", 100, 10), sheet("b.css", 200, 20)];
    const b = [sheet("b.css", 200, 20), sheet("a.css", 100, 10)];
    expect(styleSignature(a)).toBe(styleSignature(b));
  });

  test("空目录的签名是空串（与「有一份但内容为空」区分得开）", () => {
    expect(styleSignature([])).toBe("");
    expect(styleSignature([sheet("a.css", 1, 1)])).not.toBe("");
  });

  test("改了修改时间 → 签名变", () => {
    expect(styleSignature([sheet("a.css", 100, 10)])).not.toBe(
      styleSignature([sheet("a.css", 101, 10)]),
    );
  });

  test("同一秒内改动、只有大小变了 → 签名也要变", () => {
    // ⚠️ 这条是刻意的冗余：有些文件系统的时间戳精度只到秒，
    // 光比 mtime 会漏掉「同一秒里改了但大小正好不同」的情况。
    expect(styleSignature([sheet("a.css", 100, 10)])).not.toBe(
      styleSignature([sheet("a.css", 100, 11)]),
    );
  });

  test("加一份、删一份 → 签名都变", () => {
    const one = [sheet("a.css", 100, 10)];
    const two = [sheet("a.css", 100, 10), sheet("b.css", 5, 5)];
    expect(styleSignature(one)).not.toBe(styleSignature(two));
    expect(styleSignature(two)).not.toBe(styleSignature([sheet("b.css", 5, 5)]));
  });

  test("改名（大小与时间相同）→ 签名也变", () => {
    expect(styleSignature([sheet("a.css", 100, 10)])).not.toBe(
      styleSignature([sheet("b.css", 100, 10)]),
    );
  });

  test("❗翻了开关也是「变了」—— 不带状态位的话「关掉」这一步会被当成没动", () => {
    const on = [sheet("a.css", 100, 10, { applied: true, global: true })];
    const off = [sheet("a.css", 100, 10, { applied: false, global: false })];

    expect(styleSignature(on)).not.toBe(styleSignature(off));
    // 文件本身一个字节都没改，两边的「文件指纹」那一段是一样的 —— 差异只能来自状态位。
    expect(styleSignature(on)).toContain("a.css:100:10");
    expect(styleSignature(off)).toContain("a.css:100:10");
  });

  test("`bound` 单独变也认得出（全局开着的那份挂到文件上，applied 并不变）", () => {
    const plain = [sheet("a.css", 100, 10, { global: true })];
    const bound = [sheet("a.css", 100, 10, { global: true, bound: true })];

    expect(styleSignature(plain)).not.toBe(styleSignature(bound));
  });
});

describe("注入标记", () => {
  test("是 data-* 属性，值放文件名", () => {
    // 只撤我们自己注入的那批 —— 插件的 `data-plugin-style` 不能误伤，
    // 所以这个标记必须是独立的属性名。
    expect(STYLE_ATTR.startsWith("data-")).toBe(true);
    expect(STYLE_ATTR).not.toContain("plugin");
  });
});

/* ------------------------------------------------------------------ 注入本身 */

interface FakeStyleElement {
  tagName: string;
  textContent: string;
  attr: Record<string, string>;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/**
 * 一个刚好够用的假 `<head>`。
 *
 * 这里**不装 jsdom**（项目里没有，见 `codeOutline.test.ts` 的说明），手搓一个最小的：
 * `refreshGlobalStyles` 只会用到 `createElement` / `head.appendChild` /
 * `querySelectorAll("style[data-floral-style]")` 三样。
 *
 * ⚠️ `appendChild` 的行为要跟真浏览器一致：**同一个元素再 append 一次是「移到末尾」，
 * 不是插两份**。注入顺序的保证全靠这条。
 */
function installFakeDom() {
  const head = {
    children: [] as FakeStyleElement[],
    appendChild(element: FakeStyleElement) {
      head.children = head.children.filter((child) => child !== element);
      head.children.push(element);
      return element;
    },
  };

  const fakeDocument = {
    createElement(tagName: string): FakeStyleElement {
      const element: FakeStyleElement = {
        tagName,
        textContent: "",
        attr: {},
        setAttribute(name, value) {
          element.attr[name] = value;
        },
        remove() {
          head.children = head.children.filter((child) => child !== element);
        },
      };
      return element;
    },
    head,
    querySelectorAll(selector: string): FakeStyleElement[] {
      if (!selector.includes(STYLE_ATTR)) return [];
      return head.children.filter((child) => STYLE_ATTR in child.attr);
    },
  };

  (globalThis as unknown as { document: unknown }).document = fakeDocument;
  return head;
}

/** 每个用例都要一份干净的模块状态（`sheets` / `appliedSignature` 是模块级的）。 */
async function freshModule() {
  vi.resetModules();
  return await import("./globalStyles");
}

function sheetsOf(names: readonly string[]) {
  return names.map((name, index) =>
    sheet(name, 1000 + index, 10 + index, { css: `/* ${name} */` }),
  );
}

describe("把样式表注入 <head>", () => {
  beforeEach(() => {
    backend.bundle = async () => [];
  });

  test("一份一个 <style>，按文件名字典序落在 head 末尾", async () => {
    const head = installFakeDom();
    backend.bundle = async () => sheetsOf(["20-b.css", "10-a.css"]);
    const { refreshGlobalStyles } = await freshModule();

    await refreshGlobalStyles();

    expect(head.children.map((child) => child.attr[STYLE_ATTR])).toEqual([
      "10-a.css",
      "20-b.css",
    ]);
    expect(head.children.map((child) => child.textContent)).toEqual([
      "/* 10-a.css */",
      "/* 20-b.css */",
    ]);
    expect(head.children.every((child) => child.tagName === "style")).toBe(true);
  });

  test("内容没变就不动那批元素（不是「删了重建」）", async () => {
    const head = installFakeDom();
    backend.bundle = async () => sheetsOf(["a.css"]);
    const { refreshGlobalStyles } = await freshModule();

    await refreshGlobalStyles();
    const first = head.children[0];
    await refreshGlobalStyles();

    // 同一个对象 —— 界面不会因为一次白跑的轮询而闪一下。
    expect(head.children[0]).toBe(first);
  });

  test("改了一份 → 旧的撤掉、新的按顺序补上", async () => {
    const head = installFakeDom();
    backend.bundle = async () => sheetsOf(["a.css", "b.css"]);
    const { refreshGlobalStyles } = await freshModule();
    await refreshGlobalStyles();
    expect(head.children).toHaveLength(2);

    // b.css 被删掉、c.css 加了进来，b 的内容也变了。
    backend.bundle = async () => sheetsOf(["a.css", "c.css"]);
    await refreshGlobalStyles();

    expect(head.children.map((child) => child.attr[STYLE_ATTR])).toEqual(["a.css", "c.css"]);
  });

  test("❗目录里**没打开**的那几份不注入 —— 「存在」不等于「生效」", async () => {
    const head = installFakeDom();
    backend.bundle = async () => [
      sheet("custom.css", 1, 1, { applied: true, global: true, locked: true }),
      sheet("a.css", 2, 2, { applied: true, global: true }),
      // 用户丢进目录但没打开的：清单里要有（面板要列出来），但绝不能注入。
      sheet("b.css", 3, 3, { applied: false }),
    ];
    const { listGlobalStyles, refreshGlobalStyles } = await freshModule();

    await refreshGlobalStyles();

    expect(head.children.map((child) => child.attr[STYLE_ATTR])).toEqual(["a.css", "custom.css"]);
    // 清单是**全部**（面板靠它列出可开的那几份），注入才是筛过的。
    expect(listGlobalStyles().map((item) => item.name).sort()).toEqual([
      "a.css",
      "b.css",
      "custom.css",
    ]);
  });

  test("把一份关上 → 它的 <style> 跟着撤掉", async () => {
    const head = installFakeDom();
    backend.bundle = async () => [sheet("a.css", 1, 1), sheet("b.css", 2, 2)];
    const { refreshGlobalStyles } = await freshModule();
    await refreshGlobalStyles();
    expect(head.children).toHaveLength(2);

    // 用户在面板里把 b 关掉了：文件一个字节没改，只有状态位变。
    backend.bundle = async () => [sheet("a.css", 1, 1), sheet("b.css", 2, 2, { applied: false })];
    await refreshGlobalStyles();

    expect(head.children.map((child) => child.attr[STYLE_ATTR])).toEqual(["a.css"]);
  });

  test("目录被清空 → 注入的那批全部撤掉", async () => {
    const head = installFakeDom();
    backend.bundle = async () => sheetsOf(["a.css"]);
    const { refreshGlobalStyles } = await freshModule();
    await refreshGlobalStyles();

    backend.bundle = async () => [];
    await refreshGlobalStyles();

    expect(head.children).toHaveLength(0);
  });

  test("❗读不出来时保持现状 —— 绝不清空已经套用的样式", async () => {
    const head = installFakeDom();
    backend.bundle = async () => sheetsOf(["a.css"]);
    const { refreshGlobalStyles } = await freshModule();
    await refreshGlobalStyles();
    expect(head.children).toHaveLength(1);

    // 数据目录刚被换掉、盘一时不可用……都会走到这里。
    backend.bundle = async () => {
      throw new Error("读不到数据目录");
    };
    await refreshGlobalStyles();

    // 「界面突然全白」比「还是旧的」糟糕得多，所以这里必须还在。
    expect(head.children).toHaveLength(1);
    expect(head.children[0].attr[STYLE_ATTR]).toBe("a.css");
  });

  test("force 会重注入一遍（给「重新加载」按钮用）", async () => {
    const head = installFakeDom();
    backend.bundle = async () => sheetsOf(["a.css"]);
    const { refreshGlobalStyles } = await freshModule();

    await refreshGlobalStyles();
    const first = head.children[0];
    await refreshGlobalStyles(true);

    // 内容没变，但元素被重建了 —— 按钮点下去要看得见反馈。
    expect(head.children).toHaveLength(1);
    expect(head.children[0]).not.toBe(first);
  });
});
