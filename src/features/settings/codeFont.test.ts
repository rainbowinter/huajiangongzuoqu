import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCodeFont,
  CODE_FONT_PRESETS,
  CODE_FONT_STORAGE_KEY,
  DEFAULT_CODE_FONT_STACK,
  getCodeFont,
  matchCodeFontPreset,
  previewCodeFontStack,
  restoreCodeFont,
  setCodeFont,
  visibleCodeFontPresets,
} from "./codeFont";

/**
 * vitest 跑在 node 环境，既没有 DOM 也没有 localStorage，两个都得用最小的假对象顶上
 * （`renderColors.test.ts` 用的是同一手法）。
 */
const applied = new Map<string, string>();
const store = new Map<string, string>();

beforeEach(() => {
  applied.clear();
  store.clear();
  (globalThis as { document?: unknown }).document = {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => {
          applied.set(name, value);
        },
        removeProperty: (name: string) => {
          applied.delete(name);
        },
      },
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("applyCodeFont", () => {
  it("把字体栈写成 --font-mono 内联变量", () => {
    applyCodeFont('"Fira Code", monospace');

    expect(applied.get("--font-mono")).toBe('"Fira Code", monospace');
  });

  it("空串时移除变量，而不是写空串", () => {
    // 写空串会让整条 font-family 声明失效；只有内联变量**不存在**时才会回落到
    // @theme 里的默认栈。
    applyCodeFont('"Fira Code", monospace');
    applyCodeFont("");

    expect(applied.has("--font-mono")).toBe(false);
  });

  it("把纯空白也当作默认", () => {
    applyCodeFont("   ");

    expect(applied.has("--font-mono")).toBe(false);
  });

  it("没有 document 时静默返回", () => {
    delete (globalThis as { document?: unknown }).document;

    expect(() => applyCodeFont('"Fira Code", monospace')).not.toThrow();
  });
});

describe("setCodeFont / getCodeFont / restoreCodeFont", () => {
  it("写入偏好时同时落盘并立即生效", () => {
    setCodeFont('  "JetBrains Mono", Consolas, monospace  ');

    expect(store.get(CODE_FONT_STORAGE_KEY)).toBe('"JetBrains Mono", Consolas, monospace');
    expect(applied.get("--font-mono")).toBe('"JetBrains Mono", Consolas, monospace');
  });

  it("空串清掉存储项并回落默认", () => {
    setCodeFont('"Fira Code", monospace');
    setCodeFont("");

    expect(store.has(CODE_FONT_STORAGE_KEY)).toBe(false);
    expect(applied.has("--font-mono")).toBe(false);
    expect(getCodeFont()).toBe("");
  });

  it("restoreCodeFont 应用已保存的偏好", () => {
    store.set(CODE_FONT_STORAGE_KEY, '"Fira Code", monospace');

    restoreCodeFont();

    expect(applied.get("--font-mono")).toBe('"Fira Code", monospace');
  });

  it("没存过时恢复成默认", () => {
    applyCodeFont('"Fira Code", monospace');

    restoreCodeFont();

    expect(applied.has("--font-mono")).toBe(false);
  });

  it("存储抛错时仍然让这次设置生效", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
    };

    expect(() => setCodeFont('"Fira Code", monospace')).not.toThrow();
    expect(applied.get("--font-mono")).toBe('"Fira Code", monospace');
    expect(getCodeFont()).toBe("");
  });

  it("没有 localStorage 时读成默认", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;

    expect(getCodeFont()).toBe("");
  });
});

describe("matchCodeFontPreset", () => {
  it("空串对应「跟随系统」", () => {
    expect(matchCodeFontPreset("")?.id).toBe("system");
  });

  it("预设自己的栈能对上", () => {
    const fira = CODE_FONT_PRESETS.find((preset) => preset.id === "fira");

    expect(matchCodeFontPreset(fira?.stack ?? "")?.id).toBe("fira");
  });

  it("手填的字体栈对不上任何预设", () => {
    expect(matchCodeFontPreset('"Foo Mono", monospace')).toBeNull();
  });
});

describe("预设与默认栈的约束", () => {
  it("每个非空预设都以中文兜底收尾", () => {
    // 少了这一条，代码注释里的汉字会掉成方框 —— 而且只在别人机器上出现。
    for (const preset of CODE_FONT_PRESETS) {
      if (!preset.stack) continue;
      expect(preset.stack.endsWith('"HarmonyOS Sans SC", monospace')).toBe(true);
    }
  });

  it("每个预设都在中文兜底之前先给出本机一定存在的等宽字体", () => {
    // 这就是被修掉的那个 bug：候选字体全都不存在时，栈尾的 HarmonyOS Sans SC 是
    // **比例**字体，代码就不再等宽了。所以兜底之前必须还有一款等宽字体接着。
    for (const preset of CODE_FONT_PRESETS) {
      if (!preset.stack) continue;
      const beforeFallback = preset.stack.slice(0, preset.stack.indexOf('"HarmonyOS Sans SC"'));
      expect(/Consolas|Menlo/.test(beforeFallback)).toBe(true);
    }
  });

  it("默认栈同样先给等宽字体、再交给中文兜底", () => {
    const fallbackAt = DEFAULT_CODE_FONT_STACK.indexOf('"HarmonyOS Sans SC"');
    const beforeFallback = DEFAULT_CODE_FONT_STACK.slice(0, fallbackAt);

    expect(fallbackAt).toBeGreaterThan(0);
    expect(beforeFallback).toContain("Consolas");
    expect(beforeFallback).toContain("Menlo");
    expect(DEFAULT_CODE_FONT_STACK.endsWith(", monospace")).toBe(true);
  });

  it("预览把空串换成默认栈", () => {
    expect(previewCodeFontStack("")).toBe(DEFAULT_CODE_FONT_STACK);
    expect(previewCodeFontStack('"Fira Code", monospace')).toBe('"Fira Code", monospace');
  });

  it("插件提供了同名字体时，对应的预设被滤掉", () => {
    // 否则 `JetBrains Mono` 会在下拉里出现两次，而两者渲染的是同一个字形。
    const visible = visibleCodeFontPresets("", ["JetBrains Mono", "Fira Code"]);

    expect(visible.map((preset) => preset.label)).not.toContain("JetBrains Mono");
    expect(visible.map((preset) => preset.label)).not.toContain("Fira Code");
    expect(visible.map((preset) => preset.label)).toContain("Consolas");
    expect(visible.map((preset) => preset.label)).toContain("Iosevka");
  });

  it("插件没提供的预设一个不少", () => {
    expect(visibleCodeFontPresets("", [])).toHaveLength(CODE_FONT_PRESETS.length);
    expect(visibleCodeFontPresets("", ["Iosevka"])).toHaveLength(CODE_FONT_PRESETS.length - 1);
  });

  it("「跟随系统」永远不会被滤掉", () => {
    // 它的 label 是「跟随系统（默认）」，不会跟任何字体族重名 —— 但这条得钉住。
    const visible = visibleCodeFontPresets("", CODE_FONT_PRESETS.map((preset) => preset.label));

    expect(visible.map((preset) => preset.id)).toContain("system");
  });

  it("当前正选中的预设即使被插件盖掉也要留着", () => {
    // 滤掉的话下拉找不到匹配项，会退回显示第一项「跟随系统」，而真正生效的还是这条栈
    // —— 界面跟实际对不上。
    const jetbrains = CODE_FONT_PRESETS.find((preset) => preset.id === "jetbrains");

    const visible = visibleCodeFontPresets(jetbrains?.stack ?? "", ["JetBrains Mono"]);

    expect(visible.map((preset) => preset.id)).toContain("jetbrains");
  });

  it("选中的是别的字体时，被盖掉的预设照常滤走", () => {
    const jetbrains = CODE_FONT_PRESETS.find((preset) => preset.id === "jetbrains");

    const visible = visibleCodeFontPresets('"Fira Code", monospace', ["JetBrains Mono"]);

    expect(jetbrains).toBeDefined();
    expect(visible.map((preset) => preset.id)).not.toContain("jetbrains");
  });

  it("预设 id 不重复", () => {
    const ids = CODE_FONT_PRESETS.map((preset) => preset.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
