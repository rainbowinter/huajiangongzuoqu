/**
 * 插件市场的数据形状。
 *
 * 与 Rust 侧 `plugins/market/catalog.rs` 里的 DTO 一一对应（**字段名必须对得上**，
 * 那边是 `serde(rename_all = "camelCase")`）。
 *
 * 这里是**只读**的：清单是已验签的全文，前端不参与任何信任判断 —— 该挡的在 Rust 侧
 * 已经挡完了，`blocked` 只是把「为什么不能装」带过来显示。
 */

/** 某一版插件。 */
export interface MarketRelease {
  version: string;
  /** 这一版要求宿主支持的插件 API 版本。 */
  apiVersion: number;
  /** zip 的下载地址。**已经过 https 校验**（回环地址的 http 除外，仅供本地测试）。 */
  url: string;
  /** 小写十六进制 sha256，64 位。 */
  sha256: string;
  /** zip 的字节数，可选：清单里没写就没有。 */
  size?: number;
  /**
   * 这一版**声明**要用的权限。
   *
   * ⚠️ 只用于安装前的预展示。**真正的依据是解压后 zip 里那份 `plugin.json`** ——
   * 清单可能过期，安装时会以 zip 里的为准复核一遍。
   */
  permissions: string[];
  minAppVersion?: string;
  notes?: string;
  publishedAt?: string;
  /** 不能装的原因码；`undefined` = 可以装。见 `presentation.ts` 的 `blockedText`。 */
  blocked?: string;
}

/** 市场里的一个插件。 */
export interface MarketPlugin {
  /** 规范标识 = 装到本地之后的目录名。 */
  name: string;
  description: string;
  author?: string;
  homepage?: string;
  /** 版本**从新到旧**（Rust 侧排好的）。 */
  releases: MarketRelease[];
  /** 整个插件都不能动的原因码。 */
  blocked?: string;
  /** 默认要装的那一版 = 最新的可装版。`undefined` = 没有可装的版本。 */
  latest?: string;
  /** 最新的版本号（不论能不能装）。 */
  newestVersion?: string;
}

/** 一份清单。 */
export interface MarketCatalog {
  schema: number;
  /** 单调递增；用来发现「拿到了比上次更旧的清单」。 */
  catalogVersion: number;
  generatedAt?: string;
  plugins: MarketPlugin[];
}
