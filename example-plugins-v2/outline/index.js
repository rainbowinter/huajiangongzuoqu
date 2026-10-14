/**
 * outline（v2）
 *
 * 这是最有价值的一个迁移样例：它演示了 v2 相对 v1 的**两个关键差异**。
 *
 * 1. **同步读正文。** v1 的 `render()` 里直接 `api.getActiveNoteContent()` 同步读。
 *    Worker 里没有 DOM、也不能同步 RPC，但宿主会把编辑器状态作为「镜像」推送过来，
 *    于是 `api.editor.getContentSync()` 依然同步可用，渲染逻辑几乎不用改。
 *
 * 2. **点击事件拿到的是描述符而不是 DOM 节点。** v1 写
 *    `target.closest(".outline-item")` + `btn.getAttribute("data-index")`，
 *    v2 里 `target` 是可序列化的 ElementRef，对应写法是
 *    `ref.closestClass("outline-item")` + `ref.data("index")`。
 *
 *    注意 `closest()` 只支持极小的选择器语法：`tag`、`.class`、`#id`、
 *    `[data-x]`、`[data-x="v"]`，以及 `tag.class` 这样的两段组合，
 *    **不是**完整的 CSS 选择器引擎。
 */
floral.register({
  onLoad(api) {
    api.ui.registerPanel({
      id: "outline",
      title: "目录",
      standalone: true,
      render() {
        const content = api.editor.getContentSync();
        if (!content || !content.trim()) {
          return '<p style="font-size:12px;color:var(--color-ink-ghost);text-align:center;padding:16px 0;">请先选中一篇笔记</p>';
        }

        const items = parseOutline(content);
        if (items.length === 0) {
          return '<p style="font-size:12px;color:var(--color-ink-ghost);text-align:center;padding:16px 0;">暂无标题，用 # 添加标题</p>';
        }

        return items
          .map((item, index) => {
            const pad = 8 + item.level * 12;
            return (
              '<button class="outline-item" data-index="' +
              index +
              '" style="display:block;width:100%;text-align:left;border:0;background:transparent;cursor:pointer;padding:4px 8px 4px ' +
              pad +
              'px;font-size:12px;color:var(--color-ink-soft);">' +
              escapeHtml(item.text) +
              "</button>"
            );
          })
          .join("");
      },

      onClick(ref) {
        const btn = ref.closestClass("outline-item");
        if (!btn) return;

        const index = Number(ref.data("index"));
        if (!Number.isFinite(index)) return;

        const items = parseOutline(api.editor.getContentSync());
        const item = items[index];
        if (!item) return;

        api.editor.scrollTo(item.offset);
        api.editor.scrollPreviewTo(item.offset);
      },
    });
  },
});

/** 扫描标题，同时记录每个标题在正文里的字符偏移。 */
function parseOutline(content) {
  const lines = content.split("\n");
  const items = [];
  let offset = 0;

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      items.push({ level: match[1].length, text: match[2].trim(), offset });
    }
    // +1 是换行符本身
    offset += line.length + 1;
  }

  return items;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
