/**
 * 光标、选区与输入法预览的绘制层。
 *
 * 每页一个 `.edit-overlay`，挂在 `.page` 上（与 `.page-content` 平级），所以
 * `renderPageContent` 整块重画时它不会跟着消失。坐标是页面坐标（含页边距）。
 */

import { caretRect, selectionRects } from "./hit-test.js";

const OVERLAY_CLASS = "edit-overlay";
const SELECTION_CLASS = "edit-selection";
const CARET_CLASS = "edit-caret";
const COMPOSITION_CLASS = "edit-composition";

function makeDiv(className) {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

export function createOverlay({ renderer, section, onCaretMoved }) {
  const overlays = new Map();
  let disposed = false;

  const marginLeft = section?.margin?.left ?? 0;
  const marginTop = section?.margin?.top ?? 0;

  function overlayFor(pageIndex) {
    const existing = overlays.get(pageIndex);
    if (existing && existing.isConnected) return existing;
    const page = renderer.elementAt(pageIndex);
    if (!page) return null;
    const overlay = makeDiv(OVERLAY_CLASS);
    page.appendChild(overlay);
    overlays.set(pageIndex, overlay);
    return overlay;
  }

  function clear(overlay) {
    overlay.replaceChildren();
  }

  function draw(state) {
    if (disposed) return;
    const layout = state.layout;
    if (!layout) return;

    // 先把上一帧的标记清掉；只动已经建过的页。
    for (const overlay of overlays.values()) clear(overlay);

    const rects = state.selection?.anchor && state.selection?.focus
      ? selectionRects(layout, state.selection.anchor, state.selection.focus)
      : [];

    const grouped = new Map();
    for (const rect of rects) {
      const list = grouped.get(rect.pageIndex) ?? [];
      list.push(rect);
      grouped.set(rect.pageIndex, list);
    }

    const caret = state.caret ? caretRect(layout, state.caret) : null;
    if (caret) {
      const list = grouped.get(caret.pageIndex) ?? [];
      grouped.set(caret.pageIndex, list);
    }

    for (const [pageIndex, pageRects] of grouped.entries()) {
      const overlay = overlayFor(pageIndex);
      if (!overlay) continue;
      for (const rect of pageRects) {
        if (!rect.width && !rect.height) continue;
        const element = makeDiv(SELECTION_CLASS);
        element.style.left = `${marginLeft + rect.x}px`;
        element.style.top = `${marginTop + rect.y}px`;
        element.style.width = `${rect.width}px`;
        element.style.height = `${rect.height}px`;
        overlay.appendChild(element);
      }
    }

    if (caret) {
      const overlay = overlayFor(caret.pageIndex);
      if (overlay) {
        const element = makeDiv(CARET_CLASS);
        element.style.left = `${marginLeft + caret.x}px`;
        element.style.top = `${marginTop + caret.y}px`;
        element.style.height = `${caret.height}px`;
        overlay.appendChild(element);
        onCaretMoved?.({ pageIndex: caret.pageIndex, x: marginLeft + caret.x, y: marginTop + caret.y, height: caret.height });
      }

      if (state.composition?.text) {
        const element = document.createElement("span");
        element.className = COMPOSITION_CLASS;
        element.textContent = state.composition.text;
        if (state.composition.style) {
          const style = state.composition.style;
          element.style.fontFamily = style.fontFamily ?? "";
          element.style.fontSize = style.fontSize ?? "";
          element.style.lineHeight = `${caret.height}px`;
          element.style.color = style.color ?? "";
        }
        element.style.left = `${marginLeft + caret.x}px`;
        element.style.top = `${marginTop + caret.y}px`;
        element.style.minHeight = `${caret.height}px`;
        overlay.appendChild(element);
      }
    }
  }

  function destroy() {
    disposed = true;
    for (const overlay of overlays.values()) overlay.remove();
    overlays.clear();
  }

  return { draw, destroy };
}
