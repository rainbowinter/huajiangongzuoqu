import { useCallback, useMemo, useState } from "react";
import { getErrorMessage } from "../features/notes/api";
import { installPlugin, uninstallPlugin } from "../features/market/api";
import {
  blockedText,
  defaultRelease,
  findInstalled,
  formatSize,
  permissionsRequiringReview,
  releaseRelation,
  type MarketState,
} from "../features/market/presentation";
import type { MarketPlugin, MarketRelease } from "../features/market/types";
import { useMarket } from "../features/market/useMarket";
import { describePermission, isPermission, unknownPermissions } from "../features/plugins/permissions";
import type { PluginManifest } from "../features/plugins/types";
import { showToast } from "./Toast";

/**
 * 插件市场。
 *
 * 它是插件面板里的一个 **tab**，不是内建的侧栏面板 —— 后者要在
 * `sidePanelMode.ts` 的 `BUILT_IN` 里登记，漏了会渲染成一片空白而且不报错。
 *
 * ## 两条界面上的规矩
 *
 * 1. **装之前把权限一条条列清楚**（`PERMISSION_LABEL` 把 `fs:read` 那种串说成人话），
 *    用户点确认才发安装请求。确认的那份清单就是后端记下来授权的那份。
 * 2. **不能装的东西照样显示，只是带着原因禁用**。藏起来的话，用户以为市场里没有这个
 *    插件，或者以为市场坏了。
 */

interface MarketPanelProps {
  /** 已装的插件（来自宿主的注册表）。用来显示「已装 1.1.0」与判断能不能更新。 */
  installed: readonly PluginManifest[];
  /** 装完 / 卸完之后宿主该做的事：重载插件、刷新列表。 */
  onChanged: () => Promise<void>;
}

/** 确认框里在等用户点头的那件事。 */
type PendingAction =
  | {
      kind: "install";
      plugin: MarketPlugin;
      release: MarketRelease;
      /** 已装的那份（更新/换版本时带上，用来算「这次新增了哪些权限」）。 */
      installed?: { version: string; grantedPermissions: readonly string[] };
    }
  | { kind: "uninstall"; plugin: MarketPlugin; installedVersion: string };

export function MarketPanel({ installed, onChanged }: MarketPanelProps) {
  const { state, refresh } = useMarket();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  /** 用户手动选过的版本（按插件名记）。没选过就用清单给的默认版。 */
  const [chosenVersion, setChosenVersion] = useState<Record<string, string>>({});

  const chooseVersion = useCallback((name: string, version: string) => {
    setChosenVersion((current) => ({ ...current, [name]: version }));
  }, []);

  const runInstall = useCallback(
    async (plugin: MarketPlugin, release: MarketRelease) => {
      setBusy(true);
      try {
        const outcome = await installPlugin({
          name: plugin.name,
          version: release.version,
          url: release.url,
          sha256: release.sha256,
          // 用户在这个确认框里看到的就是这些 —— 原样交给后端，插件多要的一个都不给。
          approvedPermissions: release.permissions,
        });
        await onChanged();

        const action = outcome.replacedVersion ? "更新" : "安装";
        showToast(`${action}成功：${plugin.name} ${outcome.version}`, "info");
        if (outcome.extraPermissions.length > 0) {
          // 清单与插件对不上：多要的权限没生效，必须说出来，否则用户会以为功能坏了。
          showToast(
            `${plugin.name} 还声明了未确认的权限（${outcome.extraPermissions.join("、")}），未授权，相关功能可能不可用`,
            "info",
          );
        }

        setPending(null);
        await refresh();
      } catch (error) {
        // 后端给的都是具体原因（清单过期、同名插件、下载失败……），原样显示，别吞掉。
        showToast(`安装失败：${getErrorMessage(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [onChanged, refresh],
  );

  const runUninstall = useCallback(
    async (plugin: MarketPlugin, deleteData: boolean) => {
      setBusy(true);
      try {
        await uninstallPlugin(plugin.name, deleteData);
        await onChanged();
        showToast(
          `已卸载：${plugin.name}${deleteData ? "（数据也删了）" : "（数据保留）"}`,
          "info",
        );
        setPending(null);
        await refresh();
      } catch (error) {
        showToast(`卸载失败：${getErrorMessage(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [onChanged, refresh],
  );

  return (
    <>
      <CatalogBody
        state={state}
        installed={installed}
        busy={busy}
        chosenVersion={chosenVersion}
        onChooseVersion={chooseVersion}
        onRefresh={() => void refresh()}
        onInstall={(plugin, release, installed) =>
          setPending({ kind: "install", plugin, release, ...(installed ? { installed } : {}) })
        }
        onUninstall={(plugin, installedVersion) =>
          setPending({ kind: "uninstall", plugin, installedVersion })
        }
      />

      {pending?.kind === "install" ? (
        <ConfirmInstall
          plugin={pending.plugin}
          release={pending.release}
          {...(pending.installed ? { installed: pending.installed } : {})}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void runInstall(pending.plugin, pending.release)}
        />
      ) : null}

      {pending?.kind === "uninstall" ? (
        <ConfirmUninstall
          plugin={pending.plugin}
          installedVersion={pending.installedVersion}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={(deleteData) => void runUninstall(pending.plugin, deleteData)}
        />
      ) : null}
    </>
  );
}

function CatalogBody({
  state,
  installed,
  busy,
  chosenVersion,
  onChooseVersion,
  onRefresh,
  onInstall,
  onUninstall,
}: {
  state: MarketState;
  installed: readonly PluginManifest[];
  busy: boolean;
  chosenVersion: Record<string, string>;
  onChooseVersion: (name: string, version: string) => void;
  onRefresh: () => void;
  onInstall: (
    plugin: MarketPlugin,
    release: MarketRelease,
    installed?: { version: string; grantedPermissions: readonly string[] },
  ) => void;
  onUninstall: (plugin: MarketPlugin, version: string) => void;
}) {
  if (state.stage === "loading" || state.stage === "unknown") {
    return <p className="text-[12px] text-ink-ghost text-center py-8">正在获取插件列表…</p>;
  }

  if (state.stage === "unavailable") {
    return (
      <p className="text-[12px] text-ink-ghost text-center py-8">
        没有配置插件市场
      </p>
    );
  }

  if (state.stage === "error") {
    return (
      <div className="px-2 py-6 text-center space-y-2">
        <p className="text-[12px] text-rust break-words">{state.message}</p>
        <button
          type="button"
          onClick={onRefresh}
          className="px-2.5 h-7 rounded-lg text-[11px] text-ink-soft bg-paper-warm hover:bg-paper-deep/40 transition-colors cursor-pointer"
        >
          重试
        </button>
      </div>
    );
  }

  if (state.catalog.plugins.length === 0) {
    return <p className="text-[12px] text-ink-ghost text-center py-8">市场里还没有插件</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {state.catalog.plugins.map((plugin) => (
        <MarketRow
          key={`${plugin.name}-${plugin.newestVersion ?? ""}`}
          plugin={plugin}
          installedManifest={findInstalled(installed, plugin.name)}
          busy={busy}
          chosenVersion={chosenVersion[plugin.name]}
          onChooseVersion={onChooseVersion}
          onInstall={onInstall}
          onUninstall={onUninstall}
        />
      ))}
    </div>
  );
}

function MarketRow({
  plugin,
  installedManifest,
  busy,
  chosenVersion,
  onChooseVersion,
  onInstall,
  onUninstall,
}: {
  plugin: MarketPlugin;
  installedManifest: PluginManifest | undefined;
  busy: boolean;
  chosenVersion: string | undefined;
  onChooseVersion: (name: string, version: string) => void;
  onInstall: (
    plugin: MarketPlugin,
    release: MarketRelease,
    installed?: { version: string; grantedPermissions: readonly string[] },
  ) => void;
  onUninstall: (plugin: MarketPlugin, version: string) => void;
}) {
  const release = useMemo(() => {
    if (chosenVersion) {
      const picked = plugin.releases.find((item) => item.version === chosenVersion);
      if (picked) return picked;
    }
    return defaultRelease(plugin);
  }, [plugin, chosenVersion]);

  const installedVersion = installedManifest?.version;
  // 只有**市场装的**才能从这里更新/卸载。本地手写或随应用分发的同名插件，
  // 后端会拒绝覆盖（那会让内置版再也回不来），所以这里先禁掉并说清楚。
  const fromMarket = installedManifest?.origin === "market";
  const conflict = Boolean(installedManifest) && !fromMarket;

  const blocked = plugin.blocked ? blockedText(plugin.blocked) : null;
  const releaseBlocked = release ? blockedText(release.blocked) : null;
  const disabled = busy || Boolean(blocked) || Boolean(releaseBlocked) || conflict || !release;

  const label = useMemo(() => {
    if (!release) return "无可装版本";
    switch (releaseRelation(installedVersion, release.version)) {
      case "install":
        return "安装";
      case "newer":
        return "更新";
      case "older":
        return "装这个版本";
      default:
        return "重新安装";
    }
  }, [installedVersion, release]);

  const relation = release ? releaseRelation(installedVersion, release.version) : "install";

  return (
    <div className="px-3 py-2 rounded-xl hover:bg-paper-warm transition-colors">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-ink-soft truncate flex-1" title={plugin.name}>
          {plugin.name || "（无法识别的一条）"}
        </span>
        {release ? (
          <span className="text-[10px] text-ink-ghost shrink-0">
            v{release.version}
            {formatSize(release.size) ? ` · ${formatSize(release.size)}` : ""}
          </span>
        ) : null}
      </div>

      {installedVersion ? (
        <p className="text-[10px] text-ink-ghost mt-0.5">
          已装 v{installedVersion}
          {relation === "newer" && release ? ` · 可更新到 v${release.version}` : ""}
          {relation === "older" ? " · 选中的是旧版本" : ""}
          {relation === "unknown" ? " · 版本号没法比较" : ""}
          {!fromMarket ? " · 不是在市场装的" : ""}
        </p>
      ) : null}

      {plugin.description ? (
        <p className="text-[11px] text-ink-ghost mt-1 leading-relaxed">{plugin.description}</p>
      ) : null}

      <div className="flex items-center gap-1.5 mt-1">
        {plugin.author ? (
          <span className="text-[10px] text-ink-ghost shrink-0">{plugin.author}</span>
        ) : null}
        {plugin.latest && plugin.newestVersion !== plugin.latest ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-md text-ink-ghost bg-paper-warm">
            最新版装不了
          </span>
        ) : null}
      </div>

      {blocked ? (
        <p className="text-[10.5px] text-rust mt-1 leading-relaxed">{blocked}</p>
      ) : null}
      {releaseBlocked ? (
        <p className="text-[10.5px] text-rust mt-1 leading-relaxed">
          这一版装不了：{releaseBlocked}
        </p>
      ) : null}
      {conflict ? (
        <p className="text-[10.5px] text-amber mt-1 leading-relaxed">
          本地已经有一个同名插件，它不是在市场装的。市场不会覆盖它 ——
          想换成市场版的话，请先手动删掉 {installedManifest?.dirPath || plugin.name}。
        </p>
      ) : null}
      {release?.notes ? (
        <p className="text-[10.5px] text-ink-ghost mt-1 leading-relaxed">{release.notes}</p>
      ) : null}

      <div className="flex items-center gap-2 mt-2">
        {plugin.releases.length > 1 && release ? (
          <select
            value={release.version}
            disabled={busy}
            onChange={(event) => onChooseVersion(plugin.name, event.target.value)}
            title="装哪一个版本"
            className="text-[10px] px-1.5 h-6 rounded-md bg-paper-warm text-ink-soft border border-paper-deep/40 cursor-pointer disabled:opacity-40"
          >
            {plugin.releases.map((item) => (
              <option key={item.version} value={item.version} disabled={Boolean(item.blocked)}>
                v{item.version}
                {item.blocked ? "（不可用）" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex-1" />
        )}

        {fromMarket ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onUninstall(plugin, installedVersion ?? "")}
            className="shrink-0 px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-rust hover:bg-rust-mist/40 transition-colors cursor-pointer disabled:opacity-40"
          >
            卸载
          </button>
        ) : null}

        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            release &&
            onInstall(
              plugin,
              release,
              // 已经是市场装的才算「更新」：确认框要靠这份算新增权限。
              fromMarket && installedManifest
                ? {
                    version: installedManifest.version,
                    grantedPermissions: installedManifest.grantedPermissions,
                  }
                : undefined,
            )
          }
          className={`shrink-0 px-2.5 h-6 rounded-md text-[10.5px] transition-colors ${
            disabled
              ? "text-ink-ghost bg-paper-warm cursor-default"
              : "text-bamboo bg-bamboo-mist/50 hover:bg-bamboo-mist cursor-pointer"
          }`}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

/**
 * 装之前把要给的权限一条条摆出来。用户点了「安装」才真的发请求。
 *
 * 导出是为了让 `MarketPanel.test.tsx` 能单独渲染它核对文案 —— 仓库里没有
 * @testing-library（没有 jsdom），组件只能靠 `renderToStaticMarkup` 验。
 */
export function ConfirmInstall({
  plugin,
  release,
  installed,
  busy,
  onCancel,
  onConfirm,
}: {
  plugin: MarketPlugin;
  release: MarketRelease;
  /**
   * 已装的那一份（更新 / 换版本时给）。**有它才会算「这次新增了哪些权限」** ——
   * 那一步是更新流程里最要紧的：新版本多要一个权限，必须让用户再看一眼。
   */
  installed?: { version: string; grantedPermissions: readonly string[] };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const unknown = unknownPermissions(release.permissions);
  const isUpdate = Boolean(installed);
  const added = installed
    ? permissionsRequiringReview(installed.grantedPermissions, release.permissions)
    : [];
  const title = isUpdate
    ? `更新 ${plugin.name} ${installed?.version} → ${release.version}`
    : `安装 ${plugin.name} ${release.version}`;

  return (
    <Modal onCancel={onCancel} title={title}>
      <div className="space-y-3">
        {/* 更新时先摆「这次多了什么权限」：用户上次确认的是旧那份，多出来的必须重看。 */}
        {isUpdate ? (
          added.length > 0 ? (
            <div className="rounded-lg bg-bamboo-mist/30 px-2.5 py-2">
              {/* ⚠️ 这里不能写 `**新的**` —— JSX 里那两个字面星号会原样显示出来。 */}
              <p className="text-[11px] text-ink-soft mb-1">
                这一版要求下面这些<em className="not-italic font-medium">新的</em>权限：
              </p>
              <ul className="space-y-0.5">
                {added.map((permission) => (
                  <li key={permission} className="text-[11px] leading-relaxed">
                    <span className="text-ink-soft">{describePermission(permission)}</span>{" "}
                    <span className="font-mono text-[10px] text-ink-ghost">{permission}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[11px] text-ink-ghost">权限没有变化。</p>
          )
        ) : null}

        <div>
          <p className="text-[11px] text-ink-ghost mb-1.5">
            {release.permissions.length > 0
              ? isUpdate
                ? "这一版的全部权限："
                : "这个插件要使用以下权限："
              : "这个插件没有声明任何权限。"}
          </p>
          <ul className="space-y-1">
            {release.permissions.map((permission) => (
              <li key={permission} className="text-[11px] leading-relaxed">
                <span className="text-ink-soft">{describePermission(permission)}</span>{" "}
                <span
                  className={`font-mono text-[10px] ${
                    isPermission(permission) ? "text-ink-ghost" : "text-rust line-through"
                  }`}
                >
                  {permission}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {unknown.length > 0 ? (
          <p className="text-[10.5px] text-rust leading-relaxed">
            其中 {unknown.join("、")} 是当前版本不认识的新权限，装进去也不会生效。
          </p>
        ) : null}

        {release.notes ? (
          <p className="text-[10.5px] text-ink-ghost leading-relaxed">{release.notes}</p>
        ) : null}

        <p className="text-[10.5px] text-ink-ghost leading-relaxed border-t border-paper-deep/30 pt-2">
          插件是第三方代码，在沙箱里运行，只能做上面这些事。以后它想多要权限，必须你重新确认。
        </p>
      </div>

      <ModalActions
        busy={busy}
        onCancel={onCancel}
        confirmLabel={isUpdate ? "更新" : "安装"}
        onConfirm={onConfirm}
      />
    </Modal>
  );
}

/** 卸载时**必须**问一句数据怎么办：默认留着（重装能恢复），删了不可恢复。 */
export function ConfirmUninstall({
  plugin,
  installedVersion,
  busy,
  onCancel,
  onConfirm,
}: {
  plugin: MarketPlugin;
  installedVersion: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (deleteData: boolean) => void;
}) {
  return (
    <Modal onCancel={onCancel} title={`卸载 ${plugin.name}${installedVersion ? ` ${installedVersion}` : ""}`}>
      <p className="text-[11px] text-ink-ghost leading-relaxed mb-3">
        插件代码会被删掉。它在自己数据目录里存的东西（设置、缓存、批注之类）要不要一起删？
      </p>
      <ul className="space-y-1 mb-2">
        <li className="text-[10.5px] text-ink-ghost leading-relaxed">
          <span className="text-ink-soft">保留</span>：以后重新装回来，设置还在。
        </li>
        <li className="text-[10.5px] text-ink-ghost leading-relaxed">
          <span className="text-rust">一起删</span>：不可恢复。
        </li>
      </ul>

      <div className="flex items-center justify-end gap-2 mt-4">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="px-3 h-7 rounded-lg text-[11px] text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirm(false)}
          className="px-3 h-7 rounded-lg text-[11px] text-ink-soft bg-paper-warm hover:bg-paper-deep/40 transition-colors cursor-pointer disabled:opacity-40"
        >
          保留数据并卸载
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirm(true)}
          className="px-3 h-7 rounded-lg text-[11px] text-rust bg-rust-mist/40 hover:bg-rust-mist/60 transition-colors cursor-pointer disabled:opacity-40"
        >
          连数据一起删
        </button>
      </div>
    </Modal>
  );
}

/** 与 `PluginPromptDialog` 用的是同一套模态观感（那里也是自己渲染的，见其注释）。 */
function Modal({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[9500] flex items-center justify-center bg-ink/20 backdrop-blur-[2px]"
      // 点遮罩关掉，与提示框一致。确认框里没有任何「已经发生了一半」的状态，关掉是安全的。
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-[400px] max-h-[70vh] overflow-y-auto rounded-2xl bg-cloud/98 border border-paper-deep/40 shadow-xl p-5"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <h3 className="text-[13px] text-ink mb-3">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function ModalActions({
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 mt-4">
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className="px-3 h-7 rounded-lg text-[11px] text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
      >
        取消
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        className="px-3 h-7 rounded-lg text-[11px] text-bamboo bg-bamboo-mist/50 hover:bg-bamboo-mist transition-colors cursor-pointer disabled:opacity-40"
      >
        {busy ? "处理中…" : confirmLabel}
      </button>
    </div>
  );
}
