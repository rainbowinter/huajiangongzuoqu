/**
 * 市场里可以直接测的纯逻辑。
 *
 * 单独成模块的理由与 `features/update/presentation.ts` 一样：`useMarket.ts` 拖着
 * `@tauri-apps/api`，组件拖着 React —— 这个仓库的测试环境没有 jsdom，hook 与组件都挂不
 * 起来。所以**判据**（什么时候露出界面、某个原因码怎么说）要放在没有依赖的地方。
 *
 * ⚠️ 这里的文案是**中文写死**的，与该面板（`PluginCommandPanel.tsx`）其余部分的现状一致
 * —— 插件界面整体还没接 i18n。将来要补多语言时，把这张表换成 key、让组件去 `t()` 即可。
 */

import type { MarketCatalog, MarketPlugin, MarketRelease } from "./types";

/** 市场界面的状态机。 */
export type MarketState =
  /** 还没问出端点配没配（刚挂载的一瞬间）。 */
  | { stage: "unknown" }
  /** 没配市场：界面上**一点痕迹都不该有**。 */
  | { stage: "unavailable" }
  | { stage: "loading" }
  | { stage: "ready"; catalog: MarketCatalog }
  | { stage: "error"; message: string };

/**
 * 市场界面该不该出现。
 *
 * `unknown` 与 `unavailable` 都不出现：前者是还没问出来（露一下再收起更难看），
 * 后者是用户没开这个功能。
 */
export function isMarketVisible(state: MarketState): boolean {
  return state.stage !== "unknown" && state.stage !== "unavailable";
}

/**
 * 原因码 → 一句话。
 *
 * 码的形状是 `名字` 或 `名字:参数`（与仓库其他地方一致，例如
 * `apiVersionUnsupported:99`）。认不出来的码**原样显示**而不是说「未知错误」——
 * 用户把这句话截图给作者，作者一看就知道是哪个分支。
 */
export function blockedText(code: string | undefined | null): string | null {
  if (!code) return null;

  const separator = code.indexOf(":");
  const name = separator === -1 ? code : code.slice(0, separator);
  const argument = separator === -1 ? "" : code.slice(separator + 1);

  switch (name) {
    case "marketPluginNameInvalid":
      return "插件名称不合法（名称会直接当目录名用）";
    case "marketPluginMalformed":
      return "这一条不是合法的插件条目（清单可能损坏）";
    case "marketPluginNameDuplicate":
      return "清单里有同名的另一个插件";
    case "marketPluginNoReleases":
      return "清单里没有它的任何版本";
    case "marketReleaseMalformed":
      return "这一版不是合法的版本条目";
    case "marketReleaseMissingVersion":
      return "清单里没写版本号";
    case "marketReleaseVersionInvalid":
      return "版本号无法比较（例如 nightly），没法判断新旧";
    case "marketReleaseMissingUrl":
      return "清单里没写下载地址";
    case "marketReleaseUrlInvalid":
      return "下载地址不合法（只接受 https）";
    case "marketReleaseSha256Invalid":
      return "缺少有效的 sha256 校验值";
    case "marketReleaseVersionDuplicate":
      return "同一版本在清单里出现了两次";
    case "marketReleaseNoSandbox":
      return `旧格式（apiVersion ${argument}）跑在主线程里，没有沙箱隔离，不能从市场安装`;
    case "marketReleaseApiTooNew":
      return `需要更新的插件 API（它要求 apiVersion ${argument}）`;
    case "marketReleaseAppTooOld":
      return `需要花笺 ${argument} 或更高版本`;
    default:
      return code;
  }
}

/**
 * 这一版能不能装。
 *
 * 判据只有 `blocked` 一个字段 —— 所有的筛选（https、sha256、apiVersion、minAppVersion）
 * 都在 Rust 侧做完了。前端**不要**再自己判一遍：两处判据迟早会漂移。
 */
export function isInstallable(release: MarketRelease): boolean {
  return !release.blocked;
}

/** 默认选中的那一版（清单里说好的「最新的可装版」）。 */
export function defaultRelease(plugin: MarketPlugin): MarketRelease | null {
  if (!plugin.latest) return null;
  return plugin.releases.find((release) => release.version === plugin.latest) ?? null;
}

/** 字节数 → 人能读的大小。清单里没写大小时给空串，界面上就什么都不显示。 */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 列表顶部那句汇总。 */
export function catalogSummary(catalog: MarketCatalog): string {
  const count = catalog.plugins.length;
  return `共 ${count} 个插件 · 清单 v${catalog.catalogVersion}`;
}
