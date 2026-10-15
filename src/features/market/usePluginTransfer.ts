import { useCallback, useState } from "react";
import { getErrorMessage } from "../notes/api";
import { showToast } from "../../components/Toast";
import { installPlugin, uninstallPlugin } from "./api";
import type { MarketPlugin, MarketRelease } from "./types";
import type { MarketController } from "./useMarket";

/**
 * 装 / 卸插件这一件事的**唯一入口**。
 *
 * 提到 hook 里、而不是留在市场那个 tab 里，是因为触发点有两个：市场里那一行，以及
 * 插件列表（已装的插件）展开之后的「重新安装 / 卸载」。两处走的必须是同一套确认框与
 * 同一套后端调用 —— 复制一份的话，迟早有一边忘记把权限列全，或者忘记带 `replaceLocal`。
 *
 * 这里**只发请求**，不渲染任何东西：确认框长什么样是界面的事（`MarketPanel.tsx` 里的
 * `ConfirmInstall` / `ConfirmUninstall`，由 `PluginCommandPanel` 渲染一次）。
 */

/** 本地已有的同名插件（不是在市场装的）——替换它需要用户再点一次头。 */
export interface LocalConflict {
  version: string;
  /** `bundled` = 随应用分发的，其余是用户自己放进去的。提示语气不一样。 */
  origin: string | undefined;
}

/** 正在等用户点头的那件事。 */
export type PendingAction =
  | {
      kind: "install";
      plugin: MarketPlugin;
      release: MarketRelease;
      /** 已装的那份（更新 / 换版本 / 重装时带上，用来算「这次新增了哪些权限」）。 */
      installed?: { version: string; grantedPermissions: readonly string[] };
      /** 正在替换一个本地同名插件。 */
      conflict?: LocalConflict;
    }
  | { kind: "uninstall"; plugin: MarketPlugin; installedVersion: string };

export interface PluginTransfer {
  busy: boolean;
  pending: PendingAction | null;
  requestInstall: (
    plugin: MarketPlugin,
    release: MarketRelease,
    options?: {
      installed?: { version: string; grantedPermissions: readonly string[] };
      conflict?: LocalConflict;
    },
  ) => void;
  requestUninstall: (plugin: MarketPlugin, installedVersion: string) => void;
  /** 用户在确认框上按了取消。 */
  dismiss: () => void;
  /** 确认安装 —— 这才真的发请求。调用的那份 `pending` 必须是 install。 */
  confirmInstall: () => void;
  /** 确认卸载；「数据要不要一起删」由确认框上那颗勾决定（默认不删）。 */
  confirmUninstall: (deleteData: boolean) => void;
}

export function usePluginTransfer(options: {
  market: MarketController;
  /** 装完 / 卸完之后宿主该做的事：重载插件、刷新列表。 */
  onChanged: () => Promise<void>;
}): PluginTransfer {
  const { market, onChanged } = options;
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const runInstall = useCallback(
    async (plugin: MarketPlugin, release: MarketRelease, conflict?: LocalConflict) => {
      setBusy(true);
      try {
        const outcome = await installPlugin({
          name: plugin.name,
          version: release.version,
          url: release.url,
          sha256: release.sha256,
          // 用户在这个确认框里看到的就是这些 —— 原样交给后端，插件多要的一个都不给。
          approvedPermissions: release.permissions,
          // 只有用户为「替换本地插件」单独点过头，才允许覆盖。
          replaceLocal: Boolean(conflict),
        });
        await onChanged();

        if (outcome.localBackupPath) {
          showToast(`已替换本地版本：${plugin.name} ${outcome.replacedVersion ?? ""}`, "info");
          showToast(`原版已备份到 ${outcome.localBackupPath}（卸载时会装回来）`, "info");
        } else {
          showToast(
            `${outcome.replacedVersion ? "更新" : "安装"}成功：${plugin.name} ${outcome.version}`,
            "info",
          );
        }
        if (outcome.extraPermissions.length > 0) {
          // 清单与插件对不上：多要的权限没生效，必须说出来，否则用户会以为功能坏了。
          showToast(
            `${plugin.name} 还声明了未确认的权限（${outcome.extraPermissions.join("、")}），未授权，相关功能可能不可用`,
            "info",
          );
        }

        setPending(null);
        await market.refresh();
      } catch (error) {
        // 后端给的都是具体原因（清单过期、同名插件、下载失败……），原样显示，别吞掉。
        showToast(`安装失败：${getErrorMessage(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [market, onChanged],
  );

  const runUninstall = useCallback(
    async (plugin: MarketPlugin, deleteData: boolean) => {
      setBusy(true);
      try {
        const outcome = await uninstallPlugin(plugin.name, deleteData);
        await onChanged();
        const restored = outcome.restoredVersion
          ? `，并装回了被它替换掉的本地版本 ${outcome.restoredVersion}`
          : "";
        showToast(
          `已卸载：${plugin.name}${deleteData ? "（数据也删了）" : "（数据保留）"}${restored}`,
          "info",
        );
        setPending(null);
        await market.refresh();
      } catch (error) {
        showToast(`卸载失败：${getErrorMessage(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [market, onChanged],
  );

  const confirmInstall = useCallback(() => {
    if (pending?.kind !== "install") return;
    void runInstall(pending.plugin, pending.release, pending.conflict);
  }, [pending, runInstall]);

  const confirmUninstall = useCallback(
    (deleteData: boolean) => {
      if (pending?.kind !== "uninstall") return;
      void runUninstall(pending.plugin, deleteData);
    },
    [pending, runUninstall],
  );

  return {
    busy,
    pending,
    requestInstall: (plugin, release, installOptions) =>
      setPending({
        kind: "install",
        plugin,
        release,
        ...(installOptions?.installed ? { installed: installOptions.installed } : {}),
        ...(installOptions?.conflict ? { conflict: installOptions.conflict } : {}),
      }),
    requestUninstall: (plugin, installedVersion) =>
      setPending({ kind: "uninstall", plugin, installedVersion }),
    dismiss: () => setPending(null),
    confirmInstall,
    confirmUninstall,
  };
}
