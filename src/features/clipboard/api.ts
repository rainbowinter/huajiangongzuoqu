import { invoke } from "@tauri-apps/api/core";

/**
 * 把文件 / 文件夹放进系统剪贴板。
 *
 * Windows 上写的是 `CF_HDROP`（资源管理器、Word、微信都认）+ 一份路径文本；所以
 * 「复制图片」粘到资源管理器得到原文件，粘回花笺的编辑器则得到 `![](路径)`。
 *
 * 路径由后端再校验一次（必须落在工作区或数据目录内）—— 前端不重复写那套规则。
 */
export function copyFilePaths(paths: string[]): Promise<void> {
  return invoke("clipboard_copy_files", { paths });
}

/**
 * 读系统剪贴板里的文件列表（从资源管理器「复制」得到的那些）。
 *
 * 返回的是绝对路径；来源可以在工作区之外 —— 真正写盘时由复制命令校验**目标**。
 */
export function readClipboardFiles(): Promise<string[]> {
  return invoke("clipboard_read_files");
}
