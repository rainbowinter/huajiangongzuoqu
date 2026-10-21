import { afterEach, describe, expect, it } from "vitest";
import { postActiveViewCommand, setActiveViewCommandSink } from "./activeView";

describe("activeView", () => {
  afterEach(() => setActiveViewCommandSink(null));

  it("没有活着的视图时返回 false", () => {
    expect(postActiveViewCommand("x")).toBe(false);
  });

  it("只把命令发给拥有该视图的插件", () => {
    const received: Array<{ id: string; value?: string }> = [];
    setActiveViewCommandSink({
      owner: "office-viewer",
      post: (id, value) => received.push({ id, value }),
    });

    expect(postActiveViewCommand("format", "{}", "office-viewer")).toBe(true);
    expect(postActiveViewCommand("format", "{}", "pdf-viewer")).toBe(false);
    // 宿主内部的文档动作不带 owner：它已经按当前文件类型筛过。
    expect(postActiveViewCommand("export", undefined)).toBe(true);

    expect(received).toEqual([
      { id: "format", value: "{}" },
      { id: "export", value: undefined },
    ]);
  });

  it("收回之后不再投递", () => {
    const received: string[] = [];
    setActiveViewCommandSink({
      owner: "office-viewer",
      post: (id) => received.push(id),
    });
    setActiveViewCommandSink(null);

    expect(postActiveViewCommand("x", undefined, "office-viewer")).toBe(false);
    expect(received).toEqual([]);
  });
});
