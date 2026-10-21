import { describe, expect, it } from "vitest";
import PLUGIN_SOURCE from "../index.js?raw";
import VIEWER_SOURCE from "../view/viewer.js?raw";

/**
 * 插件 Worker 侧的测试：不经过沙箱、也不经过宿主，直接求值 `index.js`，桩住 api。
 *
 * 这里验的是「面板什么时候出现」与「按钮发出什么命令」——两件事都没有 DOM 依赖。
 * 视图收到命令后的排版由 `linebreak` / `paginate` 与浏览器原型台覆盖。
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function buttonRef(value) {
  return {
    closestClass: (name) =>
      name === "office-btn" ? { attrs: { "data-value": value } } : null,
  };
}

function iconRef(value) {
  return {
    closestClass: (name) =>
      name === "office-icon-btn" ? { attrs: { "data-value": value } } : null,
  };
}

async function loadPlugin(file) {
  let definition = null;
  new Function("floral", PLUGIN_SOURCE)({
    register: (candidate) => {
      definition = candidate;
    },
  });
  expect(definition).not.toBeNull();

  const panels = [];
  const styles = [];
  const disposed = [];
  const sent = [];
  let registeredType = null;

  const api = {
    plugin: { id: "office-viewer" },
    files: {
      registerType: (type) => {
        registeredType = type;
      },
    },
    editor: {
      getFileSync: () => file,
    },
    ui: {
      registerPanel: (panel) => {
        panels.push(panel);
        return Promise.resolve(`reg-${panels.length}`);
      },
      registerStyle: (style) => styles.push(style),
      dispose: (id) => {
        disposed.push(id);
        return Promise.resolve();
      },
      sendToView: (command) => {
        sent.push(command);
        return Promise.resolve(true);
      },
    },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  definition.onLoad(api);
  await settle();

  return { definition, panels, styles, disposed, sent, registeredType };
}

describe("office-viewer worker", () => {
  it("打开 docx 时注册「开始」standalone 面板", async () => {
    const { definition, panels, styles, registeredType } = await loadPlugin({
      typeId: "office-viewer:docx",
    });

    expect(registeredType?.kind).toBe("view");
    expect(registeredType?.extensions).toEqual(["docx"]);
    // 新建 .docx 时宿主写入的模板：必须是 PK 开头的 ZIP，而不是 0 字节。
    expect(typeof registeredType?.newFile).toBe("string");
    const template = Uint8Array.from(atob(registeredType.newFile), (char) =>
      char.charCodeAt(0),
    );
    expect(Array.from(template.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(template.length).toBeGreaterThan(1000);
    expect(styles[0]?.css).toContain(".office-btn");
    expect(styles[0]?.css).toContain('button[data-value="insert-table:2:3"]:hover');
    expect(panels).toHaveLength(2);
    expect(panels[0].id).toBe("home");
    expect(panels[0].title).toBe("开始");
    expect(panels[0].standalone).toBe(true);
    expect(panels[1].id).toBe("insert");
    expect(panels[1].title).toBe("插入");

    const html = panels[0].render();
    expect(html).toContain("office-font-group");
    expect(html).toContain('data-key="font"');
    expect(html).toContain('data-key="size"');
    expect(html).toContain("office-detail-view");

    const insertHtml = panels[1].render();
    expect(insertHtml).toContain("office-table-grid");
    expect(insertHtml).toContain('data-value="insert-table:1:1"');
    expect(insertHtml).toContain('data-value="insert-table:2:3"');
    expect(html).toContain("office-para-group");
    expect(html).toContain('data-value="size-plus"');
    expect(html).toContain('data-value="align:center"');
    expect(html).toContain('data-value="marks"');

    definition.onUnload();
  });

  it("打开别的文件时不注册面板", async () => {
    const { definition, panels } = await loadPlugin({ typeId: "file-reader:python" });
    expect(panels).toHaveLength(0);
    definition.onUnload();
  });

  it("面板按钮把格式命令发给视图", async () => {
    const { definition, panels, sent } = await loadPlugin({
      typeId: "office-viewer:docx",
    });
    const panel = panels[0];

    panel.onClick(buttonRef("size-plus"));
    panel.onClick(iconRef("marks"));
    panel.onClick(buttonRef("before:12"));
    panel.onClick(iconRef("align:center"));
    panel.onChange({ attrs: { "data-key": "font", value: "SimSun" } });
    panel.onChange({ attrs: { "data-key": "size", value: "18" } });
    panel.onChange({ attrs: { "data-key": "line", value: "1.5" } });
    panel.onChange({ attrs: { "data-key": "line", value: "follow" } });
    panel.onChange({ attrs: { "data-key": "after", value: "6" } });
    panel.onChange({ attrs: { "data-key": "align", value: "follow" } });

    expect(sent).toEqual([
      { id: "office-format", value: JSON.stringify({ type: "size-adjust", delta: 1 }) },
      { id: "office-format", value: JSON.stringify({ type: "marks" }) },
      { id: "office-format", value: JSON.stringify({ type: "spacing", before: 12 }) },
      { id: "office-format", value: JSON.stringify({ type: "align", value: "center" }) },
      { id: "office-format", value: JSON.stringify({ type: "font", value: "SimSun" }) },
      { id: "office-format", value: JSON.stringify({ type: "size", value: 18 }) },
      { id: "office-format", value: JSON.stringify({ type: "line", value: 1.5 }) },
      { id: "office-format", value: JSON.stringify({ type: "line", value: null }) },
      { id: "office-format", value: JSON.stringify({ type: "spacing", after: 6 }) },
      { id: "office-format", value: JSON.stringify({ type: "align", value: null }) },
    ]);

    definition.onUnload();
  });

  it("卸载时释放面板", async () => {
    const { definition, disposed } = await loadPlugin({ typeId: "office-viewer:docx" });
    definition.onUnload();
    expect(disposed).toContain("reg-1");
  });

  /**
   * 视图脚本会被**内联进 srcdoc**（见 `buildViewDocument`）。HTML 解析器会把源码里的
   * 裸 NUL 换成 U+FFFD —— 一个 `[\u0000-\b]` 这样的正则当场变成「范围倒序」，整段模块
   * 解析失败，表现就是视图一直停在「等待文件…」。其余 C0 控制字符不该出现在源码里。
   *
   * 源里要写控制字符时用 `\x00` 这样的转义，不要贴裸字符。
   */
  it("视图脚本不带裸控制字符（内联进 HTML 后会被改写）", () => {
    const bad = [...VIEWER_SOURCE].filter((char) => {
      const code = char.codePointAt(0);
      return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    });
    expect(bad).toEqual([]);
  });
});
