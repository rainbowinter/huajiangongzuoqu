import { describe, expect, test } from "vitest";
import { imagePathsToMarkdown } from "./useImagePaste";

describe("imagePathsToMarkdown", () => {
  test("单个绝对路径变成图片 Markdown", () => {
    expect(imagePathsToMarkdown("E:/figs/fig.png", "note-1", "E:/data")).toBe(
      "![](E:/figs/fig.png)",
    );
  });

  test("当前笔记 images 目录下的图片还原成相对路径", () => {
    expect(imagePathsToMarkdown("E:/data/images/note-1/fig.png", "note-1", "E:/data")).toBe(
      "![](images/note-1/fig.png)",
    );
  });

  test("多行路径逐行转换", () => {
    expect(
      imagePathsToMarkdown("E:/a.png\nE:/b.jpg", null, undefined),
    ).toBe("![](E:/a.png)\n![](E:/b.jpg)");
  });

  test("file:// 先解码再转换", () => {
    expect(imagePathsToMarkdown("file:///E:/My%20Pics/a.png", null, undefined)).toBe(
      "![](E:/My Pics/a.png)",
    );
  });

  test("普通文字与不支持的扩展名不拦截", () => {
    expect(imagePathsToMarkdown("这是正文", "note-1", "E:/data")).toBeNull();
    expect(imagePathsToMarkdown("E:/a.txt", "note-1", "E:/data")).toBeNull();
    expect(imagePathsToMarkdown("./images/a.png", "note-1", "E:/data")).toBeNull();
  });

  test("已经相对路径的笔记图片原样保留", () => {
    expect(imagePathsToMarkdown("images/note-1/a.png", "note-1", "E:/data")).toBe(
      "![](images/note-1/a.png)",
    );
  });

  test("尖括号包住带空格的路径也能认", () => {
    expect(imagePathsToMarkdown("<E:/My Pics/a.png>", null, undefined)).toBe(
      "![](E:/My Pics/a.png)",
    );
  });
});
