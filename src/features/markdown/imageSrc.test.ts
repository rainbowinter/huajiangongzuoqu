import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  allowLocalFileUrls,
  resolveMarkdownImagePath,
  resolveMarkdownImageSrc,
} from "./imageSrc";

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

describe("resolveMarkdownImagePath", () => {
  test("笔记图片还原成数据目录下的绝对路径", () => {
    expect(resolveMarkdownImagePath("images/photo.png", "E:/data")).toBe(
      "E:/data/images/photo.png",
    );
    expect(resolveMarkdownImagePath("images\\photo.png", "E:/data/")).toBe(
      "E:/data/images/photo.png",
    );
  });

  test("file:// 与绝对路径原样还原", () => {
    expect(resolveMarkdownImagePath("file:///E:/My%20Pics/a.png", undefined)).toBe(
      "E:/My Pics/a.png",
    );
    expect(resolveMarkdownImagePath("E:/Projects/fig.png", undefined)).toBe(
      "E:/Projects/fig.png",
    );
  });

  test("外链与认不出的相对路径返回 null（没有可复制的本地文件）", () => {
    expect(resolveMarkdownImagePath("https://example.com/a.png", "E:/data")).toBeNull();
    expect(resolveMarkdownImagePath("./a.png", "E:/data")).toBeNull();
    expect(resolveMarkdownImagePath(undefined, "E:/data")).toBeNull();
  });
});

describe("allowLocalFileUrls", () => {
  test("图片的 file:// 放行（不然 react-markdown 会把 src 清成空串）", () => {
    expect(allowLocalFileUrls("file:///E:/My%20Pics/a.png", "src")).toBe(
      "file:///E:/My%20Pics/a.png",
    );
  });

  test("其它协议仍然走默认过滤", () => {
    expect(allowLocalFileUrls("javascript:alert(1)", "src")).toBe("");
    expect(allowLocalFileUrls("https://example.com/a.png", "src")).toBe(
      "https://example.com/a.png",
    );
    expect(allowLocalFileUrls("images/a.png", "src")).toBe("images/a.png");
  });

  test("链接（href）不放行 file:", () => {
    expect(allowLocalFileUrls("file:///E:/a.md", "href")).toBe("");
  });
});
