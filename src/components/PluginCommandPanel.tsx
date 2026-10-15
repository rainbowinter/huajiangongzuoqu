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
  listDecorations,
  listEditorGutters,
  listEditorMenuItems,
  listLoadedPlugins,
  listNoteMenuItems,
  listPluginCommands,
  listPluginPanels,
  listPopovers,
  listToolbarButtons,
  subscribeLoadedPlugins,
  subscribePluginCommands,
} from "../features/plugins/registry";
import { buildPluginDetails, type PluginContribution } from "../features/docs/pluginDetails";
import type { PluginCommand, PluginRuntimeRecord, PluginStatus } from "../features/plugins/types";
import { useMarketEnabled } from "../features/market/useMarket";
import { MarketPanel } from "./MarketPanel";
import { PluginParams, parseSettingFields } from "./PluginParams";
import { Switch } from "./Switch";
import { showToast } from "./Toast";

interface PluginCommandPanelProps {
  onClose: () => void;
  /**
   * 打开一篇只读文档。插件详情在这里生成，**显示交给宿主** —— 正文区是它的地盘。
   *
   * 可选：快速便签窗口（NotePad）里没有能放文档的地方，那种情况下**不显示**
   * 「详细信息」按钮 —— 显示一个点了没反应的按钮比不显示更糟。
   */
  onOpenDoc?: (title: string, content: string) => void;
}

/**
 * 把一个插件当前注册出去的贡献点整理成分组清单。
 *
 * 这些都是**活的**注册表（插件被停用时条目会自己消失），所以每次点「详细信息」现读一遍
 * 才是准的 —— 缓存下来的话，停用某个插件之后详情里还会写着它加过什么。
 */
function contributionsOf(name: string): PluginContribution[] {
  const owned = <T,>(items: readonly T[], field: (item: T) => string | undefined) =>
    items.filter((item) => field(item) === name);

  return [
    { label: "面板", items: owned(listPluginPanels(), (p) => p.plugin).map((p) => p.title) },
    {
      label: "工具栏按钮",
      items: owned(listToolbarButtons(), (b) => b.plugin).map((b) => b.title),
    },
    { label: "工具栏浮层", items: owned(listPopovers(), (p) => p.plugin).map((p) => p.title) },
    { label: "命令", items: owned(listPluginCommands(), (c) => c.plugin).map((c) => c.title) },
    { label: "行旁注", items: owned(listEditorGutters(), (g) => g.plugin).map((g) => g.title) },
    {
      label: "行内装饰",
      items: owned(listDecorations(), (d) => d.plugin).map((d) => d.title),
    },
    {
      label: "编辑器菜单",
      items: owned(listEditorMenuItems(), (m) => m.plugin).map((m) => m.title),
    },
    { label: "笔记菜单", items: owned(listNoteMenuItems(), (m) => m.plugin).map((m) => m.title) },
  ];
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
  expanded,
  onToggle,
  onRevoke,
  onToggleExpand,
  onOpenDoc,
}: {
  record: PluginRuntimeRecord;
  busy: boolean;
  expanded: boolean;
  onToggle: (record: PluginRuntimeRecord) => void;
  onRevoke: (record: PluginRuntimeRecord, permission: string) => void;
  onToggleExpand: (name: string) => void;
  onOpenDoc?: (title: string, content: string) => void;
}) {
  const { manifest, status, error, sandboxed } = record;
  const unknown = useMemo(
    () => unknownPermissions(manifest.permissions ?? []),
    [manifest.permissions],
  );
  const hasSettings = useMemo(() => parseSettingFields(manifest).length > 0, [manifest]);
  const hasPermissions = manifest.permissions.length > 0;
  // 只有展开区里有东西的插件才给箭头：点开一个空无一物的行是坏的反馈。
  const canExpand = hasPermissions || hasSettings;

  return (
    <div className="px-3 py-2 rounded-xl hover:bg-paper-warm transition-colors">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={canExpand ? () => onToggleExpand(manifest.name) : undefined}
          aria-expanded={canExpand ? expanded : undefined}
          className={`flex items-center gap-1.5 min-w-0 flex-1 text-left rounded ${
            canExpand ? "cursor-pointer" : "cursor-default"
          }`}
          title={manifest.name}
        >
          {canExpand ? (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`shrink-0 text-ink-ghost transition-transform duration-200 ${
                expanded ? "rotate-90" : ""
              }`}
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          ) : (
            <span className="w-[10px] shrink-0" />
          )}
          <span className="text-[12.5px] text-ink-soft truncate">{manifest.name}</span>
        </button>
        <span className="text-[10px] text-ink-ghost shrink-0">v{manifest.version || "?"}</span>

        {/* 启用 / 停用。用开关而不是「停用」这种文字按钮：文字按钮读不出当前状态，
            得先解析「停用」到底是「现在是启用的」还是「点它就会停用」。 */}
        <button
          type="button"
          role="switch"
          aria-checked={manifest.enabled}
          aria-label={`${manifest.enabled ? "停用" : "启用"} ${manifest.name}`}
          disabled={busy || !manifest.valid}
          onClick={() => onToggle(record)}
          className="shrink-0 disabled:opacity-40 disabled:cursor-default cursor-pointer"
        >
          <Switch checked={manifest.enabled} />
        </button>
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

      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] text-ink-ghost truncate flex-1" title={manifest.dirPath}>
          {manifest.dirPath}
        </span>
        {/* 「详细信息」：把清单里的东西摊开给人看。装了一堆插件之后，
            「这个到底是干嘛的」不该靠来回开关去试。 */}
        {onOpenDoc ? (
          <button
            type="button"
            onClick={() =>
              onOpenDoc(
                manifest.name,
                buildPluginDetails({
                  record,
                  contributions: contributionsOf(manifest.name),
                  settings: parseSettingFields(manifest).map((field) => ({
                    key: field.key,
                    title: field.title,
                    type: field.type,
                    description: field.description,
                  })),
                }),
              )
            }
            className="shrink-0 px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
            title="这个插件具体做了什么"
          >
            详细信息
          </button>
        ) : null}
      </div>

      {/* 展开区。权限和参数都放这儿，而不是常驻在行上。
          **权限尤其不能常驻**：那排小胶囊点一下就撤权并重载全部插件，而它就和插件名
          挨着，滑一下鼠标就误触了。收进展开区之后，撤销权限至少需要「先点开」这个
          明确的动作。参数同理由此 —— 它是这个插件的属性，和插件放在一起才找得到，
          丢进设置面板里就成了一堆只有作者才认识的字段名。 */}
      {expanded && (hasPermissions || hasSettings) ? (
        <div className="mt-2 pt-2 border-t border-paper-deep/25 space-y-2.5">
          {hasPermissions ? (
            <div>
              <p className="text-[10px] text-ink-ghost mb-1">权限</p>
              <div className="flex flex-wrap gap-1">
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
            </div>
          ) : null}

          <PluginParams manifest={manifest} />
        </div>
      ) : null}
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

export function PluginCommandPanel({ onClose, onOpenDoc }: PluginCommandPanelProps) {
  const plugins = useRegistry(listLoadedPlugins, subscribeLoadedPlugins);
  const commands = useRegistry<PluginCommand>(listPluginCommands, subscribePluginCommands);
  const logRevision = useSyncExternalStore(
    subscribePluginLogs,
    pluginLogsRevision,
    pluginLogsRevision,
  );

  const [pluginsDir, setPluginsDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"plugins" | "commands" | "logs" | "market">("plugins");
  const [query, setQuery] = useState("");
  const [expandedPlugins, setExpandedPlugins] = useState<ReadonlySet<string>>(new Set());

  /** 市场没配的话连这个 tab 都不出现（`null` = 还没问出来，也不出现）。 */
  const marketEnabled = useMarketEnabled();

  const handleToggleExpand = useCallback((name: string) => {
    setExpandedPlugins((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

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

  const handleToggle = useCallback(async (record: PluginRuntimeRecord) => {
    setBusy(true);
    try {
      await setPluginEnabled(record.manifest.name, !record.manifest.enabled);
      await reloadPlugins();
    } catch (error) {
      showToast(`切换插件状态失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRevoke = useCallback(async (record: PluginRuntimeRecord, permission: string) => {
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
  }, []);

  const runCommand = useCallback(async (command: PluginCommand) => {
    try {
      await command.run();
    } catch (error) {
      showToast(`命令执行失败：${String(error)}`);
    }
  }, []);

  /** 搜索只过滤插件页；命令与日志各有各的列表，混一个框进来反而费解。 */
  const visiblePlugins = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return plugins;
    return plugins.filter((record) =>
      `${record.manifest.name} ${record.manifest.description ?? ""}`
        .toLowerCase()
        .includes(keyword),
    );
  }, [plugins, query]);

  /** 装完 / 卸完之后：重载插件，注册表一变，两边列表都会跟着刷新。 */
  const handleMarketChanged = useCallback(async () => {
    await reloadPlugins();
  }, []);

  /** 已装插件的清单，喂给插件市场判断「装过没有、能不能更新」。 */
  const installedManifests = useMemo(() => plugins.map((record) => record.manifest), [plugins]);

  const tabs: Array<{ key: typeof tab; label: string; count: number }> = [
    { key: "plugins", label: "插件", count: plugins.length },
    { key: "commands", label: "命令", count: commands.length },
    { key: "logs", label: "日志", count: logs.length },
    // 市场没配就不出现 —— 与右上角那颗更新胶囊同一条规矩：没开的功能不留痕迹。
    ...(marketEnabled ? [{ key: "market" as const, label: "市场", count: 0 }] : []),
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
          <>
            {/* 与侧栏的搜索框同一套观感 */}
            <div className="flex items-center gap-2 px-2.5 h-8 mb-2 rounded-lg bg-paper-warm/80 border border-paper-deep/40 focus-within:border-bamboo/30 focus-within:bg-cloud transition-all">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                className="text-ink-ghost shrink-0"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索插件…"
                className="flex-1 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="text-ink-ghost hover:text-ink-faint transition-colors cursor-pointer"
                  title="清空搜索"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              ) : null}
            </div>

            {visiblePlugins.length === 0 ? (
              <p className="text-[12px] text-ink-ghost text-center py-8">
                {plugins.length === 0 ? "暂无插件" : "没有匹配的插件"}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {visiblePlugins.map((record) => (
                  <PluginRow
                    key={record.manifest.name}
                    record={record}
                    busy={busy}
                    expanded={expandedPlugins.has(record.manifest.name)}
                    onToggle={(item) => void handleToggle(item)}
                    onRevoke={(item, permission) => void handleRevoke(item, permission)}
                    onToggleExpand={handleToggleExpand}
                    onOpenDoc={onOpenDoc}
                  />
                ))}
              </div>
            )}
          </>
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

        {tab === "market" ? (
          <MarketPanel installed={installedManifests} onChanged={handleMarketChanged} />
        ) : null}
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
