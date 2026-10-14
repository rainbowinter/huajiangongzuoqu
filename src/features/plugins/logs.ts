/**
 * 插件日志：每个插件一个环形缓冲，外加一条「节流后的错误提示」通道。
 *
 * 有两个非显而易见的必要设计：
 *
 * * **节流**。沙箱 Worker 里的插件如果在一个渲染循环里反复抛错，直接把每条错误
 *   都弹 Toast 会把界面冲垮。这里按插件粒度限制为 10 秒最多一条。
 * * **环形缓冲**。插件可能长时间运行并大量打日志，无上限的数组迟早吃满内存。
 */

import { showToast } from "../../components/Toast";
import type { PluginLogLevel } from "./protocol";

export interface PluginLogEntry {
  level: PluginLogLevel;
  message: string;
  stack?: string;
  /** 毫秒时间戳。 */
  at: number;
}

const MAX_ENTRIES_PER_PLUGIN = 200;
const TOAST_THROTTLE_MS = 10_000;
/** 单条日志消息的长度上限，防止插件塞进一整篇文档。 */
const MAX_MESSAGE_LENGTH = 2_000;

const buffers = new Map<string, PluginLogEntry[]>();
const lastToastAt = new Map<string, number>();
const listeners = new Set<() => void>();

/** 供 React 判断快照是否变化的单调计数器。 */
let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[plugins] 日志订阅回调抛错", error);
    }
  }
}

export function appendPluginLog(
  plugin: string,
  level: PluginLogLevel,
  message: string,
  stack?: string,
): void {
  const entry: PluginLogEntry = {
    level,
    message:
      message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message,
    ...(stack ? { stack } : {}),
    at: Date.now(),
  };

  const buffer = buffers.get(plugin);
  if (buffer) {
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES_PER_PLUGIN) {
      buffer.splice(0, buffer.length - MAX_ENTRIES_PER_PLUGIN);
    }
  } else {
    buffers.set(plugin, [entry]);
  }

  if (level === "error") {
    toastPluginError(plugin, entry.message);
  }

  notify();
}

/** 按插件节流地把错误弹成 Toast。 */
function toastPluginError(plugin: string, message: string): void {
  const now = Date.now();
  const last = lastToastAt.get(plugin) ?? 0;
  if (now - last < TOAST_THROTTLE_MS) return;
  lastToastAt.set(plugin, now);
  showToast(`插件 ${plugin}：${message}`, "error");
}

export function listPluginLogs(plugin: string): PluginLogEntry[] {
  return [...(buffers.get(plugin) ?? [])];
}

/** 所有插件的日志总和，按时间排序，供插件面板的「日志」区展示。 */
export function listAllPluginLogs(): Array<PluginLogEntry & { plugin: string }> {
  const all: Array<PluginLogEntry & { plugin: string }> = [];
  for (const [plugin, entries] of buffers) {
    for (const entry of entries) {
      all.push({ ...entry, plugin });
    }
  }
  return all.sort((a, b) => a.at - b.at);
}

export function clearPluginLogs(plugin?: string): void {
  if (plugin === undefined) {
    buffers.clear();
    lastToastAt.clear();
  } else {
    buffers.delete(plugin);
    lastToastAt.delete(plugin);
  }
  notify();
}

export function subscribePluginLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pluginLogsRevision(): number {
  return revision;
}
