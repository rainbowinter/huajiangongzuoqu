//! 应用自更新的端点开关。
//!
//! 走 Tauri 官方的 `tauri-plugin-updater`：它去读一个静态的 `latest.json`
//! （`{ version, notes, pub_date, platforms: { "windows-x86_64": { url, signature } } }`），
//! 比对版本、下载、校验签名、安装、重启。服务器端只要能发这个 JSON 就行 ——
//! GitHub Release、任意静态托管都可以。
//!
//! **为什么单独有这个模块**：端点写在 `tauri.conf.json` 的
//! `plugins.updater.endpoints` 里，而那个数组**默认为空**。空 = 这个功能整体关闭：
//! 不发任何请求、界面上不出现任何东西、也不会因为查不通而弹错。前端靠 `update_endpoint`
//! 这个命令来判断要不要启动整条流程（见 `src/features/update/useUpdate.ts`）。
//!
//! 等发布仓库建好之后，把端点填进那个数组即可：
//!
//! ```jsonc
//! "plugins": {
//!   "updater": {
//!     "endpoints": ["https://github.com/<用户名>/<仓库>/releases/latest/download/latest.json"],
//!     "pubkey": "……"   // `tauri signer generate` 生成的公钥
//!   }
//! }
//! ```
//!
//! 调试时不想改配置文件，可以在**构建期**用 `TAURI_CONFIG` 覆盖它（Tauri 的构建脚本会把它
//! 合并进配置），例如指向本地的一个静态目录 —— 端到端验证就是这么做的。
//!
//! 换端点**不会**降低安全性：下载下来的安装包必须通过签名校验，签名对不上直接拒绝安装
//! （updater 插件里这是强制的，关不掉）。私钥在打包时通过 `TAURI_SIGNING_PRIVATE_KEY` 提供。
//!
//! > 别和 `updater/` 混了：那个是上游自带的、**已停用**的一整套更新器实现（当年指向上游
//! > 仓库，走完会把上游代码装进来覆盖本仓库的改动）。本模块只服务于官方插件的端点开关。

use serde_json::Value;
use tauri::AppHandle;

/// 从 updater 插件的配置里抠出端点列表。
///
/// 形如 `{ "endpoints": ["https://…"], "pubkey": "…" }`。任何一层对不上都返回空表 ——
/// 空表就是「功能关闭」，这是最安全的兜底，不需要额外报错。
fn endpoints_from_updater_config(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|config| config.get("endpoints"))
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

/// 当前生效的更新端点（读的是 `tauri.conf.json` 里那份，与插件实际用的一致）。
pub fn configured_endpoints(app: &AppHandle) -> Vec<String> {
    endpoints_from_updater_config(app.config().plugins.0.get("updater"))
}

/// 给前端看：有没有配端点。
///
/// 返回 `null` 表示**没配**，前端据此完全不启动更新流程 —— 不发请求、界面不留痕迹。
#[tauri::command]
pub fn update_endpoint(app: AppHandle) -> Option<String> {
    configured_endpoints(&app).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_updater_config_means_disabled() {
        assert!(endpoints_from_updater_config(None).is_empty());
        assert!(endpoints_from_updater_config(Some(&json!({}))).is_empty());
    }

    #[test]
    fn missing_or_empty_endpoints_mean_disabled() {
        // 默认就是这一种：配置里有 updater 段（放公钥），但端点留空 → 功能关闭。
        assert!(endpoints_from_updater_config(Some(&json!({ "pubkey": "abc" }))).is_empty());
        assert!(endpoints_from_updater_config(Some(&json!({ "endpoints": [] }))).is_empty());
        // 只有空白字符的条目也不算数 —— 不能拿它去发请求。
        assert!(
            endpoints_from_updater_config(Some(&json!({ "endpoints": ["   "] }))).is_empty(),
            "空白端点等于没配"
        );
    }

    #[test]
    fn reads_and_trims_configured_endpoints() {
        let config = json!({
            "endpoints": ["  https://example.com/latest.json  ", "https://backup.example.com/latest.json"],
            "pubkey": "abc"
        });

        assert_eq!(
            endpoints_from_updater_config(Some(&config)),
            vec![
                "https://example.com/latest.json".to_string(),
                "https://backup.example.com/latest.json".to_string()
            ]
        );
    }

    #[test]
    fn malformed_endpoints_are_ignored_rather_than_fatal() {
        // 类型写错（对象、数字）不该让应用起不来，也不该变出一个假的端点。
        assert!(endpoints_from_updater_config(Some(&json!({ "endpoints": "https://x/y" }))).is_empty());
        assert!(endpoints_from_updater_config(Some(&json!({ "endpoints": [1, 2] }))).is_empty());
        assert_eq!(
            endpoints_from_updater_config(Some(&json!({ "endpoints": [1, "https://ok/latest.json"] }))),
            vec!["https://ok/latest.json".to_string()],
            "混着坏条目时，好的那些仍然算数"
        );
    }
}
