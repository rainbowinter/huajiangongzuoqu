/**
 * markdown-table（v2）
 *
 * 演示 `editor.registerSelectionTransformer`。选中一段文本后按 Ctrl+\，
 * 宿主会把选中的文本交给这里的 `transform`，返回值替换原选区；返回 `null`
 * 表示"我处理不了，让下一个转换器或内置模板接手"。
 *
 * ⚠️ 迁移须知：这条链路在宿主侧是**异步**的（`transformSelection` 现在返回
 * Promise）。Ctrl+\ 的处理已相应改造——`preventDefault()` 保持同步，写回延后到
 * 续体里，且会重新读取 textarea 的实时内容，避免用过期偏移写坏文本。
 * 插件本身不受影响，照旧返回字符串即可。
 */
floral.register({
  onLoad(api) {
    let separator = "tab-first";

    api.settings.get().then((values) => {
      if (values.separator === "space-only" || values.separator === "tab-first") {
        separator = values.separator;
      }
    });

    api.editor.registerSelectionTransformer({
      id: "markdown-table.transform",
      transform(text) {
        return buildMarkdownTable(text, separator);
      },
    });
  },
});

function buildMarkdownTable(text, separator) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const rows = lines.map((line) => {
    // 默认制表符优先：有 \t 时按制表符切分（保留单元格内的空格）
    if (separator === "tab-first" && line.includes("\t")) {
      return line.split("\t").map((cell) => cell.trim());
    }
    return line.split(/\s+/);
  });

  if (rows.length === 0 || rows[0].length === 0) return null;

  const columnCount = Math.max(...rows.map((row) => row.length));
  // 只有一列不值得转成表格，交给后续处理
  if (columnCount < 2) return null;

  const normalized = rows.map((row) => {
    const cells = row.slice(0, columnCount);
    while (cells.length < columnCount) cells.push("");
    return cells;
  });

  const header = normalized[0];
  const body = normalized.slice(1);

  const headerLine = "| " + header.join(" | ") + " |";
  const separatorLine = "| " + header.map(() => "---").join(" | ") + " |";
  const bodyLines = body.map((row) => "| " + row.join(" | ") + " |");

  return [headerLine, separatorLine, ...bodyLines].join("\n");
}
