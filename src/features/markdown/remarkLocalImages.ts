import type { Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/**
 * 让「绝对路径 + 空格」的图片能显示出来。
 *
 * ## 为什么它现在渲染不出来
 *
 * CommonMark 里图片的地址**不能直接带空格** —— `![说明](E:/My Pics/a.png)` 的 `(` 到第一个
 * 空格就断了，整段会被当成普通文字原样显示（用户看到的就是那个）。标准写法是
 * `![说明](<E:/My Pics/a.png>)`，或者把空格写成 `%20`，但没人会那么写。
 *
 * 所以这里在 mdast 层面补一刀：把「长得像本地绝对路径、而且带空格」的 `![alt](dest)`
 * 从文本节点里拆出来，做成真正的 image 节点。
 *
 * ## 为什么转成 `file://`
 *
 * 直接给 `E:/...` 的话，`rehype-sanitize` 会把它当成「协议 `e:`」的 URL 丢掉。转成
 * `file:///E:/...` 之后，只要 schema 里放行 `file` 协议就能过；到了 `img` 组件那一层，
 * `resolveMarkdownImageSrc` 再把它换成 Tauri 的 asset 地址。
 *
 * ## 为什么不预处理 markdown 字符串
 *
 * 表格的复制按钮靠 hast 节点的 `position` 回头去切**原文**（`content.slice(...)`）。
 * 在字符串里插 `<` `>` 会让后面所有偏移量错位，复制出来的就是错的。改 AST 不会。
 */

/** `![alt](dest)`。`dest` 允许有空格 —— 那正是它没被解析成图片的原因。 */
const IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;

/** 看上去是不是一个**本地绝对路径**。 */
export function isLocalAbsolutePath(value: string): boolean {
  const path = value.trim();
  if (!path || path.startsWith("<")) return false;
  if (/^file:\/\//i.test(path)) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true; // E:/… 与 E:\…
  if (/^\\\\[^\\]/.test(path)) return true; // UNC \\server\share
  if (/^\/\/[^/]/.test(path)) return true; // 归一化之后的 UNC
  return false;
}

/**
 * 本地路径 → `file://` URL。
 *
 * ⚠️ 空格必须转义：不转的话 URL 到第一个空格就断了，等于又绕回原来的问题。
 */
export function localPathToFileUrl(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  // `E:/a` → `/E:/a`，这样拼出来正好是 `file:///E:/a`（三个斜杠）。
  const prefixed = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  return `file://${encodeURI(prefixed).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

export interface LocalImageSegment {
  kind: "text" | "image";
  /** `kind === "text"` 时的文字。 */
  value?: string;
  /** `kind === "image"` 时的地址（`file://…`）。 */
  url?: string;
  alt?: string;
}

/**
 * 把一段文字里「带空格的本地绝对路径图片」拆成 文字 / 图片 两种片段。
 *
 * 其它内容（普通图片、外链、认不出的写法）原样留在文字片段里 —— 宁可显示得难看，
 * 也不要吞掉正文。
 */
export function splitLocalImages(value: string): LocalImageSegment[] {
  const segments: LocalImageSegment[] = [];
  let last = 0;

  for (const match of value.matchAll(IMAGE_PATTERN)) {
    const [raw, alt, destination] = match;
    const dest = destination.trim();
    // 没有空格的图片 remark 自己就认出来了，不会以文字节点的形式走到这儿。
    if (!isLocalAbsolutePath(dest) || !/\s/.test(dest)) continue;

    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: "text", value: value.slice(last, index) });
    segments.push({ kind: "image", url: localPathToFileUrl(dest), alt });
    last = index + raw.length;
  }

  if (last < value.length) segments.push({ kind: "text", value: value.slice(last) });
  return segments;
}

const remarkLocalImages: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node: Text, index, parent) => {
    if (!parent || index === null || index === undefined) return;

    const segments = splitLocalImages(node.value);
    if (segments.length === 1 && segments[0].kind === "text") return;

    const replacement: RootContent[] = segments.map((segment) =>
      segment.kind === "text"
        ? ({ type: "text", value: segment.value ?? "" } as Text)
        : ({
            type: "image",
            url: segment.url ?? "",
            alt: segment.alt ?? "",
            title: null,
          } as RootContent),
    );

    parent.children.splice(index, 1, ...replacement);
    // 跳过刚插进去的这几个，别让 visit 再把图片节点当文本看一遍。
    return index + replacement.length;
  });
};

export default remarkLocalImages;
