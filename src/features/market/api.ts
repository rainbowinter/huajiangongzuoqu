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
