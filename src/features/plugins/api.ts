import { invoke } from "@tauri-apps/api/core";
import type { PluginManifest } from "./types";

export function listPlugins(): Promise<PluginManifest[]> {
  return invoke("plugins_list");
}

export function readPlugin(name: string): Promise<string> {
  return invoke("plugins_read", { name });
}

export function readPluginAsset(name: string, relativePath: string): Promise<string> {
  return invoke("plugins_read_asset", { name, relativePath });
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

export function setPluginPermissions(
  name: string,
  granted: string[],
): Promise<PluginManifest> {
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
