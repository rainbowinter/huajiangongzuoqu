/**
 * 导出 PDF。
 *
 * 两条路，用的是**同一份** DOM（见 `printView.ts`）：
 *
 * - **保存为 PDF**（默认）：问一个路径，然后调后端的 `print_pdf`。后端走 WebView2 自己的
 *   `PrintToPdf` —— 没有系统打印对话框、不经过任何打印机驱动，页眉页脚 / 缩放 / 纸张 /
 *   边距全由我们的参数说了算。
 * - **用系统打印机**：还是 `window.print()`。要打真纸、要选别的打印机时才用得上。
 *
 * 早先只有第二条路，而且是从**预览面板**里直接 `window.print()`：屏幕上看到的是预览、
 * 打出来的是另一个东西，中间还夹着用户自己在打印对话框里的选择。
 */

import { invoke } from "@tauri-apps/api/core";
import { mountPrintView, waitForPrintable } from "./printView";
import {
  loadPdfSettings,
  pdfFileName,
  toPrintSettings,
  type PdfExportSettings,
} from "./settings";

/** 后端生成 PDF 并写到 `path`。Windows 上是 WebView2 的 `PrintToPdf`。 */
export function printPdf(path: string, settings: PdfExportSettings): Promise<void> {
  return invoke("print_pdf", { path, settings: toPrintSettings(settings) });
}

export interface PdfExportInput {
  title: string;
  /** 笔记原文，仅在拿不到渲染结果时才用（快速便签窗口）。 */
  content: string;
  /** 预览区抠出来的 HTML。有它就用它 —— 那才是用户看到的排版。 */
  renderedHtml?: string;
  /** 本次导出用的设置；不给就用上次记住的那份。 */
  settings?: PdfExportSettings;
}

/** 把要打印的那份 HTML 准备好。导出面板也要用它。 */
export async function buildPrintBody(input: PdfExportInput): Promise<string> {
  if (input.renderedHtml) return input.renderedHtml;
  // 没有预览（快速便签窗口）：自己把 Markdown 转一份，图片转成 data URI ——
  // 那条路上的图片是 `asset:` 地址，同一个文档里能不能二次加载不作保证，转成内联最稳。
  return await convertImagesToDataUri(markdownToHtml(input.content));
}

/**
 * 「保存为 PDF」：问路径 → 摆好纸 → 让后端写文件。
 *
 * 返回 `false` 表示用户取消了保存对话框。
 */
export async function exportNoteAsPdf(input: PdfExportInput): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: pdfFileName(input.title),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof path !== "string") return false;

  const settings = input.settings ?? loadPdfSettings();
  const bodyHtml = await buildPrintBody(input);
  const view = mountPrintView(input.title, bodyHtml, settings);
  try {
    // 先等它自己把「字体与图就位之后的第二版排版」排完，再等一遍资源，然后才写文件。
    await view.settled;
    await waitForPrintable(view.element);
    await printPdf(path, settings);
  } finally {
    // 无论成没成都得收拾干净：这是个盖住整个界面的层，留着它应用就废了。
    view.cleanup();
  }
  return true;
}

/**
 * 「用系统打印机」：摆好纸，交给系统打印对话框。
 *
 * 同一个窗口里 `window.print()` 会打印**整个界面**，所以打印 CSS 把除了这张纸以外的
 * 东西全部隐藏（`visibility: hidden`，见 `printView.ts`）。
 */
export async function printNoteWithSystemPrinter(input: PdfExportInput): Promise<void> {
  const settings = input.settings ?? loadPdfSettings();
  const bodyHtml = await buildPrintBody(input);
  const view = mountPrintView(input.title, bodyHtml, settings);
  try {
    await view.settled;
    await waitForPrintable(view.element);
    window.print();
  } finally {
    setTimeout(() => view.cleanup(), 500);
  }
}

/**
 * 将 HTML 中的图片 src 转为 base64 data URI。
 *
 * 只在「没有预览」那条路上用（快速便签窗口）：它的 Markdown 里写的是相对路径，
 * 放进另一个文档里就找不到文件了。
 */
async function convertImagesToDataUri(html: string): Promise<string> {
  const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/g;
  const replacements: Array<{ original: string; replacement: string }> = [];

  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    if (src.startsWith("data:")) continue;

    try {
      const response = await fetch(src);
      if (!response.ok) continue;
      const blob = await response.blob();
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(blob);
      });
      const originalTag = match[0];
      const newTag = originalTag.replace(`src="${src}"`, `src="${dataUri}"`);
      replacements.push({ original: originalTag, replacement: newTag });
    } catch {
      // fetch 失败则保留原样
    }
  }

  let result = html;
  for (const { original, replacement } of replacements) {
    result = result.replace(original, replacement);
  }
  return result;
}

/**
 * Markdown → HTML（快速便签窗口用）。
 *
 * 是一份**简化**的实现，只求把标题、强调、代码、表格、列表这些块级结构摆对 ——
 * 真正的渲染在 `MarkdownPreview` 那边，走 unified/remark。
 */
export function markdownToHtml(md: string): string {
  let html = md;

  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` data-lang="${escapeAttr(lang)}"` : "";
    codeBlocks.push(`<pre${langAttr}><code>${escapeHtml(code.trim())}</code></pre>`);
    return `%%CB_${idx}%%`;
  });

  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `%%IC_${idx}%%`;
  });

  html = html.replace(/^#{6} (.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#{5} (.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^#{4} (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^#{3} (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^#{2} (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "");
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/^> (.+)$/gm, "<blockquote><p>$1</p></blockquote>");
  html = html.replace(/^(---|\*\*\*|___)$/gm, "<hr>");
  html = html.replace(/^- \[([ x])\] (.+)$/gm, (_, c, t) => {
    const chk = c === "x" ? " checked" : "";
    return `<li style="list-style:none"><input type="checkbox"${chk} disabled> ${t}</li>`;
  });
  html = html.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  html = convertMdTables(html);

  html = html
    .split(/\n\n+/)
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      if (/^<(h[1-6]|pre|blockquote|table|hr|div|p)\b/.test(t)) {
        if (/^<li>/.test(t)) return "<ul>" + t + "</ul>";
        return t;
      }
      return "<p>" + t.replace(/\n/g, "<br>") + "</p>";
    })
    .join("\n");

  html = html.replace(/%%CB_(\d+)%%/g, (_, i) => codeBlocks[+i] ?? "");
  html = html.replace(/%%IC_(\d+)%%/g, (_, i) => inlineCodes[+i] ?? "");
  return html;
}

function convertMdTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith("|") && line.endsWith("|")) {
      const hcells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
        const rows = ["<tr>" + hcells.map((c) => `<th>${c}</th>`).join("") + "</tr>"];
        i += 2;
        while (
          i < lines.length &&
          lines[i].trim().startsWith("|") &&
          lines[i].trim().endsWith("|")
        ) {
          const cells = lines[i]
            .trim()
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim());
          rows.push("<tr>" + cells.map((c) => `<td>${c}</td>`).join("") + "</tr>");
          i++;
        }
        result.push("<table>" + rows.join("") + "</table>");
        continue;
      }
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
