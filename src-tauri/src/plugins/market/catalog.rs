//! 市场清单（`plugin-catalog.json`）的解析与筛选。
//!
//! 清单是**已验签**的 JSON（验签在 `fetch_catalog` 里，`verify.rs` 提供配方）。
//! 这个文件里除 `fetch_catalog` 外都是纯函数：不碰网络、不碰磁盘，好测。
//!
//! ## 清单长什么样
//!
//! ```jsonc
//! {
//!   "schema": 1,                       // 清单格式版本；应用不认识的版本会报错而不是硬解
//!   "catalogVersion": 7,               // 单调递增，防回滚用（见 `Docs/plugin-market.md`）
//!   "generatedAt": "2026-10-15T12:00:00Z",
//!   "plugins": [
//!     {
//!       "name": "pdf-viewer",          // **目录名就是规范标识**，与本地插件同一条规矩
//!       "description": "…",
//!       "author": "…",
//!       "homepage": "…",
//!       "releases": [
//!         {
//!           "version": "1.0.0",
//!           "apiVersion": 2,
//!           "minAppVersion": "2.0.2",  // 可选：这个版本要求的最低应用版本
//!           "url": "https://…/pdf-viewer-1.0.0.zip",
//!           "sha256": "…64 位十六进制…",
//!           "size": 1234567,           // 可选：zip 字节数，仅用于显示与预检
//!           "permissions": ["fs:read"],// 仅供参考：**真值以 zip 里的 plugin.json 为准**
//!           "publishedAt": "…",
//!           "notes": "…"
//!         }
//!       ]
//!     }
//!   ]
//! }
//! ```
//!
//! ## 两条设计取向
//!
//! 1. **不兼容的版本照样列出来，只是带着 `blocked` 原因**，而不是删掉。删掉会让用户
//!    以为市场里没有这个东西，或者以为市场坏了。这与本地插件那边「损坏的插件也要出现在
//!    列表里并给出理由」是同一条取向。
//! 2. **一处写坏只影响那一条**。某个 release 少了 `sha256`，不该让整份清单解析失败 ——
//!    否则一个手滑的作者就能把所有人的市场打瘫。整份清单级别的失败只留给「JSON 不是 JSON」
//!    和「schema 版本我不认识」这两种。
//!
//! ## 为什么 `catalogVersion` 在 JSON 里，而不是签名的 trusted comment 里
//!
//! 原计划想把版本号放进 minisign 的 trusted comment。**做不到**：`tauri signer sign`
//! 自己写那段注释（`timestamp:… file:…`），没有留给我们塞自定义内容的口子，除非手工拼签名。
//! 而清单正文本来就整段被签名覆盖 —— 放在 JSON 里同样可信，还少一层解析。所以：
//! `catalogVersion` 读自**已验证签名**的 JSON，旁边记一句「它可信是因为验签已经过了」。

use super::super::errors::{app_error, with_detail};
use super::super::paths::validate_plugin_name;
use super::super::sync::{version_is_comparable, version_is_newer};
use super::verify::verify_signed;
use crate::services::notes::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::time::Duration;

/// 我们认识的清单格式版本。
pub const CATALOG_SCHEMA: u32 = 1;

/// 清单正文的大小上限。清单只是文本，几 MB 已经离谱了。
const MAX_CATALOG_BYTES: u64 = 4 * 1024 * 1024;
/// `.sig` 的大小上限。
const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;
/// 单次请求的超时（连接与整体）。市场不该把界面卡在那里等。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const USER_AGENT: &str = "floral-notepaper-plugin-market";

/// 市场跑在什么环境里 —— 用来判断某个 release 在这里能不能装。
#[derive(Debug, Clone)]
pub struct HostEnv {
    /// 宿主支持的插件 API 版本上限（`CURRENT_API_VERSION`）。
    pub api_version: u32,
    /// 应用自己的版本号，用于 `minAppVersion`。
    pub app_version: String,
}

/// 解析并筛好的一份清单。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalog {
    pub schema: u32,
    /// 单调递增。**只有验签通过之后它才可信。**
    pub catalog_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    pub plugins: Vec<CatalogPlugin>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// 版本**从新到旧**（宿主排的，不信清单里的顺序）。
    pub releases: Vec<CatalogRelease>,
    /// 整个插件都不能动的原因（名称非法、一个版本都没有……）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
    /// 默认要装的那一版 = 最新的**可装**版。`None` = 没有可装的版本。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// 最新的版本号（不论能不能装），仅用于区分「太旧」与「太新」两种情形。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub newest_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRelease {
    pub version: String,
    pub api_version: u32,
    pub url: String,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub permissions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    /// 不能装的原因码；`None` = 可以装。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

// ---------------------------------------------------------------------------
// 磁盘格式（宽松）
//
// 全部字段都是可选：缺一个字段只让那一条不可装，不让整份清单作废。真正的「必填」由下面
// 的 `blocked` 判定表达 —— 那样用户能看到「这个版本没写 sha256」，而不是「市场打不开」。
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCatalog {
    schema: Option<u32>,
    catalog_version: Option<u64>,
    generated_at: Option<String>,
    /// ⚠️ 刻意是 `Value` 而不是 `RawPlugin`：serde 对结构体是**全有或全无**的，写成
    /// `Vec<RawPlugin>` 的话，数组里有一条类型不对，整份清单就会一起解析失败 —— 一个手滑的
    /// 作者能把所有人的市场打瘫。逐条 `from_value` 才能做到「只标坏那一条」。
    plugins: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlugin {
    name: Option<String>,
    description: Option<String>,
    author: Option<String>,
    homepage: Option<String>,
    /// 同上，逐条解析。
    releases: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRelease {
    version: Option<String>,
    api_version: Option<u32>,
    url: Option<String>,
    sha256: Option<String>,
    size: Option<u64>,
    permissions: Option<Vec<String>>,
    min_app_version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
}

/// 解析一份**已经验签通过**的清单正文。
pub fn parse_catalog(raw: &str, host: &HostEnv) -> Result<PluginCatalog, AppError> {
    let parsed: RawCatalog = serde_json::from_str(raw).map_err(|error| {
        with_detail(
            app_error("marketCatalogInvalid", format!("插件清单不是合法的 JSON：{error}")),
            "reason",
            error.to_string(),
        )
    })?;

    // 缺省按 1 处理（与 `apiVersion` 缺省为 1 同一条规矩），显式写了别的就不认。
    let schema = parsed.schema.unwrap_or(CATALOG_SCHEMA);
    if schema != CATALOG_SCHEMA {
        return Err(if schema > CATALOG_SCHEMA {
            app_error(
                "marketCatalogTooNew",
                format!("这份插件清单是更新的格式（schema {schema}），当前应用只认到 {CATALOG_SCHEMA}，请先更新应用"),
            )
        } else {
            app_error(
                "marketCatalogTooOld",
                format!("这份插件清单的格式过旧（schema {schema}）"),
            )
        });
    }

    // 防回滚的锚点，必须有。缺失时给 0 会让「比大小」永远通过，所以直接判非法。
    let catalog_version = parsed.catalog_version.unwrap_or(0);
    if catalog_version == 0 {
        return Err(app_error(
            "marketCatalogVersionInvalid",
            "插件清单缺少有效的 catalogVersion",
        ));
    }

    let mut plugins = Vec::new();
    let mut seen_names: HashSet<String> = HashSet::new();

    for raw_plugin in parsed.plugins.unwrap_or_default() {
        let plugin = match serde_json::from_value::<RawPlugin>(raw_plugin) {
            Ok(raw) => build_plugin(raw, host, &mut seen_names),
            Err(_) => malformed_plugin(),
        };
        plugins.push(plugin);
    }

    plugins.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(PluginCatalog {
        schema,
        catalog_version,
        generated_at: non_empty(parsed.generated_at),
        plugins,
    })
}

fn build_plugin(
    raw: RawPlugin,
    host: &HostEnv,
    seen_names: &mut HashSet<String>,
) -> CatalogPlugin {
    let name = raw.name.unwrap_or_default();
    let mut blocked = None;

    if let Err(error) = validate_plugin_name(&name) {
        blocked = Some(error.code);
    } else if !seen_names.insert(name.clone()) {
        // 同名两个插件 → 谁也不知道该装哪个。只挡后一条，前一条照常可用。
        blocked = Some("marketPluginNameDuplicate".to_string());
    }

    // 名称定不下来时目录位置就不确定，后面的 release 判定没有意义。
    let name_usable = blocked.is_none();

    let mut releases: Vec<CatalogRelease> = raw
        .releases
        .unwrap_or_default()
        .into_iter()
        .map(|value| match serde_json::from_value::<RawRelease>(value) {
            Ok(raw) => build_release(raw, host, name_usable),
            Err(_) => malformed_release(),
        })
        .collect();

    sort_releases_newest_first(&mut releases);
    block_duplicate_versions(&mut releases);

    let latest = releases
        .iter()
        .find(|release| release.blocked.is_none() && name_usable)
        .map(|release| release.version.clone());

    if blocked.is_none() && releases.is_empty() {
        blocked = Some("marketPluginNoReleases".to_string());
    }

    CatalogPlugin {
        newest_version: releases.first().map(|release| release.version.clone()),
        name,
        description: raw.description.unwrap_or_default(),
        author: non_empty(raw.author),
        homepage: non_empty(raw.homepage),
        latest,
        releases,
        blocked,
    }
}

fn build_release(raw: RawRelease, host: &HostEnv, name_usable: bool) -> CatalogRelease {
    let version = raw.version.unwrap_or_default();
    let url = raw.url.unwrap_or_default();
    let sha256 = normalize_sha256(&raw.sha256.unwrap_or_default()).unwrap_or_default();
    let api_version = raw.api_version.unwrap_or(0);

    // 判定的顺序即优先级：先看这一条自己写全了没有，再看它跟宿主合不合得来。
    let blocked = if !name_usable {
        // 插件名就不合法，具体原因挂在外层。
        Some("marketPluginNameInvalid".to_string())
    } else if version.trim().is_empty() {
        Some("marketReleaseMissingVersion".to_string())
    } else if !version_is_comparable(&version) {
        // 版本号拆不出数字段就没法比大小，也就没法做「更新」判断。宁可拒绝。
        // 判据用的就是版本校正那个解析器 —— 两处规则一致，才不会出现「市场能装、
        // 校正比不了」。
        Some("marketReleaseVersionInvalid".to_string())
    } else if url.trim().is_empty() {
        Some("marketReleaseMissingUrl".to_string())
    } else if !release_url_is_allowed(&url) {
        Some("marketReleaseUrlInvalid".to_string())
    } else if sha256.is_empty() {
        Some("marketReleaseSha256Invalid".to_string())
    } else if api_version < 2 {
        // v1 在主线程 `new Function` 里跑，没有沙箱。来自网络的代码必须是 v2。
        Some(format!("marketReleaseNoSandbox:{api_version}"))
    } else if api_version > host.api_version {
        Some(format!("marketReleaseApiTooNew:{api_version}"))
    } else if let Some(required) = raw
        .min_app_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if version_is_newer(required, &host.app_version) {
            Some(format!("marketReleaseAppTooOld:{required}"))
        } else {
            None
        }
    } else {
        None
    };

    CatalogRelease {
        version,
        api_version,
        url,
        sha256,
        size: raw.size.filter(|size| *size > 0),
        permissions: raw.permissions.unwrap_or_default(),
        min_app_version: non_empty(raw.min_app_version),
        notes: non_empty(raw.notes),
        published_at: non_empty(raw.published_at),
        blocked,
    }
}

/// 清单里那一条根本不是插件对象。
///
/// 单独造一条而不是跳过：跳过的结果就是「市场里没有这个插件」，用户和作者都看不出哪里坏了。
/// 名称是空的，界面那边按「无法识别的一条」显示。
fn malformed_plugin() -> CatalogPlugin {
    CatalogPlugin {
        name: String::new(),
        description: String::new(),
        author: None,
        homepage: None,
        releases: Vec::new(),
        blocked: Some("marketPluginMalformed".to_string()),
        latest: None,
        newest_version: None,
    }
}

/// 插件里某一版不是对象。
fn malformed_release() -> CatalogRelease {
    CatalogRelease {
        version: String::new(),
        api_version: 0,
        url: String::new(),
        sha256: String::new(),
        size: None,
        permissions: Vec::new(),
        min_app_version: None,
        notes: None,
        published_at: None,
        blocked: Some("marketReleaseMalformed".to_string()),
    }
}

/// 从新到旧排。比不出来的（按上面的判定其实已经被 `blocked` 挡掉了）稳定留在原位。
fn sort_releases_newest_first(releases: &mut [CatalogRelease]) {
    releases.sort_by(|a, b| {
        if version_is_newer(&a.version, &b.version) {
            std::cmp::Ordering::Less
        } else if version_is_newer(&b.version, &a.version) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
}

/// 同一个版本号出现两次且内容不同 → 该信谁？只保第一个（最新的那份），后面的标出来。
fn block_duplicate_versions(releases: &mut [CatalogRelease]) {
    let mut seen: HashSet<String> = HashSet::new();
    for release in releases.iter_mut() {
        if !seen.insert(release.version.clone()) && release.blocked.is_none() {
            release.blocked = Some("marketReleaseVersionDuplicate".to_string());
        }
    }
}

/// zip 的下载地址是否可接受。
///
/// **只认 https**，例外是回环地址的 http（本地端到端测试要用）。内容本身还有 sha256
/// 兜底，所以这一条是纵深防御而不是唯一防线 —— 但它把「不小心写了个明文地址」挡在
/// 清单阶段，而不是等下载完了才发现。
pub fn release_url_is_allowed(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url.trim()) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };

    match parsed.scheme() {
        "https" => true,
        "http" => is_loopback_host(host),
        _ => false,
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// sha256 必须是 64 位十六进制；统一转小写，方便后面直接比。
pub fn normalize_sha256(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

// ---------------------------------------------------------------------------
// 取回（这一步才碰网络）
// ---------------------------------------------------------------------------

/// 把端点上的清单取回来、验签、解析。
///
/// **先验签再解析**：解析器面对的是不可信输入，虽然它本身也不该被喂坏 JSON 弄崩，但把
/// 验证放在前面，语义上就少一整类「解析器 bug 即漏洞」的可能。
pub fn fetch_catalog(endpoint: &str, pubkey: &str, host: &HostEnv) -> Result<PluginCatalog, AppError> {
    if reqwest::Url::parse(endpoint).is_err() {
        return Err(with_detail(
            app_error("marketEndpointInvalid", format!("清单地址不合法：{endpoint}")),
            "endpoint",
            endpoint.to_string(),
        ));
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| app_error("marketClientFailed", format!("创建网络客户端失败：{error}")))?;

    let body = get_capped(&client, endpoint, MAX_CATALOG_BYTES)?;
    let signature_url = format!("{endpoint}.sig");
    let signature = get_capped(&client, &signature_url, MAX_SIGNATURE_BYTES)?;
    let signature = String::from_utf8(signature)
        .map_err(|_| app_error("marketSignatureInvalid", "签名不是文本".to_string()))?;

    // 清单正文与签名对上号之前，一个字节都不许往下走。
    verify_signed(&body, &signature, pubkey)?;

    let text = String::from_utf8(body)
        .map_err(|_| app_error("marketCatalogInvalid", "插件清单不是 UTF-8 文本".to_string()))?;

    parse_catalog(&text, host)
}

/// 下载并限制大小：`Read::take` 比 `Content-Length` 可靠 —— 后者可以撒谎或者干脆没有。
fn get_capped(
    client: &reqwest::blocking::Client,
    url: &str,
    limit: u64,
) -> Result<Vec<u8>, AppError> {
    let response = client
        .get(url)
        .send()
        .map_err(|error| request_error(url, &error))?;

    let status = response.status();
    if !status.is_success() {
        return Err(with_detail(
            app_error(
                "marketRequestFailed",
                format!("请求 {url} 失败：HTTP {status}"),
            ),
            "status",
            status.as_u16().to_string(),
        ));
    }

    let mut buffer = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| request_error(url, &error))?;

    if buffer.len() as u64 > limit {
        return Err(with_detail(
            app_error(
                "marketResponseTooLarge",
                format!("{url} 的响应超过上限 {limit} 字节"),
            ),
            "url",
            url.to_string(),
        ));
    }

    Ok(buffer)
}

/// `send` 报的是 `reqwest::Error`，读 body 报的是 `std::io::Error` —— 两者都要能包进来。
fn request_error(url: &str, error: &impl std::fmt::Display) -> AppError {
    with_detail(
        app_error("marketRequestFailed", format!("请求 {url} 失败：{error}")),
        "url",
        url.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::manifest::CURRENT_API_VERSION;

    fn host() -> HostEnv {
        HostEnv {
            api_version: CURRENT_API_VERSION,
            app_version: "2.0.1".to_string(),
        }
    }

    fn catalog_json(plugins: &str) -> String {
        format!(
            r#"{{ "schema": 1, "catalogVersion": 3, "generatedAt": "2026-10-15T00:00:00Z", "plugins": [{plugins}] }}"#
        )
    }

    fn one_release(json: &str) -> CatalogPlugin {
        let catalog = parse_catalog(&catalog_json(json), &host()).expect("清单应当解析成功");
        catalog.plugins.into_iter().next().expect("应当有一个插件")
    }

    fn valid_release() -> String {
        r#"{
            "name": "demo",
            "description": "示例",
            "releases": [{
                "version": "1.0.0",
                "apiVersion": 2,
                "url": "https://example.com/demo-1.0.0.zip",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }]
        }"#
        .to_string()
    }

    #[test]
    fn parses_a_minimal_catalog() {
        let catalog = parse_catalog(&catalog_json(""), &host()).expect("空清单也应能解析");

        assert_eq!(catalog.schema, CATALOG_SCHEMA);
        assert_eq!(catalog.catalog_version, 3);
        assert_eq!(catalog.generated_at.as_deref(), Some("2026-10-15T00:00:00Z"));
        assert!(catalog.plugins.is_empty());
    }

    #[test]
    fn rejects_broken_json_and_unknown_schemas() {
        assert_eq!(
            parse_catalog("{ not json", &host()).unwrap_err().code,
            "marketCatalogInvalid"
        );

        // 更新的格式：得让用户去更新应用，不能硬着头皮解。
        let too_new = r#"{ "schema": 2, "catalogVersion": 1, "plugins": [] }"#;
        assert_eq!(
            parse_catalog(too_new, &host()).unwrap_err().code,
            "marketCatalogTooNew"
        );

        let too_old = r#"{ "schema": 0, "catalogVersion": 1, "plugins": [] }"#;
        assert_eq!(
            parse_catalog(too_old, &host()).unwrap_err().code,
            "marketCatalogTooOld"
        );
    }

    #[test]
    fn requires_a_catalog_version() {
        // 没有版本号就没法防回滚，整份不认。
        for raw in [
            r#"{ "schema": 1, "plugins": [] }"#,
            r#"{ "schema": 1, "catalogVersion": 0, "plugins": [] }"#,
        ] {
            assert_eq!(
                parse_catalog(raw, &host()).unwrap_err().code,
                "marketCatalogVersionInvalid"
            );
        }
    }

    #[test]
    fn accepts_a_well_formed_plugin() {
        let plugin = one_release(&valid_release());

        assert_eq!(plugin.name, "demo");
        assert_eq!(plugin.blocked, None);
        assert_eq!(plugin.latest.as_deref(), Some("1.0.0"));
        assert_eq!(plugin.releases.len(), 1);
        assert_eq!(plugin.releases[0].blocked, None);
    }

    #[test]
    fn blocks_an_invalid_plugin_name_instead_of_dropping_it() {
        // 名称同时是目录名，必须严格。但**不能悄悄不显示**。
        let plugin = one_release(
            r#"{ "name": "../escape", "releases": [{ "version": "1.0.0", "apiVersion": 2,
                 "url": "https://example.com/a.zip",
                 "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
        );

        assert_eq!(plugin.blocked.as_deref(), Some("pluginNameInvalid"));
        assert_eq!(plugin.latest, None, "名称不合法就不该有可装版本");
        assert_eq!(plugin.releases.len(), 1, "版本仍要列出来，不能凭空消失");
    }

    #[test]
    fn duplicate_plugin_names_block_only_the_later_one() {
        let raw = catalog_json(&format!("{},{}", valid_release(), valid_release()));
        let catalog = parse_catalog(&raw, &host()).expect("应能解析");

        assert_eq!(catalog.plugins.len(), 2);
        assert_eq!(catalog.plugins[0].blocked, None);
        assert_eq!(
            catalog.plugins[1].blocked.as_deref(),
            Some("marketPluginNameDuplicate")
        );
    }

    #[test]
    fn release_without_releases_is_blocked() {
        let plugin = one_release(r#"{ "name": "demo", "releases": [] }"#);
        assert_eq!(plugin.blocked.as_deref(), Some("marketPluginNoReleases"));
        assert_eq!(plugin.latest, None);
    }

    #[test]
    fn blocks_releases_with_missing_fields() {
        let cases = [
            (
                r#"{ "name": "demo", "releases": [{ "apiVersion": 2, "url": "https://e.com/a.zip",
                     "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
                "marketReleaseMissingVersion",
            ),
            (
                r#"{ "name": "demo", "releases": [{ "version": "1.0.0", "apiVersion": 2,
                     "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
                "marketReleaseMissingUrl",
            ),
            (
                r#"{ "name": "demo", "releases": [{ "version": "1.0.0", "apiVersion": 2,
                     "url": "https://e.com/a.zip" }] }"#,
                "marketReleaseSha256Invalid",
            ),
            (
                // sha256 长度不对（少一位）
                r#"{ "name": "demo", "releases": [{ "version": "1.0.0", "apiVersion": 2,
                     "url": "https://e.com/a.zip",
                     "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
                "marketReleaseSha256Invalid",
            ),
            (
                // 非十六进制字符
                r#"{ "name": "demo", "releases": [{ "version": "1.0.0", "apiVersion": 2,
                     "url": "https://e.com/a.zip",
                     "sha256": "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }] }"#,
                "marketReleaseSha256Invalid",
            ),
        ];

        for (json, expected) in cases {
            let plugin = one_release(json);
            assert_eq!(
                plugin.releases[0].blocked.as_deref(),
                Some(expected),
                "用例：{json}"
            );
            assert_eq!(plugin.latest, None, "被挡住的版本不能成为默认选择");
        }
    }

    #[test]
    fn blocks_unparsable_versions() {
        // 拆不出数字段就没法比大小，也就没法判断「有没有更新」。宁可拒绝。
        let plugin = one_release(
            r#"{ "name": "demo", "releases": [{ "version": "nightly", "apiVersion": 2,
                 "url": "https://e.com/a.zip",
                 "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
        );
        assert_eq!(
            plugin.releases[0].blocked.as_deref(),
            Some("marketReleaseVersionInvalid")
        );
    }

    #[test]
    fn only_https_and_loopback_http_are_allowed() {
        assert!(release_url_is_allowed("https://github.com/a/b/releases/download/x/a.zip"));
        assert!(release_url_is_allowed("http://127.0.0.1:8080/a.zip"), "本地测试要用");
        assert!(release_url_is_allowed("http://localhost:8080/a.zip"));

        assert!(!release_url_is_allowed("http://example.com/a.zip"), "明文外网地址不行");
        assert!(!release_url_is_allowed("file:///C:/a.zip"));
        assert!(!release_url_is_allowed("javascript:alert(1)"));
        assert!(!release_url_is_allowed("data:application/zip;base64,AAAA"));
        assert!(!release_url_is_allowed("/relative/a.zip"));
        assert!(!release_url_is_allowed(""));
    }

    #[test]
    fn blocks_v1_releases_from_the_network() {
        // v1 跑在主线程里，没有沙箱 —— 来自网络的代码必须 v2。
        let plugin = one_release(
            r#"{ "name": "demo", "releases": [{ "version": "1.0.0", "apiVersion": 1,
                 "url": "https://e.com/a.zip",
                 "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
        );
        assert_eq!(
            plugin.releases[0].blocked.as_deref(),
            Some("marketReleaseNoSandbox:1")
        );

        // apiVersion 干脆没写 → 按 v1 处理，同样挡住。
        let missing = one_release(
            r#"{ "name": "demo", "releases": [{ "version": "1.0.0",
                 "url": "https://e.com/a.zip",
                 "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
        );
        assert_eq!(
            missing.releases[0].blocked.as_deref(),
            Some("marketReleaseNoSandbox:0"),
            "缺 apiVersion 要按最坏的假设走"
        );
    }

    #[test]
    fn blocks_releases_for_a_newer_api() {
        let plugin = one_release(
            r#"{ "name": "demo", "releases": [{ "version": "1.0.0", "apiVersion": 99,
                 "url": "https://e.com/a.zip",
                 "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
        );
        assert_eq!(
            plugin.releases[0].blocked.as_deref(),
            Some("marketReleaseApiTooNew:99")
        );
    }

    #[test]
    fn blocks_releases_that_need_a_newer_app() {
        let plugin = one_release(
            r#"{ "name": "demo", "releases": [{ "version": "1.0.0", "apiVersion": 2,
                 "minAppVersion": "9.0.0",
                 "url": "https://e.com/a.zip",
                 "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
        );
        assert_eq!(
            plugin.releases[0].blocked.as_deref(),
            Some("marketReleaseAppTooOld:9.0.0")
        );

        // 要求比当前版本低 → 照常可装。
        let ok = one_release(
            r#"{ "name": "demo", "releases": [{ "version": "1.0.0", "apiVersion": 2,
                 "minAppVersion": "2.0.0",
                 "url": "https://e.com/a.zip",
                 "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }"#,
        );
        assert_eq!(ok.releases[0].blocked, None);
    }

    #[test]
    fn releases_are_sorted_newest_first_and_latest_skips_blocked_ones() {
        let plugin = one_release(
            r#"{ "name": "demo", "releases": [
                 { "version": "1.0.0", "apiVersion": 2, "url": "https://e.com/1.zip",
                   "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
                 { "version": "1.10.0", "apiVersion": 2, "url": "https://e.com/2.zip",
                   "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
                 { "version": "2.0.0", "apiVersion": 99, "url": "https://e.com/3.zip",
                   "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
                 { "version": "1.2.0", "apiVersion": 2, "url": "https://e.com/4.zip",
                   "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }
               ] }"#,
        );

        let versions: Vec<&str> = plugin.releases.iter().map(|r| r.version.as_str()).collect();
        assert_eq!(
            versions,
            vec!["2.0.0", "1.10.0", "1.2.0", "1.0.0"],
            "版本要从新到旧，且 1.10.0 比 1.2.0 新（按数字段比，不是按字符串）"
        );
        assert_eq!(plugin.newest_version.as_deref(), Some("2.0.0"));
        assert_eq!(
            plugin.latest.as_deref(),
            Some("1.10.0"),
            "最新的 2.0.0 装不了，默认要选最新**可装**的那一版"
        );
    }

    #[test]
    fn duplicate_versions_block_the_later_copy() {
        let plugin = one_release(
            r#"{ "name": "demo", "releases": [
                 { "version": "1.0.0", "apiVersion": 2, "url": "https://e.com/1.zip",
                   "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
                 { "version": "1.0.0", "apiVersion": 2, "url": "https://e.com/other.zip",
                   "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
               ] }"#,
        );

        assert_eq!(plugin.releases.len(), 2);
        assert_eq!(plugin.releases[0].blocked, None);
        assert_eq!(
            plugin.releases[1].blocked.as_deref(),
            Some("marketReleaseVersionDuplicate"),
            "同一版本两个出处，谁也不知道该信谁"
        );
    }

    #[test]
    fn one_broken_release_does_not_break_the_catalog() {
        // 手滑的作者不该把所有人的市场打瘫。
        let raw = catalog_json(
            r#"{ "name": "demo", "releases": [
                 { "version": "1.0.0" },
                 { "version": "1.1.0", "apiVersion": 2, "url": "https://e.com/a.zip",
                   "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
               ] },
               { "name": "other", "releases": [ "完全不是对象" ] }"#,
        );

        // `other` 那一条整个是错的类型 → 只说这一条坏，`demo` 照样能用。
        let catalog = parse_catalog(&raw, &host()).expect("一份清单里有坏条目不该整体失败");
        assert_eq!(catalog.plugins.len(), 2);

        let demo = catalog.plugins.iter().find(|p| p.name == "demo").unwrap();
        assert_eq!(demo.releases.len(), 2);
        assert_eq!(
            demo.releases[1].blocked.as_deref(),
            Some("marketReleaseMissingUrl")
        );
        assert_eq!(demo.latest.as_deref(), Some("1.1.0"));

        let other = catalog.plugins.iter().find(|p| p.name == "other").unwrap();
        assert_eq!(other.blocked, None, "插件本身是好的，坏的是里面那一版");
        assert_eq!(other.releases.len(), 1);
        assert_eq!(
            other.releases[0].blocked.as_deref(),
            Some("marketReleaseMalformed"),
            "不是对象的那一版要标出来，不能悄悄消失"
        );
    }

    #[test]
    fn normalizes_sha256_to_lowercase() {
        let upper = "A".repeat(64);
        assert_eq!(normalize_sha256(&upper).unwrap(), "a".repeat(64));
        assert_eq!(normalize_sha256("  aa  "), None, "长度不对就不认");
        assert_eq!(normalize_sha256(""), None);
    }

    #[test]
    fn plugins_are_sorted_by_name() {
        let raw = catalog_json(&format!(
            r#"{{ "name": "zebra", "releases": [] }},{{ "name": "alpha", "releases": [] }}"#
        ));
        let catalog = parse_catalog(&raw, &host()).unwrap();
        let names: Vec<&str> = catalog.plugins.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "zebra"]);
    }

    // ------------------------------------------------------------ 真起一个服务器取回来

    #[test]
    fn fetches_and_verifies_the_catalog_over_http() {
        use super::super::testkit::TestServer;

        let server = TestServer::start(vec![
            (
                "/plugin-catalog.json".to_string(),
                super::super::testkit::SIGNED_CATALOG.as_bytes().to_vec(),
            ),
            (
                "/plugin-catalog.json.sig".to_string(),
                super::super::testkit::CATALOG_SIGNATURE.as_bytes().to_vec(),
            ),
        ]);

        let pubkey = super::super::testkit::CATALOG_PUBKEY;
        let url = format!("{}/plugin-catalog.json", server.base);
        let catalog = fetch_catalog(&url, pubkey, &host()).expect("应当取回并验签通过");

        assert_eq!(catalog.schema, CATALOG_SCHEMA);
        assert_eq!(catalog.catalog_version, 1);
        assert_eq!(
            server.hits(),
            vec!["/plugin-catalog.json", "/plugin-catalog.json.sig"],
            "签名必须真的去取过 —— 少了那一步，验签就成了摆设"
        );
    }

    #[test]
    fn a_tampered_catalog_is_rejected_before_parsing() {
        use super::super::testkit::TestServer;

        // 正文被改了一个字节（`catalogVersion` 从 1 改成 9），签名还是那份。
        let tampered = super::super::testkit::SIGNED_CATALOG.replace(
            "\"catalogVersion\": 1",
            "\"catalogVersion\": 9",
        );
        let server = TestServer::start(vec![
            ("/c.json".to_string(), tampered.into_bytes()),
            (
                "/c.json.sig".to_string(),
                super::super::testkit::CATALOG_SIGNATURE.as_bytes().to_vec(),
            ),
        ]);

        let error = fetch_catalog(
            &format!("{}/c.json", server.base),
            super::super::testkit::CATALOG_PUBKEY,
            &host(),
        )
        .unwrap_err();

        assert_eq!(
            error.code, "marketSignatureInvalid",
            "验签不过要在这里就断掉，绝不能带着「版本 9」往下走"
        );
    }

    #[test]
    fn a_missing_signature_is_an_error_not_a_free_pass() {
        use super::super::testkit::TestServer;

        // 服务器上只有正文，没有 .sig。
        let server = TestServer::start(vec![(
            "/plugin-catalog.json".to_string(),
            super::super::testkit::SIGNED_CATALOG.as_bytes().to_vec(),
        )]);

        let error = fetch_catalog(
            &format!("{}/plugin-catalog.json", server.base),
            super::super::testkit::CATALOG_PUBKEY,
            &host(),
        )
        .unwrap_err();

        assert_eq!(error.code, "marketRequestFailed");
    }
}
