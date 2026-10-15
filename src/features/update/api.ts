import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type { Update };

/**
 * 有没有配置更新端点。`null` 表示这个功能整体关闭。
 *
 * 端点在 Rust 侧运行时解析（见 `src-tauri/src/selfupdate.rs`）：没配的时候**不要**发起
 * 任何检查，界面上也不该出现任何东西。所以这是更新流程的第一道门，而不是可选的。
 */
export function getUpdateEndpoint(): Promise<string | null> {
  return invoke("update_endpoint");
}

/** 去端点查有没有新版。没有新版返回 `null`。 */
export function checkForUpdate(): Promise<Update | null> {
  return check();
}
