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

  test("批注超过上限直接丢 —— 别让一条消息把宿主撑爆", () => {
    const huge = { blob: "x".repeat(MAX_ANNOTATION_CHARS + 10) };
    expect(parseViewMessage({ t: "saveAnnotations", data: huge })).toBeNull();

    const ok = parseViewMessage({ t: "saveAnnotations", data: { page: 1 } });
    expect(ok).toEqual({ t: "saveAnnotations", data: { page: 1 } });
  });

  test("序列化不了的数据也丢", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(parseViewMessage({ t: "saveAnnotations", data: circular })).toBeNull();
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
      values: { a: "1" },
      pressed: [],
    });
  });

  test("values 的值不是字符串的项丢掉，别的留着", () => {
    expect(
      parseViewMessage({ t: "state", values: { ok: "1", bad: 2, worse: null } }),
    ).toEqual({ t: "state", values: { ok: "1" }, pressed: [] });
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
      values: {},
      pressed: ["a", "b"],
    });
  });
});
