//! 插件市场的 `#[tauri::command]` 薄封装。
//!
//! 与其他子系统的分工一致：命令里只做「取参数 → 调服务 → 包错误」，真正的逻辑在
//! `catalog` / `install`（阶段 2）里，便于直接单测。
//!
//! **网络一律走 `spawn_blocking`**：`reqwest::blocking` 会占住线程等 IO，直接在命令里调用
//! 会把 Tauri 的异步运行时线程堵死（仓库里 `updater/commands.rs` 是同样的处理）。

use super::catalog::{self, PluginCatalog};
use super::config;
use super::install::{self, InstallOutcome, UninstallOutcome};
use super::progress;
use crate::plugins::errors::app_error;
use crate::plugins::manifest::CURRENT_API_VERSION;
use crate::plugins::paths::PluginPaths;
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
/// 失败分三类，前端的处理不一样：
/// - `marketDisabled` —— 没配市场，属于「不该走到这里」；
/// - `marketCatalogRolledBack` —— 拿到的是**旧的**清单（防回滚），界面该说清楚；
/// - 其余（网络、验签、格式）—— 属于真的出错，要如实告诉用户。
#[tauri::command]
pub async fn plugins_market_catalog(app: AppHandle) -> Result<PluginCatalog, AppError> {
    let settings = config::configured(&app);
    let Some(endpoint) = settings.catalog_endpoint().map(str::to_string) else {
        return Err(app_error("marketDisabled", "没有配置插件市场地址"));
    };

    let pubkey = settings.pubkey.clone();
    let host = host_env(&app);

    tauri::async_runtime::spawn_blocking(move || {
        let catalog = catalog::fetch_catalog(&endpoint, &pubkey, &host)?;
        // 验签通过之后才轮到防回滚：拿一份没验过签的清单去推进水位，等于把这件事
        // 交给攻击者。
        let paths = PluginPaths::resolve()?;
        progress::accept_and_record(&paths, &endpoint, catalog.catalog_version)?;
        Ok(catalog)
    })
    .await
    .map_err(|error| {
        app_error(
            "marketTaskJoinFailed",
            format!("获取插件清单的任务失败：{error}"),
        )
    })?
}

/// 从市场装一个插件。
///
/// `approved_permissions` 是**用户在确认框里看到并同意**的那一份（来自清单）。后端把它
/// 原样记进状态，既不补也不减 —— 这就是「装之前列清楚、我确认」在代码里的落点。
///
/// 装完前端要自己做两件事：`reloadPlugins()` 让新插件跑起来、刷新插件列表。
#[tauri::command]
pub async fn plugins_market_install(
    name: String,
    version: String,
    url: String,
    sha256: String,
    approved_permissions: Vec<String>,
) -> Result<InstallOutcome, AppError> {
    let paths = PluginPaths::resolve()?;
    let request = install::InstallRequest {
        name,
        version,
        url,
        sha256,
        approved_permissions,
    };

    // 下载是阻塞 IO，必须离异步运行时的线程远点。
    tauri::async_runtime::spawn_blocking(move || install::install(&paths, &request))
        .await
        .map_err(|error| {
            app_error(
                "marketTaskJoinFailed",
                format!("安装插件的任务失败：{error}"),
            )
        })?
}

/// 卸载一个市场装的插件。
///
/// `delete_data` 由用户在界面上选择（默认**不删**）：代码与数据本来就是分开的，
/// 重装能恢复设置。`install::uninstall` 会拒绝卸载不是市场装的插件。
#[tauri::command]
pub async fn plugins_market_uninstall(
    name: String,
    delete_data: bool,
) -> Result<UninstallOutcome, AppError> {
    let paths = PluginPaths::resolve()?;

    tauri::async_runtime::spawn_blocking(move || install::uninstall(&paths, &name, delete_data))
        .await
        .map_err(|error| {
            app_error(
                "marketTaskJoinFailed",
                format!("卸载插件的任务失败：{error}"),
            )
        })?
}
