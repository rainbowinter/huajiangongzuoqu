import { describe, expect, test } from "vitest";
import { deserializeError, HANDLER_PREFIX, PluginApiError, serializeError } from "./protocol";

describe("serializeError", () => {
  test("保留 AppError 形状（与 Rust 侧一致）", () => {
    const serialized = serializeError({
      code: "noteNotFound",
      message: "找不到该笔记",
      details: { id: "abc" },
    });

    expect(serialized).toEqual({
      code: "noteNotFound",
      message: "找不到该笔记",
      details: { id: "abc" },
    });
  });

  test("details 只保留字符串值（Rust 侧是 BTreeMap<String, String>）", () => {
    const serialized = serializeError({
      code: "x",
      message: "m",
      details: { keep: "yes", drop: 42, alsoDrop: null, nested: { a: 1 } },
    });

    expect(serialized.details).toEqual({ keep: "yes" });
  });

  test("details 为空时不输出该字段", () => {
    const serialized = serializeError({ code: "x", message: "m", details: {} });
    expect("details" in serialized).toBe(false);
  });

  test("普通 Error 走 fallback code", () => {
    const serialized = serializeError(new Error("崩了"), "pluginLoadFailed");
    expect(serialized.code).toBe("pluginLoadFailed");
    expect(serialized.message).toBe("崩了");
  });

  test("非 Error 值也能序列化", () => {
    expect(serializeError("字符串错误").message).toBe("字符串错误");
    expect(serializeError(undefined).message).toBe("undefined");
  });

  test("没有 code 的对象走 fallback", () => {
    expect(serializeError({ message: "只有消息" }, "fallback").code).toBe("fallback");
  });
});

describe("deserializeError", () => {
  test("还原成可按 code 分支处理的 PluginApiError", () => {
    const error = deserializeError({
      code: "permissionDenied",
      message: "未获得权限",
      details: { permission: "editor:write" },
    });

    expect(error).toBeInstanceOf(PluginApiError);
    expect(error.code).toBe("permissionDenied");
    expect(error.details.permission).toBe("editor:write");
  });

  test("缺失时给出兜底错误而不是抛错", () => {
    const error = deserializeError(undefined);
    expect(error.code).toBe("pluginError");
    expect(error.details).toEqual({});
  });
});

describe("回调令牌", () => {
  test("前缀以 NUL 开头，普通字符串参数不可能撞上", () => {
    expect(HANDLER_PREFIX.startsWith("\u0000")).toBe(true);
    expect(HANDLER_PREFIX.length).toBeGreaterThan(1);
    // NUL 是所有 C 系字符串的终止符，插件不可能在正常参数里写出它。
    expect(HANDLER_PREFIX.codePointAt(0)).toBe(0);
  });
});
