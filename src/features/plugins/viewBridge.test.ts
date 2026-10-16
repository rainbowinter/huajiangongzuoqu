import { describe, expect, test } from "vitest";
import {
  MAX_ANNOTATION_CHARS,
  VIEW_WORKER_ELEMENT_ID,
  buildViewDocument,
  isCompleteViewSpec,
  parseViewMessage,
} from "./viewBridge";

describe("校验视图发来的消息", () => {
  test("认得出的几种", () => {
    expect(parseViewMessage({ t: "ready" })).toEqual({ t: "ready" });
    expect(parseViewMessage({ t: "requestDocument" })).toEqual({ t: "requestDocument" });
    expect(parseViewMessage({ t: "toast", message: "你好" })).toEqual({
      t: "toast",
      message: "你好",
    });
    expect(parseViewMessage({ t: "log", level: "warn", message: "慢" })).toEqual({
      t: "log",
      level: "warn",
      message: "慢",
    });
  });

  test("认不出来的一律丢掉 —— 不猜", () => {
    // 视图里是插件代码，猜错就是拿不可信输入去驱动宿主。
    expect(parseViewMessage(null)).toBeNull();
    expect(parseViewMessage("ready")).toBeNull();
    expect(parseViewMessage([])).toBeNull();
    expect(parseViewMessage({ t: "让宿主干点什么" })).toBeNull();
    expect(parseViewMessage({ t: "log", message: "" })).toBeNull();
    expect(parseViewMessage({ t: "toast" })).toBeNull();
  });

  test("日志级别认不出来时降级成 info，而不是丢消息", () => {
    expect(parseViewMessage({ t: "log", level: "critical", message: "x" })).toEqual({
      t: "log",
      level: "info",
      message: "x",
    });
  });

  test("超长文本截断", () => {
    const message = parseViewMessage({ t: "toast", message: "字".repeat(5000) });
    expect(message && "message" in message ? message.message.length : 0).toBe(1000);
  });

  test("数据超过上限直接丢 —— 别让一条消息把宿主撑爆", () => {
    const huge = { blob: "x".repeat(MAX_ANNOTATION_CHARS + 10) };
    expect(parseViewMessage({ t: "saveData", plugin: "demo", data: huge })).toBeNull();

    const ok = parseViewMessage({ t: "saveData", plugin: "demo", data: { page: 1 } });
    expect(ok).toEqual({ t: "saveData", plugin: "demo", data: { page: 1 } });
  });

  test("数据必须带一个像样的插件名 —— 它决定这份数据算谁的", () => {
    // 少了名字就没法归属：一个视图里可能同时跑着两个插件的代码。
    expect(parseViewMessage({ t: "saveData", data: { page: 1 } })).toBeNull();
    expect(parseViewMessage({ t: "saveData", plugin: "", data: 1 })).toBeNull();
    expect(parseViewMessage({ t: "saveData", plugin: "a/b", data: 1 })).toBeNull();
    expect(parseViewMessage({ t: "saveData", plugin: "上标", data: 1 })).toBeNull();
  });

  test("序列化不了的数据也丢", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(parseViewMessage({ t: "saveData", plugin: "demo", data: circular })).toBeNull();
  });
});

describe("拼 srcdoc", () => {
  const base = { html: "<div id=app></div>", css: [], js: [] };

  test("结构齐全：样式表与脚本都进去了", () => {
    const document = buildViewDocument(base);

    expect(document.startsWith("<!doctype html>")).toBe(true);
    expect(document).toContain("<div id=app></div>");
    expect(document).toContain('<script type="module">');
  });

  test("桥接代码永远在插件脚本之前 —— 插件一上来就要能用 window.floralView", () => {
    const document = buildViewDocument({ ...base, js: ["floralView.ready();"] });
    const preludeAt = document.indexOf("window.floralView =");
    const pluginAt = document.indexOf("floralView.ready();");

    expect(preludeAt).toBeGreaterThan(-1);
    expect(pluginAt).toBeGreaterThan(preludeAt);
  });

  test("多个脚本拼进同一个 module（共享作用域）", () => {
    const document = buildViewDocument({ ...base, js: ["const a = 1;", "console.log(a);"] });
    // 只应有一个内联 module —— 分成两个的话第二个就看不到第一个的变量了。
    expect(document.match(/<script type="module">/g)).toHaveLength(1);
    expect(document).toContain("const a = 1;");
    expect(document).toContain("console.log(a);");
  });

  test("样式按顺序拼", () => {
    const document = buildViewDocument({ ...base, css: [".a{}", ".b{}"] });
    expect(document.indexOf(".a{}")).toBeLessThan(document.indexOf(".b{}"));
  });

  test("插件内容里的结束标签被转义 —— 否则会把宿主拼的结构提前截断", () => {
    // 结束标签拼出来，别在源码里写成字面量（那样这行自己就看着像标签，容易看错）。
    const closingScript = "<" + "/script>";
    const closingStyle = "<" + "/style>";

    const document = buildViewDocument({
      html: "<p>骨架</p>",
      css: [`body::after{content:'${closingStyle}'}`],
      js: [`const s = "${closingScript}";`],
    });

    // 判断依据是「插件写的那串没有原样出现、转义后的出现了」。
    // （别去数结束标签总数：宿主自己就会拼若干个 `<style>`。）
    expect(document).not.toContain(`const s = "${closingScript}";`);
    expect(document).not.toContain(`content:'${closingStyle}'`);
    expect(document).toContain(`const s = "<\\/script>";`);
    expect(document).toContain("body::after{content:'<\\/style>'}");
  });
});

describe("视图里的 worker 源码", () => {
  const base = { html: "<div id=app></div>", css: [], js: [] };
  const closingScript = "<" + "/script>";

  test("当文本塞进去，不执行 —— 它不是给主线程跑的", () => {
    const document = buildViewDocument({ ...base, worker: "self.onmessage = () => {};" });

    expect(document).toContain(`<script type="text/plain" id="${VIEW_WORKER_ELEMENT_ID}">`);
    expect(document).toContain("self.onmessage");
    // 放进 js 数组会被当代码执行；这个块必须是 text/plain。
    expect(document.match(/<script type="module">/g)).toHaveLength(1);
  });

  test("排在主脚本之前：插件在模块求值时就要读得到它", () => {
    const document = buildViewDocument({ ...base, js: ["floralView.ready();"], worker: "// w" });

    expect(document.indexOf(VIEW_WORKER_ELEMENT_ID)).toBeLessThan(
      document.indexOf("floralView.ready();"),
    );
  });

  test("worker 源码里的结束标签也要转义", () => {
    const document = buildViewDocument({
      ...base,
      worker: `const s = "${closingScript}";`,
    });

    expect(document).not.toContain(`const s = "${closingScript}";`);
    expect(document).toContain(`const s = "<\\/script>";`);
  });

  test("没声明 worker 就一个字节都不拼进去", () => {
    expect(buildViewDocument(base)).not.toContain(VIEW_WORKER_ELEMENT_ID);
  });
});

describe("视图声明完整性", () => {
  test("必须有 html", () => {
    expect(isCompleteViewSpec({ html: "<p></p>" })).toBe(true);
    expect(isCompleteViewSpec({ html: "" })).toBe(false);
    expect(isCompleteViewSpec(undefined)).toBe(false);
  });
});

describe("工具栏的状态消息", () => {
  test("values 覆盖显示文本、pressed 点亮开关", () => {
    expect(parseViewMessage({ t: "state", values: { zoom: "120%" }, pressed: ["spread"] })).toEqual({
      t: "state",
      plugin: null,
      values: { zoom: "120%" },
      pressed: ["spread"],
    });
  });

  test("两个字段坏掉、又都不在，就是一条空消息 —— 丢掉", () => {
    expect(parseViewMessage({ t: "state" })).toBeNull();
    expect(parseViewMessage({ t: "state", values: "120%" })).toBeNull();
    expect(parseViewMessage({ t: "state", pressed: "spread" })).toBeNull();
    // 只有一个字段是好的也收下：视图只想改半边是正常的。
    expect(parseViewMessage({ t: "state", values: { a: "1" } })).toEqual({
      t: "state",
      plugin: null,
      values: { a: "1" },
      pressed: [],
    });
  });

  test("values 的值不是字符串的项丢掉，别的留着", () => {
    expect(
      parseViewMessage({ t: "state", values: { ok: "1", bad: 2, worse: null } }),
    ).toEqual({ t: "state", plugin: null, values: { ok: "1" }, pressed: [] });
  });

  test("项数封顶：工具栏本就十几个控件，发一百个就是有人在灌", () => {
    const values: Record<string, string> = {};
    for (let index = 0; index < 100; index += 1) values[`v${index}`] = "x";

    const message = parseViewMessage({ t: "state", values });
    if (!message || message.t !== "state") throw new Error("应当收下");

    expect(Object.keys(message.values)).toHaveLength(32);
  });

  test("键长与值长也封顶", () => {
    const message = parseViewMessage({
      t: "state",
      values: { ["k".repeat(200)]: "x", zoom: "字".repeat(500) },
    });
    if (!message || message.t !== "state") throw new Error("应当收下");

    expect(Object.keys(message.values)).toEqual(["zoom"]);
    expect(message.values.zoom).toHaveLength(200);
  });

  test("pressed 里不是字符串的丢掉", () => {
    expect(parseViewMessage({ t: "state", pressed: ["a", 1, null, "b"] })).toEqual({
      t: "state",
      plugin: null,
      values: {},
      pressed: ["a", "b"],
    });
  });
});

// ---------------------------------------------------------------- 另存为

/**
 * 「另存为」（`saveFile`）与「另要一份字节」（`requestDocumentCopy`）。
 *
 * 前者是唯一一条会让插件**往磁盘写东西**的消息，所以它的校验要盯紧：形状不对一律丢掉，
 * 而且必须是 ArrayBuffer —— 别的一律当成形状不对，不猜。真正拍板的是原生保存对话框。
 */
describe("另存为与字节副本", () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;

  test("saveFile：名字与字节都在才收", () => {
    expect(parseViewMessage({ t: "saveFile", name: "a.pdf", bytes })).toEqual({
      t: "saveFile",
      name: "a.pdf",
      bytes,
    });
  });

  test("saveFile：名字空的、超长的、字节不是 ArrayBuffer 的都不要", () => {
    expect(parseViewMessage({ t: "saveFile", name: "   ", bytes })).toBeNull();
    expect(parseViewMessage({ t: "saveFile", bytes })).toBeNull();
    expect(parseViewMessage({ t: "saveFile", name: "a.pdf" })).toBeNull();
    // 数字数组 / Uint8Array 都不算 —— 视图那边来自 `pdfDoc.save()` 的切片就是 ArrayBuffer，
    // 收下别的形状只会让人以为「传什么都行」。
    expect(parseViewMessage({ t: "saveFile", name: "a.pdf", bytes: [1, 2, 3] })).toBeNull();
    expect(
      parseViewMessage({ t: "saveFile", name: "a.pdf", bytes: new Uint8Array([1, 2]) }),
    ).toBeNull();
  });

  test("saveFile：空字节丢掉（「存一个空文件」一定是出了什么问题）", () => {
    expect(parseViewMessage({ t: "saveFile", name: "a.pdf", bytes: new ArrayBuffer(0) })).toBeNull();
  });

  test("saveFile：名字太长就截断，不是整条丢掉（路径里的中文要靠后端解回来）", () => {
    const long = "名".repeat(400) + ".pdf";
    const parsed = parseViewMessage({ t: "saveFile", name: long, bytes });
    expect(parsed?.t).toBe("saveFile");
    expect((parsed as { name: string }).name.length).toBe(200);
  });

  test("requestDocumentCopy：另一条通道，别和 requestDocument 混起来", () => {
    expect(parseViewMessage({ t: "requestDocumentCopy" })).toEqual({ t: "requestDocumentCopy" });
    expect(parseViewMessage({ t: "requestDocument" })).toEqual({ t: "requestDocument" });
  });
});
