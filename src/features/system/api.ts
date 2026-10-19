import { invoke } from "@tauri-apps/api/core";

/** 用系统的「打开方式」对话框打开一个工作区文件。 */
export function openWithSystemApp(path: string): Promise<void> {
  return invoke("system_open_with", { path });
}

/** 打开资源管理器原生的属性页。 */
export function showSystemProperties(path: string): Promise<void> {
  return invoke("system_show_properties", { path });
}
