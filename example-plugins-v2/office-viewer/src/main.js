/**
 * office-viewer 的视图入口。
 *
 * 流程：
 *
 *   init → requestDocument → parseDocx → layoutDocument → renderDocument
 *
 * 解析、排版、渲染三层各自独立；改字体 / 行距只是换一份 layoutOptions 重排，
 * 不需要重新解析 DOCX。
 */

import { blankDocxBytes } from "./docx/blank.js";
import { parseDocx } from "./docx/parse.js";
import { buildSavedDocx, savedFileName, verifySavedDocx } from "./docx/save.js";
import { createEditor } from "./edit/editor.js";
import { defaultLayoutOptions, layoutDocument } from "./layout/index.js";
import { renderDocument } from "./render/pages.js";
import { applyTheme } from "./render/theme.js";
import { clamp } from "./units.js";

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.15;
const VIEWPORT_GUTTER = 48;
const PAGE_GAP = 12;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const viewport = document.getElementById("viewport");
const pagesElement = document.getElementById("pages");
const hint = document.getElementById("hint");
const hintText = document.getElementById("hint-text");
const statusLeft = document.getElementById("status-left");
const statusRight = document.getElementById("status-right");
const imeInput = document.getElementById("ime-input");

const state = {
  name: "",
  path: "",
  bytes: null,
  doc: null,
  layout: null,
  renderer: null,
  editor: null,
  busy: false,
  zoom: 1,
  fit: true,
  single: false,
  page: 1,
  total: 0,
  display: {
    showMarks: false,
    showParagraphNumbers: false,
  },
  layoutOptions: defaultLayoutOptions(),
};

// ---------------------------------------------------------------- 提示与状态

function showHint(text, kind = "") {
  hintText.textContent = text;
  hint.className = kind ? `hint ${kind}` : "hint";
  hint.hidden = false;
}

function hideHint() {
  hint.hidden = true;
}

function setStatus(left, right) {
  statusLeft.textContent = left;
  statusRight.textContent = right;
}

function formatBytes(count) {
  if (!Number.isFinite(count) || count <= 0) return "0 B";
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

function updateStatus() {
  if (!state.doc) {
    setStatus(state.name || "Word 文档", state.bytes ? formatBytes(state.bytes.length) : "");
    return;
  }

  const stats = state.doc.stats;
  const parts = [`${state.total} 页`];
  if (stats.chars > 0) parts.push(`${stats.chars} 字`);
  if (stats.images > 0) parts.push(`${stats.images} 张图`);
  if (stats.tables > 0) parts.push(`${stats.tables} 个表格`);
  if (state.doc.dirty) parts.push("未保存");
  if (state.doc.warnings.length > 0) parts.push(`${state.doc.warnings.length} 条兼容提示`);

  setStatus(state.name || "Word 文档", parts.join(" · "));
}

// ---------------------------------------------------------------- 缩放与翻页

function pageWidth() {
  return state.layout?.section.pageWidth ?? 794;
}

function applyZoom() {
  if (state.fit) {
    const available = Math.max(1, viewport.clientWidth - VIEWPORT_GUTTER);
    state.zoom = clamp(available / pageWidth(), MIN_ZOOM, MAX_ZOOM);
  } else {
    state.zoom = clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
  }
  pagesElement.style.setProperty("--zoom", String(state.zoom));
  state.editor?.update({});
  updateState();
}

function zoomBy(factor) {
  state.fit = false;
  state.zoom = clamp(state.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  pagesElement.style.setProperty("--zoom", String(state.zoom));
  state.editor?.update({});
  updateState();
  requestAnimationFrame(() => {
    if (!state.single) scrollToPage(state.page);
  });
}

function toggleFit() {
  state.fit = !state.fit;
  applyZoom();
  requestAnimationFrame(() => {
    if (!state.single) scrollToPage(state.page);
  });
}

function scrollToPage(pageNumber) {
  if (!state.renderer || state.single) return;
  const element = state.renderer.elementAt(pageNumber - 1);
  if (!element) return;
  const delta =
    element.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top -
    PAGE_GAP;
  viewport.scrollTop += delta;
  state.renderer.renderPage(pageNumber - 1);
}

function goToPage(target) {
  if (state.total <= 0) return;
  const pageNumber = clamp(Math.round(target), 1, state.total);
  state.page = pageNumber;
  if (state.single) {
    applySingleMode();
  } else {
    scrollToPage(pageNumber);
  }
  updateState();
}

function applySingleMode() {
  pagesElement.classList.toggle("single", state.single);
  if (!state.renderer) return;
  state.renderer.pageElements.forEach((element, index) => {
    element.dataset.current = String(index + 1 === state.page);
  });
  if (state.single) {
    viewport.scrollTop = 0;
    state.renderer.renderPage(state.page - 1);
  }
}

function toggleSpread() {
  state.single = !state.single;
  applySingleMode();
  if (!state.single) {
    requestAnimationFrame(() => scrollToPage(state.page));
  }
  updateState();
}

function trackCurrentPage() {
  if (!state.renderer || state.single || state.total <= 0) return;

  const scrollHeight = viewport.scrollHeight;
  const canScroll = scrollHeight > viewport.clientHeight + 2;
  if (canScroll && viewport.scrollTop + viewport.clientHeight >= scrollHeight - 3) {
    if (state.page !== state.total) {
      state.page = state.total;
      updateState();
    }
    return;
  }

  const top = viewport.getBoundingClientRect().top;
  let current = 1;
  state.renderer.pageElements.forEach((element, index) => {
    if (element.getBoundingClientRect().top - top <= PAGE_GAP + 0.5) {
      current = index + 1;
    }
  });
  if (current !== state.page) {
    state.page = current;
    updateState();
  }
}

function updateState() {
  const pressed = [];
  if (state.fit) pressed.push("fit-width");

  floralView.setState(
    {
      zoom: `${Math.round(state.zoom * 100)}%`,
      page: state.total > 0 ? `${state.page} / ${state.total}` : "—",
      spread: state.single ? "单页" : "连续",
    },
    pressed,
  );
}

// ---------------------------------------------------------------- 排版与渲染

/**
 * 渲染器换了之后，把编辑器接到新的页面 DOM 上。
 *
 * 编辑状态（光标 / 选区）由编辑器自己按 `blockKey` 保存；这里只递新数据，
 * 不重置选区，所以改字号、切换标记不会把光标弄丢。
 */
function syncEditor() {
  if (!state.doc || !state.layout || !state.renderer) return;
  const options = {
    doc: state.doc,
    layout: state.layout,
    renderer: state.renderer,
    section: state.layout.section,
    pagesElement,
    viewport,
    ime: imeInput,
    getZoom: () => state.zoom,
    onEdited: (result) => {
      // 编辑已经写回 XML 并重解析过段落，这里只负责重新排版与重画。
      relayout({ dirtyKeys: result.dirtyKeys, preserveScroll: true });
    },
    onEnter: () => {
      floralView.toast("分段与段合并还差最后一步，先继续输入文字。");
    },
    onMerge: () => {
      floralView.toast("跨段合并还没接上，先把光标移到段内再删。");
    },
    onUnsupported: (reason) => {
      const messages = {
        "cross-block": "跨段删除还没接上，先在同一段内删。",
        "paste-large": "粘贴内容太长，只保留了前 100 万个字符。",
        section: "这一段带分节符，暂时不能在这里分段。",
        nested: "超链接 / 修订里的内容暂时不能分段。",
        "not-adjacent": "中间隔着表格或其它结构，暂时不能合并。",
        "empty-selection": "先选中文字，再使用字符格式。",
        "no-format-range": "这段内容不能设置字符格式。",
        "nested-table": "请在正文里插入表格，表格里暂时不能嵌套表格。",
      };
      floralView.toast(messages[reason] ?? "这一处暂时不能编辑。");
    },
    onError: (error) => {
      floralView.log("error", `编辑失败：${error?.message ?? error}`);
      floralView.toast("这一步编辑没有成功。");
    },
    onDirtyChange: () => updateStatus(),
    onSave: () => {
      void saveAsDocx();
    },
  };
  if (state.editor) state.editor.update(options);
  else state.editor = createEditor(options);
}

function relayout({ keepPage = state.page, dirtyKeys = null, preserveScroll = false } = {}) {
  if (!state.doc) return;
  const scrollTop = viewport.scrollTop;

  const previousPage = clamp(keepPage, 1, Math.max(1, state.total));
  // 有 dirtyKeys 时只重排脏段；分页仍然全量跑（孤行 / keepNext 会回看）。
  const laidOut = layoutDocument(
    state.doc,
    state.layoutOptions,
    dirtyKeys ? { dirtyKeys } : {},
  );
  state.layout = laidOut;
  state.total = laidOut.pages.length;
  state.page = clamp(previousPage, 1, state.total);

  applyZoom();
  state.renderer?.destroy();
  state.renderer = renderDocument(pagesElement, laidOut, {
    ...state.display,
    layoutOptions: state.layoutOptions,
  });
  applySingleMode();
  syncEditor();

  requestAnimationFrame(() => {
    if (preserveScroll) {
      // 编辑时不要跳回页首：页面高度基本不变，数值恢复滚动位置最不打扰。
      applySingleMode();
      viewport.scrollTop = scrollTop;
      state.renderer?.renderPage(state.page - 1);
      return;
    }
    if (state.single) {
      applySingleMode();
    } else {
      scrollToPage(state.page);
    }
    state.renderer?.renderPage(state.page - 1);
  });

  updateState();
  updateStatus();
}

function rerenderPages() {
  if (!state.layout) return;
  state.renderer?.destroy();
  state.renderer = renderDocument(pagesElement, state.layout, {
    ...state.display,
    layoutOptions: state.layoutOptions,
  });
  applySingleMode();
  syncEditor();
  requestAnimationFrame(() => {
    if (!state.single) scrollToPage(state.page);
    state.renderer?.renderPage(state.page - 1);
  });
}

// ---------------------------------------------------------------- 打开文档

function looksLikeZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function looksLikeOle(bytes) {
  if (bytes.length < OLE_MAGIC.length) return false;
  return OLE_MAGIC.every((value, index) => bytes[index] === value);
}

async function loadDocument(buffer) {
  if (state.busy) return;
  let bytes = new Uint8Array(buffer);
  if (state.doc && state.bytes && bytes.length === state.bytes.length) return;

  state.busy = true;
  showHint("正在解析文档…", "loading");
  setStatus(state.name || "Word 文档", "解析中…");
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    if (looksLikeOle(bytes)) {
      throw new Error(
        "这是旧版 .doc 或者加了密码的文档（OLE 复合文档），当前版本打不开。" +
          "请在 Word 里另存为不加密的 .docx 再试。",
      );
    }

    // 花笺「新建文件」可能落一个 0 字节或纯文本的 .docx。它们不是 ZIP，
    // 但用户要的是一张能编辑的纸：换成最小合法 DOCX 再走正常链路。
    let recoveredText = null;
    if (bytes.length === 0) {
      bytes = await blankDocxBytes();
    } else if (!looksLikeZip(bytes)) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const hasControl = /[\x00-\x08\x0e-\x1f]/.test(text);
        if (!hasControl) {
          recoveredText = text;
          bytes = await blankDocxBytes(text);
        }
      } catch {
        // 不是 UTF-8 文本：保持原样，下面由 ZIP 解析给出明确错误。
      }
    }
    state.bytes = bytes;
    if (recoveredText != null) {
      const message = "这个 .docx 不是有效的 Word 文件，已按纯文本打开。";
      floralView.log("warn", message);
      floralView.toast(message);
    }

    const doc = await parseDocx(bytes);
    // 新文档的光标 / 选区 / 撤销历史都不该沿用上一份。
    state.editor?.destroy();
    state.editor = null;
    state.doc = doc;
    state.doc.originalBytes = bytes;
    state.page = 1;
    relayout({ keepPage: 1 });
    hideHint();
    updateStatus();

    for (const warning of doc.warnings) floralView.log("warn", warning);
    if (doc.warnings.length > 0) floralView.toast(doc.warnings[0]);
  } catch (error) {
    state.editor?.destroy();
    state.editor = null;
    state.doc = null;
    state.layout = null;
    state.total = 0;
    state.renderer?.destroy();
    state.renderer = null;
    pagesElement.replaceChildren();
    showHint(`这个文件打不开：${error?.message ?? error}`, "error");
    setStatus("打不开这个文件", "");
    updateState();
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------- 格式命令

/**
 * 来自「开始」面板的格式命令。
 *
 * 面板跑在 Worker 里，视图跑在沙箱 iframe 里；`api.ui.sendToView()` 把这条消息原样送到
 * `floralView.onCommand`，与 `view.toolbar` 的命令同一个形状。
 *
 * 字符格式（加粗 / 斜体 / 下划线 / 删除线 / 上下标）按选区写回 XML；
 * 字体、字号、对齐、行距仍是**整篇预览**。命令只做参数校验。
 */
function applyFormatCommand(raw) {
  let payload;
  try {
    payload = JSON.parse(String(raw ?? ""));
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;

  switch (payload.type) {
    case "insert-table": {
      const rows = Math.round(Number(payload.rows));
      const cols = Math.round(Number(payload.cols));
      if (!(rows >= 1) || !(cols >= 1)) return;
      state.editor?.insertTable(rows, cols);
      return;
    }
    case "run-format": {
      const allowed = new Set([
        "bold", "italic", "underline", "strike", "vertAlign", "color",
      ]);
      if (typeof payload.key !== "string" || !allowed.has(payload.key)) return;
      state.editor?.formatSelection({ key: payload.key, value: payload.value });
      return;
    }
    case "font":
      state.layoutOptions.fontOverride =
        typeof payload.value === "string" ? payload.value : "";
      relayout({ keepPage: state.page });
      break;
    case "size":
      state.layoutOptions.sizeOverridePt = Number.isFinite(payload.value)
        ? clamp(payload.value, 6, 200)
        : null;
      relayout({ keepPage: state.page });
      break;
    case "size-adjust": {
      // A⁺ / A⁻：从当前覆盖值加减；还没覆盖过就从 12pt 起步（Word 默认正文附近）。
      const delta = Number.isFinite(payload.delta) ? payload.delta : 0;
      const current = state.layoutOptions.sizeOverridePt ?? 12;
      state.layoutOptions.sizeOverridePt = clamp(current + delta, 6, 200);
      relayout({ keepPage: state.page });
      break;
    }
    case "line":
      if (payload.value == null) {
        state.layoutOptions.lineSpacingMode = null;
        state.layoutOptions.lineSpacingValue = null;
      } else if (Number.isFinite(payload.value)) {
        state.layoutOptions.lineSpacingMode = "auto";
        state.layoutOptions.lineSpacingValue = clamp(payload.value, 0.5, 5);
      }
      relayout({ keepPage: state.page });
      break;
    case "spacing":
      if ("before" in payload) {
        state.layoutOptions.spaceBeforePt = Number.isFinite(payload.before)
          ? clamp(payload.before, 0, 500)
          : null;
      }
      if ("after" in payload) {
        state.layoutOptions.spaceAfterPt = Number.isFinite(payload.after)
          ? clamp(payload.after, 0, 500)
          : null;
      }
      relayout({ keepPage: state.page });
      break;
    case "align": {
      // 整篇预览：把每一段都换成这个对齐方式；null 回到文档自己的 jc。
      const allowed = ["left", "center", "right", "both", "distribute"];
      state.layoutOptions.alignOverride =
        typeof payload.value === "string" && allowed.includes(payload.value)
          ? payload.value
          : null;
      relayout({ keepPage: state.page });
      break;
    }
    case "marks":
      state.display.showMarks = !state.display.showMarks;
      rerenderPages();
      break;
    case "numbers":
      state.display.showParagraphNumbers = !state.display.showParagraphNumbers;
      rerenderPages();
      break;
    case "reset":
      state.layoutOptions = defaultLayoutOptions();
      relayout({ keepPage: state.page });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 另存

/**
 * 另存为新的 `.docx`。
 *
 * 宿主只提供「弹出保存对话框」这一条写文件通道，而且没有结果回调 —— 所以这里
 * 只能说「已打开保存对话框」，不能声称文件一定写成功了。
 */
async function saveAsDocx() {
  if (!state.doc) return;
  const name = savedFileName(state.name);

  try {
    const bytes = await buildSavedDocx(state.doc);
    const verification = await verifySavedDocx(bytes, state.doc);
    if (!verification.ok) {
      floralView.log("error", `另存校验失败：${verification.message}`);
      floralView.toast(`另存失败：${verification.message}`);
      return;
    }

    // saveFile 只认真正的 ArrayBuffer；Uint8Array 的 slice 顺手处理 byteOffset。
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    floralView.saveFile(name, buffer);
    // 保存后的字节成为新的基线：再点一次「另存为」也应该写出刚保存的版本。
    state.doc.originalBytes = bytes;
    state.editor?.markSaved();
    updateStatus();
    floralView.toast(`已打开保存对话框：${name}`);
  } catch (error) {
    floralView.log("error", `另存失败：${error?.message ?? error}`);
    floralView.toast(`另存失败：${error?.message ?? error}`);
  }
}

// ---------------------------------------------------------------- 工具栏命令

function handleCommand(message) {
  switch (message.id) {
    case "zoom-in":
      zoomBy(ZOOM_STEP);
      break;
    case "zoom-out":
      zoomBy(1 / ZOOM_STEP);
      break;
    case "fit-width":
      toggleFit();
      break;
    case "page-prev":
      goToPage(state.page - 1);
      break;
    case "page-next":
      goToPage(state.page + 1);
      break;
    case "goto": {
      const target = Number.parseInt(String(message.value ?? ""), 10);
      if (Number.isFinite(target)) goToPage(target);
      break;
    }
    case "spread":
      toggleSpread();
      break;
    case "office-format":
      applyFormatCommand(message.value);
      break;
    case "save-as":
      void saveAsDocx();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 启动

floralView.onCommand(handleCommand);

floralView.onMessage((message) => {
  if (!message || typeof message !== "object") return;

  if (message.t === "init") {
    applyTheme(message);
    state.name = typeof message.name === "string" ? message.name : "";
    state.path = typeof message.path === "string" ? message.path : "";
    setStatus(state.name || "Word 文档", "读取中…");
    floralView.requestDocument();
    return;
  }

  if (message.t === "theme") {
    applyTheme(message);
    return;
  }

  if (message.t === "document") {
    void loadDocument(message.bytes);
    return;
  }

  if (message.t === "documentError") {
    showHint(`读不到这个文件：${message.message}`, "error");
    setStatus("打不开这个文件", "");
  }
});

viewport.addEventListener("scroll", trackCurrentPage, { passive: true });

const resizeObserver = new ResizeObserver(() => {
  if (state.fit) applyZoom();
});
resizeObserver.observe(viewport);

viewport.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  },
  { passive: false },
);

document.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
  else if (event.key === "-") zoomBy(1 / ZOOM_STEP);
});

applyZoom();
floralView.ready();
