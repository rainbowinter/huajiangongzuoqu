import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error 发布脚本是 .mjs（不参与 tsc 的源码构建），这里只取它的纯函数。
import {
  MAX_ICON_BYTES,
  addRelease,
  buildRelease,
  bumpCatalog,
  compareVersions,
  comparableVersion,
  emptyCatalog,
  readCatalog,
  readIconDataUrl,
  serializeCatalog,
  upsertPlugin,
} from "./catalog.mjs";

function release(overrides: Record<string, unknown> = {}) {
  return buildRelease({
    version: "1.0.0",
    apiVersion: 2,
    url: "https://example.com/a.zip",
    sha256: "a".repeat(64),
    size: 1024,
    permissions: ["editor:read"],
    publishedAt: "2026-10-15T00:00:00Z",
    ...overrides,
  });
}

describe("版本比较（与宿主同一套规则）", () => {
  it("按数字段比，不是按字符串", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
  });

  it("能不能比，与宿主的判据一致", () => {
    expect(comparableVersion("1.2.3")).toBe(true);
    expect(comparableVersion("1.0.0-beta.2")).toBe(true);
    expect(comparableVersion("nightly")).toBe(false);
    expect(comparableVersion("v1.0")).toBe(false);
    expect(comparableVersion("")).toBe(false);
  });
});

describe("清单的形状", () => {
  it("release 的键名与 Rust DTO 逐字对应", () => {
    // 这条是**跨语言的契约测试**：键名写错的话，应用会解不出来，而发布时看不出任何异常。
    // 改动这几个键名时，`src-tauri/src/plugins/market/catalog.rs` 那边必须同步。
    expect(Object.keys(release()).sort()).toEqual(
      ["apiVersion", "permissions", "publishedAt", "sha256", "size", "url", "version"].sort(),
    );

    expect(Object.keys(release({ minAppVersion: "2.0.0", notes: "修了个崩溃" })).sort()).toEqual(
      ["apiVersion", "minAppVersion", "notes", "permissions", "publishedAt", "sha256", "size", "url", "version"].sort(),
    );
  });

  it("可选字段缺省时不写进 JSON", () => {
    const raw = serializeCatalog({
      ...emptyCatalog(),
      plugins: [{ name: "demo", description: "", releases: [release()] }],
    });

    expect(raw).not.toContain("null");
  });

  it("清单根上的键名固定", () => {
    const catalog = { ...emptyCatalog(), generatedAt: "2026-10-15T00:00:00Z" };
    bumpCatalog(catalog, catalog.generatedAt);

    expect(Object.keys(catalog).sort()).toEqual(
      ["catalogVersion", "generatedAt", "plugins", "schema"].sort(),
    );
  });
});

describe("往清单里加一版", () => {
  it("同版本不许发第二次", () => {
    const entry = upsertPlugin(emptyCatalog(), { name: "demo", description: "" });
    addRelease(entry, release());

    expect(() => addRelease(entry, release())).toThrow(/已经在清单里/);
    // 上一次发布卡在半路时可以强行重来。
    expect(() => addRelease(entry, release(), { force: true })).not.toThrow();
  });

  it("版本从新到旧排", () => {
    const entry = upsertPlugin(emptyCatalog(), { name: "demo", description: "" });
    for (const version of ["1.0.0", "1.10.0", "1.2.0"]) {
      addRelease(entry, release({ version }));
    }

    expect(entry.releases.map((item: { version: string }) => item.version)).toEqual([
      "1.10.0",
      "1.2.0",
      "1.0.0",
    ]);
  });

  it("插件条目是复用的，描述会跟着新的 plugin.json 走", () => {
    const catalog = emptyCatalog();
    const first = upsertPlugin(catalog, { name: "demo", description: "旧的", author: "我" });
    const second = upsertPlugin(catalog, { name: "demo", description: "新的" });

    expect(catalog.plugins).toHaveLength(1);
    expect(second).toBe(first);
    expect(second.description).toBe("新的");
    expect(second.author).toBe("我");
  });
});

describe("图标：读成 data URL 内联进清单", () => {
  const dir = mkdtempSync(join(tmpdir(), "floral-icon-"));
  writeFileSync(join(dir, "icon.svg"), "<svg/>");
  writeFileSync(join(dir, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "big.svg"), "x".repeat(MAX_ICON_BYTES + 1));

  it("svh / png / jpg 各给对 MIME", () => {
    expect(readIconDataUrl(dir, "icon.svg")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(readIconDataUrl(dir, "a.png")).toMatch(/^data:image\/png;base64,/);
  });

  it("读不到、不是图片、太大、路径可疑 —— 一律 null（用默认图标，不拦发布）", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "nope.svg",
      "index.js",
      "icon",
      "../icon.svg",
      "/etc/icon.svg",
      "a\\b.svg",
      "C:/icon.svg",
      "big.svg",
    ]) {
      expect(readIconDataUrl(dir, bad as string)).toBeNull();
    }
  });

  it("写进条目里；plugin.json 里去掉了图标，清单里那条也跟着没", () => {
    const catalog = emptyCatalog();
    const first = upsertPlugin(catalog, { name: "demo", description: "", icon: "data:image/png;base64,AA" });
    expect(first.icon).toBe("data:image/png;base64,AA");

    upsertPlugin(catalog, { name: "demo", description: "" });
    expect(first.icon).toBeUndefined();
    expect(serializeCatalog(catalog)).not.toContain("icon");
  });
});

describe("catalogVersion", () => {
  it("每次都抬一格 —— 这是应用防回滚的水位线", () => {
    const catalog = emptyCatalog();
    expect(catalog.catalogVersion).toBe(0);

    expect(bumpCatalog(catalog, "2026-10-15T00:00:00Z")).toBe(1);
    expect(bumpCatalog(catalog, "2026-10-16T00:00:00Z")).toBe(2);
    expect(catalog.generatedAt).toBe("2026-10-16T00:00:00Z");
  });

  it("序列化之后还能读回来", () => {
    const catalog = emptyCatalog();
    upsertPlugin(catalog, { name: "demo", description: "" });
    bumpCatalog(catalog, "2026-10-15T00:00:00Z");

    const roundtrip = readCatalog(serializeCatalog(catalog));
    expect(roundtrip.catalogVersion).toBe(1);
    expect(roundtrip.plugins[0].name).toBe("demo");
  });

  it("schema 不认识就拒绝，别把旧格式往上写", () => {
    expect(() => readCatalog('{ "schema": 99, "catalogVersion": 1, "plugins": [] }')).toThrow(
      /schema/,
    );
  });
});
