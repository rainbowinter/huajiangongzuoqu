import { describe, expect, test } from "vitest";
// 与 codeOutline.test.ts / mathSymbols.test.ts 同样的手法：`?raw` 读源码 + 桩 api。
import PLUGIN_SOURCE from "../../../example-plugins-v2/color-swatches/index.js?raw";

/**
 * 颜色块插件的测试。
 *
 * 这个插件的全部难度在两处：**认出哪些是颜色**（且不误伤注释里的），以及**换色时不丢
 * 透明度**。两处都是纯逻辑，没有宿主依赖，所以直接求值插件源码、用桩 api 驱动。
 *
 * 宿主侧的接线（区间校验、`<input type="color">` 只认 #rrggbb）另有 v2Host 的测试覆盖。
 */
interface FileInfo {
  path: string | null;
  typeId: string | null;
  kind: string | null;
  language: string | null;
}

interface Decoration {
  offset: number;
  length: number;
  color: string;
}

interface PluginDecorations {
  id: string;
  title: string;
  render: () => Decoration[];
  pick: (offset: number, length: number, color: string) => void;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const CODE_FILE: FileInfo = { path: "/tmp/a.css", typeId: "css", kind: "code", language: "css" };

function loadPlugin(content: string, file: FileInfo | null = CODE_FILE) {
  let definition: { onLoad: (api: unknown) => void } | null = null;
  new Function("floral", PLUGIN_SOURCE)({
    register: (candidate: { onLoad: (api: unknown) => void }) => {
      definition = candidate;
    },
  });
  expect(definition).not.toBeNull();

  const registrations: PluginDecorations[] = [];
  const writes: Array<{ start: number; end: number; text: string }> = [];

  const api = {
    ui: { registerDecorations: (decoration: PluginDecorations) => registrations.push(decoration) },
    editor: {
      getContentSync: () => content,
      getFileSync: () => file,
      getContent: async () => content,
      replaceRange: async (start: number, end: number, text: string) => {
        writes.push({ start, end, text });
        return true;
      },
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  definition!.onLoad(api);

  const applied = (offset: number, length: number) => content.slice(offset, offset + length);

  return { decorations: registrations[0], writes, applied };
}

// ------------------------------------------------------------------ 识别

describe("认出哪些是颜色", () => {
  test("五种写法都能折算成 #rrggbb", () => {
    const content = [
      "a: #fff;",
      "b: #abcd;",
      "c: #11223344;",
      "d: rgb(255, 0, 0);",
      "e: hsl(210, 50%, 40%);",
      "",
    ].join("\n");

    const { decorations, applied } = loadPlugin(content);

    expect(
      decorations.render().map((item) => [applied(item.offset, item.length), item.color]),
    ).toEqual([
      ["#fff", "#ffffff"],
      ["#abcd", "#aabbcc"],
      ["#11223344", "#112233"],
      ["rgb(255, 0, 0)", "#ff0000"],
      ["hsl(210, 50%, 40%)", "#336699"],
    ]);
  });

  test("偏移与长度正好覆盖那个字面量", () => {
    const content = "  --x: #fbf9f4;";
    const { decorations } = loadPlugin(content);

    const [item] = decorations.render();
    expect(content.slice(item.offset, item.offset + item.length)).toBe("#fbf9f4");
  });

  test("注释里的颜色不算 —— 包括 // 那一行之后的", () => {
    const content = [
      "/* --gone: #deadbe; */",
      "a: #00ff00;",
      "// b: #badbad;",
      "c: #0a0b0c;",
      "",
    ].join("\n");

    const { decorations, applied } = loadPlugin(content);

    expect(decorations.render().map((item) => applied(item.offset, item.length))).toEqual([
      "#00ff00",
      "#0a0b0c",
    ]);
  });

  test("URL 里的 // 不算注释开头，不会吞掉同行的颜色", () => {
    const content = "a { background: url(https://x.test/p.png); border-color: #123456; }";
    const { decorations, applied } = loadPlugin(content);

    expect(decorations.render().map((item) => applied(item.offset, item.length))).toEqual([
      "#123456",
    ]);
  });

  test("只对代码文件生效：Markdown 与笔记都返回空", () => {
    const content = "a: #fff;";

    expect(loadPlugin(content, { ...CODE_FILE, kind: "markdown" }).decorations.render()).toEqual(
      [],
    );
    expect(loadPlugin(content, null).decorations.render()).toEqual([]);
  });

  test("多行文档里按出现顺序返回", () => {
    const content = ["a: #111111;", "b: #222222;", "c: #333333;"].join("\n");
    const { decorations } = loadPlugin(content);

    const offsets = decorations.render().map((item) => item.offset);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
  });
});

// ------------------------------------------------------------------ 换色

describe("换色", () => {
  test("十六进制原样换成新颜色", async () => {
    const content = "color: #ff0000;";
    const { decorations, writes } = loadPlugin(content);
    const [item] = decorations.render();

    decorations.pick(item.offset, item.length, "#00ff00");
    await settle();

    // `color: ` 占 7 个字符，#ff0000 落在 7..14
    expect(writes).toEqual([{ start: 7, end: 14, text: "#00ff00" }]);
  });

  test("原来是 rgba 时保住 alpha —— 取色器表达不了透明度，不能顺手丢掉", async () => {
    const content = "color: rgba(0, 0, 0, 0.25);";
    const { decorations, writes } = loadPlugin(content);
    const [item] = decorations.render();

    decorations.pick(item.offset, item.length, "#00ff00");
    await settle();

    expect(writes).toEqual([{ start: 7, end: 26, text: "rgba(0, 255, 0, 0.25)" }]);
  });

  test("百分号写法的 alpha 也原样带回去", async () => {
    const content = "c: hsla(0deg 100% 50% / 30%);";
    const { decorations, writes } = loadPlugin(content);
    const [item] = decorations.render();

    decorations.pick(item.offset, item.length, "#00ff00");
    await settle();

    expect(writes[0].text).toBe("rgba(0, 255, 0, 30%)");
  });

  test("区间已经不是颜色时什么都不做（渲染到点击之间正文被改过）", async () => {
    const content = "color: #ff0000;";
    const { decorations, writes } = loadPlugin(content);
    const [item] = decorations.render();

    // 偏移滑到了旁边的普通文本上
    decorations.pick(item.offset - 5, 12, "#00ff00");
    await settle();

    expect(writes).toEqual([]);
  });
});
