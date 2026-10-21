/**
 * 撤销 / 重做。
 *
 * 第一版用**整份 document.xml 快照**：实现简单、天然保住所有未知内容。
 * 段落级快照是后续优化（DESIGN.md 里写的那种），接口不变。
 *
 * 光标位置不能存 blockKey —— 撤销会整篇重建、key 重新分配；这里存
 * `{ blockIndex, offset }`，恢复时再换算回光标。
 */

const MAX_ENTRIES = 200;
const MAX_BYTES = 16 * 1024 * 1024;
const COALESCE_MS = 800;

function samePoint(a, b) {
  return Boolean(a && b) && a.blockIndex === b.blockIndex && a.offset === b.offset;
}

export function createHistory({ initialXml = "" } = {}) {
  const undoStack = [];
  const redoStack = [];
  let savedXml = initialXml;
  let totalBytes = 0;

  function trim() {
    while (
      undoStack.length > MAX_ENTRIES ||
      (totalBytes > MAX_BYTES && undoStack.length > 1)
    ) {
      const removed = undoStack.shift();
      totalBytes -= removed.size ?? 0;
    }
  }

  /**
   * 记录一次改动。连续输入 / 删除会在同一段、光标相接、800ms 内合并成一步。
   */
  function record(entry) {
    const size = (entry.beforeXml?.length ?? 0) + (entry.afterXml?.length ?? 0);
    const last = undoStack[undoStack.length - 1];
    const canCoalesce =
      last &&
      entry.kind === "text" &&
      last.kind === "text" &&
      entry.blockIndex === last.blockIndex &&
      samePoint(entry.selectionBefore, last.selectionAfter) &&
      entry.time - last.time < COALESCE_MS;

    if (canCoalesce) {
      totalBytes -= last.size ?? 0;
      last.afterXml = entry.afterXml;
      last.selectionAfter = entry.selectionAfter;
      last.time = entry.time;
      last.size = (last.beforeXml?.length ?? 0) + (last.afterXml?.length ?? 0);
      totalBytes += last.size;
      redoStack.length = 0;
      trim();
      return;
    }

    undoStack.push({ ...entry, size });
    totalBytes += size;
    redoStack.length = 0;
    trim();
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return null;
    totalBytes -= entry.size ?? 0;
    redoStack.push(entry);
    return entry;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return null;
    undoStack.push(entry);
    totalBytes += entry.size ?? 0;
    trim();
    return entry;
  }

  function reset(xml) {
    undoStack.length = 0;
    redoStack.length = 0;
    totalBytes = 0;
    savedXml = xml;
  }

  function markSaved(xml) {
    savedXml = xml;
  }

  function isDirty(currentXml) {
    return currentXml !== savedXml;
  }

  return {
    record,
    undo,
    redo,
    reset,
    markSaved,
    isDirty,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    size: () => undoStack.length,
  };
}
