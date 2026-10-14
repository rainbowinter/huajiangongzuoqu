import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  getPluginsDir,
  openPluginsDir,
  setPluginEnabled,
  setPluginPermissions,
} from "../features/plugins/api";
import { reloadPlugins } from "../features/plugins/loader";
import {
  listAllPluginLogs,
  pluginLogsRevision,
  subscribePluginLogs,
  type PluginLogEntry,
} from "../features/plugins/logs";
import { unknownPermissions } from "../features/plugins/permissions";
import {
  listLoadedPlugins,
  listPluginCommands,
  subscribeLoadedPlugins,
  subscribePluginCommands,
} from "../features/plugins/registry";
import type {
  PluginCommand,
  PluginRuntimeRecord,
  PluginStatus,
} from "../features/plugins/types";
import { showToast } from "./Toast";

interface PluginCommandPanelProps {
  onClose: () => void;
}

const STATUS_LABEL: Record<PluginStatus, string> = {
  loaded: "运行中",
  legacy: "运行中（未沙箱）",
  disabled: "已停用",
  invalid: "清单无效",
  failed: "加载失败",
  suspended: "已暂停",
};

const STATUS_TONE: Record<PluginStatus, string> = {
  loaded: "text-bamboo bg-bamboo-mist/50",
  legacy: "text-ink-soft bg-paper-warm",
  disabled: "text-ink-ghost bg-paper-warm",
  invalid: "text-rust bg-rust-mist/40",
  failed: "text-rust bg-rust-mist/40",
  suspended: "text-rust bg-rust-mist/40",
};

/**
 * 订阅一个注册表，返回它的当前内容。
 *
 * `list` 必须是**稳定快照**（注册表内部已缓存）：若每次都返回新数组，
 * `useSyncExternalStore` 会判定快照持续变化而陷入无限重渲染。
 */
function useRegistry<T>(
  list: () => readonly T[],
  subscribe: (fn: () => void) => () => void,
): readonly T[] {
  return useSyncExternalStore(subscribe, list, list);
}

function PluginRow({
  record,
  busy,
  onToggle,
  onRevoke,
}: {
  record: PluginRuntimeRecord;
  busy: boolean;
  onToggle: (record: PluginRuntimeRecord) => void;
  onRevoke: (record: PluginRuntimeRecord, permission: string) => void;
}) {
  const { manifest, status, error, sandboxed } = record;
  const unknown = useMemo(
    () => unknownPermissions(manifest.permissions ?? []),
    [manifest.permissions],
  );

  return (
    <div className="px-3 py-2 rounded-xl hover:bg-paper-warm transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] text-ink-soft truncate" title={manifest.name}>
          {manifest.name}
        </span>
        <span className="text-[10px] text-ink-ghost shrink-0">v{manifest.version || "?"}</span>
      </div>

      <div className="flex items-center gap-1.5 mt-1">
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-md ${STATUS_TONE[status]}`}
          title={error ?? undefined}
        >
          {STATUS_LABEL[status]}
        </span>
        {manifest.apiVersion >= 2 && sandboxed ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-md text-bamboo bg-bamboo-mist/40">
            沙箱
          </span>
        ) : null}
        {!manifest.valid ? (
          <span className="text-[10px] text-rust truncate" title={manifest.invalidReason}>
            {manifest.invalidReason}
          </span>
        ) : null}
      </div>

      {manifest.description ? (
        <p className="text-[11px] text-ink-ghost mt-1">{manifest.description}</p>
      ) : null}

      {error ? <p className="text-[11px] text-rust mt-1 break-words">{error}</p> : null}

      {manifest.apiVersion < 2 ? (
        <p className="text-[10.5px] text-ink-ghost mt-1 leading-relaxed">
          v1 插件运行在主线程，没有沙箱隔离与权限限制。建议作者迁移到 v2。
        </p>
      ) : null}

      {manifest.permissions.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {manifest.permissions.map((permission) => {
            const isGranted = manifest.grantedPermissions.includes(permission);
            const isUnknown = unknown.includes(permission);
            return (
              <button
                key={permission}
                type="button"
                disabled={busy}
                onClick={() => onRevoke(record, permission)}
                title={
                  isUnknown
                    ? "宿主不认识这个权限，已忽略"
                    : isGranted
                      ? "点击撤销该权限（重新加载后生效）"
                      : "已撤销，点击重新授予"
                }
                className={`text-[10px] px-1.5 py-0.5 rounded-md transition-colors cursor-pointer ${
                  isUnknown
                    ? "text-ink-ghost line-through"
                    : isGranted
                      ? "text-bamboo bg-bamboo-mist/40"
                      : "text-ink-ghost bg-paper-warm"
                }`}
              >
                {permission}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          disabled={busy || !manifest.valid}
          onClick={() => onToggle(record)}
          className="px-2 py-0.5 text-[11px] rounded-lg text-ink-soft hover:bg-paper-deep/30 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
        >
          {manifest.enabled ? "停用" : "启用"}
        </button>
        <span className="text-[10px] text-ink-ghost truncate flex-1" title={manifest.dirPath}>
          {manifest.dirPath}
        </span>
      </div>
    </div>
  );
}

function LogList({ entries }: { entries: Array<PluginLogEntry & { plugin: string }> }) {
  if (entries.length === 0) {
    return <p className="text-[11px] text-ink-ghost text-center py-4">暂无日志</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {entries
        .slice(-40)
        .reverse()
        .map((entry, index) => (
          <div key={`${entry.at}-${index}`} className="text-[10.5px] font-mono break-words">
            <span
              className={
                entry.level === "error"
                  ? "text-rust"
                  : entry.level === "warn"
                    ? "text-amber"
                    : "text-ink-ghost"
              }
            >
              [{entry.plugin}]
            </span>{" "}
            <span className="text-ink-soft">{entry.message}</span>
          </div>
        ))}
    </div>
  );
}

export function PluginCommandPanel({ onClose }: PluginCommandPanelProps) {
  const plugins = useRegistry(listLoadedPlugins, subscribeLoadedPlugins);
  const commands = useRegistry<PluginCommand>(listPluginCommands, subscribePluginCommands);
  const logRevision = useSyncExternalStore(
    subscribePluginLogs,
    pluginLogsRevision,
    pluginLogsRevision,
  );

  const [pluginsDir, setPluginsDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"plugins" | "commands" | "logs">("plugins");

  const logs = useMemo(() => listAllPluginLogs(), [logRevision]);

  useEffect(() => {
    getPluginsDir()
      .then(setPluginsDir)
      .catch(() => undefined);
  }, []);

  const handleRefresh = useCallback(async () => {
    setBusy(true);
    try {
      await reloadPlugins();
      showToast("插件已刷新", "info");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleOpenDir = useCallback(async () => {
    try {
      await openPluginsDir();
    } catch (error) {
      showToast(`打开插件文件夹失败：${String(error)}`);
    }
  }, []);

  const handleToggle = useCallback(
    async (record: PluginRuntimeRecord) => {
      setBusy(true);
      try {
        await setPluginEnabled(record.manifest.name, !record.manifest.enabled);
        await reloadPlugins();
      } catch (error) {
        showToast(`切换插件状态失败：${String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleRevoke = useCallback(
    async (record: PluginRuntimeRecord, permission: string) => {
      setBusy(true);
      try {
        const granted = record.manifest.grantedPermissions.includes(permission)
          ? record.manifest.grantedPermissions.filter((item) => item !== permission)
          : [...record.manifest.grantedPermissions, permission];
        await setPluginPermissions(record.manifest.name, granted);
        await reloadPlugins();
      } catch (error) {
        showToast(`更新插件权限失败：${String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const runCommand = useCallback(async (command: PluginCommand) => {
    try {
      await command.run();
    } catch (error) {
      showToast(`命令执行失败：${String(error)}`);
    }
  }, []);

  const tabs: Array<{ key: typeof tab; label: string; count: number }> = [
    { key: "plugins", label: "插件", count: plugins.length },
    { key: "commands", label: "命令", count: commands.length },
    { key: "logs", label: "日志", count: logs.length },
  ];

  return (
    <aside className="w-[360px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between shrink-0">
        <span className="text-[13px] font-medium text-ink">插件</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={busy}
            className="w-6 h-6 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
            title="刷新插件"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="px-3 pb-2 flex gap-1 shrink-0">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={`px-2 py-1 text-[11px] rounded-lg transition-colors cursor-pointer ${
              tab === entry.key
                ? "text-bamboo bg-bamboo-mist/50"
                : "text-ink-ghost hover:text-ink-soft hover:bg-paper-warm"
            }`}
          >
            {entry.label}
            {entry.count > 0 ? ` ${entry.count}` : ""}
          </button>
        ))}
      </div>

      <div className="px-3 pb-2 flex-1 min-h-0 overflow-y-auto">
        {tab === "plugins" ? (
          plugins.length === 0 ? (
            <p className="text-[12px] text-ink-ghost text-center py-8">暂无插件</p>
          ) : (
            <div className="flex flex-col gap-1">
              {plugins.map((record) => (
                <PluginRow
                  key={record.manifest.name}
                  record={record}
                  busy={busy}
                  onToggle={(item) => void handleToggle(item)}
                  onRevoke={(item, permission) => void handleRevoke(item, permission)}
                />
              ))}
            </div>
          )
        ) : null}

        {tab === "commands" ? (
          commands.length === 0 ? (
            <p className="text-[12px] text-ink-ghost text-center py-8">暂无插件命令</p>
          ) : (
            <div className="flex flex-col gap-1">
              {commands.map((command) => (
                <button
                  key={command.id}
                  type="button"
                  onClick={() => void runCommand(command)}
                  className="px-3 py-2 rounded-xl text-left hover:bg-paper-warm transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] text-ink-soft">{command.title}</span>
                    {command.keybinding ? (
                      <span className="text-[10px] text-ink-ghost font-mono shrink-0">
                        {command.keybinding}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-[10px] text-ink-ghost">{command.plugin}</span>
                </button>
              ))}
            </div>
          )
        ) : null}

        {tab === "logs" ? <LogList entries={logs} /> : null}
      </div>

      <div className="px-4 py-2.5 border-t border-paper-deep/30 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[10px] text-ink-ghost truncate flex-1" title={pluginsDir}>
          {pluginsDir || "插件目录"}
        </span>
        <button
          type="button"
          onClick={() => void handleOpenDir()}
          className="px-2.5 py-1 text-[11px] text-bamboo hover:bg-bamboo-mist/50 rounded-lg transition-colors cursor-pointer shrink-0"
        >
          打开插件文件夹
        </button>
      </div>
    </aside>
  );
}
