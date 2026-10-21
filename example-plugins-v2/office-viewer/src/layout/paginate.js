/**
 * 行 → 页。
 *
 * 分页不是「排不下就换页」，而是一组约束：
 *
 * * `pageBreakBefore`：段前强制分页
 * * `keepLines`：整段不拆页
 * * `keepNext`：与下一段同页（标题最常见的用法）
 * * 孤行控制：段首 / 段尾不能只剩一行
 * * 手动分页符（`w:br type="page"`）
 *
 * 先把每个段落排成行，再按这些约束装箱。装箱时只记账、不画 DOM，
 * 所以这一层可以完全用纯函数单测。
 */

export function paginate(blocks, section) {
  const contentHeight = section.contentHeight;
  const pages = [];
  let page = { lines: [], items: [], used: 0 };
  // 上一段的段后距。Word/WPS 里相邻两段的「段后 + 段前」不叠加，取较大者
  // （S03：18pt 段后 + 6pt 段前，WPS 实际只留 18pt）。换页后清空。
  let lastAfter = 0;

  const newPage = () => {
    if (page.items.length > 0) {
      pages.push(page);
      page = { lines: [], items: [], used: 0 };
    }
    lastAfter = 0;
  };

  const placeTable = (block) => {
    const headerRows = block.rows.filter((row) => row.tableHeader);
    for (const row of block.rows) {
      if (page.items.length > 0 && page.used + row.height > contentHeight + 0.01) {
        newPage();
        // 表头行在新页顶部重复；如果当前行本身就是表头，不要重复画两遍。
        if (!row.tableHeader) {
          for (const header of headerRows) {
            if (page.used + header.height > contentHeight + 0.01) break;
            // 重复表头要复制行与行内 line，避免两次摆放共用同一批坐标对象。
            const repeated = {
              ...header,
              cells: header.cells.map((cell) => ({
                ...cell,
                lines: (cell.lines ?? []).map((line) => ({ ...line })),
              })),
            };
            page.items.push({
              kind: "table-row",
              table: block,
              row: repeated,
              top: page.used,
              height: header.height,
            });
            page.used += header.height;
          }
        }
      }
      page.items.push({
        kind: "table-row",
        table: block,
        row,
        top: page.used,
        height: row.height,
      });
      page.used += row.height;
    }
    lastAfter = 0;
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block.kind === "table") {
      placeTable(block);
      continue;
    }
    const lines = block.lines ?? [];
    if (lines.length === 0) {
      // 只有分页符的段落：没有行，但要让下一段从新页开始。
      if (block.pageBreakAfter && page.items.length > 0) newPage();
      continue;
    }

    const props = block.props ?? {};
    if (lines[0].pageBreakBefore && page.items.length > 0) newPage();
    const before = lines[0].spaceBefore ?? 0;
    const after = lines[lines.length - 1].spaceAfter ?? 0;
    const linesHeight = lines.reduce((sum, line) => sum + line.height, 0);
    const blockHeight = before + linesHeight + after;

    if (props.pageBreakBefore && page.items.length > 0) newPage();

    // 整段不拆页：放不下就整段挪到下一页；比一整页还高的段落只能拆。
    if (
      props.keepLines &&
      blockHeight <= contentHeight &&
      page.items.length > 0 &&
      page.used + before + linesHeight > contentHeight
    ) {
      newPage();
    }

    // 与下段同页：至少保证下一段的第一行能和本段落在同一页。
    if (props.keepNext && page.items.length > 0) {
      const next = blocks[blockIndex + 1];
      const nextFirst = next?.lines?.[0];
      if (nextFirst && !next?.props?.pageBreakBefore) {
        const need =
          before + linesHeight + after + (nextFirst.spaceBefore ?? 0) + nextFirst.height;
        if (page.used + need > contentHeight) newPage();
      }
    }

    // 段前距在页首也要生效（S03：首页首段 before=12pt，WPS 保留）。
    let beforeApplied = page.items.length === 0
      ? before
      : Math.max(0, before - lastAfter);
    if (
      page.items.length > 0 &&
      page.used + beforeApplied + lines[0].height > contentHeight
    ) {
      newPage();
      beforeApplied = before;
    }
    page.used += beforeApplied;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      line.spaceBeforeApplied = lineIndex === 0 ? beforeApplied : 0;

      // 孤行控制：段首只剩一行时，整段挪到下一页（如果一整页放得下）。
      if (
        lineIndex === 0 &&
        lines.length >= 2 &&
        props.widowControl !== false &&
        page.items.length > 0 &&
        linesHeight <= contentHeight &&
        page.used + line.height + lines[1].height > contentHeight
      ) {
        newPage();
        line.spaceBeforeApplied = 0;
      }

      // 孤行控制：最后一行会单独落到下一页时，把倒数第二行也带过去。
      if (
        lineIndex === lines.length - 2 &&
        lineIndex > 0 &&
        props.widowControl !== false &&
        page.items.length > 0 &&
        page.used + line.height + lines[lineIndex + 1].height > contentHeight
      ) {
        newPage();
      }

      if (page.used + line.height > contentHeight + 0.01 && page.items.length > 0) {
        newPage();
        line.spaceBeforeApplied = 0;
      }

      line.top = page.used;
      page.lines.push(line);
      page.items.push({ kind: "line", line });
      page.used += line.height;

      if (line.pageBreakAfter) newPage();
    }

    page.used += after;
    lastAfter = after;
  }

  if (page.items.length > 0) pages.push(page);
  if (pages.length === 0) pages.push({ lines: [], items: [], used: 0 });

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    for (const line of pages[pageIndex].lines) line.pageIndex = pageIndex;
    for (const item of pages[pageIndex].items) {
      if (item.kind !== "table-row") continue;
      for (const cell of item.row.cells) {
        if (cell.hidden) continue;
        const originX = item.table.x + cell.x + (cell.margins?.left ?? 0);
        const originY = item.top + (cell.contentTop ?? 0);
        for (const line of cell.lines ?? []) {
          line.pageIndex = pageIndex;
          line.tableOriginX = originX;
          line.tableOriginY = originY;
        }
      }
    }
  }

  return pages;
}
