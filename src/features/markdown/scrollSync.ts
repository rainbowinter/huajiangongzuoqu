import { isAlignClose, parseAlignMarker } from "./alignText";

export interface ParsedBlock {
  text: string;
  startLine: number; // inclusive
  endLine: number; // exclusive
}

const MIRROR_STYLE_PROPERTIES = [
  "font",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "wordBreak",
  "overflowWrap",
  "wordWrap",
  "tabSize",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "border",
  "borderTop",
  "borderRight",
  "borderBottom",
  "borderLeft",
] as const;

const MIRROR_BUILD_YIELD_INTERVAL = 500;
const MARKER_MEASURE_YIELD_INTERVAL = 64;

function yieldToPendingWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isStandaloneLinkReferenceDefinition(line: string): boolean {
  return /^\s{0,3}\[[^\]]+]:\s*\S/.test(line);
}

/** Parse markdown into non-empty logical blocks with line boundaries. */
export function parseBlocks(text: string): ParsedBlock[] {
  const lines = text.split("\n");
  const blocks: ParsedBlock[] = [];
  let i = 0;

  const push = (start: number, end: number) => {
    blocks.push({ text: lines.slice(start, end).join("\n"), startLine: start, endLine: end });
  };

  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }

    const line = lines[i];
    const trimmed = line.trim();

    // 链接引用定义在预览中会变成不可见的 definition 节点，需跳过。
    if (isStandaloneLinkReferenceDefinition(line)) {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = trimmed.match(/^(```|~~~)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const start = i;
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) i++;
      if (i < lines.length) i++;
      push(start, i);
      continue;
    }

    // Display math block
    if (trimmed === "$$") {
      const start = i;
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") i++;
      if (i < lines.length) i++;
      push(start, i);
      continue;
    }

    // Heading / HR
    if (/^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      push(i, i + 1);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const start = i;
      while (i < lines.length && lines[i].startsWith(">")) i++;
      push(start, i);
      continue;
    }

    // Table
    if (/^\s*\|/.test(line)) {
      const start = i;
      while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
      push(start, i);
      continue;
    }

    // List
    if (/^(\s*[-*+]\s|\s*\d+[.)]\s)/.test(line)) {
      const start = i;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          const next = i + 1;
          if (next < lines.length && /^(\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[next])) {
            i++;
            continue;
          }
          break;
        }
        if (/^(#{1,6}\s|```|~~~|>)/.test(l) || l.trim() === "$$") break;
        i++;
      }
      push(start, i);
      continue;
    }

    // Paragraph
    const start = i;
    while (i < lines.length && lines[i].trim() !== "") {
      const l = lines[i];
      if (/^(#{1,6}\s|```|~~~|>)/.test(l)) break;
      if (l.trim() === "$$") break;
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l.trim())) break;
      i++;
    }
    if (i > start) push(start, i);
  }

  return blocks;
}

/** 测量每个块在 textarea 中的 scrollTop 偏移量，支持 AbortSignal 取消。 */
export async function measureBlockOffsets(
  content: string,
  sourceTextarea: HTMLTextAreaElement,
  signal?: AbortSignal,
): Promise<number[]> {
  const blocks = parseBlocks(content);
  if (blocks.length === 0) return [];

  const style = getComputedStyle(sourceTextarea);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const measure = document.createElement("div");
  const width =
    style.width && style.width !== "auto" ? style.width : `${sourceTextarea.clientWidth}px`;
  const markers: HTMLElement[] = [];

  measure.style.cssText = `
    position: fixed; top: -9999px; left: -9999px; visibility: hidden;
    width: ${width};
    height: auto;
    margin: 0;
    box-sizing: ${style.boxSizing};
    white-space: pre-wrap;
    overflow: hidden;
    pointer-events: none;
    contain: layout style;
    ${MIRROR_STYLE_PROPERTIES.map((property) => {
      const cssName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      return `${cssName}: ${style[property]};`;
    }).join("\n    ")}
  `;

  const markerLines = new Map<number, number>();
  blocks.forEach((block, index) => markerLines.set(block.startLine, index));

  const lines = content.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const markerIndex = markerLines.get(lineIndex);
    if (markerIndex !== undefined) {
      const marker = document.createElement("span");
      marker.style.cssText =
        "display: inline-block; width: 0; height: 0; overflow: hidden; line-height: 0; font-size: 0; vertical-align: top;";
      markers[markerIndex] = marker;
      measure.appendChild(marker);
    }
    measure.appendChild(document.createTextNode(line));
    if (lineIndex < lines.length - 1) measure.appendChild(document.createTextNode("\n"));

    if ((lineIndex + 1) % MIRROR_BUILD_YIELD_INTERVAL === 0) {
      await yieldToPendingWork();
      if (signal?.aborted) return [];
    }
  }

  if (signal?.aborted) return [];

  document.body.appendChild(measure);

  const offsets: number[] = [];
  try {
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index];
      if (signal?.aborted) break;
      offsets.push(Math.max(0, marker.offsetTop - paddingTop));
      if (signal?.aborted) break;

      if ((index + 1) % MARKER_MEASURE_YIELD_INTERVAL === 0) {
        await yieldToPendingWork();
      }
    }
  } finally {
    document.body.removeChild(measure);
  }

  return offsets;
}

/**
 * 用**高亮层**算每个块的纵向偏移。
 *
 * 高亮层一行一个 div、行号就是源码行号，所以「第 N 块在哪儿」直接读
 * `children[block.startLine].offsetTop` —— 那就是浏览器按真实编辑区排出来的位置。
 *
 * 这里原先走 `measureBlockOffsets`：另起一个 div、复制 textarea 的样式再排一遍。那份复制品
 * 只要有一处排版对不上（字体特性、字距、折行规则……），偏差就**随行数累积**：几万字符的文档
 * 里能攒到一两屏，表现为「分栏两边对不上，预览整体偏下一段，写的时候看不到对应结果」。
 * 复制品永远追不上本体，所以这里直接问本体。
 *
 * 返回 `null` 表示层不可用（超大文档放弃着色时它是空的），调用方回退到镜像测量。
 */
export function blockOffsetsFromLayer(layer: HTMLElement | null, content: string): number[] | null {
  if (!layer || layer.children.length === 0) return null;

  const offsets: number[] = [];
  for (const block of parseBlocks(content)) {
    const node = layer.children[block.startLine];
    if (!(node instanceof HTMLElement)) return null;
    offsets.push(node.offsetTop);
  }
  return offsets;
}

/** Find which block index occupies the given textarea scrollTop. */
export function blockIndexAtOffset(offsets: number[], scrollTop: number): number {
  for (let i = offsets.length - 1; i >= 0; i--) {
    if (offsets[i] <= scrollTop) return i;
  }
  return 0;
}

/**
 * 给预览的块级子元素打上 `data-block-index`，下标与 `parseBlocks` 的块序号一一对应。
 *
 * 带一层"打过就不用再打"的缓存：这个函数现在每帧都会被调（见 MainWindow 的滚动测量），
 * 而它对每个块子元素都要 `setAttribute` 一次 —— 上千个块的文档里，白跑一遍就是上千次
 * DOM 写。判据用**内容 + 根元素 + 子元素个数**三个一起：内容没变、根节点还是同一个、
 * 块数也没变，那就没必要重打；任何一项变了（React 换了节点、块被拆开或合并）就重来。
 */
const taggedPreview = new WeakMap<HTMLElement, { content: string; root: Element; count: number }>();

export function tagPreviewBlocks(container: HTMLElement, content: string): void {
  const root = container.querySelector<HTMLElement>(".font-body");
  if (!root) return;

  const previous = taggedPreview.get(container);
  if (
    previous &&
    previous.content === content &&
    previous.root === root &&
    previous.count === root.children.length
  ) {
    return;
  }

  let index = 0;
  for (const child of root.children) {
    if (child instanceof HTMLElement) {
      child.setAttribute("data-block-index", String(index++));
    }
  }
  taggedPreview.set(container, { content, root, count: root.children.length });
}

export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 测量 textarea 中 [start, end) 字符范围对应的屏幕矩形（相对 textarea 内容区）。
 * 通过镜像 div + span 包裹选区 + getClientRects 实现，支持跨行选区。
 */
export interface StrippedText {
  plain: string;
  positions: number[];
}

/**
 * 去除 Markdown 格式符号（标题/列表/任务清单/表格/代码块/图片/分割线/行内格式等），
 * 得到"渲染后纯文本"以及纯文本每个字符对应的源文本偏移，用于跨格式符号的匹配。
 */
export function stripMarkdownInline(text: string): StrippedText {
  let plain = "";
  const positions: number[] = [];

  let lastWasSpace = false;
  const append = (ch: string, pos: number) => {
    const out = ch === " " || ch === "\n" || ch === "\t" || ch === "\r" ? " " : ch;
    if (out === " " && lastWasSpace) return;
    plain += out;
    positions.push(pos);
    lastWasSpace = out === " ";
  };

  const appendRange = (start: number, end: number) => {
    for (let k = start; k < end; k++) append(text[k], k);
  };

  let i = 0;
  const n = text.length;

  while (i < n) {
    const lineStart = i;
    while (i < n && text[i] !== "\n") i++;
    const lineEnd = i;
    const line = text.slice(lineStart, lineEnd);

    // 代码块围栏：跳过围栏符号，代码内容保留，语言标识追加到末尾（与预览渲染一致）
    const fenceMatch = line.match(/^\s*(```|~~~)\s*([a-zA-Z0-9_-]*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] ?? "";
      const langStart = lang ? fenceMatch[0].lastIndexOf(lang) : 0;
      i++;
      let endNewline = i;
      while (i < n) {
        const cs = i;
        while (i < n && text[i] !== "\n") i++;
        const cl = text.slice(cs, i);
        if (cl.trim().startsWith(fence)) {
          endNewline = i;
          i++;
          break;
        }
        appendRange(cs, i);
        if (i < n) append("\n", i);
        i++;
      }
      if (lang) {
        append("\n", lineStart);
        for (let k = 0; k < lang.length; k++) {
          append(lang[k], lineStart + langStart + k);
        }
        append("\n", endNewline);
      }
      continue;
    }

    // 段落对齐的容器标记：`::: center` 与收尾的 `:::` 在预览里**不产生任何文字**，
    // 直接跳过。不跳的话这两行会在「渲染后纯文本」里各占一行，两边越滚越偏 ——
    // 而且是那种「滚到后面才发现差了几行」的偏。容器里的正文照常参与匹配。
    if (parseAlignMarker(line) !== null || isAlignClose(line)) {
      i++;
      continue;
    }

    // 块级公式：跳过（公式渲染成符号，无法和源文本匹配）
    if (line.trim() === "$$") {
      i++;
      while (i < n) {
        const cs = i;
        while (i < n && text[i] !== "\n") i++;
        const cl = text.slice(cs, i);
        if (cl.trim() === "$$") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    stripLine(line, lineStart, append);

    if (i < n) append(" ", i);
    i++;
  }

  return { plain, positions };
}

function stripLine(
  line: string,
  lineStart: number,
  append: (ch: string, pos: number) => void,
): void {
  // 分割线
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return;

  // 标题
  const heading = line.match(/^\s*(#{1,6})\s+/);
  if (heading) {
    const start = heading[0].length;
    stripInline(line.slice(start), lineStart + start, append);
    return;
  }

  // 任务清单
  const task = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+/);
  if (task) {
    const start = task[0].length;
    stripInline(line.slice(start), lineStart + start, append);
    return;
  }

  // 列表（无序 / 有序）
  const list = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/);
  if (list) {
    const start = list[0].length;
    stripInline(line.slice(start), lineStart + start, append);
    return;
  }

  // 引用
  if (/^\s*>/.test(line)) {
    let idx = 0;
    while (idx < line.length && (line[idx] === " " || line[idx] === "\t" || line[idx] === ">")) {
      idx++;
    }
    stripInline(line.slice(idx), lineStart + idx, append);
    return;
  }

  // 表格
  if (/^\s*\|/.test(line)) {
    stripTableLine(line, lineStart, append);
    return;
  }

  // 普通段落
  stripInline(line, lineStart, append);
}

function stripInline(
  text: string,
  offset: number,
  append: (ch: string, pos: number) => void,
): void {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];

    // 图片 ![alt](url) 或 ![alt][id]：跳过（渲染成图，无可选文字）
    if (ch === "!" && text[i + 1] === "[") {
      const close = text.indexOf("]", i);
      if (close >= 0) {
        i = close + 1;
        if (text[i] === "(") {
          const closeParen = text.indexOf(")", i);
          if (closeParen >= 0) i = closeParen + 1;
        } else if (text[i] === "[") {
          const closeRef = text.indexOf("]", i);
          if (closeRef >= 0) i = closeRef + 1;
        }
        continue;
      }
    }

    // 链接 [text](url) 或 [text][id]：只保留 text
    if (ch === "[") {
      const close = text.indexOf("]", i);
      if (close >= 0) {
        for (let j = i + 1; j < close; j++) append(text[j], offset + j);
        i = close + 1;
        if (text[i] === "(") {
          const closeParen = text.indexOf(")", i);
          if (closeParen >= 0) i = closeParen + 1;
        } else if (text[i] === "[") {
          const closeRef = text.indexOf("]", i);
          if (closeRef >= 0) i = closeRef + 1;
        }
        continue;
      }
    }

    // 行内公式 $...$：跳过（公式渲染成符号，无法和源文本匹配）
    if (ch === "$") {
      const close = text.indexOf("$", i + 1);
      if (close >= 0) {
        i = close + 1;
        continue;
      }
    }

    // HTML 标签 <tag> / </tag>：跳过（渲染成对应格式，如 <u> 下划线、<del> 删除线）
    if (ch === "<") {
      const closeTag = text.indexOf(">", i);
      if (closeTag >= 0 && /^<\/?[a-zA-Z]/.test(text.slice(i, closeTag + 1))) {
        i = closeTag + 1;
        continue;
      }
    }

    // 行内格式符号 * _ ` ~：跳过
    if (ch === "*" || ch === "_" || ch === "`" || ch === "~") {
      i++;
      continue;
    }

    append(ch, offset + i);
    i++;
  }
}

function stripTableLine(
  line: string,
  lineStart: number,
  append: (ch: string, pos: number) => void,
): void {
  // 表头分隔行 | --- | --- |：跳过
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
    return;
  }
  // 去掉竖线，单元格之间视为空格
  for (let j = 0; j < line.length; j++) {
    if (line[j] === "|") {
      append(" ", lineStart + j);
    } else {
      append(line[j], lineStart + j);
    }
  }
}

export function measureSelectionRects(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
): SelectionRect[] {
  if (start >= end) return [];

  const style = getComputedStyle(textarea);
  const measure = document.createElement("div");

  /**
   * 镜像的宽度必须给**内容宽度**，并且显式声明 `content-box`。
   *
   * 原来是把 `getComputedStyle().width` 原样搬过来、再复制元素的 `box-sizing`。这两件事
   * 凑在一起是错的：`width` 取到的是**内容**宽度，而 `box-sizing` 是 `border-box`
   * （Tailwind preflight 全局设的），于是镜像的可用宽度被 padding **又减了一次**。
   *
   * 后果不是「差几个像素」—— 镜像比编辑器窄，换行就更早，前面每多折一行，目标位置就往下
   * 偏一点，累积起来就是「预览里选中的文字，编辑区的高亮框落在它下一行」。
   *
   * `clientWidth - padding` 无论 `width` 返回哪种语义都等于真实内容宽度（clientWidth 已经
   * 扣掉了滚动条），所以这里用它。
   */
  const contentWidth =
    textarea.clientWidth -
    parseFloat(style.paddingLeft || "0") -
    parseFloat(style.paddingRight || "0");
  const width = `${contentWidth}px`;

  measure.style.cssText = `
    position: fixed; top: -9999px; left: -9999px;
    width: ${width};
    height: auto;
    margin: 0;
    box-sizing: content-box;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    overflow: hidden;
    pointer-events: none;
    contain: layout style;
    ${MIRROR_STYLE_PROPERTIES.map((property) => {
      const cssName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      return `${cssName}: ${style[property]};`;
    }).join("\n    ")}
  `;

  const value = textarea.value;
  measure.appendChild(document.createTextNode(value.slice(0, start)));
  const selected = document.createElement("span");
  selected.textContent = value.slice(start, end);
  measure.appendChild(selected);
  // **不追加尾部文本。** 目标矩形只由它**前面**的内容决定，后面写什么都不影响；
  // 而镜像每次都要整体布局一遍，白带上十几万字符就是几十上百毫秒。

  document.body.appendChild(measure);

  const measureRect = measure.getBoundingClientRect();
  const rects = Array.from(selected.getClientRects()).map((rect) => ({
    top: rect.top - measureRect.top,
    left: rect.left - measureRect.left,
    width: rect.width,
    height: rect.height,
  }));

  document.body.removeChild(measure);
  return rects;
}
