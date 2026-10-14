/**
 * PDF 导出功能
 *
 * 策略：在页面内创建打印浮层，直接调用浏览器打印。
 * 图片保留在原始 DOM 上下文中，避免 Tauri asset protocol 跨上下文失效。
 */

export async function exportNoteAsPdf(
  title: string,
  _content: string,
  renderedHtml?: string,
): Promise<void> {
  if (!renderedHtml) {
    // NotePad 无预览 → 只能用 Markdown 转 HTML
    renderedHtml = markdownToHtml(_content);
    renderedHtml = await convertImagesToDataUri(renderedHtml);
    printViaIframe(title, renderedHtml);
    return;
  }

  // MainWindow 有预览 → 直接在页面内打印，图片自然可用
  printViaOverlay(title, renderedHtml);
}

/**
 * 方式一：页面浮层打印（MainWindow 用，图片在原始 DOM 中天然可用）
 */
function printViaOverlay(title: string, bodyHtml: string): void {
  // 创建全屏打印浮层（只放 body 内容，不是完整 HTML）
  const overlay = document.createElement("div");
  overlay.id = "__floral_print_overlay__";
  overlay.innerHTML = `<h1>${escapeHtml(title)}</h1>${bodyHtml}`;
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    background: white; overflow-y: auto;
    padding: 18mm 20mm;
    font-family: "Source Han Serif SC", "SimSun", Georgia, serif;
    font-size: 12pt; line-height: 1.85; color: #2c2c2c;
  `;
  document.body.appendChild(overlay);

  // 提示文字：提醒关闭页眉页脚
  const hint = document.createElement("div");
  hint.id = "__floral_print_hint__";
  hint.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 24px;border-radius:10px;font-size:14px;z-index:2147483647;box-shadow:0 4px 20px rgba(0,0,0,0.3);text-align:center;";
  hint.innerHTML =
    '打印对话框 → 更多设置 → <b>取消勾选"页眉和页脚"</b>';
  document.body.appendChild(hint);

  // 注入打印 CSS
  const style = document.createElement("style");
  style.id = "__floral_print_style__";
  style.textContent = `
    @media print {
      /* 隐藏除浮层外的所有内容 */
      body > *:not(#__floral_print_overlay__) { display: none !important; }
      #__floral_print_overlay__ {
        position: static !important; inset: auto !important;
        overflow: visible !important;
        padding: 0 !important; margin: 0 !important;
      }
      @page {
        size: A4;
        margin: 18mm 20mm;
      }
    }

    /* === 浮层内容样式（打印和屏幕通用，确保格式正确） === */
    #__floral_print_overlay__ {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }

    /* 标题字号放大 */
    #__floral_print_overlay__ h1 { font-size: 22pt !important; font-weight: 700 !important; margin: 0 0 10mm 0 !important; padding-bottom: 3mm !important; border-bottom: 2px solid #333 !important; color: #1a1a1a !important; }
    #__floral_print_overlay__ h2 { font-size: 17pt !important; font-weight: 600 !important; margin: 8mm 0 4mm !important; color: #2a2a2a !important; }
    #__floral_print_overlay__ h3 { font-size: 14pt !important; font-weight: 600 !important; margin: 6mm 0 3mm !important; }
    #__floral_print_overlay__ h4 { font-size: 12.5pt !important; font-weight: 600 !important; margin: 5mm 0 2mm !important; }

    /* 表格样式 */
    #__floral_print_overlay__ table {
      border-collapse: collapse !important;
      width: 100% !important;
      margin: 5mm 0 !important;
      font-size: 11pt !important;
      border: 1px solid #ccc !important;
    }
    #__floral_print_overlay__ th {
      background: #e8e8e8 !important;
      color: #333 !important;
      font-weight: 700 !important;
      padding: 3mm 4mm !important;
      border: 1px solid #bbb !important;
      text-align: left !important;
    }
    #__floral_print_overlay__ td {
      padding: 2mm 4mm !important;
      border: 1px solid #ccc !important;
      text-align: left !important;
      vertical-align: top !important;
    }
    #__floral_print_overlay__ tr:nth-child(even) td {
      background: #f5f5f5 !important;
    }

    /* 代码块 */
    #__floral_print_overlay__ .markdown-code-block {
      position: relative !important;
      margin: 5mm 0 !important;
    }
    #__floral_print_overlay__ .markdown-code-block > button {
      /* 隐藏复制按钮 */
      display: none !important;
    }
    #__floral_print_overlay__ .markdown-code-block > span:first-of-type {
      /* 语言标签（PYTHON / JAVA 等） */
      position: absolute !important;
      top: 6px !important;
      left: 14px !important;
      font-size: 9pt !important;
      font-family: monospace !important;
      color: #888 !important;
      text-transform: uppercase !important;
      z-index: 1 !important;
    }
    #__floral_print_overlay__ pre {
      background: #f4f4f4 !important;
      border: 1px solid #ddd !important;
      border-radius: 4px !important;
      padding: 28px 14px 10px 14px !important;
      margin: 0 !important;
      font-size: 10pt !important;
      line-height: 1.6 !important;
      overflow-x: auto !important;
    }
    #__floral_print_overlay__ pre code {
      background: none !important;
      font-size: inherit !important;
    }
    #__floral_print_overlay__ code {
      background: #f0f0f0 !important;
      padding: 1px 4px !important;
      border-radius: 3px !important;
      font-size: 10pt !important;
    }

    /* 引用块 */
    #__floral_print_overlay__ blockquote {
      border-left: 3px solid #aaa !important;
      padding: 2mm 6mm !important;
      margin: 4mm 0 !important;
      color: #555 !important;
      background: #fafafa !important;
    }

    /* 提示文字，只在屏幕上显示 */
    #__floral_print_hint__ {
      position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
      background: #333; color: #fff; padding: 8px 20px; border-radius: 8px;
      font-size: 14px; z-index: 2147483647; pointer-events: none;
    }
    @media print {
      #__floral_print_hint__ { display: none !important; }
    }
  `;
  document.head.appendChild(style);

  function cleanup() {
    const el = document.getElementById("__floral_print_overlay__");
    if (el) document.body.removeChild(el);
    const st = document.getElementById("__floral_print_style__");
    if (st) document.head.removeChild(st);
    const ht = document.getElementById("__floral_print_hint__");
    if (ht) document.body.removeChild(ht);
  }

  window.addEventListener("afterprint", cleanup, { once: true });

  setTimeout(() => {
    window.print();
    // 超时兜底
    setTimeout(cleanup, 120000);
  }, 800);
}

/**
 * 方式二：iframe 打印（NotePad 降级方案，图片已转 base64）
 */
function printViaIframe(title: string, bodyHtml: string): void {
  const doc = buildPrintDocument(title, bodyHtml);

  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;width:210mm;height:297mm;border:none;";
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDoc) {
    document.body.removeChild(iframe);
    return;
  }

  iframeDoc.open();
  iframeDoc.write(doc);
  iframeDoc.close();

  let resolved = false;
  const cleanup = () => {
    if (resolved) return;
    resolved = true;
    setTimeout(() => {
      if (document.body.contains(iframe)) document.body.removeChild(iframe);
    }, 1000);
  };

  iframe.onload = () => {
    setTimeout(() => {
      try {
        iframe.contentWindow?.addEventListener("afterprint", cleanup);
        iframe.contentWindow?.print();
      } catch {
        cleanup();
      }
    }, 500);
  };

  setTimeout(cleanup, 60000);
}

/**
 * 将 HTML 中的图片 src 转为 base64 data URI
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
 * 构建打印 HTML 文档（不含 <html>/<body> 外层，供 overlay/iframe 使用）
 */
function buildPrintDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <style>
    @page { size: A4; margin: 18mm 20mm; }
    body {
      font-family: "Source Han Serif SC", "Noto Serif CJK SC", "SimSun", Georgia, serif;
      font-size: 12pt; line-height: 1.85; color: #2c2c2c;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    h1 { font-size: 20pt; font-weight: 700; margin-bottom: 6mm; padding-bottom: 2mm; border-bottom: 2px solid #2c2c2c; }
    h2 { font-size: 16pt; font-weight: 600; margin: 6mm 0 3mm; }
    h3 { font-size: 14pt; font-weight: 600; margin: 5mm 0 2mm; }
    h4 { font-size: 12pt; font-weight: 600; margin: 4mm 0 2mm; }
    p { margin: 2mm 0; }
    strong, b { font-weight: 700; }
    em, i { font-style: italic; }
    del { text-decoration: line-through; color: #999; }
    code { font-family: "Cascadia Code", "Fira Code", monospace; background: #f3f3f3; padding: 1px 5px; border-radius: 3px; font-size: 10pt; color: #c7254e; }
    pre { background: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 4px; padding: 10px 14px; margin: 4mm 0; overflow-x: auto; font-size: 10pt; line-height: 1.6; page-break-inside: avoid; }
    pre code { background: none; padding: 0; color: #333; }
    blockquote { border-left: 3px solid #bbb; padding: 2mm 6mm; margin: 4mm 0; color: #555; background: #fafafa; }
    table { border-collapse: collapse; width: 100%; margin: 4mm 0; font-size: 10.5pt; page-break-inside: avoid; }
    th, td { border: 1px solid #ccc; padding: 2mm 4mm; text-align: left; }
    th { background: #f0f0f0; font-weight: 700; }
    tr:nth-child(even) td { background: #fafafa; }
    ul, ol { margin: 2mm 0; padding-left: 7mm; }
    li { margin: 1mm 0; }
    img { max-width: 100%; height: auto; display: block; margin: 4mm auto; }
    hr { border: none; border-top: 1px solid #ddd; margin: 6mm 0; }
    .katex { font-size: 1.05em; }
    .katex-display { margin: 3mm 0; }
    .markdown-alert { border-left: 3px solid #888; padding: 2mm 5mm; margin: 3mm 0; background: #f8f8f8; }
    .page-break { page-break-after: always; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${bodyHtml}
</body>
</html>`;
}

/**
 * Markdown → HTML（NotePad 降级用）
 */
function markdownToHtml(md: string): string {
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
      const hcells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
        const rows = ["<tr>" + hcells.map((c) => `<th>${c}</th>`).join("") + "</tr>"];
        i += 2;
        while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
          const cells = lines[i].trim().split("|").slice(1, -1).map((c) => c.trim());
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
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
