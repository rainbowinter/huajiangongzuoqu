import { describe, expect, test } from "vitest";
import {
  isLocalAbsolutePath,
  localPathToFileUrl,
  splitLocalImages,
} from "./remarkLocalImages";

describe("isLocalAbsolutePath", () => {
  test("认盘符、UNC、file://", () => {
    expect(isLocalAbsolutePath("E:/a/b.png")).toBe(true);
    expect(isLocalAbsolutePath("E:\\a\\b.png")).toBe(true);
    expect(isLocalAbsolutePath("\\\\server\\share\\b.png")).toBe(true);
    expect(isLocalAbsolutePath("file:///E:/b.png")).toBe(true);
  });

  test("不碰普通地址", () => {
    expect(isLocalAbsolutePath("https://example.com/a.png")).toBe(false);
    expect(isLocalAbsolutePath("images/a.png")).toBe(false);
    expect(isLocalAbsolutePath("./a.png")).toBe(false);
    expect(isLocalAbsolutePath("")).toBe(false);
    // 用户自己写成 `<E:/a b.png>` 时 remark 已经解析过了，不要再动。
    expect(isLocalAbsolutePath("<E:/a b.png>")).toBe(false);
  });
});

describe("localPathToFileUrl", () => {
  test("盘符路径 → 三个斜杠，空格转义", () => {
    expect(localPathToFileUrl("E:/My Pics/a.png")).toBe("file:///E:/My%20Pics/a.png");
    expect(localPathToFileUrl("E:\\My Pics\\a.png")).toBe("file:///E:/My%20Pics/a.png");
  });

  test("UNC 路径保留两个斜杠", () => {
    expect(localPathToFileUrl("\\\\server\\share\\a b.png")).toBe(
      "file:////server/share/a%20b.png",
    );
  });
});

describe("splitLocalImages", () => {
  test("把带空格的本地图片从文字里拆出来", () => {
    const source =
      "看图：![B1 相对 A0](E:/fwinter/Projects/Raman Spectral Unmixing/exp/fig.png) 后面还有字";
    const segments = splitLocalImages(source);

    expect(segments.map((segment) => segment.kind)).toEqual(["text", "image", "text"]);
    expect(segments[1].url).toBe(
      "file:///E:/fwinter/Projects/Raman%20Spectral%20Unmixing/exp/fig.png",
    );
    expect(segments[1].alt).toBe("B1 相对 A0");
    expect(segments[0].value).toBe("看图：");
    expect(segments[2].value).toBe(" 后面还有字");
  });

  test("没有空格的本地路径不处理（remark 自己认得）", () => {
    const segments = splitLocalImages("![a](E:/x/a.png)");
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("text");
  });

  test("普通网络图片不处理", () => {
    const segments = splitLocalImages("![a](https://example.com/a.png)");
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("text");
  });

  test("一行里有多张也都能拆出来", () => {
    const segments = splitLocalImages(
      "![x](E:/a b/1.png) 中间 ![y](E:/c d/2.png)",
    );
    expect(segments.map((segment) => segment.kind)).toEqual([
      "image",
      "text",
      "image",
    ]);
  });
});
