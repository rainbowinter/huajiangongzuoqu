/**
 * insert-timestamp（v2）
 *
 * 演示 v2 才有的写入能力：
 *
 * - `ui.registerCommand` 带 `keybinding`，在命令面板里可搜索、也可用快捷键触发。
 * - `editor.insertText` / `editor.wrapSelection` —— v1 只有「整篇替换」和
 *   「替换选区」两个粗粒度操作，连"在光标处插一段文本"都做不到。
 * - `editor.getSelection()` 读选区，`ui.registerEditorMenuItem` 往编辑器右键菜单
 *   里加条目。
 *
 * 键位优先级：宿主的内置 Markdown 快捷键（Ctrl+B/I 等）**先**处理，插件键位只在其
 * 未处理时才介入。因此不要指望用插件覆盖内置键位。
 */
floral.register({
  onLoad(api) {
    let format = "datetime";

    api.settings.get().then((values) => {
      if (typeof values.format === "string") format = values.format;
    });

    api.ui.registerCommand({
      id: "insert-timestamp.now",
      title: "插入当前时间",
      keybinding: "Ctrl+Shift+D",
      run() {
        return api.editor.insertText(`\n${stamp(format)}\n`);
      },
    });

    api.ui.registerCommand({
      id: "insert-timestamp.wrap-code",
      title: "把选中文本包成行内代码",
      run() {
        return api.editor.wrapSelection("`", "`");
      },
    });

    api.ui.registerEditorMenuItem({
      id: "insert-timestamp.menu-write",
      title: "把选中内容写入剪贴板式引用",
      run() {
        return api.editor.getSelection().then((selection) => {
          if (!selection || !selection.text) {
            api.ui.showToast("请先选中一段文本", "warning");
            return;
          }
          const quoted = selection.text
            .split(/\r?\n/)
            .map((line) => `> ${line}`)
            .join("\n");
          return api.editor.replaceSelection(quoted);
        });
      },
    });

    api.log.info("insert-timestamp 已加载，快捷键 Ctrl+Shift+D");
  },
});

function stamp(mode) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  if (mode === "date") return date;
  if (mode === "iso") return `${date}T${time}`;
  return `${date} ${time}`;
}
