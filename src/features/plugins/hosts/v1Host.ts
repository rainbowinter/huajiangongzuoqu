/**
 * v1 插件运行时：主线程 `new Function` 执行，无沙箱隔离。
 *
 * 这段逻辑原先直接写在 `loader.ts` 里，现在原样搬过来，只做两处改动：
 *
 * 1. 每个 `registerX` 都带上归属名，并把返回的 `Disposable` 收进本插件的
 *    `DisposableStore`，于是"卸载单个插件"成为可能。注意 `PluginApi` v1 接口
 *    本身**没有改**——插件调用处忽略返回值依然照常工作。
 * 2. 支持可选的 `onUnload` 钩子。
 *
 * ⚠️ v1 插件与宿主同权限运行在主线程，`window.__TAURI_INTERNALS__` 对它完全可见，
 * 因此权限门对 v1 插件**不生效**。这是保留兼容性的代价，界面上必须把 v1 插件
 * 明确标注为"未沙箱"。新插件一律应写 v2。
 */

import { showToast } from "../../../components/Toast";
import { getNote, listNotes } from "../../notes/api";
import {
  getActiveContent,
  getActiveSelection,
  replaceActiveSelection,
  setActiveContent,
} from "../activeContent";
import { DisposableStore, type Disposable } from "../disposable";
import { scrollEditorTo, scrollPreviewTo } from "../jump";
import {
  addPluginCommand,
  registerPluginPanel,
  registerSelectionTransformer,
  registerStatusBarRenderer,
} from "../registry";
import type { PluginApi, PluginDefinition, PluginManifest } from "../types";

export interface LegacyPluginInstance {
  name: string;
  dispose(): Promise<void>;
}

function buildApi(manifest: PluginManifest, store: DisposableStore): PluginApi {
  const owner = manifest.name;
  const keep = (disposable: Disposable) => {
    store.add(disposable);
  };

  return {
    addCommand(command) {
      keep(
        addPluginCommand({
          id: `${owner}:${command.title}`,
          title: command.title,
          plugin: owner,
          run: command.run,
        }),
      );
    },
    getActiveNoteContent: getActiveContent,
    setActiveNoteContent: setActiveContent,
    getActiveNoteSelection: getActiveSelection,
    replaceActiveNoteSelection: replaceActiveSelection,
    registerSelectionTransformer: (transformer) => {
      keep(registerSelectionTransformer(owner, transformer));
    },
    registerStatusBarItem: (render) => {
      keep(registerStatusBarRenderer(owner, render));
    },
    registerPanel: (def) => {
      keep(registerPluginPanel(owner, { ...def, plugin: owner }));
    },
    scrollEditorTo,
    scrollPreviewTo,
    showToast: (message, type = "info") => showToast(message, type),
    listNotes,
    getNote,
  };
}

/**
 * 加载一个 v1 插件。
 *
 * 插件源码在运行期才从磁盘读出，因此必须用 `Function` 构造器执行——这是 v1 的
 * 既定设计，隔离性由"用户手动把插件放进目录"这一步承担，而不是由沙箱承担。
 */
export async function loadV1Plugin(
  manifest: PluginManifest,
  code: string,
): Promise<LegacyPluginInstance> {
  const store = new DisposableStore();
  const api = buildApi(manifest, store);
  let definition: PluginDefinition | undefined;

  const floral = {
    register(candidate: PluginDefinition) {
      definition = candidate;
    },
  };

  try {
    const factory = new Function("floral", code) as unknown as (floral: unknown) => void;
    factory(floral);
  } catch (error) {
    store.dispose();
    throw new Error(`插件代码执行失败：${String(error)}`);
  }

  if (!definition) {
    store.dispose();
    throw new Error("插件没有调用 floral.register()");
  }

  const registered = definition as PluginDefinition;

  try {
    await registered.onLoad(api);
  } catch (error) {
    store.dispose();
    throw new Error(`onLoad 抛错：${String(error)}`);
  }

  return {
    name: manifest.name,
    async dispose() {
      // 先跑插件自己的清理钩子，再释放宿主侧注册项。钩子里抛错不应阻断注册项清理。
      try {
        await registered.onUnload?.();
      } catch (error) {
        showToast(`插件 ${manifest.name} 的 onUnload 出错：${String(error)}`);
      }
      store.dispose();
    },
  };
}
