import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearBuiltinCommands,
  dispatchCommandKeybinding,
  formatKeybinding,
  listCommands,
  matchKeybinding,
  parseKeybinding,
  registerBuiltinCommand,
} from "./registry";
import { addPluginCommand, clearAllPlugins } from "../plugins/registry";

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  preventDefault: () => void;
} {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...init,
  };
}

beforeEach(() => {
  clearBuiltinCommands();
  clearAllPlugins();
});

describe("parseKeybinding", () => {
  test("解析修饰键与主键", () => {
    expect(parseKeybinding("Ctrl+Shift+W")).toEqual({
      ctrl: true,
      meta: false,
      alt: false,
      shift: true,
      key: "w",
    });
  });

  test("大小写与别名不敏感", () => {
    expect(parseKeybinding("Control+K")).toMatchObject({ ctrl: true, key: "k" });
    expect(parseKeybinding("Command+K")).toMatchObject({ meta: true, key: "k" });
    expect(parseKeybinding("control+k")).toMatchObject({ ctrl: true, key: "k" });
  });

  test("alt 与 option 是同一个修饰键", () => {
    expect(parseKeybinding("Alt+K")).toMatchObject({ alt: true, key: "k" });
    expect(parseKeybinding("Option+K")).toMatchObject({ alt: true, key: "k" });
  });

  test("CmdOrCtrl 在非 macOS 上映射到 Ctrl", () => {
    expect(parseKeybinding("CmdOrCtrl+K")).toMatchObject({ ctrl: true, meta: false });
  });

  test("缺少主键时无效", () => {
    expect(parseKeybinding("Ctrl+Shift")).toBeNull();
    expect(parseKeybinding("")).toBeNull();
  });

  test("已知限制：以 + 分隔的解析方式无法表达 + 键本身", () => {
    // "Ctrl++" 会被切成 "Ctrl" 与两个空串，主键缺失。
    expect(parseKeybinding("Ctrl++")).toBeNull();
  });
});

describe("matchKeybinding", () => {
  test("修饰键与主键全部一致才匹配", () => {
    expect(matchKeybinding(keyEvent({ key: "w", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+W")).toBe(true);
    expect(matchKeybinding(keyEvent({ key: "w", ctrlKey: true }), "Ctrl+Shift+W")).toBe(false);
    expect(matchKeybinding(keyEvent({ key: "w", shiftKey: true }), "Ctrl+Shift+W")).toBe(false);
    expect(matchKeybinding(keyEvent({ key: "k", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+W")).toBe(false);
  });

  test("多出来的修饰键会导致不匹配", () => {
    expect(
      matchKeybinding(keyEvent({ key: "w", ctrlKey: true, shiftKey: true, altKey: true }), "Ctrl+Shift+W"),
    ).toBe(false);
  });

  test("非法绑定不匹配任何东西", () => {
    expect(matchKeybinding(keyEvent({ key: "w", ctrlKey: true }), "Ctrl")).toBe(false);
  });
});

describe("formatKeybinding", () => {
  test("渲染成便于展示的形式", () => {
    expect(formatKeybinding("ctrl+shift+w")).toBe("Ctrl+Shift+W");
    expect(formatKeybinding("Ctrl+k")).toBe("Ctrl+K");
  });

  test("非法绑定原样返回", () => {
    expect(formatKeybinding("Ctrl")).toBe("Ctrl");
  });
});

describe("统一命令表", () => {
  test("内置命令与插件命令合流", () => {
    registerBuiltinCommand({ id: "builtin.a", title: "内置 A", run: () => {} });
    addPluginCommand({ id: "p:b", title: "插件 B", plugin: "p", run: () => {} });

    const commands = listCommands();
    expect(commands.map((c) => c.source).sort()).toEqual(["builtin", "p"]);
  });

  test("注册返回的 Disposable 可撤销", () => {
    const disposable = registerBuiltinCommand({ id: "builtin.a", title: "A", run: () => {} });
    expect(listCommands()).toHaveLength(1);
    disposable.dispose();
    expect(listCommands()).toHaveLength(0);
  });
});

describe("dispatchCommandKeybinding", () => {
  test("匹配时接管事件并执行命令", async () => {
    const run = vi.fn();
    registerBuiltinCommand({ id: "builtin.a", title: "A", keybinding: "Ctrl+Shift+W", run });

    const event = keyEvent({ key: "w", ctrlKey: true, shiftKey: true });
    expect(dispatchCommandKeybinding(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();

    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("不匹配时不接管", () => {
    registerBuiltinCommand({ id: "builtin.a", title: "A", keybinding: "Ctrl+Shift+W", run: () => {} });

    const event = keyEvent({ key: "b", ctrlKey: true });
    expect(dispatchCommandKeybinding(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("没绑键位的命令不会被按键触发", () => {
    const run = vi.fn();
    registerBuiltinCommand({ id: "builtin.a", title: "A", run });

    expect(dispatchCommandKeybinding(keyEvent({ key: "a" }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("命令同步抛错不会冒出到按键处理里", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    registerBuiltinCommand({
      id: "builtin.a",
      title: "A",
      keybinding: "Ctrl+Shift+W",
      run: () => {
        throw new Error("boom");
      },
    });

    const event = keyEvent({ key: "w", ctrlKey: true, shiftKey: true });
    expect(() => dispatchCommandKeybinding(event)).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
