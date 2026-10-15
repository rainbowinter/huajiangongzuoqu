import { describe, expect, test } from "vitest";
import { pluginOwningPath } from "./pluginPaths";

/**
 * 「这个文件属于哪个插件」。
 *
 * 判断错了的后果是**推给错误的插件**：正确的那个不刷新（表现是「保存了没反应」），
 * 无关的那个重读一遍自己的资源（多半无害）。所以宁可返回 null，也不要猜。
 */
const DATA_DIR = "E:\\fwinter\\Projects\\floral-notepaper-main\\.devdata\\notes";

describe("pluginOwningPath", () => {
  test("插件目录里的文件返回插件名", () => {
    expect(pluginOwningPath(DATA_DIR, `${DATA_DIR}\\plugins\\css-modifier\\styles\\aaa.css`)).toBe(
      "css-modifier",
    );
  });

  test("反斜杠与正斜杠都认", () => {
    expect(pluginOwningPath(DATA_DIR, `${DATA_DIR}/plugins/css-modifier/styles/aaa.css`)).toBe(
      "css-modifier",
    );
    expect(pluginOwningPath("E:/notes", "E:/notes/plugins/x/a.css")).toBe("x");
  });

  test("插件名下带连字符不会被截断成前缀", () => {
    // 这是最容易写错的地方：`plugins/abc-extra/...` 必须属于 abc-extra，不是 abc。
    expect(pluginOwningPath(DATA_DIR, `${DATA_DIR}\\plugins\\abc-extra\\a.css`)).toBe("abc-extra");
  });

  test("不在插件目录里的路径返回 null", () => {
    expect(pluginOwningPath(DATA_DIR, `${DATA_DIR}\\notes\\我的笔记.md`)).toBeNull();
    expect(pluginOwningPath(DATA_DIR, "E:\\other\\plugins\\x\\a.css")).toBeNull();
    // 另一个数据目录下的同名结构不能算数
    expect(pluginOwningPath(DATA_DIR, "E:\\elsewhere\\plugins\\x\\a.css")).toBeNull();
  });

  test("直接躺在 plugins/ 下的文件不属于任何插件", () => {
    expect(pluginOwningPath(DATA_DIR, `${DATA_DIR}\\plugins\\orphan.css`)).toBeNull();
    expect(pluginOwningPath(DATA_DIR, `${DATA_DIR}\\plugins`)).toBeNull();
    expect(pluginOwningPath(DATA_DIR, `${DATA_DIR}\\plugins\\`)).toBeNull();
  });

  test("空输入不炸", () => {
    expect(pluginOwningPath("", `${DATA_DIR}\\plugins\\x\\a.css`)).toBeNull();
    expect(pluginOwningPath(DATA_DIR, "")).toBeNull();
  });

  test("Windows 路径大小写不敏感，返回的仍是原样那一段", () => {
    expect(
      pluginOwningPath(DATA_DIR, `${DATA_DIR.toUpperCase()}\\plugins\\CSS-Modifier\\a.css`),
    ).toBe("CSS-Modifier");
  });
});
