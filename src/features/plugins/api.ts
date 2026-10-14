import { invoke } from "@tauri-apps/api/core";
import type { PluginManifest } from "./types";

export function listPlugins(): Promise<PluginManifest[]> {
  return invoke("plugins_list");
}

export function readPlugin(name: string): Promise<string> {
  return invoke("plugins_read", { name });
}

export function getPluginsDir(): Promise<string> {
  return invoke("plugins_dir_path");
}

export function openPluginsDir(): Promise<void> {
  return invoke("plugins_open_dir");
}
