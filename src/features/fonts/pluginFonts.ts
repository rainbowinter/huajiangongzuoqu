/**
 * 插件提供的字体族注册表。
 *
 * 插件把字体文件丢进自己的文件夹、调一次 `api.fonts.register()`，宿主在这里做三件事：
 * 把 `@font-face` 注入当前窗口、登记族名、在插件卸载时把两者一起撤掉。
 *
 * 选择器（设置 → 代码字体）从这里读插件字体，因此**快照必须是稳定引用** —— 它会被
 * `useSyncExternalStore` 直接消费，每次新建数组会让 React 认为快照一直在变，从而无限
 * 重渲染。这个坑项目里踩过一次，别再踩第二次。
 */

import { buildFontFaceCss, type FontFaceSpec } from "./fontFace";

export interface PluginFontFamily {
  /** CSS 里的 `font-family` 名，也是选择器里显示的名字。 */
  family: string;
  /** 哪个插件提供的，用于分组显示。 */
  owner: string;
}

let families: readonly PluginFontFamily[] = Object.freeze([]);

/** owner → 该插件登记的族名。用 Map 保住插入顺序，让下拉列表的顺序稳定。 */
const byOwner = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();

export function listPluginFonts(): readonly PluginFontFamily[] {
  return families;
}

export function subscribePluginFonts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sameContents(next: readonly PluginFontFamily[]): boolean {
  if (next.length !== families.length) return false;
  return next.every(
    (item, index) =>
      item.family === families[index].family && item.owner === families[index].owner,
  );
}

function recompute(): void {
  const next: PluginFontFamily[] = [];
  for (const [owner, list] of byOwner) {
    for (const family of list) next.push({ family, owner });
  }

  if (sameContents(next)) return;

  families = Object.freeze(next);
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[fonts] 字体订阅回调抛错", error);
    }
  }
}

/**
 * 注入 `@font-face` 并登记族名，返回撤销函数。
 *
 * `@font-face` 进的是**当前窗口**的主世界。插件加载器在主窗口与小窗都会跑
 * （`MainWindow` 与 `NotePad` 都调 `loadPlugins`），所以这两处都能用上插件字体；
 * 磁贴窗不加载插件，用不到（它目前在界面上也没有入口）。
 */
export function installPluginFonts(owner: string, specs: readonly FontFaceSpec[]): () => void {
  const element = document.createElement("style");
  element.dataset.pluginFonts = owner;
  element.textContent = buildFontFaceCss(specs);
  document.head.appendChild(element);

  const registered = Object.freeze([...new Set(specs.map((spec) => spec.family))]);
  byOwner.set(owner, registered);
  recompute();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    element.remove();

    // 只有当前登记的仍是本次这一组时才撤销。同一个插件重新登记过的话，撤销**旧的**
    // 那一次不该把新的一组也带走（否则先注册的被释放时，字体列表会整个空掉）。
    if (byOwner.get(owner) === registered) {
      byOwner.delete(owner);
      recompute();
    }
  };
}

/** 供测试重置：注册表是模块级状态，用例之间会互相污染。 */
export function resetPluginFontsForTests(): void {
  families = Object.freeze([]);
  byOwner.clear();
  listeners.clear();
}
