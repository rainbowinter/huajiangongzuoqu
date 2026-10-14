import { useEffect, useState } from "react";
import { getPluginsDir, openPluginsDir } from "../features/plugins/api";
import { reloadPlugins } from "../features/plugins/loader";
import { listLoadedPlugins, subscribeLoadedPlugins } from "../features/plugins/registry";
import type { PluginManifest } from "../features/plugins/types";
import { showToast } from "./Toast";

interface PluginCommandPanelProps {
  onClose: () => void;
}

export function PluginCommandPanel({ onClose }: PluginCommandPanelProps) {
  const [plugins, setPlugins] = useState<PluginManifest[]>(() => listLoadedPlugins());
  const [pluginsDir, setPluginsDir] = useState("");

  useEffect(() => subscribeLoadedPlugins(() => setPlugins(listLoadedPlugins())), []);

  useEffect(() => {
    getPluginsDir()
      .then(setPluginsDir)
      .catch(() => undefined);
  }, []);

  const handleRefresh = async () => {
    await reloadPlugins();
    showToast("插件已刷新", "info");
  };

  const handleOpenDir = async () => {
    try {
      await openPluginsDir();
    } catch (error) {
      showToast(`打开插件文件夹失败：${String(error)}`);
    }
  };

  return (
    <aside className="w-[360px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between shrink-0">
        <span className="text-[13px] font-medium text-ink">插件</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            className="w-6 h-6 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
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

      <div className="px-3 pb-2 flex-1 min-h-0 overflow-y-auto">
        {plugins.length === 0 ? (
          <p className="text-[12px] text-ink-ghost text-center py-8">暂无插件</p>
        ) : (
          <div className="flex flex-col gap-1">
            {plugins.map((plugin) => (
              <div
                key={plugin.name}
                className="px-3 py-2 rounded-xl hover:bg-paper-warm transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] text-ink-soft">{plugin.name}</span>
                  <span className="text-[10px] text-ink-ghost shrink-0">v{plugin.version}</span>
                </div>
                {plugin.description ? (
                  <p className="text-[11px] text-ink-ghost mt-0.5">{plugin.description}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
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
