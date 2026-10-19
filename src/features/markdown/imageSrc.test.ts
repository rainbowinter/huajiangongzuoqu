import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveMarkdownImageSrc } from "./imageSrc";

describe("resolveMarkdownImageSrc", () => {
  const convertFileSrc = vi.fn((path: string) => `asset://${path}`);

  beforeEach(() => {
    convertFileSrc.mockClear();
  });

  test("resolves note image paths under the images directory", () => {
    expect(resolveMarkdownImageSrc("images/photo.png", "/notes/note-1", convertFileSrc)).toBe(
      "asset:///notes/note-1/images/photo.png",
    );
    expect(convertFileSrc).toHaveBeenCalledWith("/notes/note-1/images/photo.png");
  });

  test("normalizes Windows-style separators before resolving note images", () => {
    expect(resolveMarkdownImageSrc("images\\photo.png", "C:/notes/note-1", convertFileSrc)).toBe(
      "asset://C:/notes/note-1/images/photo.png",
    );
    expect(convertFileSrc).toHaveBeenCalledWith("C:/notes/note-1/images/photo.png");
  });

  test("keeps non-note image paths unchanged", () => {
    expect(
      resolveMarkdownImageSrc("https://example.com/photo.png", "/notes/note-1", convertFileSrc),
    ).toBe("https://example.com/photo.png");
    expect(resolveMarkdownImageSrc("./photo.png", "/notes/note-1", convertFileSrc)).toBe(
      "./photo.png",
    );
    expect(convertFileSrc).not.toHaveBeenCalled();
  });

  test("keeps image paths unchanged when the base directory is unavailable", () => {
    expect(resolveMarkdownImageSrc("images/photo.png", undefined, convertFileSrc)).toBe(
      "images/photo.png",
    );
    expect(convertFileSrc).not.toHaveBeenCalled();
  });

  test("returns an empty string for missing sources", () => {
    expect(resolveMarkdownImageSrc(undefined, "/notes/note-1", convertFileSrc)).toBe("");
  });

  test("绝对路径（盘符 / UNC）也走 asset 协议", () => {
    expect(
      resolveMarkdownImageSrc("E:/Projects/exp/fig.png", undefined, convertFileSrc),
    ).toBe("asset://E:/Projects/exp/fig.png");
    expect(convertFileSrc).toHaveBeenCalledWith("E:/Projects/exp/fig.png");

    // 反斜杠先归一化
    expect(
      resolveMarkdownImageSrc("E:\\Projects\\exp\\fig.png", undefined, convertFileSrc),
    ).toBe("asset://E:/Projects/exp/fig.png");
  });

  test("file:// 还原成路径再交给 asset 协议，%20 解回来", () => {
    expect(
      resolveMarkdownImageSrc(
        "file:///E:/My%20Pics/a.png",
        undefined,
        convertFileSrc,
      ),
    ).toBe("asset://E:/My Pics/a.png");
    expect(convertFileSrc).toHaveBeenCalledWith("E:/My Pics/a.png");
  });
});
