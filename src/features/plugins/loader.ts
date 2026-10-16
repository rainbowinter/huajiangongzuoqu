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
import { getPluginSyncReport, listPlugins, readPlugin } from "./api";
import { loadV1Plugin } from "./hosts/v1Host";
import { createV2PluginHost } from "./hosts/v2Host";
import { clearPluginLogs } from "./logs";
import type { EditorMirror, UnloadReason } from "./protocol";
import { clearAllPlugins, registerLoadedPlugin, unregisterPlugin } from "./registry";
import { resetPluginStores } from "./stores";
import { clearViewDocumentCache } from "./viewAssets";
import type { PluginManifest, PluginSyncReport, Selection } from "./types";

interface RunningPlugin {
  manifest: PluginManifest;
  dispose(reason?: UnloadReason): Promise<void>;
  updateMirror?(patch: Partial<EditorMirror>): void;
  refreshStatusBar?(selection: Selection | null): void;
  /** 只有 v2 宿主有：v1 跑在主线程，读设置是同步的，不需要推送。 */
  refreshSettings?(): void;
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
  // 视图的 srcdoc 是按**类型 id** 缓存的（pdf.js 那种库读一次是兆级字符串，不能每次打开
  // 都重来）。但重新加载插件正是为了让新代码生效 —— 不清这一份，市场里装了新版本、
  // 界面还是老的，得重启应用才看得见。
  clearViewDocumentCache();
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

  // 先报「这次启动顺手更新了哪些插件」。校正本身在 Rust 侧的 `.setup` 里就做完了，
  // 这里只是把结果取回来告诉用户 —— 后端**取过即清空**，所以重复调用（HMR、重载插件）
  // 只会拿到 null，不会重复提示。
  void reportBundledPluginSync();

  // 清一次再装。`loaded` 只是**本模块**的守卫，而 Vite HMR 重新求值本模块时它会
  // 归零，注册表（registry.ts）的模块状态却还在 —— 不清就会把同一批插件登记第二
  // 遍，表现为侧栏与工具栏里每个插件页签都出现两份、三份，把工具栏挤得放不下。
  clearAllPlugins();

  let manifests: PluginManifest[];
  try {
    manifests = await listPlugins();
  } catch (error) {
    showToast(`读取插件列表失败：${getErrorMessage(error)}`);
    return;
  }

  for (const manifest of loadOrder(manifests)) {
    if (!manifest.enabled) {
      registerLoadedPlugin(manifest, "disabled");
      continue;
    }

    if (!manifest.valid) {
      // 坏掉的插件也要在界面上出现，否则用户只会觉得"插件没生效"。
      registerLoadedPlugin(manifest, "invalid", manifest.invalidReason);
      continue;
    }

    // 依赖没满足就**不加载**：它会去扩展/调用那个插件，而那个插件根本不在。
    // 让它半死不活地跑起来，报出来的错会离真正的原因很远。
    const missing = missingDependencies(manifest, manifests);
    if (missing.length > 0) {
      registerLoadedPlugin(
        manifest,
        "missingDependency",
        `需要 ${missing.join("、")}（没装，或者被停用了）`,
      );
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

/**
 * 按依赖关系排出加载顺序：**被依赖的先加载**。
 *
 * 插件加载是有先后的（后者可能要去找前者注册的文件类型、视图），所以不能只按名字的字母序
 * 来 —— 那正是这一版之前干的事。这里做拓扑排序：
 *
 * * 依赖已经排过的先放；
 * * **成环的**（A 要 B、B 要 A）一组都放最后 —— 谁也没法先于谁，与其死循环不如让它们
 *   各自去撞「依赖没满足」那道门，那里给出的提示比「卡住」有用得多；
 * * 不认识的依赖名**不在这里报错**：同一个名字可能属于一个 `valid: false` 的插件，
 *   「它坏了」这件事该由那一条自己去说。
 *
 * 顺序不稳定不影响正确性（依赖该满足的照样满足），但会让日志难对，所以同一批里保持
 * 传进来的次序（`Array.prototype.sort` 自 ES2019 起是稳定的）。
 */
export function loadOrder(manifests: readonly PluginManifest[]): PluginManifest[] {
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const ordered: PluginManifest[] = [];
  const settled = new Set<string>();

  const visit = (manifest: PluginManifest, chain: Set<string>): void => {
    if (settled.has(manifest.name)) return;
    // 环：把这一条原样放进去（下面 missingDependencies 会拦住它），别再往下递归。
    if (chain.has(manifest.name)) return;
    chain.add(manifest.name);

    for (const dependency of manifest.requires ?? []) {
      const target = byName.get(dependency);
      if (target) visit(target, chain);
    }

    chain.delete(manifest.name);
    settled.add(manifest.name);
    ordered.push(manifest);
  };

  for (const manifest of manifests) visit(manifest, new Set());
  return ordered;
}

/**
 * 这个插件的依赖里，哪些没被满足。
 *
 * 判据是「装了、而且**启用着**」：停用某一个插件时，依赖它的那些也该跟着起不来 ——
 * 否则它们会对着一个没注册任何东西的宿主报一堆看不懂的错。
 */
export function missingDependencies(
  manifest: PluginManifest,
  manifests: readonly PluginManifest[],
): string[] {
  const available = new Set(
    manifests.filter((item) => item.enabled && item.valid).map((item) => item.name),
  );
  return (manifest.requires ?? []).filter((name) => !available.has(name));
}

/**
 * 把校正报告变成一句人话。没有值得说的就返回 `null` —— **此时一个字都不该弹**。
 *
 * 抽成纯函数是为了能直接测：弹不弹的判据全在这里，接 Toast 那一步没有任何分支。
 */
export function describeSyncReport(report: PluginSyncReport): string | null {
  const parts: string[] = [];

  if (report.updated.length > 0) {
    parts.push(`已更新 ${report.updated.length} 个插件（${report.updated.join("、")}）`);
  }
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.length} 个插件因本地有改动被跳过`);
  }
  if (report.backedUp.length > 0) {
    parts.push(`原件已备份 ${report.backedUp.length} 份`);
  }

  if (parts.length === 0) {
    // 状态文件的迁移是纯内部动作，没有任何用户可见的后果。只有在别的都没发生时
    // 才提一句 —— 免得用户看到提示却找不到任何变化，以为插件出了毛病。
    return report.migrated ? "插件状态文件已升级" : null;
  }

  return `插件版本校正：${parts.join("；")}`;
}

async function reportBundledPluginSync(): Promise<void> {
  let report: PluginSyncReport | null = null;
  try {
    report = await getPluginSyncReport();
  } catch (error) {
    // 取不到报告不影响插件加载 —— 校正本身在 Rust 侧早已跑完，没必要因此弹个错误吓人。
    console.error("[plugins] 取版本校正报告失败", error);
    return;
  }
  if (!report) return;

  const message = describeSyncReport(report);
  if (message) showToast(message);
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

/**
 * 通知某个插件「你的设置变了」。
 *
 * 由**写设置的那一处**调用（见 PluginParams）：设置是前端直接写进 Rust 的，宿主不该
 * 去轮询。不通知的话，值虽然存下去了，插件却一直用着旧值 —— 表现为「改了没反应，重启
 * 才好」。
 */
export function notifyPluginSettingsChanged(name: string): void {
  running.get(name)?.refreshSettings?.();
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
