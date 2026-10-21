/**
 * 编辑器的「视图侧」：光标、选区、焦点与键盘/指针。
 *
 * 输入与 XML 修改不在这里 —— M5.2 起由 `operations.js` 接管；这一层只负责
 * 「用户在哪个位置、看到什么」，并把位置维护成与布局无关的 `{blockKey,itemIndex,offset}`。
 */

import {
  blockByKey,
  blockEndCaret,
  blockOffsetCaret,
  blockStartCaret,
  blockTextOffset,
  isEditableBlock,
  normalizeCaret,
  selectionText,
  stepCaret,
  wordRangeAt,
} from "./source-map.js";
import { recountStats, replaceDocumentXml } from "../docx/parse.js";
import { createHistory } from "./history.js";
import {
  applyRunFormat,
  deleteBackward,
  deleteForward,
  insertPlainText,
  insertSoftBreak,
  insertTableAt,
  insertTextAt,
  mergeWithNext,
  mergeWithPrevious,
  replaceSelection,
  splitParagraph,
} from "./operations.js";
import {
  caretRect,
  hitTest,
  lineForCaret,
  pagePointFromClient,
  verticalCaret,
} from "./hit-test.js";
import { effectiveSizePx, fontFamily } from "../layout/measure.js";
import { createOverlay } from "./overlay.js";

function collapsed(selection) {
  if (!selection?.anchor || !selection?.focus) return true;
  return (
    selection.anchor.blockKey === selection.focus.blockKey &&
    selection.anchor.itemIndex === selection.focus.itemIndex &&
    selection.anchor.offset === selection.focus.offset
  );
}

export function createEditor(options) {
  const { pagesElement, viewport, ime } = options;
  let doc = options.doc;
  let layout = options.layout;
  let renderer = options.renderer;
  let section = options.section;
  const getZoom = options.getZoom ?? (() => 1);

  let selection = null;
  let desiredX = null;
  let dragging = false;
  let overlay = null;
  /** 输入法组合：{ selection, text }；只画预览，不碰 XML。 */
  let composition = null;
  let lastCompositionEnd = 0;

  function serializeXml() {
    return new XMLSerializer().serializeToString(doc.source.documentXml);
  }

  function pointOf(caret) {
    const block = blockByKey(doc, caret?.blockKey);
    if (!block) return null;
    return { blockIndex: block.index, offset: blockTextOffset(block, caret) };
  }

  function caretOfPoint(point) {
    if (!point) return null;
    const index = Math.max(0, Math.min(point.blockIndex ?? 0, doc.blocks.length - 1));
    let block = doc.blocks[index];
    if (!block || !isEditableBlock(block)) block = doc.blocks.find(isEditableBlock) ?? null;
    if (!block) return null;
    return blockOffsetCaret(block, point.offset ?? 0);
  }

  const history = createHistory({ initialXml: serializeXml() });
  doc.dirty = false;

  function editableRange() {
    const blocks = doc.blocks.filter(isEditableBlock);
    if (blocks.length === 0) return null;
    return { start: blockStartCaret(blocks[0]), end: blockEndCaret(blocks[blocks.length - 1]) };
  }

  function compositionStyle() {
    if (!selection) return null;
    const block = blockByKey(doc, selection.focus.blockKey);
    const item = block?.items?.[selection.focus.itemIndex];
    const style = item?.style ?? block?.defaultStyle;
    if (!style) return null;
    return {
      fontFamily: fontFamily(style, true),
      fontSize: `${effectiveSizePx(style)}px`,
      color: style.color ?? "",
    };
  }

  function draw() {
    if (!overlay) return;
    // 组合期间光标固定，选区高亮暂时让位给预览。
    const caret = selection && (collapsed(selection) || composition) ? selection.focus : null;
    overlay.draw({
      layout,
      selection: composition ? null : selection,
      caret,
      composition: composition
        ? { text: composition.text, style: compositionStyle() }
        : null,
    });
  }

  function positionIme() {
    if (!ime || !selection) return;
    const rect = caretRect(layout, selection.focus);
    if (!rect) {
      ime.style.left = "-1000px";
      ime.style.top = "-1000px";
      return;
    }
    const page = renderer.elementAt(rect.pageIndex);
    if (!page) return;
    const pageRect = page.getBoundingClientRect();
    const zoom = getZoom();
    const left = pageRect.left + ((section.margin?.left ?? 0) + rect.x) * zoom;
    const top = pageRect.top + ((section.margin?.top ?? 0) + rect.y) * zoom;
    // 光标贴在输入框的上沿：候选框会跟着它出现。
    ime.style.left = `${Math.round(left)}px`;
    ime.style.top = `${Math.round(top)}px`;
    ime.style.height = `${Math.max(1, Math.round(rect.height * zoom))}px`;
  }

  function scrollCaretIntoView() {
    if (!selection) return;
    const rect = caretRect(layout, selection.focus);
    if (!rect) return;
    const page = renderer.elementAt(rect.pageIndex);
    if (!page) return;
    const zoom = getZoom();
    const pageRect = page.getBoundingClientRect();
    const viewRect = viewport.getBoundingClientRect();
    const top = pageRect.top + ((section.margin?.top ?? 0) + rect.y) * zoom;
    const bottom = top + Math.max(rect.height, 12) * zoom;
    const padding = 28;
    if (top < viewRect.top + padding) {
      viewport.scrollTop -= viewRect.top + padding - top;
    } else if (bottom > viewRect.bottom - padding) {
      viewport.scrollTop += bottom - (viewRect.bottom - padding);
    }
  }

  function setSelection(next, { extend = false, scroll = true } = {}) {
    if (!next?.focus) return;
    if (extend && selection) {
      selection = {
        anchor: normalizeCaret(doc, selection.anchor) ?? selection.anchor,
        focus: normalizeCaret(doc, next.focus),
      };
    } else {
      const caret = normalizeCaret(doc, next.focus);
      selection = caret ? { anchor: caret, focus: caret } : null;
    }
    draw();
    positionIme();
    if (scroll) scrollCaretIntoView();
  }

  function setCaret(caret, options = {}) {
    setSelection({ focus: caret }, options);
  }

  function ensureFocus() {
    if (!ime) return;
    if (document.activeElement !== ime) ime.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- 编辑事务

  // 输入事件可能比重解析快：串行化，保证后一次编辑看到前一次的结果。
  let editQueue = Promise.resolve();

  function enqueueEdit(task) {
    editQueue = editQueue.then(task).catch((error) => {
      options.onError?.(error);
    });
  }

  async function settleEdit(result) {
    if (!result) return;
    if (result.unsupported) {
      options.onUnsupported?.(result.unsupported);
      return;
    }
    if (result.merge) {
      options.onMerge?.(result);
      return;
    }
    if (!result.caretAfter) return;

    await options.onEdited?.(result);
    selection = result.selectionAfter
      ? { anchor: result.selectionAfter.anchor, focus: result.selectionAfter.focus }
      : { anchor: result.caretAfter, focus: result.caretAfter };
    desiredX = null;
    draw();
    positionIme();
    scrollCaretIntoView();
  }

  /**
   * 一次用户动作 = 一个入队任务 + 一条历史记录。
   *
   * `beforeXml` 在任务之前取，`afterXml` 在重排之后取；两字符串相同就不记
   * （例如在空段末尾按 Delete）。
   */
  function runEdit(kind, task) {
    enqueueEdit(async () => {
      if (!selection) return;
      const beforeXml = serializeXml();
      const selectionBefore = pointOf(selection.focus);
      const result = await task();
      if (!result) return;
      if (result.unsupported) {
        options.onUnsupported?.(result.unsupported);
        return;
      }
      if (result.merge) {
        options.onMerge?.(result);
        return;
      }
      if (!result.caretAfter) return;

      recountStats(doc);
      await settleEdit(result);
      const afterXml = serializeXml();
      if (afterXml === beforeXml) return;

      history.record({
        beforeXml,
        afterXml,
        selectionBefore,
        selectionAfter: pointOf(selection?.focus),
        blockIndex: selectionBefore?.blockIndex ?? 0,
        kind,
        time: Date.now(),
      });
      doc.dirty = history.isDirty(afterXml);
      options.onDirtyChange?.(doc.dirty);
    });
  }

  function insertTextData(text) {
    runEdit("text", async () => {
      const current = selection;
      return collapsed(current)
        ? insertTextAt(doc, current.focus, text)
        : replaceSelection(doc, current, text);
    });
  }

  function deleteBackwardData() {
    runEdit("text", async () => {
      const current = selection;
      const result = collapsed(current)
        ? await deleteBackward(doc, current.focus)
        : await replaceSelection(doc, current, "");
      if (result?.merge === "backward") {
        return (await mergeWithPrevious(doc, result.block)) ?? null;
      }
      return result;
    });
  }

  function deleteForwardData() {
    runEdit("text", async () => {
      const current = selection;
      const result = collapsed(current)
        ? await deleteForward(doc, current.focus)
        : await replaceSelection(doc, current, "");
      if (result?.merge === "forward") {
        return (await mergeWithNext(doc, result.block)) ?? null;
      }
      return result;
    });
  }

  function enterData(soft) {
    runEdit("struct", async () => {
      let current = selection;
      if (!collapsed(current)) {
        const deleted = await replaceSelection(doc, current, "");
        if (!deleted || deleted.unsupported) return deleted;
        current = { anchor: deleted.caretAfter, focus: deleted.caretAfter };
      }
      return soft
        ? insertSoftBreak(doc, current.focus)
        : splitParagraph(doc, current.focus);
    });
  }

  // ---------------------------------------------------------------- 剪贴板

  function copySelection(event) {
    if (!selection || collapsed(selection)) return false;
    const text = selectionText(doc, selection);
    if (!text) return false;
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    return true;
  }

  function cutSelection(event) {
    if (!copySelection(event)) return;
    const current = selection;
    runEdit("text", async () => replaceSelection(doc, current, ""));
  }

  function onCopy(event) {
    copySelection(event);
  }

  function onCut(event) {
    cutSelection(event);
  }

  function pasteText(text) {
    if (!text) return;
    // 超大粘贴会拖死排版；先截断并明确告诉用户。
    const limit = 1_000_000;
    const clipped = text.length > limit ? text.slice(0, limit) : text;
    if (clipped !== text) options.onUnsupported?.("paste-large");

    runEdit("paste", async () => {
      let current = selection;
      if (!collapsed(current)) {
        const deleted = await replaceSelection(doc, current, "");
        if (!deleted || deleted.unsupported) return deleted;
        current = { anchor: deleted.caretAfter, focus: deleted.caretAfter };
      }
      return insertPlainText(doc, current.focus, clipped);
    });
  }

  function onPaste(event) {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    if (text) pasteText(text);
  }

  // ---------------------------------------------------------------- 撤销 / 重做

  async function restoreSnapshot(entry, useAfter) {
    const xml = useAfter ? entry.afterXml : entry.beforeXml;
    const point = useAfter ? entry.selectionAfter : entry.selectionBefore;
    await replaceDocumentXml(doc, xml);
    await options.onEdited?.({
      dirtyKeys: doc.blocks.map((block) => block.key),
      caretAfter: null,
    });

    const caret = caretOfPoint(point);
    selection = caret ? { anchor: caret, focus: caret } : null;
    desiredX = null;
    draw();
    positionIme();
    if (caret) scrollCaretIntoView();

    doc.dirty = history.isDirty(serializeXml());
    options.onDirtyChange?.(doc.dirty);
  }

  function undoEdit() {
    enqueueEdit(async () => {
      const entry = history.undo();
      if (entry) await restoreSnapshot(entry, false);
    });
  }

  function redoEdit() {
    enqueueEdit(async () => {
      const entry = history.redo();
      if (entry) await restoreSnapshot(entry, true);
    });
  }

  // ---------------------------------------------------------------- 指针

  function caretFromEvent(event) {
    const point = pagePointFromClient({
      clientX: event.clientX,
      clientY: event.clientY,
      renderer,
      section,
      zoom: getZoom(),
    });
    if (!point) return null;
    return hitTest(layout, point.pageIndex, point.x, point.y);
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const caret = caretFromEvent(event);
    if (!caret) return;
    // 表格拍平行等只读区域：点了不移动光标，也不抢焦点。
    const targetBlock = blockByKey(doc, caret.blockKey);
    if (!targetBlock || !isEditableBlock(targetBlock)) return;
    event.preventDefault();
    ensureFocus();

    if (event.detail >= 3) {
      const block = blockByKey(doc, caret.blockKey);
      if (block && isEditableBlock(block)) {
        setSelection({ anchor: blockStartCaret(block), focus: blockEndCaret(block) });
        dragging = false;
        return;
      }
    }

    dragging = true;
    desiredX = null;
    // 合成事件（验证台）没有真实 pointer，原生 capture 会抛 NotFoundError。
    try {
      pagesElement.setPointerCapture?.(event.pointerId);
    } catch {
      // 忽略：没有 capture 也能完成这次拖选。
    }
    setSelection({ focus: caret }, { extend: event.shiftKey });
  }

  function onPointerMove(event) {
    if (!dragging) return;
    const caret = caretFromEvent(event);
    if (!caret) return;
    event.preventDefault();
    setSelection({ focus: caret }, { extend: true, scroll: false });
  }

  function onPointerUp(event) {
    if (!dragging) return;
    dragging = false;
    try {
      pagesElement.releasePointerCapture?.(event.pointerId);
    } catch {
      // 同上。
    }
  }

  function onDoubleClick(event) {
    const caret = caretFromEvent(event);
    if (!caret) return;
    const block = blockByKey(doc, caret.blockKey);
    if (!block || !isEditableBlock(block)) return;
    event.preventDefault();
    ensureFocus();
    const range = wordRangeAt(doc, caret);
    if (range) setSelection(range);
  }

  // ---------------------------------------------------------------- 键盘

  function currentLine() {
    if (!selection) return null;
    // 行信息挂在 layout 的 block 上；单元格段落不在 layout.blocks 里，
    // 要走 keyToBlock（表格重排后它指向带 lines 的那一份）。
    const block =
      layout.keyToBlock?.get(selection.focus.blockKey) ??
      layout.blocks.find((candidate) => candidate.key === selection.focus.blockKey);
    if (!block) return null;
    return { block, line: lineForCaret(block, selection.focus) };
  }

  function moveVertical(direction, extend) {
    if (!selection) return;
    const rect = caretRect(layout, selection.focus);
    if (!rect) return;
    const target = verticalCaret(layout, selection.focus, direction, desiredX ?? rect.x);
    if (!target) return;
    if (desiredX == null) desiredX = rect.x;
    setSelection({ focus: target }, { extend, scroll: false });
  }

  function moveLineEdge(toEnd, extend) {
    const current = currentLine();
    if (!current?.line) return;
    const caret = toEnd ? current.line.endCaret : current.line.startCaret;
    setSelection(
      { focus: { blockKey: current.block.key, ...caret } },
      { extend, scroll: false },
    );
  }

  function movePage(direction, extend) {
    const rect = caretRect(layout, selection.focus);
    if (!rect) return;
    const targetPage = Math.max(0, Math.min(layout.pages.length - 1, rect.pageIndex + direction));
    if (targetPage === rect.pageIndex) return;
    const target = hitTest(layout, targetPage, rect.x, 4);
    if (target) setSelection({ focus: target }, { extend, scroll: false });
  }

  function onKeyDown(event) {
    if (!selection || event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    const extend = event.shiftKey;
    let handled = true;

    switch (event.key) {
      case "ArrowLeft":
        if (!mod) setSelection({ focus: stepCaret(doc, selection.focus, -1) }, { extend });
        break;
      case "ArrowRight":
        if (!mod) setSelection({ focus: stepCaret(doc, selection.focus, 1) }, { extend });
        break;
      case "ArrowUp":
        moveVertical(-1, extend);
        break;
      case "ArrowDown":
        moveVertical(1, extend);
        break;
      case "Home":
        if (mod) {
          const block = blockByKey(doc, selection.focus.blockKey);
          if (block) setSelection({ focus: blockStartCaret(block) }, { extend });
        } else {
          moveLineEdge(false, extend);
        }
        break;
      case "End":
        if (mod) {
          const block = blockByKey(doc, selection.focus.blockKey);
          if (block) setSelection({ focus: blockEndCaret(block) }, { extend });
        } else {
          moveLineEdge(true, extend);
        }
        break;
      case "PageUp":
        movePage(-1, extend);
        break;
      case "PageDown":
        movePage(1, extend);
        break;
      case "a":
      case "A":
        if (mod) {
          const range = editableRange();
          if (range) setSelection(range);
        } else {
          handled = false;
        }
        break;
      case "z":
      case "Z":
        if (mod) {
          if (event.shiftKey) redoEdit();
          else undoEdit();
        } else {
          handled = false;
        }
        break;
      case "y":
      case "Y":
        if (mod) redoEdit();
        else handled = false;
        break;
      case "s":
      case "S":
        if (mod) options.onSave?.();
        else handled = false;
        break;
      case "Escape":
        setSelection({ focus: selection.focus });
        break;
      case "Tab":
        // M5.6 会插入 w:tab；现在先别让焦点跳走。
        break;
      case "Backspace":
        deleteBackwardData();
        break;
      case "Delete":
        deleteForwardData();
        break;
      case "Enter":
        enterData(event.shiftKey);
        break;
      default:
        handled = false;
    }

    if (handled) {
      event.preventDefault();
      desiredX = null;
    }
  }

  function cloneSelection(value) {
    if (!value?.anchor || !value?.focus) return null;
    return {
      anchor: { ...value.anchor },
      focus: { ...value.focus },
    };
  }

  function onCompositionStart() {
    if (!selection) return;
    composition = { selection: cloneSelection(selection), text: "" };
    draw();
  }

  function onCompositionUpdate(event) {
    if (!composition) {
      if (!selection) return;
      composition = { selection: cloneSelection(selection), text: "" };
    }
    composition.text = event.data ?? "";
    draw();
  }

  function onCompositionEnd(event) {
    const pending = composition;
    composition = null;
    lastCompositionEnd = performance.now();
    if (ime) ime.value = "";
    if (!pending?.selection) {
      draw();
      return;
    }
    const text = event.data ?? pending.text ?? "";
    if (!text) {
      draw();
      return;
    }
    const base = pending.selection;
    enqueueEdit(async () => {
      const result = collapsed(base)
        ? await insertTextAt(doc, base.focus, text)
        : await replaceSelection(doc, base, text);
      await settleEdit(result);
    });
  }

  function onBeforeInput(event) {
    // 组合期间由输入法接管；这里不碰，也不阻止默认。
    if (event.isComposing) return;
    if (event.inputType === "insertCompositionText") {
      event.preventDefault();
      return;
    }
    // 有的 WebView 在 compositionend 之后还会补一个 insertText，去重。
    if (
      event.inputType === "insertText" &&
      performance.now() - lastCompositionEnd < 80
    ) {
      event.preventDefault();
      return;
    }
    event.preventDefault();

    switch (event.inputType) {
      case "insertText":
        if (typeof event.data === "string" && event.data) insertTextData(event.data);
        break;
      case "deleteContentBackward":
      case "deleteWordBackward":
        deleteBackwardData();
        break;
      case "deleteContentForward":
      case "deleteWordForward":
        deleteForwardData();
        break;
      case "insertParagraph":
        enterData(false);
        break;
      case "insertLineBreak":
        enterData(true);
        break;
      case "historyUndo":
        undoEdit();
        break;
      case "historyRedo":
        redoEdit();
        break;
      case "insertFromPaste": {
        const text =
          event.dataTransfer?.getData("text/plain") ??
          (typeof event.data === "string" ? event.data : "");
        if (text) pasteText(text);
        break;
      }
      case "deleteByCut":
        if (selection && !collapsed(selection)) {
          const current = selection;
          runEdit("text", async () => replaceSelection(doc, current, ""));
        }
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- 更新

  function update(next) {
    if (next.doc) doc = next.doc;
    if (next.layout) layout = next.layout;
    if (next.section) section = next.section;

    if (next.renderer && next.renderer !== renderer) {
      renderer = next.renderer;
      overlay?.destroy();
      overlay = createOverlay({ renderer, section });
    } else if (!overlay) {
      overlay = createOverlay({ renderer, section });
    }

    if (selection) {
      const anchor = normalizeCaret(doc, selection.anchor);
      const focus = normalizeCaret(doc, selection.focus);
      selection = anchor && focus ? { anchor, focus } : null;
    }
    draw();
    positionIme();
  }

  function destroy() {
    overlay?.destroy();
    overlay = null;
    pagesElement.removeEventListener("pointerdown", onPointerDown);
    pagesElement.removeEventListener("pointermove", onPointerMove);
    pagesElement.removeEventListener("pointerup", onPointerUp);
    pagesElement.removeEventListener("pointercancel", onPointerUp);
    pagesElement.removeEventListener("dblclick", onDoubleClick);
    ime?.removeEventListener("keydown", onKeyDown);
    ime?.removeEventListener("beforeinput", onBeforeInput);
    ime?.removeEventListener("compositionstart", onCompositionStart);
    ime?.removeEventListener("compositionupdate", onCompositionUpdate);
    ime?.removeEventListener("compositionend", onCompositionEnd);
    ime?.removeEventListener("copy", onCopy);
    ime?.removeEventListener("cut", onCut);
    ime?.removeEventListener("paste", onPaste);
  }

  pagesElement.addEventListener("pointerdown", onPointerDown);
  pagesElement.addEventListener("pointermove", onPointerMove);
  pagesElement.addEventListener("pointerup", onPointerUp);
  pagesElement.addEventListener("pointercancel", onPointerUp);
  pagesElement.addEventListener("dblclick", onDoubleClick);
  if (ime) {
    ime.addEventListener("keydown", onKeyDown);
    ime.addEventListener("beforeinput", onBeforeInput);
    ime.addEventListener("compositionstart", onCompositionStart);
    ime.addEventListener("compositionupdate", onCompositionUpdate);
    ime.addEventListener("compositionend", onCompositionEnd);
    ime.addEventListener("copy", onCopy);
    ime.addEventListener("cut", onCut);
    ime.addEventListener("paste", onPaste);
  }

  overlay = createOverlay({ renderer, section });
  update({});

  return {
    update,
    destroy,
    focus: ensureFocus,
    getSelection: () => selection,
    setCaret,
    setSelection,
    selectAll(changed = true) {
      const range = editableRange();
      if (range) setSelection(range, { extend: false });
      else if (!changed) draw();
    },
    redraw: draw,
    /**
     * 给当前选区设置字符格式。
     * 返回 false 表示没有可用选区（调用方负责提示）。
     */
    insertTable(rows, cols) {
      if (!selection) {
        options.onUnsupported?.("empty-selection");
        return false;
      }
      const caret = { ...selection.focus };
      runEdit("table", () => insertTableAt(doc, caret, rows, cols));
      return true;
    },
    formatSelection(format) {
      if (!selection || collapsed(selection)) {
        options.onUnsupported?.("empty-selection");
        return false;
      }
      const current = {
        anchor: { ...selection.anchor },
        focus: { ...selection.focus },
      };
      runEdit("format", () => applyRunFormat(doc, current, format));
      return true;
    },
    undo: undoEdit,
    redo: redoEdit,
    markSaved() {
      history.markSaved(serializeXml());
      doc.dirty = false;
      options.onDirtyChange?.(false);
    },
  };
}
