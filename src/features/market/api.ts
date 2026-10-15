import { invoke } from "@tauri-apps/api/core";
import type { MarketCatalog } from "./types";

/**
 * 市场开关。`null` = 没配市场，整条流程不启动。
 *
 * 端点在 Rust 侧运行时解析（`plugins/market/config.rs`）：没配的时候**不要**发任何请求，
 * 界面上也不该出现任何东西。所以这是第一道门，而不是可选项 —— 与 `getUpdateEndpoint()`
 * 同一条约定。
 */
export function getMarketEndpoint(): Promise<string | null> {
  return invoke("plugins_market_endpoint");
}

/**
 * 取回插件清单（Rust 侧会先验签，验签不过直接抛错）。
 *
 * 失败时抛出来的 `AppError` 里 `code` 可能是 `marketRequestFailed`（网络）、
 * `marketSignatureInvalid`（验签）、`marketCatalogInvalid`（格式）等 —— 前端照实显示，
 * 不要笼统地说「市场不可用」。
 */
export function fetchMarketCatalog(): Promise<MarketCatalog> {
  return invoke("plugins_market_catalog");
}

/** 安装结果。`extraPermissions` 非空说明清单与插件对不上，要显式提示用户。 */
export interface InstallOutcome {
  name: string;
  version: string;
  extraPermissions: string[];
  replacedVersion?: string;
}

/**
 * 装一个插件。
 *
 * `approvedPermissions` **必须**是用户在那个确认框里看到并同意的那一份 —— 后端把它原样
 * 记下来，插件清单里多出来的权限一个都不会生效。所以**不要**在没有确认的情况下调用它。
 *
 * 装完由调用方负责 `reloadPlugins()`：后端只落盘，加载是前端的事。
 */
export function installPlugin(options: {
  name: string;
  version: string;
  url: string;
  sha256: string;
  approvedPermissions: string[];
}): Promise<InstallOutcome> {
  return invoke("plugins_market_install", options);
}

export interface UninstallOutcome {
  name: string;
  dataRemoved: boolean;
}

/**
 * 卸一个插件。`deleteData` 由用户选择（界面上会问，默认不删）。
 *
 * 后端会拒绝卸载不是从市场装的插件 —— 那条错误该原样给用户看，不要吞掉。
 */
export function uninstallPlugin(name: string, deleteData: boolean): Promise<UninstallOutcome> {
  return invoke("plugins_market_uninstall", { name, deleteData });
}
