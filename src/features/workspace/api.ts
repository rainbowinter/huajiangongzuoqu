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

/**
 * 读工作区文件的**原始字节**（PDF 这类二进制走这条）。
 *
 * 命令返回的是 `tauri::ipc::Response`，所以 `invoke` 直接给到 `ArrayBuffer` ——
 * 不经 JSON 数组、不做 base64，也不会因为不是 UTF-8 而失败。
 */
export function readWorkspaceFileBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("workspace_read_file_bytes", { path });
}

export function writeWorkspaceFile(path: string, content: string): Promise<void> {
  return invoke("workspace_write_file", { path, content });
}

/**
 * 把**原始字节**写进工作区的一个文件（「新建文件」带模板时用）。
 *
 * 与 `saveExternalFileBytes` 一样走 Tauri 的 raw body：模板里可以有任何字节，
 * 不该为了过 JSON 变成数字数组。路径放请求头，前端先 percent-encode（中文目录）。
 *
 * 这条命令仍由 Rust 侧校验「路径在工作区内」，不是「想写哪儿写哪儿」。
 */
export function writeWorkspaceFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  return invoke("workspace_write_file_bytes", bytes, {
    headers: { "x-floral-path": encodeURIComponent(path) },
  });
}

/** 删除一个**文件**。目录会被后端拒绝。 */
export function deleteWorkspaceFile(path: string): Promise<void> {
  return invoke("workspace_delete_file", { path });
}

/** 把文件或目录移动到另一个目录下，返回移动后的新路径。 */
export function moveWorkspaceEntry(path: string, targetDir: string): Promise<string> {
  return invoke("workspace_move_entry", { path, targetDir });
}

/**
 * 重命名一个**文件**（不换目录），返回新路径。
 *
 * 目录重命名由「移动到…」覆盖；后端会拒绝 `..`、路径分隔符与 Windows 非法字符。
 */
export function renameWorkspaceEntry(path: string, newName: string): Promise<string> {
  return invoke("workspace_rename_entry", { path, newName });
}

/** 把外部文件 / 文件夹复制进一个工作目录；返回顶层项目数。 */
export function copyWorkspaceEntries(sources: string[], targetDir: string): Promise<number> {
  return invoke("workspace_copy_entries", { sources, targetDir });
}

/** 批量删除文件 / 文件夹；返回实际删除的顶层项目数。 */
export function deleteWorkspaceEntries(paths: string[]): Promise<number> {
  return invoke("workspace_delete_entries", { paths });
}

/** 批量移动到另一个目录；返回实际移动的顶层项目数。 */
export function moveWorkspaceEntries(paths: string[], targetDir: string): Promise<number> {
  return invoke("workspace_move_entries", { paths, targetDir });
}

/** 列出某个目录下的所有子目录（递归、有上限），供「移动到…」选择目标。 */
export function listWorkspaceSubdirs(dir: string): Promise<string[]> {
  return invoke("workspace_list_subdirs", { dir });
}

/** 添加工作文件夹，返回更新后的配置。**幂等**：已经在列表里就不重复加。 */
export function addWorkspaceFolder(path: string): Promise<AppConfig> {
  return invoke("workspace_add_folder", { path });
}

/**
 * 数据目录的绝对路径。
 *
 * 插件不知道它在哪（用户配的、还可能被迁移），所以 `api.workspace.openFolder` 的
 * `@data` 哨兵由宿主在这里解析完再传下去。
 */
export function dataDirPath(): Promise<string> {
  return invoke("data_dir_path");
}

export function removeWorkspaceFolder(path: string): Promise<AppConfig> {
  return invoke("workspace_remove_folder", { path });
}

/**
 * 给一个工作文件夹换图标（`icon` 传空串 = 恢复默认），返回更新后的配置。
 *
 * 只影响活动栏那一列的观感 —— 图标是给用户自己认路用的（几个都叫 `src` / `styles`
 * 的时候，光看名字分不清）。
 */
export function setWorkspaceIcon(path: string, icon: string): Promise<AppConfig> {
  return invoke("workspace_set_icon", { path, icon });
}

// ---------------------------------------------------------------- 工作区缓存
//
// `__floral-notepaper__/` —— 插件把**与某个文件相关**的数据放在那个文件旁边。位置由宿主
// 算（文件在哪个工作区里就用那个工作区的根，不在任何工作区里就用文件自己所在的目录），
// 插件只说「我是谁」。规矩见 `Docs/workspace-cache.md`。

/** 读某文件上某个插件的数据。没写过返回 `null`。 */
export function readWorkspaceCache(file: string, plugin: string): Promise<unknown | null> {
  return invoke("workspace_cache_read", { file, plugin });
}

/** 写一份数据（整份覆盖）。 */
export function writeWorkspaceCache(
  file: string,
  plugin: string,
  value: unknown,
): Promise<void> {
  return invoke("workspace_cache_write", { file, plugin, value });
}

/** 删掉某文件上某个插件的数据；本来就没有时返回 `false`（不算错）。 */
export function deleteWorkspaceCache(file: string, plugin: string): Promise<boolean> {
  return invoke("workspace_cache_remove", { file, plugin });
}

/** 某个工作文件夹里的缓存有多少（「移除工作文件夹」那个确认框要显示）。 */
export interface WorkspaceCacheInfo {
  exists: boolean;
  files: number;
  bytes: number;
}

export function workspaceCacheInfo(path: string): Promise<WorkspaceCacheInfo> {
  return invoke("workspace_cache_info", { path });
}

/** 把某个工作文件夹里的缓存整个删掉。返回删之前数到的那份信息。 */
export function clearWorkspaceCache(path: string): Promise<WorkspaceCacheInfo> {
  return invoke("workspace_cache_clear", { path });
}
