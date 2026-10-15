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

/**
 * 拆版本号里的数字段；拆不出来返回 `null`。
 *
 * **规则必须与 Rust 侧 `sync::version_segments` 一模一样**（那是版本校正用的解析器，
 * 市场那边也拿它当准入判据）：
 *
 * * 先去掉 `-` / `+` 之后的部分 —— 预发布后缀不参与比较，`1.1.0-beta.2` 与 `1.1.0` 同版；
 * * 再按 `.` 切，**每一段整体必须是数字**（`v1.0`、`1_2`、`1.0-beta.1` 都拆不出来）。
 *
 * 两边不一致的后果是「界面说有新版、后端说没有」这种自相矛盾，所以宁可两边都严。
 */
function versionSegments(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const core = trimmed.split(/[-+]/)[0] ?? trimmed;
  const segments: number[] = [];
  for (const part of core.split(".")) {
    if (!/^\d+$/.test(part)) return null;
    segments.push(Number(part));
  }
  return segments;
}

/**
 * 比大小：`a > b` 返回正数，相等 0，`a < b` 负数。
 *
 * **拆不出数字段时返回 `null`**，也就是「比不了」——调用方必须把它当成第三种结果，
 * 不能当成「相等」：版本号是自由字符串（`nightly`、`1.0-beta` 都合法），把「比不了」
 * 当成「一样」会让界面显示「已是最新」，而它根本不知道。
 */
export function compareVersions(a: string, b: string): number | null {
  const left = versionSegments(a);
  const right = versionSegments(b);
  if (!left || !right) return null;

  // 补齐到等长再逐位比：`1.0` 与 `1.0.0` 是同一版。
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 某个版本相对于**已装版本**是什么关系。
 *
 * `install` = 还没装过；`unknown` = 装了，但两边有一个版本号拆不出数字段（比不了）。
 * 界面按这个决定按钮上写「安装 / 更新 / 重装 / 降级」，以及要不要提醒「这是旧版本」。
 */
export type ReleaseRelation = "install" | "same" | "newer" | "older" | "unknown";

export function releaseRelation(
  installed: string | undefined | null,
  candidate: string,
): ReleaseRelation {
  if (!installed) return "install";

  const compared = compareVersions(candidate, installed);
  if (compared === null) return "unknown";
  if (compared > 0) return "newer";
  if (compared < 0) return "older";
  return "same";
}

/** 从已装列表里找同名的那个插件。 */
export function findInstalled<T extends { name: string }>(
  installed: readonly T[],
  name: string,
): T | undefined {
  return installed.find((plugin) => plugin.name === name);
}

/**
 * 清单的呈现顺序：**没装的在前，装过的沉到后面**。
 *
 * 装过的那几条已经没有可看的了（要更新有更新徽标、要卸载在插件列表里），把它们压在
 * 前面只会把「还有哪些没装」挤到下面去。两半各自保持清单原来的顺序 —— 那是发布者
 * 排过序的，不该被我们打乱。
 *
 * 判据只看「装没装」，**不看有没有更新**：真有新版的话插件列表那一栏会顶出「市场有新
 * 版本」的徽标与「去更新」，市场这条路上不缺提示。
 */
export function sortCatalogPlugins<T extends { name: string }>(
  plugins: readonly T[],
  installed: readonly { name: string }[],
): T[] {
  const installedNames = new Set(installed.map((plugin) => plugin.name));
  const pending: T[] = [];
  const done: T[] = [];
  for (const plugin of plugins) {
    (installedNames.has(plugin.name) ? done : pending).push(plugin);
  }
  return [...pending, ...done];
}

/**
 * 搜索框的过滤。
 *
 * 只匹配**名字、说明、作者**这三样：它们就在那一行上显示着，用户搜到什么就能指着什么。
 * 空串（或全是空白）返回原样的列表。
 */
export function filterCatalogPlugins<
  T extends { name: string; description?: string; author?: string },
>(plugins: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...plugins];

  return plugins.filter((plugin) =>
    [plugin.name, plugin.description ?? "", plugin.author ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

/**
 * 清单里有没有比已装版本更新的可装版本；有就返回那个版本号。
 *
 * 只认「更新」（market 的版本比已装的新）。清单里只有旧版本时返回 `null` —— 那不是
 * 「有更新」，而用户在插件面板里看到一个大字「有新版本」然后点过去发现是降级，比不提示更糟。
 *
 * 判据与市场那一行按钮上的文案共用 `releaseRelation`，两处不会说不到一起去。
 */
export function updateAvailable(
  installed: { name: string; version: string },
  catalog: MarketCatalog | null,
): string | null {
  if (!catalog) return null;

  const entry = catalog.plugins.find((plugin) => plugin.name === installed.name);
  if (!entry?.latest) return null;

  return releaseRelation(installed.version, entry.latest) === "newer" ? entry.latest : null;
}

/**
 * 更新时**需要用户重新确认**的那几个权限：新版本要的、而现在没生效的。
 *
 * 为什么这件事必须单独算：插件更新时静默拿到新权限，等于把「装之前我确认」变成
 * 「第一次确认就永久放行」。后端也按这条来 —— 授权表是「用户确认过的那份」，
 * 新版本多出来的权限不重新确认就不会生效（只是相关功能可能不可用，所以界面上要说）。
 */
export function permissionsRequiringReview(
  granted: readonly string[],
  needed: readonly string[],
): string[] {
  return needed.filter((permission) => !granted.includes(permission));
}

// ------------------------------------------------------------------ 自动更新

/**
 * 为什么这一版没自动装。攒着是为了给用户一句解释 —— 静默跳过等于没做。
 */
export type AutoUpdateSkipReason =
  /** 这一版本身就不能装（宿主 API 版本对不上之类）。 */
  | "blocked"
  /** 要的权限比现在多，得用户重新确认。 */
  | "needs-review";

export type AutoUpdatePlan =
  | {
      name: string;
      action: "update";
      release: MarketRelease;
      /** 交给后端的授权集合 = 「这一版要的」∩「已经授予的」。 */
      permissions: string[];
    }
  | { name: string; action: "skip"; reason: AutoUpdateSkipReason; version: string };

/** 跑完一轮自动更新的结果，交给界面说一句话。 */
export interface AutoUpdateReport {
  updated: string[];
  skipped: string[];
}

/**
 * 算出这次启动该自动做哪些事。
 *
 * **一条不能让步的规矩**：新版本要的权限超出已授予的集合时，**不装**。
 * 自动更新是在用户看不见的时候换掉代码，如果新版本多要一个权限也照旧静默装上，
 * 「安装前我确认过」就变成了「第一次确认就永久放行」—— 权限确认这件事会整个失效。
 * 用户自己点一次「更新」，那份清单就摆到他眼前了。
 *
 * `permissions` 传的是**交集**而不是清单声明的那一份：即便上面这条判断将来被改坏，
 * 这一层也不会多给一个权限出去。
 *
 * 只会出现在结果里的两种情况：够得着更新（`update`）、够得着但没自动装（`skip`）。
 * 「没开自动更新」「已经是最新」「市场里没有这个插件」都是**正常状态**，不是要汇报的事，
 * 一条都不返回 —— 否则每次启动都要弹一串「什么都没发生」。
 */
export function planAutoUpdates(
  installed: readonly AutoUpdateCandidate[],
  catalog: MarketCatalog,
): AutoUpdatePlan[] {
  const plan: AutoUpdatePlan[] = [];

  for (const plugin of installed) {
    // 只有从市场装的才谈得上「从市场更新」：随应用分发的那份跟着应用走，用户自己放进
    // 目录的更不许我们动（后端也会拒，这里先挡住，省一次请求）。
    if (!plugin.autoUpdate || plugin.origin !== "market" || !plugin.enabled) continue;

    const entry = catalog.plugins.find((item) => item.name === plugin.name);
    if (!entry?.latest) continue;
    if (releaseRelation(plugin.version, entry.latest) !== "newer") continue;

    const release = entry.releases.find((item) => item.version === entry.latest);
    if (!release) continue;

    const version = release.version;
    if (entry.blocked ?? release.blocked) {
      plan.push({ name: plugin.name, action: "skip", reason: "blocked", version });
      continue;
    }

    if (permissionsRequiringReview(plugin.grantedPermissions, release.permissions).length > 0) {
      plan.push({ name: plugin.name, action: "skip", reason: "needs-review", version });
      continue;
    }

    plan.push({
      name: plugin.name,
      action: "update",
      release,
      permissions: release.permissions.filter((permission) =>
        plugin.grantedPermissions.includes(permission),
      ),
    });
  }

  return plan;
}

/**
 * `planAutoUpdates` 要的那几项。
 *
 * 写成结构类型而不是直接吃 `PluginManifest`：这个模块的原则是「不拖任何依赖」，
 * 而 `PluginManifest` 在插件那边还挂着一堆运行状态。真实调用方传的是它，形状对得上。
 */
export interface AutoUpdateCandidate {
  name: string;
  version: string;
  enabled: boolean;
  autoUpdate: boolean;
  origin?: string;
  grantedPermissions: readonly string[];
}

/** 跳过的那一条该怎么说给用户听。 */
export function skipText(reason: AutoUpdateSkipReason, version: string): string {
  switch (reason) {
    case "blocked":
      return `新版本 v${version} 这个宿主装不了，没有自动更新`;
    case "needs-review":
      return `新版本 v${version} 要的权限比现在多，没有自动更新 —— 请自己点一次「更新」确认`;
  }
}

/** 给界面用的一句话总结；没有任何事发生时返回 `null`（不打扰用户）。 */
export function reportText(report: AutoUpdateReport | null): string | null {
  if (!report || (report.updated.length === 0 && report.skipped.length === 0)) return null;
  const parts: string[] = [];
  if (report.updated.length > 0) parts.push(`已自动更新：${report.updated.join("、")}`);
  parts.push(...report.skipped);
  return parts.join("；");
}
