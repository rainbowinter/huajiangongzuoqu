//! 记住「上一份清单是第几版」，用来挡**回滚攻击**。
//!
//! ## 签名挡不住什么
//!
//! 签名保证清单确实出自私钥持有者，但它**不保证这是最新的一份**。能控制端点（或能
//! 中间人）的对手可以把**昨天那份真的、签过名的清单**再放回去：内容完全合法，验签也过。
//! 于是用户看到的是一个更旧的插件列表，装下去的是有已知问题的旧版本。
//!
//! 对策很朴素：清单里的 `catalogVersion` 必须**单调递增**，比上次见到的小就拒绝。
//!
//! ## 换端点时不能沿用旧记录
//!
//! 记录里连**端点**一起存：换一个市场之后，它的版本号体系与新市场没有可比性。
//! 起点不一样就重新开始，否则换个市场就被自己的旧记录挡在门外。
//!
//! 记录写在 `<data_dir>/plugin-market.json`，很小的一份。**只在验签通过之后才写** ——
//! 拿一份没验过签的清单去推进水位，等于把防回滚交给了攻击者。

use super::super::errors::app_error;
use super::super::paths::PluginPaths;
use crate::json_io::write_json_atomic;
use crate::services::notes::AppError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarketProgress {
    /// 这份版本号属于哪个端点。换端点即重新开始。
    pub endpoint: String,
    /// 见过的最高 `catalogVersion`。
    pub catalog_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_at: Option<DateTime<Utc>>,
}

/// 读记录。文件缺失、读不动、或内容坏掉都当作「没有记录」。
///
/// 坏掉的记录当成没有，是**刻意的**：这个文件的作用是挡回滚，而把所有用户挡在市场门外
/// 比放过一次回滚更糟。真正要紧的那道防线是验签。
pub fn load(path: &std::path::Path) -> Option<MarketProgress> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 这份清单能不能接受。
///
/// * 没有记录 → 接受（第一次用市场，或者换了个端点）；
/// * 记录属于**别的端点** → 接受（两个市场的版本号体系没有可比性）；
/// * 记录是同一个端点，版本**更低** → 拒绝；
/// * 相同或更高 → 接受（相同是常态：用户反复打开市场 tab）。
pub fn accept(
    current: Option<&MarketProgress>,
    endpoint: &str,
    catalog_version: u64,
) -> Result<(), AppError> {
    let Some(current) = current else {
        return Ok(());
    };
    if current.endpoint != endpoint {
        return Ok(());
    }
    if catalog_version < current.catalog_version {
        return Err(app_error(
            "marketCatalogRolledBack",
            format!(
                "插件清单的版本比上次见到的还旧（这次 {}，上次 {}）—— 可能有人在拿旧清单顶替，已停止更新",
                catalog_version, current.catalog_version
            ),
        ));
    }
    Ok(())
}

/// 验收并在通过之后把水位抬上去。
///
/// 顺序不能反：**先判后写**。先写的话，一份被拒绝的旧清单也已经把水位拉低了，
/// 下次再拿到真的新清单反而会被自己的记录挡下。
pub fn accept_and_record(
    paths: &PluginPaths,
    endpoint: &str,
    catalog_version: u64,
) -> Result<(), AppError> {
    let current = load(&paths.market_progress_path);
    accept(current.as_ref(), endpoint, catalog_version)?;

    // 版本相同就别写盘了 —— 用户每打开一次市场 tab 都会走到这里。
    if let Some(current) = &current {
        if current.endpoint == endpoint && current.catalog_version == catalog_version {
            return Ok(());
        }
    }

    write_json_atomic(
        &paths.market_progress_path,
        &MarketProgress {
            endpoint: endpoint.to_string(),
            catalog_version,
            seen_at: Some(Utc::now()),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn progress(endpoint: &str, version: u64) -> MarketProgress {
        MarketProgress {
            endpoint: endpoint.to_string(),
            catalog_version: version,
            seen_at: None,
        }
    }

    fn temp_paths(tag: &str) -> (PluginPaths, PathBuf) {
        let mut root = std::env::temp_dir();
        root.push(format!("floral-market-progress-{tag}-{}", uuid::Uuid::new_v4()));
        let paths = PluginPaths::from_data_dir(&root);
        paths.ensure_dirs().expect("ensure dirs");
        (paths, root)
    }

    #[test]
    fn the_first_catalog_is_always_accepted() {
        assert!(accept(None, "https://example.com/c.json", 1).is_ok());
        assert!(accept(None, "https://example.com/c.json", 99).is_ok());
    }

    #[test]
    fn the_same_or_a_newer_version_is_accepted() {
        let current = progress("https://example.com/c.json", 7);
        assert!(accept(Some(&current), "https://example.com/c.json", 7).is_ok());
        assert!(accept(Some(&current), "https://example.com/c.json", 8).is_ok());
    }

    #[test]
    fn an_older_version_is_rejected() {
        // 这就是回滚攻击：内容是签过名的真清单，只是旧的。
        let current = progress("https://example.com/c.json", 7);
        let error = accept(Some(&current), "https://example.com/c.json", 6).unwrap_err();

        assert_eq!(error.code, "marketCatalogRolledBack");
        assert!(error.message.contains("旧"));
    }

    #[test]
    fn switching_endpoints_starts_over() {
        // 换了市场，两边的版本号没有可比性 —— 否则换个市场就被自己的旧记录挡在门外。
        let current = progress("https://old.example.com/c.json", 900);
        assert!(accept(Some(&current), "https://new.example.com/c.json", 1).is_ok());
    }

    #[test]
    fn records_survive_a_roundtrip_and_move_forward() {
        let (paths, root) = temp_paths("roundtrip");
        let endpoint = "https://example.com/c.json";

        accept_and_record(&paths, endpoint, 3).unwrap();
        assert_eq!(load(&paths.market_progress_path).unwrap().catalog_version, 3);

        accept_and_record(&paths, endpoint, 5).unwrap();
        assert_eq!(load(&paths.market_progress_path).unwrap().catalog_version, 5);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_rejected_catalog_does_not_lower_the_watermark() {
        // 顺序反了就会出现这个 bug：一份被拒绝的旧清单把水位拉低，下次真的新清单反而被挡。
        let (paths, root) = temp_paths("watermark");
        let endpoint = "https://example.com/c.json";
        accept_and_record(&paths, endpoint, 9).unwrap();

        assert!(accept_and_record(&paths, endpoint, 4).is_err());
        assert_eq!(
            load(&paths.market_progress_path).unwrap().catalog_version,
            9,
            "被拒绝的清单一个字都不该写进去"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_corrupt_record_does_not_lock_the_user_out() {
        // 这个文件坏了就当没有：把所有用户挡在市场门外比放过一次回滚更糟。
        let (paths, root) = temp_paths("corrupt");
        fs::write(&paths.market_progress_path, "not json").unwrap();

        assert!(load(&paths.market_progress_path).is_none());
        assert!(accept_and_record(&paths, "https://example.com/c.json", 1).is_ok());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn missing_file_reads_as_no_record() {
        let (paths, root) = temp_paths("missing");
        assert!(load(&paths.market_progress_path).is_none());
        fs::remove_dir_all(root).ok();
    }
}
