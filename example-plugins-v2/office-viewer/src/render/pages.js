/**
 * 页面渲染。
 *
 * 行由排版引擎决定，渲染层只做两件事：
 *
 * 1. 把行 / 原子画成 DOM（字体、颜色、上下标、两端对齐、图片）；
 * 2. 按页虚拟化 —— 先用固定高度的空页撑出滚动条，滚到附近才真正画内容。
 *
 * 段落标记（¶ / ↵ / → / ·）与段落序号是**显示开关**，不影响排版；打开时重画当前页即可。
 */

import { browserFontMetrics, fontFamily } from "../layout/measure.js";

/** 页数不多时直接全画；超过这个数就按视口懒加载。 */
const ALL_AT_ONCE = 24;

function applyTextStyle(span, atom, line, options) {
  span.style.fontFamily = fontFamily(atom.style, atom.isCJK, options);
  span.style.fontSize = `${atom.size}px`;
  span.style.fontWeight = atom.style.bold ? "700" : "400";
  span.style.fontStyle = atom.style.italic ? "italic" : "normal";
  span.style.whiteSpace = "pre";

  if (atom.style.color) span.style.color = atom.style.color;
  if (atom.style.background) span.style.backgroundColor = atom.style.background;

  const decorations = [];
  if (atom.style.underline) decorations.push("underline");
  if (atom.style.strike || atom.style.doubleStrike) decorations.push("line-through");
  if (decorations.length > 0) span.style.textDecorationLine = decorations.join(" ");

  if (atom.style.caps) {
    span.style.textTransform = "uppercase";
  } else if (atom.style.smallCaps) {
    span.style.fontVariantCaps = "small-caps";
  }

  if (atom.style.vertAlign === "superscript") span.style.verticalAlign = "super";
  else if (atom.style.vertAlign === "subscript") span.style.verticalAlign = "sub";

  const letterSpacing =
    (atom.style.letterSpacingPx ?? 0) + (line.justified ? line.letterSpacing : 0);
  if (Math.abs(letterSpacing) > 0.001) span.style.letterSpacing = `${letterSpacing}px`;
}

function markElement(text) {
  const mark = document.createElement("span");
  mark.className = "fmt-mark";
  mark.textContent = text;
  return mark;
}

function renderTextAtom(atom, line, display, options) {
  const span = document.createElement("span");
  span.textContent = atom.text;
  applyTextStyle(span, atom, line, options);

  if (atom.isSpace && display.showMarks) {
    span.classList.add("space-atom");
    span.append(markElement("·"));
  }

  return span;
}

function renderTabAtom(atom, display) {
  const span = document.createElement("span");
  span.className = "tab-atom";
  span.style.display = "inline-block";
  span.style.width = `${Math.max(0, atom.width)}px`;
  span.style.height = "1px";
  span.style.verticalAlign = "baseline";
  if (display.showMarks) {
    span.style.position = "relative";
    span.append(markElement("→"));
  }
  return span;
}

function renderImageAtom(atom) {
  if (atom.src) {
    const image = document.createElement("img");
    image.src = atom.src;
    image.alt = atom.alt ?? "";
    image.style.width = `${atom.width}px`;
    image.style.height = `${atom.height}px`;
    image.style.verticalAlign = "baseline";
    image.draggable = false;
    return image;
  }

  const placeholder = document.createElement("span");
  placeholder.className = "image-placeholder";
  placeholder.textContent = atom.label ?? "[图片]";
  placeholder.style.width = `${atom.width}px`;
  placeholder.style.height = `${atom.height}px`;
  placeholder.style.lineHeight = `${Math.min(atom.height, 40)}px`;
  return placeholder;
}

/**
 * 行盒基线在 CSS 里的落点。
 *
 * `line-height: 行高` 会让浏览器按字体自己的 ascent/descent 把文字垂直居中，
 * 固定值 / 最小值行距下（Word 把基线固定在行盒的某个位置）会差好几个点。
 * 这里改成「父盒子只定高度，内层按 `line.baseline` 摆」。
 *
 * 含上下标的行不套这一层：它们已经用 CSS `vertical-align` 定位，再叠一次会双重偏移。
 */
function lineContentOffset(line, options) {
  if (line.baseline == null || line.atoms.length === 0) return null;
  let ascent = 0;
  for (const atom of line.atoms) {
    if (atom.kind !== "text" || atom.isSpace) continue;
    if (atom.style?.vertAlign) return null;
    const metrics = browserFontMetrics(atom.style, atom.isCJK, options);
    if (metrics.ascent > ascent) ascent = metrics.ascent;
  }
  if (ascent === 0) return null;
  return line.baseline - ascent;
}

function renderLine(line, display) {
  const element = document.createElement("div");
  element.className = "line";
  element.style.top = `${line.top}px`;
  element.style.left = `${line.paddingLeft}px`;
  element.style.width = `${line.availableWidth}px`;
  element.style.height = `${line.height}px`;
  element.style.lineHeight = `${line.height}px`;
  if (line.alignment === "center") element.style.textAlign = "center";
  else if (line.alignment === "right" || line.alignment === "end") {
    element.style.textAlign = "right";
  }

  const options = display.layoutOptions;
  const offset = lineContentOffset(line, options);
  let content = element;
  if (offset != null) {
    content = document.createElement("div");
    content.className = "line-content";
    content.style.position = "absolute";
    content.style.left = "0";
    content.style.right = "0";
    content.style.top = `${offset}px`;
    content.style.lineHeight = "normal";
    element.append(content);
  }

  for (const atom of line.atoms) {
    if (atom.kind === "text") {
      content.append(renderTextAtom(atom, line, display, options));
    } else if (atom.kind === "tab") {
      content.append(renderTabAtom(atom, display));
    } else if (atom.kind === "image" && !atom.floating) {
      content.append(renderImageAtom(atom));
    }
  }

  if (display.showMarks) {
    if (line.manualBreak) content.append(markElement("↵"));
    if (line.pageBreakAfter) content.append(markElement("⤓"));
    if (line.paragraphEnd) content.append(markElement("¶"));
  }

  return element;
}

function cssBorder(border) {
  if (!border || border.style === "none") return "none";
  const width = Math.max(0.5, border.widthPx ?? 0.5);
  return `${width}px solid #${border.color ?? "000000"}`;
}

function cellBorder(table, cell, edge) {
  const own = cell.borders?.[edge];
  if (own) return own;
  const tableEdge = edge === "insideH" ? "insideH" : edge === "insideV" ? "insideV" : edge;
  return table.props?.borders?.[tableEdge] ?? null;
}

function renderTableCell(table, cell, rowHeight, display) {
  const element = document.createElement("div");
  element.className = "table-cell";
  element.style.left = `${cell.x}px`;
  element.style.top = "0";
  element.style.width = `${cell.width}px`;
  element.style.height = `${rowHeight}px`;
  element.style.borderTop = cssBorder(cellBorder(table, cell, "top"));
  element.style.borderLeft = cssBorder(cellBorder(table, cell, "left"));
  element.style.borderBottom = cssBorder(cellBorder(table, cell, "bottom"));
  element.style.borderRight = cssBorder(cellBorder(table, cell, "right"));
  if (cell.fill && cell.fill !== "auto") element.style.backgroundColor = `#${cell.fill}`;
  if (cell.rowSpan > 1) element.style.zIndex = "2";

  const content = document.createElement("div");
  content.className = "cell-content";
  content.style.position = "absolute";
  content.style.left = `${cell.margins?.left ?? 0}px`;
  content.style.top = `${cell.contentTop ?? 0}px`;
  content.style.width = `${Math.max(
    1,
    cell.width - (cell.margins?.left ?? 0) - (cell.margins?.right ?? 0),
  )}px`;
  for (const line of cell.lines ?? []) content.append(renderLine(line, display));
  element.append(content);
  return element;
}

function renderTableRow(item, display) {
  const { table, row, top } = item;
  const element = document.createElement("div");
  element.className = "table-row";
  element.style.left = `${table.x}px`;
  element.style.top = `${top}px`;
  element.style.width = `${table.width}px`;
  element.style.height = `${row.height}px`;

  for (const cell of row.cells) {
    if (cell.hidden) continue;
    element.append(renderTableCell(table, cell, cell.height ?? row.height, display));
  }
  return element;
}

function renderParagraphNumber(pageElement, line, section) {
  const number = document.createElement("span");
  number.className = "para-number";
  number.textContent = String(line.paraNumber);
  number.style.top = `${section.margin.top + line.top}px`;
  number.style.left = `${Math.max(4, section.margin.left - 38)}px`;
  number.style.width = "30px";
  number.style.height = `${line.height}px`;
  number.style.lineHeight = `${line.height}px`;
  pageElement.append(number);
}

/** 浮动图片：按锚点相对段落 / 栏 / 页面绝对定位，不参与行内排版。 */
function floatingImageElement(atom, x, y) {
  const image = renderImageAtom({
    ...atom,
    width: atom.drawWidth ?? atom.width,
    height: atom.drawHeight ?? atom.height,
  });
  image.classList.add("floating-image");
  image.style.position = "absolute";
  image.style.left = `${x}px`;
  image.style.top = `${y}px`;
  image.style.pointerEvents = "none";
  return image;
}

function floatingImages(page, section) {
  const behind = [];
  const front = [];
  const lines = page.lines ?? [];
  for (const line of lines) {
    for (const atom of line.atoms ?? []) {
      if (!atom.floating) continue;
      const anchor = atom.anchor ?? {};
      const firstLine =
        lines.find(
          (candidate) =>
            candidate.paragraphIndex === line.paragraphIndex &&
            candidate.isFirstInParagraph,
        ) ?? line;
      let x = anchor.x ?? 0;
      if (anchor.relativeH === "page") x -= section.margin.left;
      let y = firstLine.top + (anchor.y ?? 0);
      if (anchor.relativeV === "page") y -= section.margin.top;
      else if (anchor.relativeV === "margin") y = anchor.y ?? 0;
      const element = floatingImageElement(atom, x, y);
      element.style.zIndex = anchor.behindDoc ? "0" : "3";
      (anchor.behindDoc ? behind : front).push(element);
    }
  }
  return { behind, front };
}

function renderPageContent(pageElement, page, doc, display) {
  const content = pageElement.querySelector(".page-content");
  content.replaceChildren();
  pageElement.querySelectorAll(".para-number").forEach((element) => element.remove());

  const items = page.items ?? page.lines.map((line) => ({ kind: "line", line }));
  const { behind, front } = floatingImages(page, doc.section);
  for (const item of items) {
    if (item.kind === "table-row") {
      content.append(renderTableRow(item, display));
      continue;
    }
    const line = item.line;
    content.append(renderLine(line, display));
    if (display.showParagraphNumbers && line.isFirstInParagraph) {
      renderParagraphNumber(pageElement, line, doc.section);
    }
  }
  if (behind.length > 0) content.prepend(...behind);
  if (front.length > 0) content.append(...front);
  pageElement.dataset.rendered = "true";
}

export function createPageElement(pageIndex, section) {
  const element = document.createElement("section");
  element.className = "page";
  element.dataset.index = String(pageIndex);
  element.style.width = `${section.pageWidth}px`;
  element.style.height = `${section.pageHeight}px`;

  const content = document.createElement("div");
  content.className = "page-content";
  content.style.left = `${section.margin.left}px`;
  content.style.top = `${section.margin.top}px`;
  content.style.width = `${section.contentWidth}px`;
  content.style.height = `${section.contentHeight}px`;
  element.append(content);
  return element;
}

/**
 * 把整份文档画到 `container` 里。
 *
 * 返回一个句柄：`scrollToPage` / `currentPage` / `setDisplay` / `destroy`。
 * 重新排版时调用方直接重新 `renderDocument`，不必自己清 DOM。
 */
export function renderDocument(container, doc, display) {
  container.replaceChildren();

  const pageElements = [];
  const observer =
    doc.pages.length > ALL_AT_ONCE
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const index = Number(entry.target.dataset.index);
              if (entry.target.dataset.rendered === "true") continue;
              renderPageContent(entry.target, doc.pages[index], doc, display);
            }
          },
          { root: container.closest(".viewport"), rootMargin: "900px 0px" },
        )
      : null;

  doc.pages.forEach((page, index) => {
    const element = createPageElement(index, doc.section);
    pageElements.push(element);
    container.append(element);
    if (!observer || index < 2) {
      renderPageContent(element, page, doc, display);
    } else {
      observer.observe(element);
    }
  });

  return {
    pageElements,
    observer,
    elementAt(index) {
      return pageElements[index] ?? null;
    },
    renderPage(index) {
      const element = pageElements[index];
      if (!element || element.dataset.rendered === "true") return;
      renderPageContent(element, doc.pages[index], doc, display);
    },
    destroy() {
      observer?.disconnect();
      container.replaceChildren();
    },
  };
}
