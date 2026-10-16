import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  blockedText,
  defaultRelease,
  filterCatalogPlugins,
  findInstalled,
  formatSize,
  permissionsRequiringReview,
  releaseRelation,
  sortCatalogPlugins,
  type MarketState,
} from "../features/market/presentation";
import type { MarketPlugin, MarketRelease } from "../features/market/types";
import type { MarketController } from "../features/market/useMarket";
import type { LocalConflict, PluginTransfer } from "../features/market/usePluginTransfer";
import { describePermission, isPermission, unknownPermissions } from "../features/plugins/permissions";
import type { PluginManifest } from "../features/plugins/types";
import { Modal, ModalActions } from "./Modal";
import { PluginIcon } from "./PluginIcon";

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
  /**
   * 清单的取回状态。**由面板外面传进来**，不是这里自己 `useMarket()` —— 插件列表那边
   * 也要用它算「市场有新版本」，两个 hook 实例会各取一次清单。
   */
  market: MarketController;
  /**
   * 装 / 卸那件事的控制器。**同样由面板外面传进来**：插件列表展开之后的「重新安装 /
   * 卸载」要走同一套确认框，两处各持一份状态就会出现两个确认框。
   */
  transfer: PluginTransfer;
  /** 从「去更新」跳过来时，把这一行高亮出来（免得用户在列表里找不到）。 */
  focusPlugin?: string | null;
  /**
   * 打开一篇只读说明文档（「详细信息」）。快速便签窗口没有能放文档的地方，那边不传，
   * 按钮就不出现。
   */
  onOpenDoc?: (title: string, content: string) => void;
}

export function MarketPanel({
  installed,
  market,
  transfer,
  focusPlugin,
  onOpenDoc,
}: MarketPanelProps) {
  const { state, refresh } = market;
  /** 用户手动选过的版本（按插件名记）。没选过就用清单给的默认版。 */
  const [chosenVersion, setChosenVersion] = useState<Record<string, string>>({});

  const chooseVersion = useCallback((name: string, version: string) => {
    setChosenVersion((current) => ({ ...current, [name]: version }));
  }, []);

  return (
    <CatalogBody
      state={state}
      installed={installed}
      focusPlugin={focusPlugin}
      busy={transfer.busy}
      chosenVersion={chosenVersion}
      onChooseVersion={chooseVersion}
      onRefresh={() => void refresh()}
      onInstall={transfer.requestInstall}
      onUninstall={transfer.requestUninstall}
      {...(onOpenDoc ? { onOpenDoc } : {})}
    />
  );
}

function CatalogBody({
  state,
  installed,
  focusPlugin,
  busy,
  chosenVersion,
  onChooseVersion,
  onRefresh,
  onInstall,
  onUninstall,
  onOpenDoc,
}: {
  state: MarketState;
  installed: readonly PluginManifest[];
  focusPlugin?: string | null;
  busy: boolean;
  chosenVersion: Record<string, string>;
  onChooseVersion: (name: string, version: string) => void;
  onRefresh: () => void;
  onInstall: (
    plugin: MarketPlugin,
    release: MarketRelease,
    options?: {
      installed?: { version: string; grantedPermissions: readonly string[] };
      conflict?: LocalConflict;
    },
  ) => void;
  onUninstall: (plugin: MarketPlugin, version: string) => void;
  onOpenDoc?: (title: string, content: string) => void;
}) {
  // ⚠️ hook 要在**所有提前 return 之前**：写在下面那几个分支之后，就是「有时调、有时不调」，
  // React 会直接报错（而且这个文件的几个分支是常态，不是边角情况）。
  const [query, setQuery] = useState("");

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

  // 先过滤再排序：排序只影响「谁在前面」，与搜索无关，两件事分开写才各自说得清。
  const visible = sortCatalogPlugins(
    filterCatalogPlugins(state.catalog.plugins, query),
    installed,
  );

  return (
    <div className="flex flex-col gap-1">
      {/* 搜索框常驻在列表顶上：插件多起来之后，靠肉眼在几十行里找一个是找不动的。 */}
      <div className="relative px-1 pb-1">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索插件（名字 / 说明 / 作者）"
          className="w-full h-7 rounded-lg bg-paper-warm pl-7 pr-2 text-[11.5px] text-ink-soft placeholder:text-ink-ghost/70 focus:outline-none focus:ring-1 focus:ring-bamboo/40"
        />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="absolute left-3 top-[7px] w-3.5 h-3.5 text-ink-ghost/70 pointer-events-none"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </div>

      {visible.length === 0 ? (
        <p className="text-[12px] text-ink-ghost text-center py-8">
          {`没有匹配「${query.trim()}」的插件`}
        </p>
      ) : null}

      {visible.map((plugin) => (
        <MarketRow
          key={`${plugin.name}-${plugin.newestVersion ?? ""}`}
          plugin={plugin}
          installedManifest={findInstalled(installed, plugin.name)}
          focused={plugin.name === focusPlugin}
          busy={busy}
          chosenVersion={chosenVersion[plugin.name]}
          onChooseVersion={onChooseVersion}
          onInstall={onInstall}
          onUninstall={onUninstall}
          {...(onOpenDoc ? { onOpenDoc } : {})}
        />
      ))}
    </div>
  );
}

function MarketRow({
  plugin,
  installedManifest,
  focused,
  busy,
  chosenVersion,
  onChooseVersion,
  onInstall,
  onUninstall,
  onOpenDoc,
}: {
  plugin: MarketPlugin;
  installedManifest: PluginManifest | undefined;
  /** 刚被「去更新」跳过来指着的那个插件。 */
  focused: boolean;
  busy: boolean;
  chosenVersion: string | undefined;
  onChooseVersion: (name: string, version: string) => void;
  onInstall: (
    plugin: MarketPlugin,
    release: MarketRelease,
    options?: {
      installed?: { version: string; grantedPermissions: readonly string[] };
      conflict?: LocalConflict;
    },
  ) => void;
  onUninstall: (plugin: MarketPlugin, version: string) => void;
  onOpenDoc?: (title: string, content: string) => void;
}) {
  const release = useMemo(() => {
    if (chosenVersion) {
      const picked = plugin.releases.find((item) => item.version === chosenVersion);
      if (picked) return picked;
    }
    return defaultRelease(plugin);
  }, [plugin, chosenVersion]);

  const installedVersion = installedManifest?.version;
  // 本地已有的同名插件不是在市场装的 → 装市场版会把它**替换**掉。
  // 这件事由后端把关（不带 `replaceLocal` 直接拒），界面上再问一次用户，
  // 并说明原版会备份下来、卸载时装回来 —— 不然就是一条死胡同（让人自己去删目录）。
  const fromMarket = installedManifest?.origin === "market";
  const conflict = Boolean(installedManifest) && !fromMarket;
  const localConflict: LocalConflict | undefined =
    conflict && installedManifest
      ? { version: installedManifest.version, origin: installedManifest.origin }
      : undefined;

  const blocked = plugin.blocked ? blockedText(plugin.blocked) : null;
  const releaseBlocked = release ? blockedText(release.blocked) : null;
  const disabled = busy || Boolean(blocked) || Boolean(releaseBlocked) || !release;

  const label = useMemo(() => {
    if (!release) return "无可装版本";
    if (conflict) return "替换安装";
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
  }, [conflict, installedVersion, release]);

  const relation = release ? releaseRelation(installedVersion, release.version) : "install";

  // 「去更新」跳过来时把这一行滚到中间 —— 列表长了以后用户根本找不到是哪一个。
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "center" });
  }, [focused]);

  // 图标优先用清单里的（那是**将要装上的那一版**），其次用本地已装那份的，都没有就用默认。
  const icon = plugin.icon ?? installedManifest?.icon;

  /**
   * 装过的这一行**变灰**。
   *
   * 不是禁用 —— 底下的版本选择与「更新 / 卸载」照样能点，只是让眼睛先跳过它：
   * 已经装好的插件在这张表里已经没有可看的东西了（`sortCatalogPlugins` 也把它们沉到
   * 了后面）。被「去更新」跳过来的那一行**不灰**，否则用户盯着一个灰蒙蒙的行，
   * 分不清是自己点错了还是界面在提示什么。
   */
  const dim = Boolean(installedVersion) && !focused;

  return (
    <div
      ref={rowRef}
      className={`px-3 py-2 rounded-xl transition-colors ${
        focused ? "bg-bamboo-mist/25 ring-1 ring-bamboo/30" : "hover:bg-paper-warm"
      }`}
    >
      {/* 图标一列、正文一列：市场里插件多，**图标的辨识度比名字高**，
          所以它比正文大得多（32px）。 */}
      <div className="flex items-start gap-3">
        <PluginIcon
          icon={icon}
          size={32}
          className={`mt-0.5 ${dim ? "text-ink-ghost/30" : "text-ink-ghost/60"}`}
        />
        <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-[12.5px] truncate flex-1 ${
              dim ? "text-ink-ghost" : "text-ink-soft"
            }`}
            title={plugin.name}
          >
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
          <p className={`text-[10px] mt-0.5 ${dim ? "text-ink-ghost/70" : "text-ink-ghost"}`}>
            已装 v{installedVersion}
            {relation === "newer" && release ? ` · 可更新到 v${release.version}` : ""}
            {relation === "older" ? " · 选中的是旧版本" : ""}
            {relation === "unknown" ? " · 版本号没法比较" : ""}
            {!fromMarket ? " · 不是在市场装的" : ""}
          </p>
        ) : null}

        {plugin.description ? (
          <p
            className={`text-[11px] mt-1 leading-relaxed ${
              dim ? "text-ink-ghost/70" : "text-ink-ghost"
            }`}
          >
            {plugin.description}
          </p>
        ) : null}

        <div className="flex items-center gap-1.5 mt-1">
          {plugin.author ? (
            <span className="text-[10px] text-ink-ghost/80 shrink-0">{plugin.author}</span>
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
            本地已经有一个同名插件，它不是在市场装的。点「替换安装」可以用市场版替掉它 ——
            原版会被备份下来，卸载时自动装回。
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

          {/* 「详细信息」：**装之前**也能看这个插件是干嘛的 —— 打开的是发布时内联进清单的
              那份 README（`plugin.readme`）。装完之后看的是磁盘上那份（可能被作者改过），
              两条路径各自取最新的一份。没带说明就不给这颗按钮。 */}
          {onOpenDoc && plugin.readme ? (
            <button
              type="button"
              onClick={() => onOpenDoc(plugin.name, plugin.readme ?? "")}
              className="shrink-0 px-2 h-6 rounded-md text-[10px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
              title="这个插件是干嘛的（作者写的说明）"
            >
              详细信息
            </button>
          ) : null}

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
              onInstall(plugin, release, {
                // 已经是市场装的才算「更新」：确认框要靠这份算新增权限。
                ...(fromMarket && installedManifest
                  ? {
                      installed: {
                        version: installedManifest.version,
                        grantedPermissions: installedManifest.grantedPermissions,
                      },
                    }
                  : {}),
                ...(localConflict ? { conflict: localConflict } : {}),
              })
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
  conflict,
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
  /** 本地已有的同名插件（不是在市场装的）——这次会把它替掉。 */
  conflict?: LocalConflict;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const unknown = unknownPermissions(release.permissions);
  const isUpdate = Boolean(installed);
  const added = installed
    ? permissionsRequiringReview(installed.grantedPermissions, release.permissions)
    : [];
  const title = conflict
    ? `替换 ${plugin.name} ${conflict.version} → ${release.version}`
    : isUpdate
      ? `更新 ${plugin.name} ${installed?.version} → ${release.version}`
      : `安装 ${plugin.name} ${release.version}`;

  return (
    <Modal onCancel={onCancel} title={title}>
      <div className="space-y-3">
        {/* 替换本地插件：先把「你的东西会怎样」说清楚 —— 只会被搬走，不会被删掉。 */}
        {conflict ? (
          <div className="rounded-lg bg-rust-mist/30 px-2.5 py-2">
            <p className="text-[11px] text-ink-soft leading-relaxed">
              本地已经有一个「{plugin.name} {conflict.version}」，它
              {conflict.origin === "bundled" ? "是随花笺一起装的" : "是你自己放进插件目录的"}。
            </p>
            <p className="text-[10.5px] text-ink-ghost leading-relaxed mt-1">
              装市场版会把它<strong className="font-medium text-ink-soft">搬去备份</strong>
              （不是删掉），放在插件数据目录的 <code className="font-mono">plugin-data/{plugin.name}/.replaced/</code> 下。
              以后在插件面板点「卸载」，它会自动装回来。
            </p>
          </div>
        ) : null}

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
        confirmLabel={conflict ? "替换安装" : isUpdate ? "更新" : "安装"}
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
      {/* 当初是用「替换安装」装上来的话，卸载会把原版放回去 —— 先说清楚，免得用户
          以为卸载没干净。后端就是这么做的（见 install.rs 的 restore_replaced）。 */}
      <p className="text-[10.5px] text-ink-ghost leading-relaxed mb-2">
        如果这个插件当初替换掉了本地的一个同名插件，卸载时会把它<strong className="font-medium text-ink-soft">装回</strong>来。
      </p>

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
