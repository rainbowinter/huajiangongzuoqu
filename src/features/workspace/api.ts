import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "../settings/types";

/**
 * 工作文件夹的前端接口。
 *
 * 这里**不做任何路径合法性判断** —— 真正的闸在后端 `services::workspace`：它会把目标
 * `canonicalize()` 之后与已授权的根做前缀匹配，因此 `..` 与符号链接都绕不过去。
 * 前端若也判一遍，只会造成"两套规则"，迟早不一致。
 */

export interface WorkspaceEntry {
  name: string;
  /** 绝对路径，原样传回下面几个命令即可。 */
  path: string;
  isDir: boolean;
  /** 字节数；目录为 null。 */
  size: number | null;
  /** RFC3339；取不到为 null。 */
  modifiedAt: string | null;
  /** 小写扩展名（不含点）。 */
  extension: string | null;
  /** 首个非空行的预览；二进制 / 空文件 / 过大 / 超出单次上限时为 null。 */
  preview: string | null;
}

export interface WorkspaceListing {
  entries: WorkspaceEntry[];
  /** 条目数触到上限被截断。界面上应如实提示，别让用户以为文件夹里就这么多。 */
  truncated: boolean;
}

/** 列出一层目录（不递归；展开子目录时再调一次）。 */
export function listWorkspaceDir(dir: string): Promise<WorkspaceListing> {
  return invoke("workspace_list_dir", { dir });
}

export function readWorkspaceFile(path: string): Promise<string> {
  return invoke("workspace_read_file", { path });
}

export function writeWorkspaceFile(path: string, content: string): Promise<void> {
  return invoke("workspace_write_file", { path, content });
}

/** 删除一个**文件**。目录会被后端拒绝。 */
export function deleteWorkspaceFile(path: string): Promise<void> {
  return invoke("workspace_delete_file", { path });
}

/** 把文件或目录移动到另一个目录下，返回移动后的新路径。 */
export function moveWorkspaceEntry(path: string, targetDir: string): Promise<string> {
  return invoke("workspace_move_entry", { path, targetDir });
}

/** 列出某个目录下的所有子目录（递归、有上限），供「移动到…」选择目标。 */
export function listWorkspaceSubdirs(dir: string): Promise<string[]> {
  return invoke("workspace_list_subdirs", { dir });
}

/** 添加工作文件夹，返回更新后的配置。 */
export function addWorkspaceFolder(path: string): Promise<AppConfig> {
  return invoke("workspace_add_folder", { path });
}

export function removeWorkspaceFolder(path: string): Promise<AppConfig> {
  return invoke("workspace_remove_folder", { path });
}
