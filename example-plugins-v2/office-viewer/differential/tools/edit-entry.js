/**
 * 编辑用例重放入口（E01–E10）。
 *
 * 不经过 UI：直接调用插件的 `src/edit/operations.js`，把 manifest 里的
 * `place / ime / key / select / paste` 翻译成模型操作，再把结果整理成可比对的
 * 笨数据（文本、段落数、numPr、run 格式、document.xml）。
 *
 * 撤销 / 重做在重放器里用整份 XML 快照模拟（插件自己的 history 在 editor 层，
 * 不在 operations 层）。
 */

import { parseDocx, replaceDocumentXml } from "../../src/docx/parse.js";
import {
  blockByKey,
  blockOffsetCaret,
  blockText,
  blockTextOffset,
} from "../../src/edit/source-map.js";
import {
  deleteBackward,
  applyRunFormat,
  deleteForward,
  insertPlainText,
  insertSoftBreak,
  insertTableAt,
  insertTextAt,
  mergeWithNext,
  mergeWithPrevious,
  replaceSelection,
  splitParagraph,
} from "../../src/edit/operations.js";

function collapsed(selection) {
  if (!selection?.anchor || !selection?.focus) return true;
  return (
    selection.anchor.blockKey === selection.focus.blockKey &&
    selection.anchor.itemIndex === selection.focus.itemIndex &&
    selection.anchor.offset === selection.focus.offset
  );
}

function serialize(doc) {
  return new XMLSerializer().serializeToString(doc.source.documentXml);
}

export async function replayEdit(fixtureUrl, ops) {
  const bytes = new Uint8Array(await (await fetch(fixtureUrl)).arrayBuffer());
  const doc = await parseDocx(bytes);

  let caret = null;
  let selection = null;
  const undo = [];
  const redo = [];

  const pointOf = (value) => {
    const block = blockByKey(doc, value?.blockKey);
    if (!block) return null;
    return {
      blockKey: block.key,
      blockIndex: block.index,
      offset: blockTextOffset(block, value),
    };
  };

  const caretOf = (point) => {
    if (!point) return null;
    const block = point.blockKey
      ? blockByKey(doc, point.blockKey)
      : doc.blocks[point.blockIndex];
    if (!block) return null;
    return blockOffsetCaret(block, point.offset ?? 0);
  };

  const snapshot = () => ({ xml: serialize(doc), point: pointOf(caret) });
  const restore = async (snap) => {
    await replaceDocumentXml(doc, snap.xml);
    caret = caretOf(snap.point);
    selection = null;
  };

  const accept = (result) => {
    if (!result) return;
    if (result.unsupported) throw new Error(`unsupported: ${result.unsupported}`);
    if (result.caretAfter) caret = result.caretAfter;
    selection = null;
  };

  const mutate = async (fn) => {
    const before = snapshot();
    await fn();
    undo.push(before);
    redo.length = 0;
  };

  for (const op of ops) {
    if (op.op === "placeCell") {
      const tables = doc.blocks.filter((block) => block.kind === "table");
      const table = tables[op.table ?? 0];
      const row = table?.rows?.[op.row ?? 0];
      const cell = row?.cells?.[op.cell ?? 0];
      const block = cell?.blocks?.[op.paragraph ?? 0];
      if (!block) throw new Error("placeCell: no cell paragraph");
      caret = blockOffsetCaret(block, op.offset ?? 0);
      selection = null;
      continue;
    }

    if (op.op === "place") {
      const block = op.key ? blockByKey(doc, op.key) : doc.blocks[op.block];
      if (!block) throw new Error(`no block ${op.key ?? op.block}`);
      caret = blockOffsetCaret(block, op.offset ?? 0);
      selection = null;
      continue;
    }

    if (op.op === "select") {
      const anchorBlock = op.from?.key
        ? blockByKey(doc, op.from.key)
        : doc.blocks[op.from?.block ?? op.block ?? 0];
      const focusBlock = op.to?.key
        ? blockByKey(doc, op.to.key)
        : doc.blocks[op.to?.block ?? op.block ?? 0];
      if (!anchorBlock || !focusBlock) throw new Error("select: no block");
      const anchor = op.from
        ? blockOffsetCaret(anchorBlock, op.from.offset ?? 0)
        : caret;
      const focus = blockOffsetCaret(focusBlock, op.to?.offset ?? 0);
      selection = { anchor, focus };
      caret = focus;
      continue;
    }

    if (op.op === "type" || op.op === "ime") {
      await mutate(async () => {
        const result = collapsed(selection)
          ? await insertTextAt(doc, caret, op.text)
          : await replaceSelection(doc, selection, op.text);
        accept(result);
      });
      continue;
    }

    if (op.op === "format") {
      await mutate(async () => {
        const currentSelection = selection;
        const result = await applyRunFormat(doc, currentSelection, {
          key: op.key,
          value: op.value,
        });
        accept(result);
        if (result?.selectionAfter) selection = currentSelection;
      });
      continue;
    }

    if (op.op === "insertTable") {
      await mutate(async () => {
        accept(await insertTableAt(doc, caret, op.rows, op.cols));
      });
      continue;
    }

    if (op.op === "paste") {
      await mutate(async () => {
        let base = caret;
        if (!collapsed(selection)) {
          const deleted = await replaceSelection(doc, selection, "");
          accept(deleted);
          base = deleted?.caretAfter ?? base;
        }
        accept(await insertPlainText(doc, base, op.text));
      });
      continue;
    }

    if (op.op === "key") {
      if (op.key === "Ctrl+Z") {
        if (undo.length === 0) continue;
        redo.push(snapshot());
        await restore(undo.pop());
        continue;
      }
      if (op.key === "Ctrl+Y") {
        if (redo.length === 0) continue;
        undo.push(snapshot());
        await restore(redo.pop());
        continue;
      }

      await mutate(async () => {
        if (op.key === "Enter") {
          accept(await splitParagraph(doc, caret));
        } else if (op.key === "Shift+Enter") {
          accept(await insertSoftBreak(doc, caret));
        } else if (op.key === "Backspace") {
          let result = collapsed(selection)
            ? await deleteBackward(doc, caret)
            : await replaceSelection(doc, selection, "");
          if (result?.merge === "backward") {
            result = await mergeWithPrevious(doc, result.block);
          }
          accept(result);
        } else if (op.key === "Delete") {
          let result = collapsed(selection)
            ? await deleteForward(doc, caret)
            : await replaceSelection(doc, selection, "");
          if (result?.merge === "forward") {
            result = await mergeWithNext(doc, result.block);
          }
          accept(result);
        } else {
          throw new Error(`unknown key: ${op.key}`);
        }
      });
      continue;
    }

    throw new Error(`unknown op: ${op.op}`);
  }

  const blocks = doc.blocks
    .filter((block) => !block.synthetic && block.kind === "paragraph")
    .map((block) => {
      const pPr = block.node?.children
        ? Array.from(block.node.children).find(
            (node) => node.localName === "pPr" && node.namespaceURI === block.node.namespaceURI,
          )
        : null;
      return {
        key: block.key,
        text: blockText(block),
        numPr: block.propsBase?.numPr ?? block.props?.numPr ?? null,
        labels: (block.labelItems ?? []).map((item) =>
          item.kind === "tab" ? "\t" : (item.text ?? ""),
        ),
        runs: (block.items ?? [])
          .filter((item) => item.kind === "text")
          .map((item) => ({
            text: item.text,
            bold: Boolean(item.style?.bold),
            italic: Boolean(item.style?.italic),
            underline: Boolean(item.style?.underline),
          })),
        pPr: pPr ? new XMLSerializer().serializeToString(pPr) : "",
      };
    });

  const tables = doc.blocks
    .filter((block) => block.kind === "table")
    .map((block) => ({
      key: block.key,
      rows: block.rows.map((row) => ({
        cells: row.cells.map((cell) => ({
          hidden: Boolean(cell.hidden),
          paragraphs: (cell.blocks ?? []).map((paragraph) => ({
            text: blockText(paragraph),
            runs: (paragraph.items ?? [])
              .filter((item) => item.kind === "text")
              .map((item) => ({ text: item.text, bold: Boolean(item.style?.bold) })),
          })),
        })),
      })),
    }));

  return {
    text: blocks.map((block) => block.text).join("\n"),
    paras: blocks.length,
    blocks,
    tables,
    documentXml: serialize(doc),
    caret: pointOf(caret),
  };
}

window.replayEdit = replayEdit;
