import { describe, expect, test } from "vitest";
import { folderName, shortenPath } from "./WorkspaceTree";

/**
 * 侧栏标题行的两个纯函数。
 *
 * 它们都不碰 DOM，却是「一眼看出这是哪个文件夹」的全部依据 —— 之前只有 `folderName`
 * 一条路径，现在副标题还要靠 `shortenPath` 把尾部几段保住，截错方向就等于没给地址。
 */
describe("folderName", () => {
  test("取最后一段，Windows 与 POSIX 分隔符都认", () => {
    expect(folderName("E:\\fwinter\\Projects\\floral-notepaper-main")).toBe(
      "floral-notepaper-main",
    );
    expect(folderName("/home/me/notes")).toBe("notes");
  });

  test("结尾带分隔符也能取到", () => {
    expect(folderName("E:\\fwinter\\Projects\\floral-notepaper-main\\")).toBe(
      "floral-notepaper-main",
    );
  });
});

describe("shortenPath", () => {
  test("没超长就原样返回", () => {
    expect(shortenPath("E:\\short")).toBe("E:\\short");
  });

  test("超长时从**头部**截，保住尾部几段", () => {
    const path = "E:\\fwinter\\Projects\\floral-notepaper-main\\src\\styles";
    const shortened = shortenPath(path, 24);

    expect(shortened).toHaveLength(24);
    expect(shortened.startsWith("…")).toBe(true);
    // 区分度在尾部：这一段必须活下来，否则截了等于白截。
    expect(shortened.endsWith("src\\styles")).toBe(true);
  });

  test("刚好等于上限时不截", () => {
    const path = `E:\\${"a".repeat(17)}`; // 3 + 17 = 20，正好等于上限
    expect(path).toHaveLength(20);
    expect(shortenPath(path, 20)).toBe(path);
  });

  test("每多一个字符就真的少截一个，不会差一位", () => {
    const path = "E:\\a\\very\\long\\path\\that\\keeps\\going\\and\\going\\styles";

    for (const max of [12, 20, 30, 40]) {
      const shortened = shortenPath(path, max);
      expect(shortened.length).toBeLessThanOrEqual(max);
      expect(path.endsWith(shortened.slice(1))).toBe(true);
    }
  });

  test("栏宽极窄时留一个下限，不会只剩省略号", () => {
    const path = "E:\\fwinter\\Projects\\floral-notepaper-main\\src\\styles";
    // 调用方按栏宽估算，窄栏会算出很小的值甚至负数。
    const shortened = shortenPath(path, -3);

    expect(shortened.length).toBe(10);
    expect(shortened.endsWith("styles")).toBe(true);
  });
});
