/**
 * popover-demo（v2）—— 工具栏浮层的样例
 *
 * 演示 `api.ui.registerPopover` 的三个要点：
 *
 * 1. `render()` 在**每次点开时**调一次，返回下拉里的 HTML。
 * 2. `onClick(ref)` 里 `ref` 是点击落点的描述符；要取自己那个格子的 `data-*`，
 *    得走 `closestClass(...)` 拿到的**那一层**的 `attrs`（点击常常落在内部的 span 上）。
 * 3. `onClick` **返回一个字符串**时，宿主会把它当成新内容换上 —— 分类切换就是这么做的，
 *    插件在自己的沙箱里记状态即可，不必重新注册。
 */

const PAGES = [
  { id: "face", title: "表情", items: ["😀", "😅", "🤔", "👍", "🎉", "✅", "❌", "🔥"] },
  { id: "mark", title: "标记", items: ["★", "☆", "❤", "⚠", "→", "←", "↑", "↓"] },
];

const STYLE = `
.pd-tabs { display: flex; gap: 4px; padding: 6px 6px 2px; }
.pd-tab {
  flex: 1; padding: 3px 6px; border-radius: 6px; cursor: pointer;
  font-size: 11px; color: var(--color-ink-faint); background: transparent;
  border: 1px solid transparent; transition: background .12s ease;
}
.pd-tab:hover { background: var(--color-bamboo-mist); }
.pd-tab-on { color: var(--color-bamboo); border-color: var(--color-bamboo); }
.pd-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 4px 6px 6px; }
.pd-cell {
  height: 34px; border-radius: 6px; cursor: pointer; font-size: 17px;
  background: transparent; border: 1px solid transparent; transition: background .12s ease;
}
.pd-cell:hover { background: var(--color-bamboo-mist); border-color: var(--color-bamboo); }
`;

function pageHtml(activeId) {
  const page = PAGES.find((item) => item.id === activeId) ?? PAGES[0];

  // ⚠️ `data-*` 是严格白名单（只有 index / id / key / value 四个键能穿过消毒器），
  // 所以「哪个标签是当前页」只能靠 class 表达，自造 `data-active` 会被静默剥掉。
  const tabs = PAGES.map(
    (item) =>
      `<button type="button" class="pd-tab${item.id === page.id ? " pd-tab-on" : ""}"` +
      ` data-value="${item.id}">${item.title}</button>`,
  ).join("");

  const cells = page.items
    .map((glyph) => `<button type="button" class="pd-cell" data-value="${glyph}">${glyph}</button>`)
    .join("");

  return `<div class="pd-tabs">${tabs}</div><div class="pd-grid">${cells}</div>`;
}

floral.register({
  onLoad(api) {
    let current = PAGES[0].id;

    api.ui.registerStyle({ id: "popover-demo", css: STYLE });

    api.ui.registerPopover({
      id: "demo",
      title: "表情",
      icon: "☺",
      width: 240,

      render() {
        return pageHtml(current);
      },

      onClick(ref) {
        const tab = ref.closestClass("pd-tab");
        if (tab && tab.attrs && tab.attrs["data-value"]) {
          current = tab.attrs["data-value"];
          return pageHtml(current);
        }

        const cell = ref.closestClass("pd-cell");
        if (cell && cell.attrs && cell.attrs["data-value"]) {
          void api.editor.insertText(cell.attrs["data-value"]);
        }
        return undefined;
      },
    });
  },
});
