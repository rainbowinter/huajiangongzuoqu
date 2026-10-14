floral.register({
  name: "outline",
  onLoad(api) {
    api.registerPanel({
      id: "outline",
      title: "目录",
      standalone: true,
      render() {
        const content = api.getActiveNoteContent();
        if (!content || !content.trim()) {
          return (
            '<p style="font-size:12px;color:var(--color-ink-ghost);text-align:center;padding:16px 0;">请先选中一篇笔记</p>'
          );
        }
        const items = parseOutline(content);
        if (items.length === 0) {
          return (
            '<p style="font-size:12px;color:var(--color-ink-ghost);text-align:center;padding:16px 0;">暂无标题，用 # 添加标题</p>'
          );
        }
        return items
          .map((item, index) => {
            const pad = 8 + item.level * 12;
            return (
              '<button class="outline-item" data-index="' +
              index +
              '" style="padding-left:' +
              pad +
              'px">' +
              escapeHtml(item.text) +
              "</button>"
            );
          })
          .join("");
      },
      onClick(target) {
        const btn = target.closest(".outline-item");
        if (!btn) return;
        const index = Number(btn.getAttribute("data-index"));
        const content = api.getActiveNoteContent() ?? "";
        const items = parseOutline(content);
        const item = items[index];
        if (!item) return;
        api.scrollEditorTo(item.offset);
        api.scrollPreviewTo(item.offset);
      },
    });
  },
});

function parseOutline(content) {
  const lines = content.split("\n");
  const items = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      items.push({ level: match[1].length, text: match[2].trim(), offset });
    }
    offset += lines[i].length + 1;
  }
  return items;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
