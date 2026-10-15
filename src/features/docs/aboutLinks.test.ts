import { describe, expect, test } from "vitest";
import { releasePageFromEndpoint } from "./aboutLinks";

describe("从更新源推发布页", () => {
  test("GitHub 的 releases/latest/download 形式", () => {
    expect(
      releasePageFromEndpoint(
        "https://github.com/rainbowinter/huajiangongzuoqu/releases/latest/download/latest.json",
      ),
    ).toBe("https://github.com/rainbowinter/huajiangongzuoqu/releases");
  });

  test("别管更新源具体指到哪个文件 —— 只取到 releases 那一段", () => {
    expect(releasePageFromEndpoint("https://github.com/a/b/releases/latest/download/x.json")).toBe(
      "https://github.com/a/b/releases",
    );
    expect(releasePageFromEndpoint("https://github.com/a/b/releases/download/v1.0.0/pack.zip")).toBe(
      "https://github.com/a/b/releases",
    );
  });

  test("没有更新源时不猜", () => {
    expect(releasePageFromEndpoint(null)).toBeNull();
    expect(releasePageFromEndpoint(undefined)).toBeNull();
    expect(releasePageFromEndpoint("")).toBeNull();
  });

  test("不是合法 URL / 不是 GitHub 那套路径的，一律返回 null", () => {
    expect(releasePageFromEndpoint("本地文件.json")).toBeNull();
    // 自建静态托管：没有 releases 这一段，硬猜只会给出一个错链接。
    expect(releasePageFromEndpoint("https://example.com/downloads/latest.json")).toBeNull();
    // `releases` 恰好是第一段（`https://releases/...`）也不认。
    expect(releasePageFromEndpoint("https://host/releases/latest.json")).toBeNull();
  });
});
