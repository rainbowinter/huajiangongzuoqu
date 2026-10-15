import { listPlugins } from "../plugins/api";
import { reloadPlugins } from "../plugins/loader";
import { fetchMarketCatalog, installPlugin } from "./api";
import { planAutoUpdates, reportText, skipText, type AutoUpdateReport } from "./presentation";
import type { MarketCatalog } from "./types";

/**
 * 「市场有新版本就自动装」这条路**真正动手的那一层**。
 *
 * 判据（谁该更新、谁不能自动更新）全在 `presentation.ts` 的 `planAutoUpdates` 里 —— 那是
 * 纯函数、有单测。这里只负责取数据、按计划发请求、把结果说成一句话，所以刻意薄。
 *
 * ## 一条不能让步的规矩：**不替用户批准新权限**
 *
 * 自动更新是在用户看不见的时候换掉代码。新版本多要权限时如果照旧静默装上，「安装前我确认
 * 过」就变成了「第一次确认就永久放行」。所以那种情况一律**不装**，只在面板上留一句
 * 「有新版，但要重新确认权限」。判断与授权集合的算法见 `planAutoUpdates`。
 */

/** 一次只跑一轮：启动钩子与「重载插件」都可能碰到它，两轮并发会同时去写同一个目录。 */
let running = false;

/**
 * 启动时跑一遍。
 *
 * **没有开自动更新的插件就一个请求都不发** —— 不用这个功能的人不该为它付启动开销，
 * 没配市场时更不该去碰网络。所以先问本地状态，再决定要不要取清单。
 *
 * 失败一律吞掉并记日志：自动更新是**顺带**做的事，它出问题不该打断启动，也不该弹一个
 * 用户没主动触发的错误框。
 */
export async function runStartupAutoUpdates(): Promise<AutoUpdateReport | null> {
  if (running) return null;
  running = true;
  try {
    const installed = await listPlugins();
    if (!installed.some((plugin) => plugin.autoUpdate)) return null;

    let catalog: MarketCatalog;
    try {
      catalog = await fetchMarketCatalog();
    } catch (error) {
      // 没配市场 / 网络不通 / 验签不过 —— 都只是「这次没更成」，静默收场。
      console.warn("[market] 自动更新取清单失败", error);
      return null;
    }

    const plan = planAutoUpdates(installed, catalog);
    if (plan.length === 0) return null;

    const report: AutoUpdateReport = { updated: [], skipped: [] };
    for (const item of plan) {
      if (item.action === "skip") {
        report.skipped.push(skipText(item.reason, item.version));
        continue;
      }
      try {
        await installPlugin({
          name: item.name,
          version: item.release.version,
          url: item.release.url,
          sha256: item.release.sha256,
          approvedPermissions: item.permissions,
          // 自动更新**不**替用户点头「替换本地同名插件」：那件事必须是人点出来的。
          replaceLocal: false,
        });
        report.updated.push(`${item.name} → v${item.release.version}`);
      } catch (error) {
        console.warn(`[market] 自动更新 ${item.name} 失败`, error);
        report.skipped.push(`${item.name} 自动更新失败，下次启动再试`);
      }
    }

    if (report.updated.length > 0) {
      // 装完了才重载：不然新代码还没落盘，重载出来的还是旧的。
      await reloadPlugins();
    }
    return report;
  } finally {
    running = false;
  }
}

/** 跑一轮并把结果说出来；没事发生就什么都不做（不打扰用户）。 */
export async function runStartupAutoUpdatesQuietly(): Promise<void> {
  const report = await runStartupAutoUpdates();
  const text = reportText(report);
  if (!text) return;
  // 动态引入：`Toast` 会碰 DOM，纯逻辑的单测不该被它牵着。
  const { showToast } = await import("../../components/Toast");
  showToast(text, "info");
}
