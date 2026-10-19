/**
 * 代码高亮。
 *
 * 从 `MarkdownPreview.tsx` 里抽出来，因为「文件读取器」里 `kind: "code"` 的文件要走
 * **同一条**管线：语言白名单与回落行为如果各写一份，迟早会漂移——预览里能高亮的语言，
 * 文件视图里却变成纯文本，这种不一致很难排查。
 *
 * 用的是全量 highlight.js，但被白名单限制。不在白名单内的一律**转义后原样输出**，
 * 而不是交给 hljs 猜——`highlightAuto` 对短文本的误判率很高，宁可不着色。
 */

const HLJS_LANGS = new Set([
  "python",
  "py",
  "java",
  "c",
  "cpp",
  "c++",
  "csharp",
  "cs",
  "javascript",
  "js",
  "typescript",
  "ts",
  "tsx",
  "rust",
  "rs",
  "go",
  "golang",
  "html",
  "css",
  "scss",
  "json",
  "yaml",
  "toml",
  "sql",
  "shell",
  "sh",
  "bash",
  "powershell",
  "ps1",
  "xml",
  "markdown",
  "md",
  "ruby",
  "php",
  "swift",
  "kotlin",
]);

/** 判断宿主是否内置支持某个语言（插件可以据此决定要不要自己着色）。 */
export function isHighlightLanguage(language: string): boolean {
  return HLJS_LANGS.has(language.toLowerCase().trim());
}

export function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把源码高亮成可直接 `dangerouslySetInnerHTML` 的 HTML。
 *
 * 返回值一定是**安全**的：要么来自 hljs（它自己转义），要么经过 `escapeHtmlEntities`。
 * 失败路径也走转义，因此调用方不需要再兜一层。
 */
export async function highlightCode(code: string, language: string): Promise<string> {
  const normalized = language.toLowerCase().trim();
  if (!HLJS_LANGS.has(normalized)) return escapeHtmlEntities(code);

  try {
    const hljs = await import("highlight.js");
    const result = hljs.default.highlight(code, {
      language: normalized,
      ignoreIllegals: true,
    });
    return result.value;
  } catch {
    return escapeHtmlEntities(code);
  }
}

/**
 * 把整份高亮结果按行切开。
 *
 * **不能直接 `split("\n")`**：hljs 吃的是整篇代码（它需要跨行状态 —— 多行字符串、块注释
 * 都是靠上下文才认得出来的），所以它的输出里一个 `<span>` 完全可能横跨好几行。从中间劈开
 * 会得到半个标签，浏览器把后面半截当普通文字吃掉，整段颜色就散了。
 *
 * 做法是在切的同时维护一个「未闭合标签栈」：断行时把还开着的标签补上闭合，下一行开头再
 * 原样重新打开。切完拼回去与原文等价，只是多了几对标签。
 *
 * 这是「按行增量更新」的前提：只有拿到逐行的 HTML，才能只重画改动的那一行。
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  // 只存开始标签的原文，闭合时统一补 `</span>` —— hljs 的输出里只有 span。
  const openTags: string[] = [];
  let buffer = "";
  /**
   * 当前这一行有没有**文字**（而不是只有标签）。
   *
   * 空行必须切成 `""`：渲染层只有见到空串才会补一个零宽空格把行盒撑出来（见 `HighlightLine`）。
   * 而「多行字符串 / 块注释里夹着的空行」在断行时会被重新挂上外层标签，切出来是
   * `<span class="hljs-string"></span>` —— 一个只含空 inline 元素的 div **没有行盒**，
   * 高度是 0，于是它后面的每一行都上移一行，与 textarea（高亮层底下那个真编辑器）彻底
   * 错位。用户看到的就是「选区 / 高亮框落到了别的行上」，而且文件越往下差得越多。
   */
  let lineHasText = false;

  // 一次扫过：要么是一个标签，要么是一段纯文本。
  const tokenPattern = /<[^>]*>|[^<]+/g;
  let token: RegExpExecArray | null;

  const closeAll = () => "</span>".repeat(openTags.length);

  while ((token = tokenPattern.exec(html)) !== null) {
    const piece = token[0];

    if (piece.startsWith("<")) {
      buffer += piece;
      if (piece.startsWith("</")) {
        openTags.pop();
      } else if (!piece.endsWith("/>")) {
        openTags.push(piece);
      }
      continue;
    }

    const parts = piece.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) {
        // 换行即断行：先把这一行补成合法 HTML，再把还开着的标签带到下一行开头。
        // **没有文字的行走空串** —— 只有空串才会被渲染层补零宽空格撑出行高。
        lines.push(lineHasText ? buffer + closeAll() : "");
        buffer = openTags.join("");
        lineHasText = false;
      }
      buffer += parts[index];
      // 制表符 / 空格也算文字：`pre-wrap` 下它们照样撑得出一行。
      if (parts[index].length > 0) lineHasText = true;
    }
  }

  lines.push(lineHasText ? buffer + closeAll() : "");
  return lines;
}
