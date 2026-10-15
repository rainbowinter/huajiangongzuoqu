import { describe, expect, test } from "vitest";
import { describeSyncReport } from "./loader";
import type { PluginSyncReport } from "./types";

/**
 * 只测「校正报告该怎么说给人听」。
 *
 * 这一层值得单独钉住，是因为它决定了**什么时候不该出声**：校正每次启动都会跑，绝大多数
 * 时候什么都不用做，此时弹一个「插件版本校正完成」只会让人以为出了什么事。真正的判据
 * 全在 `describeSyncReport` 里，接 Toast 的那一步没有分支。
 */
function report(overrides: Partial<PluginSyncReport> = {}): PluginSyncReport {
  return { updated: [], skipped: [], backedUp: [], migrated: false, ...overrides };
}

describe("版本校正报告的说辞", () => {
  test("什么都没发生就一个字都不说", () => {
    expect(describeSyncReport(report())).toBeNull();
  });

  test("更新了插件就报数量和名字", () => {
    const message = describeSyncReport(report({ updated: ["outline", "line-numbers"] }));

    expect(message).toContain("2 个插件");
    expect(message).toContain("outline");
    expect(message).toContain("line-numbers");
  });

  test("用户改过的插件单独说一句 —— 那是他需要知道的事", () => {
    const message = describeSyncReport(
      report({ updated: ["outline"], skipped: ["line-numbers"] }),
    );

    expect(message).toContain("已更新 1 个插件");
    expect(message).toContain("跳过");
  });

  test("备份过原件也要说", () => {
    const message = describeSyncReport(report({ updated: ["outline"], backedUp: ["outline"] }));

    expect(message).toContain("备份");
  });

  test("状态文件单独的迁移只在没别的事时说一句", () => {
    // 它没有任何用户可见的后果，混在别的消息里只会让人去找「哪里变了」。
    expect(describeSyncReport(report({ migrated: true }))).toBe("插件状态文件已升级");

    const withUpdates = describeSyncReport(report({ migrated: true, updated: ["outline"] }));
    expect(withUpdates).toContain("已更新 1 个插件");
    expect(withUpdates).not.toContain("状态文件");
  });
});
