//! 市场配置：清单端点与验签公钥。
//!
//! 写在 `tauri.conf.json` 的 `plugins.market` 里：
//!
//! ```jsonc
//! "plugins": {
//!   "market": {
//!     "endpoints": ["https://…/plugin-catalog.json"],
//!     "pubkey": "……"        // `tauri signer generate` 的公钥（与应用自更新同一套密钥体系）
//!   }
//! }
//! ```
//!
//! **空 `endpoints` = 市场整体关闭**：不发任何请求、界面不留痕迹。这条约定与应用自更新
//! （`selfupdate.rs`）完全一致，前端按同一个范式判断要不要启动整条流程。
//!
//! 公钥**故意与 `plugins.updater.pubkey` 分开写**：两者现在填的是同一把密钥，但字段独立，
//! 将来要单独轮换插件市场的密钥时只改这一处，不会牵动应用自更新。

use serde_json::Value;
use tauri::AppHandle;

/// 从 `plugins.market` 读出来的配置。
///
/// 解析刻意**不报错** —— 配置写坏时退化成「没配」，即功能关闭。这与
/// `selfupdate.rs::endpoints_from_updater_config` 的选择一致：市场是可选功能，
/// 配置有问题就不出现，而不是让应用起不来或者弹一堆错。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarketConfig {
    /// 清单地址，按顺序尝试。空表 = 关闭。
    pub endpoints: Vec<String>,
    /// 验签公钥（base64）。空串 = 没配。
    pub pubkey: String,
}

impl MarketConfig {
    pub fn from_value(value: Option<&Value>) -> Self {
        let Some(value) = value else {
            return Self::default();
        };

        Self {
            endpoints: string_list(value.get("endpoints")),
            pubkey: value
                .get("pubkey")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
        }
    }

    /// 市场是否可用。
    ///
    /// 端点与公钥**缺一不可**：有端点没公钥的话，清单拿回来也验不了签，装了等于不设防 ——
    /// 那种状态下必须当作关闭，而不是「凑合能跑」。
    pub fn is_enabled(&self) -> bool {
        !self.endpoints.is_empty() && !self.pubkey.is_empty()
    }

    /// 实际要请求的清单地址。`None` = 功能关闭。
    pub fn catalog_endpoint(&self) -> Option<&str> {
        if !self.is_enabled() {
            return None;
        }
        self.endpoints.first().map(String::as_str)
    }
}

/// 抠出一个字符串数组，顺手丢掉空白项与非字符串项。
///
/// 写错一个条目不该让整份配置作废：好的那些仍然算数（与 `selfupdate.rs` 的处理一致）。
fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 当前生效的市场配置（读的是 `tauri.conf.json` 里那份）。
pub fn configured(app: &AppHandle) -> MarketConfig {
    MarketConfig::from_value(app.config().plugins.0.get("market"))
}

/// 给前端看：清单地址。`null` = 市场关闭，前端不显示任何相关界面。
#[tauri::command]
pub fn plugins_market_endpoint(app: AppHandle) -> Option<String> {
    configured(&app).catalog_endpoint().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> MarketConfig {
        MarketConfig::from_value(Some(&value))
    }

    #[test]
    fn missing_or_empty_config_means_disabled() {
        assert!(!MarketConfig::from_value(None).is_enabled());
        assert!(!config(json!({})).is_enabled());
        assert!(!config(json!({ "endpoints": [] })).is_enabled());
        assert!(!config(json!({ "endpoints": ["   "] })).is_enabled());
    }

    #[test]
    fn endpoints_without_a_pubkey_stay_disabled() {
        // 关键一条：有清单地址、但没有公钥 —— 拿回来也验不了签，等于不设防。
        let only_endpoint = config(json!({ "endpoints": ["https://example.com/plugin-catalog.json"] }));
        assert!(!only_endpoint.is_enabled(), "没公钥就不能算启用");
        assert_eq!(only_endpoint.catalog_endpoint(), None);

        let blank_pubkey = config(json!({
            "endpoints": ["https://example.com/plugin-catalog.json"],
            "pubkey": "   "
        }));
        assert!(!blank_pubkey.is_enabled());
    }

    #[test]
    fn reads_endpoint_and_pubkey() {
        let parsed = config(json!({
            "endpoints": ["  https://example.com/plugin-catalog.json  "],
            "pubkey": "  RWQabc  "
        }));

        assert_eq!(parsed.endpoints, vec!["https://example.com/plugin-catalog.json"]);
        assert_eq!(parsed.pubkey, "RWQabc", "两端空白要去掉");
        assert!(parsed.is_enabled());
        assert_eq!(parsed.catalog_endpoint(), Some("https://example.com/plugin-catalog.json"));
    }

    #[test]
    fn takes_the_first_endpoint_as_the_catalog() {
        // 多端点 = 备用地址，现阶段只请求第一个。
        let parsed = config(json!({
            "endpoints": ["https://a.example.com/c.json", "https://b.example.com/c.json"],
            "pubkey": "K"
        }));
        assert_eq!(parsed.catalog_endpoint(), Some("https://a.example.com/c.json"));
    }

    #[test]
    fn malformed_entries_are_ignored_rather_than_fatal() {
        assert!(!config(json!({ "endpoints": "https://x/y", "pubkey": "K" })).is_enabled());
        assert!(!config(json!({ "endpoints": [1, 2], "pubkey": "K" })).is_enabled());

        let mixed = config(json!({
            "endpoints": [1, "https://ok/c.json"],
            "pubkey": "K"
        }));
        assert!(mixed.is_enabled(), "混着坏条目时，好的那些仍然算数");
        assert_eq!(mixed.catalog_endpoint(), Some("https://ok/c.json"));

        // pubkey 类型写错（对象）→ 当没配。
        assert!(!config(json!({ "endpoints": ["https://ok/c.json"], "pubkey": { "a": 1 } })).is_enabled());
    }
}
