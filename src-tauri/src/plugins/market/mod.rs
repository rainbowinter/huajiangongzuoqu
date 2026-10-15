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
