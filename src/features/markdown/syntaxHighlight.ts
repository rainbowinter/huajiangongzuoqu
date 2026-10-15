type TokenColor = string;

const TOKEN_COLORS: Record<string, TokenColor> = {
  heading: "#a78bfa",
  bold: "#f59e0b",
  italic: "#34d399",
  strike: "#f87171",
  code: "#60a5fa",
  codeblock: "#60a5fa",
  list: "#22d3ee",
  quote: "#facc15",
  table: "#f472b6",
  link: "#60a5fa",
  image: "#f472b6",
  hr: "#9ca3af",
  task: "#22d3ee",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function span(text: string, type: string): string {
  const color = TOKEN_COLORS[type] ?? "#9ca3af";
  return `<span style="color:${color}">${escapeHtml(text)}</span>`;
}

function renderInline(text: string): string {
  let result = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    // 图片 ![alt](url)
    if (ch === "!" && text[i + 1] === "[") {
      const close = text.indexOf("]", i);
      if (close >= 0) {
        const closeParen = text.indexOf(")", close);
        if (closeParen >= 0) {
          result += span(text.slice(i, closeParen + 1), "image");
          i = closeParen + 1;
          continue;
        }
      }
    }

    // 链接 [text](url)
    if (ch === "[") {
      const close = text.indexOf("]", i);
      if (close >= 0) {
        const closeParen = text.indexOf(")", close);
        if (closeParen >= 0) {
          const linkText = text.slice(i + 1, close);
          const tail = text.slice(close, closeParen + 1);
          result += span("[", "link") + renderInline(linkText) + span(tail, "link");
          i = closeParen + 1;
          continue;
        }
      }
    }

    // 粗体 **text** / __text__
    if ((ch === "*" && text[i + 1] === "*") || (ch === "_" && text[i + 1] === "_")) {
      const marker = ch;
      const close = text.indexOf(marker + marker, i + 2);
      if (close >= 0) {
        result += span(marker + marker, "bold");
        result += renderInline(text.slice(i + 2, close));
        result += span(marker + marker, "bold");
        i = close + 2;
        continue;
      }
    }

    // 删除线 ~~text~~
    if (ch === "~" && text[i + 1] === "~") {
      const close = text.indexOf("~~", i + 2);
      if (close >= 0) {
        result += span("~~", "strike");
        result += renderInline(text.slice(i + 2, close));
        result += span("~~", "strike");
        i = close + 2;
        continue;
      }
    }

    // 行内代码 `text`
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close >= 0) {
        result += span(text.slice(i, close + 1), "code");
        i = close + 1;
        continue;
      }
    }

    // 斜体 *text* / _text_
    if (ch === "*" || ch === "_") {
      const close = text.indexOf(ch, i + 1);
      if (close >= 0) {
        result += span(ch, "italic") + renderInline(text.slice(i + 1, close)) + span(ch, "italic");
        i = close + 1;
        continue;
      }
    }

    result += escapeHtml(ch);
    i++;
  }

  return result;
}

function renderTableLine(line: string): string {
  let result = "";
  for (let j = 0; j < line.length; j++) {
    if (line[j] === "|") {
      result += span("|", "table");
    } else {
      result += escapeHtml(line[j]);
    }
  }
  return result;
}

function renderLine(line: string): string {
  // 分割线
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return span(line, "hr");
  }

  // 代码块围栏
  if (/^\s*(```|~~~)/.test(line)) {
    return span(line, "codeblock");
  }

  // 标题
  const heading = line.match(/^(\s*)(#{1,6})(\s+)/);
  if (heading) {
    return (
      escapeHtml(heading[1]) +
      span(heading[2], "heading") +
      escapeHtml(heading[3]) +
      renderInline(line.slice(heading[0].length))
    );
  }

  // 任务清单
  const task = line.match(/^(\s*)([-*+])(\s+)(\[[ xX]\])(\s+)/);
  if (task) {
    return (
      escapeHtml(task[1]) +
      span(task[2] + task[3], "list") +
      span(task[4], "task") +
      escapeHtml(task[5]) +
      renderInline(line.slice(task[0].length))
    );
  }

  // 列表（无序 / 有序）
  const list = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)/);
  if (list) {
    return (
      escapeHtml(list[1]) +
      span(list[2], "list") +
      escapeHtml(list[3]) +
      renderInline(line.slice(list[0].length))
    );
  }

  // 引用
  const quote = line.match(/^(\s*)(>+)(\s?)/);
  if (quote) {
    return (
      escapeHtml(quote[1]) +
      span(quote[2], "quote") +
      escapeHtml(quote[3]) +
      renderInline(line.slice(quote[0].length))
    );
  }

  // 表格
  if (/^\s*\|/.test(line)) {
    return renderTableLine(line);
  }

  // 普通段落
  return renderInline(line);
}

export function renderMarkdownHighlight(text: string): string {
  return text.split("\n").map(renderLine).join("\n");
}

/**
 * 逐行分词，且**按行缓存**。
 *
 * `renderLine` 是纯函数 —— 它只看这一行怎么写，不记录「我在代码块里」这类跨行状态
 * （围栏行本身会被上色，但下一行并不因此改变分词方式）。所以「行文本 → HTML」这个映射
 * 可以放心缓存：在几千行的文档里改一行，其余的行直接命中缓存，一次正则都不用跑。
 *
 * 缓存是**模块级**的，跨笔记共享 —— 缓存键是行内容本身，同一行在哪儿都是同一个结果。
 */
const lineHtmlCache = new Map<string, string>();

/** 缓存上限。超了就整体清空：文档里出现过的行集合本来就不会无限大，够用即可。 */
const LINE_CACHE_LIMIT = 8000;

export function renderMarkdownLines(text: string): string[] {
  return text.split("\n").map((line) => {
    const cached = lineHtmlCache.get(line);
    if (cached !== undefined) return cached;

    const html = renderLine(line);
    if (lineHtmlCache.size >= LINE_CACHE_LIMIT) lineHtmlCache.clear();
    lineHtmlCache.set(line, html);
    return html;
  });
}
