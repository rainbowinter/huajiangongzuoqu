import { invoke } from "@tauri-apps/api/core";
import type { FontAsset } from "../fonts/fontFace";
import type { PluginManifest, PluginSyncReport } from "./types";

export function listPlugins(): Promise<PluginManifest[]> {
  return invoke("plugins_list");
}

/**
 * 取走启动时那次插件版本校正的报告。
 *
 * **取过即清空**（清空在 Rust 侧）：同一个进程里只有第一个调用者拿得到内容，其余拿到
 * `null`。多窗口下正好只提示一次。
 */
export function getPluginSyncReport(): Promise<PluginSyncReport | null> {
  return invoke("plugins_sync_report");
}

export function readPlugin(name: string): Promise<string> {
  return invoke("plugins_read", { name });
}

export function readPluginAsset(name: string, relativePath: string): Promise<string> {
  return invoke("plugins_read_asset", { name, relativePath });
}

/** 列出插件目录下某个子目录里可读的文本资源文件名（不递归，空串表示插件根目录）。 */
export function listPluginAssets(name: string, relativeDir: string): Promise<string[]> {
  return invoke("plugins_list_assets", { name, relativeDir });
}

/**
 * 列出插件字体目录里的字体文件（不递归）。
 *
 * ⚠️ 返回值带**绝对路径**。它只该在宿主侧用来生成 asset URL，**不要**再往下传给插件
 * —— 那是"插件不触碰文件系统"这条边界的一部分。
 */
export function listPluginFontAssets(name: string, relativeDir: string): Promise<FontAsset[]> {
  return invoke("plugins_list_fonts", { name, relativeDir });
}

export function getPluginsDir(): Promise<string> {
  return invoke("plugins_dir_path");
}

export function openPluginsDir(): Promise<void> {
  return invoke("plugins_open_dir");
}

export function setPluginEnabled(name: string, enabled: boolean): Promise<PluginManifest> {
  return invoke("plugins_set_enabled", { name, enabled });
}

/** 开 / 关「市场有新版本时自动更新这个插件」。 */
export function setPluginAutoUpdate(name: string, autoUpdate: boolean): Promise<PluginManifest> {
  return invoke("plugins_set_auto_update", { name, autoUpdate });
}

export function setPluginPermissions(name: string, granted: string[]): Promise<PluginManifest> {
  return invoke("plugins_set_permissions", { name, granted });
}

// ------------------------------------------------------------ 插件级持久化

export function storageGet(name: string, key: string): Promise<unknown> {
  return invoke("plugins_storage_get", { name, key });
}

export function storageSet(name: string, key: string, value: unknown): Promise<void> {
  return invoke("plugins_storage_set", { name, key, value });
}

export function storageDelete(name: string, key: string): Promise<void> {
  return invoke("plugins_storage_delete", { name, key });
}

export function storageKeys(name: string): Promise<string[]> {
  return invoke("plugins_storage_keys", { name });
}

export function storageClear(name: string): Promise<void> {
  return invoke("plugins_storage_clear", { name });
}

export function settingsGet(name: string): Promise<Record<string, unknown>> {
  return invoke("plugins_settings_get", { name });
}

export function settingsSet(
  name: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return invoke("plugins_settings_set", { name, values });
}
