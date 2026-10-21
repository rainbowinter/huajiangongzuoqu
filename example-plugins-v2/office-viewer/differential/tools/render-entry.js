import { parseDocx } from "../../src/docx/parse.js";
import { defaultLayoutOptions, layoutDocument } from "../../src/layout/index.js";
import { renderDocument } from "../../src/render/pages.js";

export async function renderFixture(url) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const doc = await parseDocx(bytes);
  const layout = layoutDocument(doc, defaultLayoutOptions());
  const viewport = document.getElementById("viewport");
  const pages = document.getElementById("pages");
  renderDocument(pages, layout, {
    showMarks: false,
    showParagraphNumbers: false,
    layoutOptions: defaultLayoutOptions(),
  });
  viewport.dataset.pages = String(layout.pages.length);
  const floats = [];
  for (const page of layout.pages) {
    for (const line of page.lines) {
      for (const atom of line.atoms ?? []) {
        if (!atom.floating) {
          if (atom.kind === "image") {
            floats.push({ inline: true, para: line.paragraphIndex, top: line.top, lh: line.height, w: atom.width, h: atom.height });
          }
          continue;
        }
        floats.push({
          para: line.paragraphIndex,
          page: line.pageIndex,
          top: line.top,
          first: line.isFirstInParagraph,
          anchor: atom.anchor,
        });
      }
    }
  }
  const rects = Array.from(pages.querySelectorAll("img, .image-placeholder")).map((el) => {
    const r = el.getBoundingClientRect();
    const page = el.closest(".page").getBoundingClientRect();
    const pageEl = el.closest(".page");
    const content = el.closest(".page-content");
    const cr = content?.getBoundingClientRect();
    return { cls: el.className, page: Array.from(document.querySelectorAll(".page")).indexOf(pageEl),
      absY: r.top, x: r.left - page.left, y: r.top - page.top, w: r.width, h: r.height,
      contentTop: cr ? cr.top : null, contentStyleTop: content?.style.top, contentComputedTop: content ? getComputedStyle(content).top : null, contentPosition: content ? getComputedStyle(content).position : null, contentOffsetTop: content?.offsetTop, pageStyleTop: pageEl?.style.top, parentPage: content ? Array.from(document.querySelectorAll(".page")).indexOf(content.closest(".page")) : null };
  });
  const pageRects = Array.from(document.querySelectorAll(".page")).map((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
  const pre = document.createElement("pre");
  pre.id = "debug";
  pre.textContent = JSON.stringify({ floats, rects, pageRects });
  document.body.append(pre);
  return { pages: layout.pages.length, lines: layout.laidOut.lineCount, floats };
}
