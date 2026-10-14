import { showToast } from "../../components/Toast";
import { getNote, listNotes } from "../notes/api";
import {
  getActiveContent,
  getActiveSelection,
  replaceActiveSelection,
  setActiveContent,
} from "./activeContent";
import { listPlugins, readPlugin } from "./api";
import {
  addPluginCommand,
  clearAllPlugins,
  registerLoadedPlugin,
  registerPluginPanel,
  registerSelectionTransformer,
  registerStatusBarRenderer,
} from "./registry";
import { scrollEditorTo, scrollPreviewTo } from "./jump";
import type { PluginApi, PluginDefinition, PluginManifest } from "./types";

let loaded = false;

function buildApi(pluginName: string): PluginApi {
  return {
    addCommand(command) {
      addPluginCommand({
        id: `${pluginName}:${command.title}`,
        title: command.title,
        plugin: pluginName,
        run: command.run,
      });
    },
    getActiveNoteContent: getActiveContent,
    setActiveNoteContent: setActiveContent,
    getActiveNoteSelection: getActiveSelection,
    replaceActiveNoteSelection: replaceActiveSelection,
    registerSelectionTransformer,
    registerStatusBarItem: registerStatusBarRenderer,
    registerPanel: (def) => {
      registerPluginPanel({ ...def, plugin: pluginName });
    },
    scrollEditorTo,
    scrollPreviewTo,
    showToast: (message, type = "info") => showToast(message, type),
    listNotes,
    getNote,
  };
}

function executePlugin(manifest: PluginManifest, code: string): void {
  const api = buildApi(manifest.name);
  const floral = {
    register(definition: PluginDefinition) {
      void Promise.resolve(definition.onLoad(api)).catch((error) => {
        showToast(`插件 ${manifest.name} 出错：${String(error)}`);
      });
    },
  };

  try {
    // 插件代码是运行期才读取的文本，必须用 Function 构造器执行。
    const factory = new Function("floral", code) as unknown as (floral: unknown) => void;
    factory(floral);
  } catch (error) {
    showToast(`插件 ${manifest.name} 加载失败：${String(error)}`);
  }
}

export async function loadPlugins(): Promise<void> {
  if (loaded) return;
  await doLoad();
}

export async function reloadPlugins(): Promise<void> {
  clearAllPlugins();
  loaded = false;
  await doLoad();
}

async function doLoad(): Promise<void> {
  loaded = true;

  let plugins: PluginManifest[];
  try {
    plugins = await listPlugins();
  } catch (error) {
    showToast(`读取插件列表失败：${String(error)}`);
    return;
  }

  for (const manifest of plugins) {
    try {
      const code = await readPlugin(manifest.name);
      executePlugin(manifest, code);
      registerLoadedPlugin(manifest);
    } catch (error) {
      showToast(`插件 ${manifest.name} 读取失败：${String(error)}`);
    }
  }
}
