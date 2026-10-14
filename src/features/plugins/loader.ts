/**
 * 插件加载分发器。
 *
 * 这里只做三件事：读清单 → 按 `apiVersion` 选运行时 → 管生命周期。两条运行时的
 * 差异全部封装在各自的 host 里，loader 本身不含任何插件执行逻辑——否则它会退化成
 * 第二个「什么都塞进去」的 MainWindow。
 *
 * | apiVersion | 运行时 | 隔离 | 权限门 |
 * |---|---|---|---|
 * | 1（缺省） | `hosts/v1Host` 主线程 `new Function` | 无 | 不适用 |
 * | 2 | `hosts/v2Host` 沙箱 Worker | 有 | 有 |
 */

import { showToast } from "../../components/Toast";
import { getErrorMessage } from "../notes/api";
import { listPlugins, readPlugin } from "./api";
import { loadV1Plugin } from "./hosts/v1Host";
import { createV2PluginHost } from "./hosts/v2Host";
import { clearPluginLogs } from "./logs";
import type { EditorMirror, UnloadReason } from "./protocol";
import { clearAllPlugins, registerLoadedPlugin, unregisterPlugin } from "./registry";
import { resetPluginStores } from "./stores";
import type { PluginManifest, Selection } from "./types";

interface RunningPlugin {
  manifest: PluginManifest;
  dispose(reason?: UnloadReason): Promise<void>;
  updateMirror?(patch: Partial<EditorMirror>): void;
  refreshStatusBar?(selection: Selection | null): void;
}

const running = new Map<string, RunningPlugin>();
let loaded = false;

export async function loadPlugins(): Promise<void> {
  if (loaded) return;
  await doLoad();
}

export async function reloadPlugins(): Promise<void> {
  await unloadAll("reload");
  clearAllPlugins();
  resetPluginStores();
  clearPluginLogs();
  loaded = false;
  await doLoad();
}

async function unloadAll(reason: UnloadReason): Promise<void> {
  const plugins = [...running.values()];
  running.clear();
  await Promise.all(
    plugins.map(async (plugin) => {
      try {
        await plugin.dispose(reason);
      } catch (error) {
        console.error(`[plugins] 卸载 ${plugin.manifest.name} 失败`, error);
      }
      unregisterPlugin(plugin.manifest.name);
    }),
  );
}

async function doLoad(): Promise<void> {
  loaded = true;

  let manifests: PluginManifest[];
  try {
    manifests = await listPlugins();
  } catch (error) {
    showToast(`读取插件列表失败：${getErrorMessage(error)}`);
    return;
  }

  for (const manifest of manifests) {
    if (!manifest.enabled) {
      registerLoadedPlugin(manifest, "disabled");
      continue;
    }

    if (!manifest.valid) {
      // 坏掉的插件也要在界面上出现，否则用户只会觉得"插件没生效"。
      registerLoadedPlugin(manifest, "invalid", manifest.invalidReason);
      continue;
    }

    try {
      if (manifest.apiVersion >= 2) {
        await loadV2(manifest);
      } else {
        await loadV1(manifest);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      registerLoadedPlugin(manifest, "failed", message);
      showToast(`插件 ${manifest.name} 加载失败：${message}`);
    }
  }
}

async function loadV1(manifest: PluginManifest): Promise<void> {
  const code = await readPlugin(manifest.name);
  const instance = await loadV1Plugin(manifest, code);

  running.set(manifest.name, {
    manifest,
    dispose: () => instance.dispose(),
  });

  registerLoadedPlugin(manifest, "legacy");
}

async function loadV2(manifest: PluginManifest): Promise<void> {
  const code = await readPlugin(manifest.name);
  const host = await createV2PluginHost({ manifest, code });

  running.set(manifest.name, {
    manifest,
    dispose: (reason) => host.dispose(reason),
    updateMirror: (patch) => host.updateMirror(patch),
    refreshStatusBar: (selection) => host.refreshStatusBar(selection),
  });

  registerLoadedPlugin(manifest, "loaded");
}

// -------------------------------------------------------------- 宿主调用

/**
 * 把当前编辑器状态推给 v2 插件。
 *
 * 这是「镜像」机制：插件侧可以用 `editor.getContentSync()` 同步读到内容，
 * 从而让 `outline` 那种「渲染时同步读正文」的老写法在 v2 下依然成立。
 */
export function updatePluginEditorMirror(patch: Partial<EditorMirror>): void {
  for (const plugin of running.values()) {
    plugin.updateMirror?.(patch);
  }
}

/** 选区变化时让 v2 状态栏项重新计算。 */
export function refreshPluginStatusBar(selection: Selection | null): void {
  for (const plugin of running.values()) {
    plugin.refreshStatusBar?.(selection);
  }
}

/** 仅供测试：重置加载状态。 */
export function resetPluginLoaderForTests(): void {
  running.clear();
  loaded = false;
}
