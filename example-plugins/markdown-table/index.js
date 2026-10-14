floral.register({
  name: "markdown-table",
  onLoad(api) {
    api.registerSelectionTransformer((text) => buildMarkdownTable(text));
  },
});

function buildMarkdownTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const rows = lines.map((line) => {
    // 制表符优先：有 \t 按制表符分隔（保留单元格内空格），否则按空格分隔
    if (line.includes("\t")) {
      return line.split("\t").map((cell) => cell.trim());
    }
    return line.split(/\s+/);
  });
  if (rows.length === 0 || rows[0].length === 0) return null;

  const columnCount = Math.max(...rows.map((row) => row.length));
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
