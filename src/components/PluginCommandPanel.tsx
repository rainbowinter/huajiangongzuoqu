import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  getPluginsDir,
  openPluginsDir,
  readPluginAsset,
  setPluginAutoUpdate,
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
import { defaultRelease, updateAvailable } from "../features/market/presentation";
import { useMarket, useMarketEnabled } from "../features/market/useMarket";
import { usePluginTransfer } from "../features/market/usePluginTransfer";
import { ConfirmInstall, ConfirmUninstall, MarketPanel } from "./MarketPanel";
import { PluginIcon } from "./PluginIcon";
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

/** 插件根目录下那份说明文件的名字。约定写死，见 `Docs/plugin-api.md` 的「发布到插件市场」。 */
const README_FILE = "README.md";

/**
 * 「详细信息」要打开的那份文档。
 *
 * 优先用插件**自带**的 README.md —— 那是作者写给用户看的东西，比我们从清单里拼出来的
 * 准得多、也全得多。读不到时才退回自动生成的那份，**并且不提示**：没带 README 是正常
 * 情况（内置的那些示例就有没带的），不是错误。
 *
 * 生成的那份仍然有用：它列的是**当下真正注册出去的贡献点**，而 README 里写的可能是
 * 作者的承诺。
 */
async function openPluginDoc(record: PluginRuntimeRecord): Promise<string> {
  const { name } = record.manifest;
  for (const candidate of [README_FILE, "readme.md"]) {
    try {
      const content = await readPluginAsset(name, candidate);
      if (content.trim().length > 0) return content;
    } catch {
      // 这个大小写没有，试下一个；两个都没有就走下面那份生成的。
    }
  }

  return buildPluginDetails({
    record,
    contributions: contributionsOf(name),
    settings: parseSettingFields(record.manifest).map((field) => ({
      key: field.key,
      title: field.title,
      type: field.type,
      description: field.description,
    })),
  });
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
  updateTo,
  onToggle,
  onRevoke,
  onToggleExpand,
  onGoToMarket,
  onOpenDoc,
  onReinstall,
  onUninstall,
  onToggleAutoUpdate,
}: {
  record: PluginRuntimeRecord;
  busy: boolean;
  expanded: boolean;
  /** 市场里有更新的版本时是那个版本号；否则 `null`。 */
  updateTo: string | null;
  onToggle: (record: PluginRuntimeRecord) => void;
  onRevoke: (record: PluginRuntimeRecord, permission: string) => void;
  onToggleExpand: (name: string) => void;
  onGoToMarket: (name: string) => void;
  onOpenDoc?: (title: string, content: string) => void;
  /** 从市场再装一遍（修好装坏的那份）。`undefined` = 这个插件不该有这颗按钮。 */
  onReinstall?: (record: PluginRuntimeRecord) => void;
  /** 卸载。`undefined` = 这个插件不该有这颗按钮（不是市场装的）。 */
  onUninstall?: (record: PluginRuntimeRecord) => void;
  onToggleAutoUpdate: (record: PluginRuntimeRecord) => void;
}) {
  const { manifest, status, error, sandboxed } = record;
  const unknown = useMemo(
    () => unknownPermissions(manifest.permissions ?? []),
    [manifest.permissions],
  );
  const hasSettings = useMemo(() => parseSettingFields(manifest).length > 0, [manifest]);
  const hasPermissions = manifest.permissions.length > 0;
  const manageable = Boolean(onReinstall) || Boolean(onUninstall);
  // 只有展开区里有东西的插件才给箭头：点开一个空无一物的行是坏的反馈。
  const canExpand = hasPermissions || hasSettings || manageable;

  return (
    <div className="px-3 py-2 rounded-xl hover:bg-paper-warm transition-colors">
      {/* 图标单独一列、且比正文大得多：**它才是列表里区分插件的主要视觉**。
          两列布局（图标 | 正文）比「图标挤在名字前面」能给出立体感，名字也不会被图标推得
          缩进不齐。 */}
      <div className="flex items-start gap-2.5">
        <PluginIcon icon={manifest.icon} size={28} className="mt-0.5 text-ink-ghost/60" />
        <div className="min-w-0 flex-1">
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

        {/* 市场里有新版：在这里就要能看见，否则用户得自己去市场那个页签里一行行找。
            点它跳到市场并高亮那一行 —— 安装（含权限重新确认）仍然只在市场那一条路上走。 */}
        {updateTo && updateTo !== manifest.version ? (
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[10px] px-1.5 py-0.5 rounded-md text-bamboo bg-bamboo-mist/40">
              市场有新版本 v{updateTo}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onGoToMarket(manifest.name)}
              className="text-[10px] px-1.5 py-0.5 rounded-md text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer disabled:opacity-40"
            >
              去更新
            </button>
          </div>
        ) : null}

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
          {/* 「详细信息」：优先打开插件**自带**的 README.md。
              装了一堆插件之后，「这个到底是干嘛的」不该靠来回开关去试 —— 而这件事作者
              写得比我们从清单里拼出来的清楚得多。没带 README 时才退回那份自动生成的。 */}
          {onOpenDoc ? (
            <button
              type="button"
              onClick={() =>
                void openPluginDoc(record).then((content) => onOpenDoc(manifest.name, content))
              }
              className="shrink-0 px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
              title="这个插件具体做了什么"
            >
              详细信息
            </button>
          ) : null}
        </div>

        </div>
      </div>

      {/* 展开区。权限和参数都放这儿，而不是常驻在行上。
          **权限尤其不能常驻**：那排小胶囊点一下就撤权并重载全部插件，而它就和插件名
          挨着，滑一下鼠标就误触了。收进展开区之后，撤销权限至少需要「先点开」这个
          明确的动作。参数同理由此 —— 它是这个插件的属性，和插件放在一起才找得到，
          丢进设置面板里就成了一堆只有作者才认识的字段名。

          ⚠️ 里面那层 `pl-[38px]` 是**对齐用**的：上面每一行正文都从图标右边起（28px 图标
          + 10px 间距），展开区要是从卡片边缘起，两段的左边界就差着一整个图标的宽度，
          看起来像两段各说各的。分隔线仍然通栏 —— 那是「下面属于上面这一条」的意思。 */}
      {expanded && canExpand ? (
        <div className="mt-2 pt-2 border-t border-paper-deep/25">
          <div className="space-y-2.5 pl-[38px]">
          {/* 装 / 卸 / 自动更新都收在展开区里。
              卸载尤其不能常驻：它就在插件名下面，滑一下鼠标就点到了。 */}
          {manageable ? (
            <div>
              <p className="text-[10px] text-ink-ghost mb-1">管理</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {onReinstall ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onReinstall(record)}
                    title="从市场把这个版本重新装一遍（用来修好装坏的那份）"
                    className="px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    重新安装
                  </button>
                ) : null}
                {onUninstall ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onUninstall(record)}
                    className="px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-rust hover:bg-rust-mist/40 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    卸载
                  </button>
                ) : null}
                {/* 「自动更新」是一颗胶囊开关而不是复选框：它是个**长期生效**的开关，
                    复选框看起来像「这次要不要」，而这件事管的是以后每一次。
                    **按钮上不写「开 / 关」**：亮着就是开、暗着就是关，再写两个字反而
                    让这颗胶囊的宽窄随状态跳来跳去。无障碍那边由 `aria-checked` 交代。 */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={manifest.autoUpdate}
                  disabled={busy}
                  onClick={() => onToggleAutoUpdate(record)}
                  title={
                    manifest.autoUpdate
                      ? "市场有新版本时自动装（要新权限的版本不会被自动装，会先问你）。点一下关掉。"
                      : "市场有新版本时只提示，不自动装。点一下打开。"
                  }
                  className={`px-2.5 h-6 rounded-full text-[10px] transition-colors cursor-pointer disabled:opacity-40 ${
                    manifest.autoUpdate
                      ? "text-bamboo bg-bamboo-mist/60 ring-1 ring-bamboo/30"
                      : "text-ink-ghost bg-paper-warm hover:bg-paper-deep/30"
                  }`}
                >
                  自动更新
                </button>
              </div>
            </div>
          ) : null}

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
  /** 「去更新」要跳过去高亮的那一行。 */
  const [focusPlugin, setFocusPlugin] = useState<string | null>(null);

  /**
   * 市场清单。**只在配了市场时才有** —— 面板打开时会去取一次（与打开市场页签同一条路径），
   * 用来给「市场有新版本」那个徽标算依据。
   */
  const market = useMarket();
  const catalog = market.state.stage === "ready" ? market.state.catalog : null;

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

  /**
   * 装 / 卸那件事的控制器。**两个触发点共用它**：市场里那一行，和插件列表展开之后的
   * 「重新安装 / 卸载」—— 各持一份状态的话，两个确认框能同时挂出来。
   */
  const transfer = usePluginTransfer({ market, onChanged: handleMarketChanged });

  /** 卸载用的是市场那一套（它会问「数据要不要一起删」），所以要先凑出一个市场条目。 */
  const handleUninstall = useCallback(
    (record: PluginRuntimeRecord) => {
      const entry = catalog?.plugins.find((item) => item.name === record.manifest.name) ?? {
        name: record.manifest.name,
        description: "",
        releases: [],
      };
      transfer.requestUninstall(entry, record.manifest.version);
    },
    [catalog, transfer],
  );

  /**
   * 重新安装 = 把**当前这个版本**从市场再装一遍（用来修好装坏的那份）。
   *
   * 故意装同一个版本而不是最新版：想升级的话那一行上本来就有「去更新」，
   * 两个按钮做同一件事才是真的费解。清单里已经找不到这个版本时（发布者下架了旧版）
   * 才退回默认的那一版，并如实说出来。
   */
  const handleReinstall = useCallback(
    (record: PluginRuntimeRecord) => {
      const entry = catalog?.plugins.find((item) => item.name === record.manifest.name);
      const release = entry
        ? (entry.releases.find((item) => item.version === record.manifest.version) ??
          defaultRelease(entry))
        : null;
      if (!entry || !release) {
        showToast(`${record.manifest.name} 在市场清单里没有可装的版本`);
        return;
      }
      if (release.version !== record.manifest.version) {
        showToast(`市场里已经没有 v${record.manifest.version} 了，将装 v${release.version}`, "info");
      }
      transfer.requestInstall(entry, release, {
        installed: {
          version: record.manifest.version,
          grantedPermissions: record.manifest.grantedPermissions,
        },
      });
    },
    [catalog, transfer],
  );

  const handleToggleAutoUpdate = useCallback(async (record: PluginRuntimeRecord) => {
    setBusy(true);
    try {
      await setPluginAutoUpdate(record.manifest.name, !record.manifest.autoUpdate);
      // 与启停、改权限同一条路：写回状态文件之后重载一遍，界面上的那份才是新的。
      await reloadPlugins();
    } catch (error) {
      showToast(`切换自动更新失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  /** 已装插件的清单，喂给插件市场判断「装过没有、能不能更新」。 */
  const installedManifests = useMemo(() => plugins.map((record) => record.manifest), [plugins]);

  /** 「去更新」：跳到市场那个页签，并让那一行高亮出来。 */
  const handleGoToMarket = useCallback((name: string) => {
    setFocusPlugin(name);
    setTab("market");
  }, []);

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
            onClick={() => {
              setTab(entry.key);
              // 手点进来的就不高亮了 —— 高亮只服务于「去更新」那一下。
              setFocusPlugin(null);
            }}
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
                    updateTo={updateAvailable(record.manifest, catalog)}
                    onGoToMarket={handleGoToMarket}
                    onToggle={(item) => void handleToggle(item)}
                    onRevoke={(item, permission) => void handleRevoke(item, permission)}
                    onToggleExpand={handleToggleExpand}
                    onOpenDoc={onOpenDoc}
                    onToggleAutoUpdate={(item) => void handleToggleAutoUpdate(item)}
                    // 市场那一套只管得了市场装的：随应用分发的那份不该在界面上留一颗
                    // 点了就报错的按钮。
                    //
                    // 「重新安装」还要市场清单里确实有这个插件才给 —— 卸载不需要（它只认
                    // 本地目录），而没配市场时清单是空的，留一个点了只会弹「没有可装版本」
                    // 的按钮不如不给。
                    {...(record.manifest.origin === "market"
                      ? {
                          onUninstall: handleUninstall,
                          ...(catalog?.plugins.some(
                            (item) => item.name === record.manifest.name,
                          )
                            ? { onReinstall: handleReinstall }
                            : {}),
                        }
                      : {})}
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
          <MarketPanel
            installed={installedManifests}
            market={market}
            transfer={transfer}
            focusPlugin={focusPlugin}
            // 没装之前也能看说明：那份 README 是发布时内联进清单的（见 market/types.ts）。
            {...(onOpenDoc ? { onOpenDoc } : {})}
          />
        ) : null}
      </div>

      {/* 确认框挂在面板这一层，而不是市场那一栏里：插件列表里的「重新安装 / 卸载」走的是
          同一套确认流程，挂在市场那一栏的话，人在插件页签时它根本不在 DOM 里。 */}
      {transfer.pending?.kind === "install" ? (
        <ConfirmInstall
          plugin={transfer.pending.plugin}
          release={transfer.pending.release}
          {...(transfer.pending.installed ? { installed: transfer.pending.installed } : {})}
          {...(transfer.pending.conflict ? { conflict: transfer.pending.conflict } : {})}
          busy={transfer.busy}
          onCancel={transfer.dismiss}
          onConfirm={transfer.confirmInstall}
        />
      ) : null}

      {transfer.pending?.kind === "uninstall" ? (
        <ConfirmUninstall
          plugin={transfer.pending.plugin}
          installedVersion={transfer.pending.installedVersion}
          busy={transfer.busy}
          onCancel={transfer.dismiss}
          onConfirm={transfer.confirmUninstall}
        />
      ) : null}

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
