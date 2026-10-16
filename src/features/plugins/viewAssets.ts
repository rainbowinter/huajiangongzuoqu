import type { FileType, ViewToolbarItem } from "../workspace/fileTypes";
import type { ViewToolbarState } from "../../components/PluginViewToolbar";
import { readPluginAsset } from "./api";
import { listViewExtensions } from "./registry";
import { buildViewDocument, isCompleteViewSpec } from "./viewBridge";

/**
 * 把插件声明的视图资源读出来、拼成 iframe 的 `srcdoc`。
 *
 * **为什么要读成文本再内联**：视图帧是 opaque origin，外部 `<script type="module">`
 * 与 `new Worker(assetUrl)` 在那儿都会被 CORS 挡掉；内联之后既跑得起来，也不必为了视图
 * 去放宽 asset 协议范围（那会逼着我们去掉沙箱）。实测见 `Docs/plugin-view-sandbox.md`。
 */

/**
 * 从文件类型 id 里取出插件名。
 *
 * `v2Host.registerFileType` 会给插件的 id 加上 `<插件名>:` 前缀（避免两个插件撞名），
 * 读插件目录下的资源正需要这个名字。前缀不存在时返回 `null` —— 那种类型不是插件注册的，
 * 也就没有视图资源可读。
 */
export function ownerOfFileType(typeId: string): string | null {
  const index = typeId.indexOf(":");
  return index > 0 ? typeId.slice(0, index) : null;
}

/** 同一种文件类型只读一次：pdf.js 那种库读进来是兆级字符串，别每次打开都重来一遍。 */
const documentCache = new Map<string, Promise<string>>();

/** 往这个视图里并东西的插件（按注册顺序）。谁扩展了谁，只有被扩展的那个类型 id 知道。 */
function extensionsFor(typeId: string) {
  return listViewExtensions().filter((extension) => extension.typeId === typeId);
}

/** 合并后的一项，以及它**属于哪个插件**（图标的路径要按那个插件的目录去读）。 */
interface ToolbarEntry {
  item: ViewToolbarItem;
  owner: string | null;
}

/**
 * 把基础插件与各扩展声明的控件按顺序合成一条。
 *
 * **id 撞了就丢扩展的那一项**，基础插件赢：id 同时是命令名与状态名，两条同名的控件事后
 * 根本分不出谁是谁。至于分隔线，它本来就没有 id，照单全收。
 *
 * 这一份是**唯一的合并实现**：`viewToolbarFor`（要控件）与 `viewToolbarIcons`（要图标）
 * 都从它派生。两边各写一遍的话，顺序与去重迟早会分家 —— 那时图标就会贴错按钮。
 */
function toolbarEntries(type: FileType): ToolbarEntry[] {
  const base = type.view?.toolbar ?? [];
  const baseOwner = ownerOfFileType(type.id);
  const merged: ToolbarEntry[] = base.map((item) => ({ item, owner: baseOwner }));
  const taken = new Set(base.flatMap((item) => (item.kind === "separator" ? [] : [item.id])));
  const dropped: string[] = [];

  for (const extension of extensionsFor(type.id)) {
    for (const item of extension.toolbar) {
      if (item.kind === "separator") {
        merged.push({ item, owner: extension.plugin });
        continue;
      }
      if (taken.has(item.id)) {
        dropped.push(item.id);
        continue;
      }
      taken.add(item.id);
      merged.push({ item, owner: extension.plugin });
    }
  }

  if (dropped.length > 0) {
    // 不静默：作者会想知道自己那一项为什么没出现。
    console.warn(`[plugin-view] 工具栏 id 与基础插件重名，已丢掉：${dropped.join("、")}`);
  }

  return merged;
}

/** 这个视图顶上那一排控件：基础插件的在前，扩展的按注册顺序接在后面。 */
export function viewToolbarFor(type: FileType): ViewToolbarItem[] {
  return toolbarEntries(type).map((entry) => entry.item);
}

/**
 * 图标在表里的键。
 *
 * 同一个 `id` 的按钮只有一个，但**一个 menu 的每个选项都可以有自己的图标**，
 * 所以选项用 `id:value` 区分。宿主渲染时用同一个函数算键，两边不会对不上。
 */
export function toolbarIconKey(id: string, value?: string): string {
  return value ? `${id}:${value}` : id;
}

export interface ToolbarIconRequest {
  key: string;
  /** 从**哪个插件目录**读（扩展插件的图标在它自己那儿）。 */
  owner: string;
  /** 插件目录下的相对路径。 */
  path: string;
}

/**
 * 这一排控件要用到的图标。
 *
 * 只返回**需要读盘**的那些（没声明 `icon` 的项不出现），顺序与工具栏一致。
 * 读与消毒由调用方做（`PluginFileView` 那个 hook），这里只管「谁、在哪儿」。
 */
export function viewToolbarIcons(type: FileType): ToolbarIconRequest[] {
  const requests: ToolbarIconRequest[] = [];

  for (const { item, owner } of toolbarEntries(type)) {
    if (!owner || item.kind === "separator" || item.kind === "readout" || item.kind === "input") {
      continue;
    }
    if (item.icon) requests.push({ key: toolbarIconKey(item.id), owner, path: item.icon });
    if (item.kind === "menu") {
      for (const option of item.options) {
        if (option.icon) {
          requests.push({
            key: toolbarIconKey(item.id, option.value),
            owner,
            path: option.icon,
          });
        }
      }
    }
  }

  return requests;
}

/**
 * 要**私有数据通道**的那些插件（视图那边按名字各自开一条、各推一份已存的数据）。
 *
 * 只有声明了 `data: true` 的才算 —— 只叠样式和按钮的扩展碰不到磁盘。
 */
export function viewDataPlugins(type: FileType): string[] {
  return extensionsFor(type.id)
    .filter((extension) => extension.data)
    .map((extension) => extension.plugin);
}

/**
 * 把各插件各报的那张状态表摊成一张。
 *
 * 视图里可能同时跑着两个插件（被扩展的 + 扩展它的），工具栏的状态**按插件分开报**
 * （`{ t: "state", plugin }`）—— 合成一份存的话后报的会把先报的整个盖掉，表现是
 * 「缩放比例」这类小字忽然空了。这里只是把它们贴在一起。
 *
 * 两个插件报出**同一个 id** 是不可能的：`viewToolbarFor` 合并工具栏时就把扩展里与基础
 * 插件重名的项丢掉了，而视图只会报自己声明的那些 id。所以 `pressed` 直接取并集即可。
 */
export function mergeToolbarStates(
  states: Record<string, ViewToolbarState>,
): ViewToolbarState {
  const values: Record<string, string> = {};
  const pressed: string[] = [];
  for (const state of Object.values(states)) {
    Object.assign(values, state.values);
    pressed.push(...state.pressed);
  }
  return { values, pressed };
}

export function loadViewDocument(type: FileType): Promise<string> {
  const cached = documentCache.get(type.id);
  if (cached) return cached;

  const pending = (async () => {
    const owner = ownerOfFileType(type.id);
    const spec = type.view;
    if (!owner || !isCompleteViewSpec(spec)) {
      throw new Error("这个文件类型的视图声明不完整（缺少 html，或不是插件注册的）");
    }

    const read = (relativePath: string) => readPluginAsset(owner, relativePath);
    const extensions = extensionsFor(type.id);
    // 扩展的资源在它自己的插件目录里，得用**它**的名字去读。
    const readFrom = (plugin: string, relativePath: string) => readPluginAsset(plugin, relativePath);

    const [html, css, js, worker, extCss, extJs] = await Promise.all([
      read(spec.html),
      Promise.all((spec.css ?? []).map(read)),
      Promise.all((spec.js ?? []).map(read)),
      // worker 只是**文本**：pdf.js 那份 1.4MB 的 worker 源码要原样进到帧里，
      // 由插件自己做成 blob 再 new Worker（帧是 opaque origin，外部地址会被 CORS 挡掉）。
      spec.worker ? read(spec.worker) : Promise.resolve(undefined),
      Promise.all(
        extensions.map((extension) =>
          Promise.all(extension.css.map((path) => readFrom(extension.plugin, path))),
        ),
      ),
      Promise.all(
        extensions.map((extension) =>
          Promise.all(extension.js.map((path) => readFrom(extension.plugin, path))),
        ),
      ),
    ]);

    return buildViewDocument({
      html,
      // 顺序有意义：基础插件的样式与脚本在前，扩展的接在后面（同一个内联 module，
      // 于是扩展能看见基础插件的顶层名字，反过来则在它之后才求值）。
      css: [...css, ...extCss.flat()],
      js: [...js, ...extJs.flat()],
      worker,
    });
  })();

  documentCache.set(type.id, pending);
  // 失败不进缓存 —— 否则一次读盘失败会让这个类型永久坏掉，重试都没机会。
  void pending.catch(() => documentCache.delete(type.id));

  return pending;
}

/** 测试用：清掉缓存。 */
export function clearViewDocumentCache(): void {
  documentCache.clear();
}
