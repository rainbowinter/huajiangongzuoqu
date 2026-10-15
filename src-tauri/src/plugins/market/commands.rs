//! 插件市场的 `#[tauri::command]` 薄封装。
//!
//! 与其他子系统的分工一致：命令里只做「取参数 → 调服务 → 包错误」，真正的逻辑在
//! `catalog` / `install`（阶段 2）里，便于直接单测。
//!
//! **网络一律走 `spawn_blocking`**：`reqwest::blocking` 会占住线程等 IO，直接在命令里调用
//! 会把 Tauri 的异步运行时线程堵死（仓库里 `updater/commands.rs` 是同样的处理）。

use super::catalog::{self, PluginCatalog};
use super::config;
use crate::plugins::errors::app_error;
use crate::plugins::manifest::CURRENT_API_VERSION;
use crate::services::notes::AppError;
use tauri::AppHandle;

/// 宿主环境：判断某个版本「在这里能不能装」时要用。
pub fn host_env(app: &AppHandle) -> catalog::HostEnv {
    catalog::HostEnv {
        api_version: CURRENT_API_VERSION,
        // 用应用自己报的版本（`tauri.conf.json` 的 `version`），而不是别处的副本。
        app_version: app.package_info().version.to_string(),
    }
}

/// 给前端看：清单地址。`null` = 市场关闭。
///
/// 这是整条流程的第一道门，**不是可选项** —— 没配端点时前端不该发任何请求，
/// 界面上也不该留任何痕迹（与 `selfupdate::update_endpoint` 同一套约定）。
#[tauri::command]
pub fn plugins_market_endpoint(app: AppHandle) -> Option<String> {
    config::configured(&app).catalog_endpoint().map(str::to_string)
}

/// 取回并解析插件清单。
///
/// 失败分两类，前端的处理不一样：
/// - `marketDisabled` —— 没配市场，属于「不该走到这里」；
/// - 其余（网络、验签、格式）—— 属于真的出错，要如实告诉用户。
#[tauri::command]
pub async fn plugins_market_catalog(app: AppHandle) -> Result<PluginCatalog, AppError> {
    let settings = config::configured(&app);
    let Some(endpoint) = settings.catalog_endpoint().map(str::to_string) else {
        return Err(app_error("marketDisabled", "没有配置插件市场地址"));
    };

    let pubkey = settings.pubkey.clone();
    let host = host_env(&app);

    tauri::async_runtime::spawn_blocking(move || catalog::fetch_catalog(&endpoint, &pubkey, &host))
        .await
        .map_err(|error| {
            app_error(
                "marketTaskJoinFailed",
                format!("获取插件清单的任务失败：{error}"),
            )
        })?
}
