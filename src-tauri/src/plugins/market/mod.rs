//! 插件市场。
//!
//! 与 `plugins/` 下其他模块的分工：那边管**本地已装的插件**（读代码、跑沙箱、存状态），
//! 这边管**从网上把插件取回来**。两者唯一的交互点是 `state.rs` 的 `origin` 字段 ——
//! 市场装的插件对内置同步（`sync.rs`）是不可见的，详见 `origin` 的文档注释。
//!
//! 信任链与阶段划分见 `Docs/plugin-market.md`。

pub mod archive;
pub mod catalog;
pub mod commands;
pub mod config;
pub mod install;
pub mod progress;
pub mod verify;

/// 测试专用（最小 HTTP 服务器 + 签名夹具），不进正式构建。
#[cfg(test)]
pub mod testkit;

/// 把 `reqwest` 的失败翻成一句**能指导下一步**的话。
///
/// 默认的 `Display` 只有一句 `error sending request for url (…)` —— 用户看不出这是
/// 「网络不通 / 代理没开」还是「对方服务器挂了」，只能来问为什么。这里先给结论，再把
/// 原始错误附在后面（真要排查还得靠它）。
///
/// 为什么要**分时限**：连不上时 reqwest 通常卡到超时才报错，用户看到的是一段空白等待；
/// 不点明「超时」的话，只会以为是自己点错了。
pub(crate) fn describe_request_error(error: &reqwest::Error) -> String {
    let hint = if error.is_timeout() {
        "连接超时：没能在限定时间内连上服务器。网络可能不通，或者代理没有开启。"
    } else if error.is_connect() {
        "连不上服务器：网络可能不通，或者代理没有开启。"
    } else if error.is_redirect() {
        "重定向次数过多：下载地址可能有问题。"
    } else if error.is_decode() {
        "响应内容解析失败：数据可能被截断了，请重试。"
    } else {
        "请求失败。"
    };

    format!("{hint}（{error}）")
}
