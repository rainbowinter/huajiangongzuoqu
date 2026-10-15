import { describe, expect, test } from "vitest";
import {
  checkPermission,
  isGranted,
  isPermission,
  PERMISSIONS,
  PermissionError,
  unknownPermissions,
} from "./permissions";

describe("权限词汇表", () => {
  test("识别已知与未知权限", () => {
    expect(isPermission("editor:read")).toBe(true);
    expect(isPermission("ui:panel")).toBe(true);
    expect(isPermission("markdown:render")).toBe(false);
    expect(isPermission("fs:read")).toBe(false);
  });

  test("挑出宿主不认识的声明", () => {
    expect(unknownPermissions(["editor:read", "nope:thing", "ui:panel"])).toEqual(["nope:thing"]);
    expect(unknownPermissions([...PERMISSIONS])).toEqual([]);
  });
});

describe("默认拒绝", () => {
  test("未在清单里声明的权限一律不生效", () => {
    // 即便状态文件把权限写进了授予列表，只要清单没声明就不能生效。
    expect(isGranted([], ["editor:read"], "editor:read")).toBe(false);
    expect(isGranted(["ui:panel"], ["editor:read"], "editor:read")).toBe(false);
  });

  test("声明了但没被授予时不生效", () => {
    expect(isGranted(["editor:read"], [], "editor:read")).toBe(false);
  });

  test("声明且授予时才生效", () => {
    expect(isGranted(["editor:read"], ["editor:read"], "editor:read")).toBe(true);
  });
});

describe("蕴含关系", () => {
  test("写权限蕴含对应读权限", () => {
    expect(isGranted(["editor:write"], ["editor:write"], "editor:read")).toBe(true);
    expect(isGranted(["workspace:write"], ["workspace:write"], "workspace:read")).toBe(true);
    expect(isGranted(["categories:write"], ["categories:write"], "categories:read")).toBe(true);
  });

  test("剪贴板写不蕴含读", () => {
    expect(
      isGranted(["system:clipboard:write"], ["system:clipboard:write"], "system:clipboard:read"),
    ).toBe(false);
  });

  test("蕴含不反向", () => {
    expect(isGranted(["editor:read"], ["editor:read"], "editor:write")).toBe(false);
  });

  test("蕴含关系不能绕过「必须声明」这一关", () => {
    // 清单只声明了 editor:write，没有声明 editor:read —— 但 write 蕴含 read，
    // 因此仍然应当放行；反过来说，若清单两者都没声明，则都不放行。
    expect(isGranted([], ["editor:write"], "editor:read")).toBe(false);
  });
});

describe("checkPermission", () => {
  test("放行时不抛错", () => {
    expect(() =>
      checkPermission(["ui:panel"], ["ui:panel"], "ui:panel", "ui.registerPanel", "demo"),
    ).not.toThrow();
  });

  test("拒绝时抛 PermissionError，并带上可定位的细节", () => {
    let caught: unknown;
    try {
      checkPermission(["ui:panel"], ["ui:panel"], "editor:write", "editor.setContent", "demo");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PermissionError);
    const error = caught as PermissionError;
    expect(error.code).toBe("permissionDenied");
    expect(error.details).toEqual({
      permission: "editor:write",
      method: "editor.setContent",
      plugin: "demo",
    });
    expect(error.message).toContain("editor:write");
  });
});
