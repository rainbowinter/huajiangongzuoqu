import { describe, expect, test } from "vitest";
import {
  MAX_ANNOTATION_CHARS,
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

describe("视图声明完整性", () => {
  test("必须有 html", () => {
    expect(isCompleteViewSpec({ html: "<p></p>" })).toBe(true);
    expect(isCompleteViewSpec({ html: "" })).toBe(false);
    expect(isCompleteViewSpec(undefined)).toBe(false);
  });
});
