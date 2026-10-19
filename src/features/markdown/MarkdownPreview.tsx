import { memo, useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Components } from "react-markdown";
import "katex/dist/katex.min.css";
// 代码主题不再静态 import —— 那一份是写死的浅色，深色模式下代码块一直是浅的。
// 现在由 `codeThemes.ts` 在运行时注入，跟随应用主题或当前文件类型的声明。
import remarkAlerts from "./remarkAlerts";
import remarkAlign from "./remarkAlign";
import remarkLocalImages from "./remarkLocalImages";
import { sliceBlockSource } from "./blockSource";
import { highlightCode } from "./highlight";
import { parseImageLayout } from "./imageLayout";
import {
  allowLocalFileUrls,
  resolveMarkdownImagePath,
  resolveMarkdownImageSrc,
} from "./imageSrc";
import { ImageCopyButton, useImageCopyMenu } from "../../components/ImageCopyOverlay";

/**
 * 块右上角的复制按钮。代码块与表格共用。
 *
 * 平时 `opacity-0`，**悬停所在的块**（外层那个 `group`）才显形 —— 每个块都常驻一个
 * 按钮会把预览区的留白切得很碎。
 */
function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-paper-deep/30 text-ink-ghost opacity-0 group-hover:opacity-100 hover:bg-paper-deep/50 hover:text-ink-soft transition-all cursor-pointer"
    >
      {copied
        ? t("markdown.copied", { defaultValue: "已复制" })
        : t("markdown.copy", { defaultValue: "复制" })}
    </button>
  );
}

/**
 * hast 子树里有没有 `<img>`。
 *
 * 参数类型放宽成 `unknown` 是因为 react-markdown 的 `node` 只声明了一个宽松的
 * Element 形状，逐层 narrow 反而更啰嗦。
 */
function containsImage(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;

  const element = node as { type?: string; tagName?: string; children?: unknown[] };
  if (element.type === "element" && element.tagName === "img") return true;

  return (element.children ?? []).some(containsImage);
}

type MarkdownImageProps = React.ComponentPropsWithoutRef<"img"> & {
  /** hast 节点，必须摘掉，不能落到 DOM 上。 */
  node?: unknown;
  imageBaseDir?: string;
};

/**
 * Markdown 里的一张图。
 *
 * 单独提出来是为了能在这里用 hook（右键菜单的状态）。尺寸 / 对齐参数写在 alt 里，
 * 见 `imageLayout.ts`；外层那个 div 的宽度就是图片宽度，复制按钮才能贴在**图片**的
 * 右上角，而不是整块正文的右上角。
 */
function MarkdownImage({
  src,
  alt,
  title,
  node: _node,
  imageBaseDir,
  ...props
}: MarkdownImageProps) {
  const resolvedSrc = resolveMarkdownImageSrc(src, imageBaseDir, convertFileSrc);
  const absolutePath = resolveMarkdownImagePath(src, imageBaseDir);
  const { openMenu, menu } = useImageCopyMenu(absolutePath);

  const layout = parseImageLayout(alt);
  const caption = title || layout.alt || "";
  const alignClass =
    layout.align === "left"
      ? "ml-0 mr-auto"
      : layout.align === "right"
        ? "ml-auto mr-0"
        : "mx-auto";

  return (
    <figure className="my-3 group" onContextMenu={openMenu}>
      <div
        className={`relative ${alignClass}`}
        style={{ width: layout.width ?? "50%" }}
      >
        <img
          src={resolvedSrc}
          alt={layout.alt}
          loading="lazy"
          className="rounded block w-full"
          style={layout.height ? { height: layout.height } : undefined}
          {...props}
        />
        {absolutePath ? <ImageCopyButton path={absolutePath} /> : null}
      </div>
      {caption ? (
        <figcaption className="text-center text-[0.85em] md-caption mt-1.5">
          {caption}
        </figcaption>
      ) : null}
      {menu}
    </figure>
  );
}

interface MermaidRenderer {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

let mermaidRenderer: MermaidRenderer | null = null;

async function getMermaidRenderer(): Promise<MermaidRenderer> {
  if (!mermaidRenderer) {
    const mod = await import("mermaid");
    const instance = mod.default as unknown as MermaidRenderer;
    instance.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "strict",
    });
    mermaidRenderer = instance;
  }
  return mermaidRenderer;
}

async function renderMermaid(code: string): Promise<string> {
  const mermaid = await getMermaidRenderer();
  const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
  const { svg } = await mermaid.render(id, code);
  return svg;
}

function CodeBlock({ children, language }: { children: React.ReactNode; language?: string }) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [mermaidSvg, setMermaidSvg] = useState<string | null>(null);
  const [mermaidFailed, setMermaidFailed] = useState(false);

  const rawCode = extractText(children);
  const isMermaid = language?.toLowerCase() === "mermaid";

  // 异步语法高亮（非 mermaid）
  useEffect(() => {
    if (isMermaid) return;
    let cancelled = false;
    if (language) {
      void highlightCode(rawCode, language).then((html) => {
        if (!cancelled) setHighlighted(html);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [rawCode, language, isMermaid]);

  // mermaid 流程图渲染
  useEffect(() => {
    if (!isMermaid) return;
    let cancelled = false;
    setMermaidSvg(null);
    setMermaidFailed(false);
    void renderMermaid(rawCode)
      .then((svg) => {
        if (!cancelled) setMermaidSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setMermaidFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [rawCode, isMermaid]);

  // mermaid 渲染成功
  if (isMermaid && mermaidSvg) {
    return (
      <div className="markdown-code-block my-3 relative group">
        <div
          className="mermaid-svg flex justify-center overflow-x-auto px-4 py-3 rounded bg-paper-warm/80"
          dangerouslySetInnerHTML={{ __html: mermaidSvg }}
        />
        <span className="absolute top-2 left-3 text-[10px] font-mono text-ink-faint/70 uppercase tracking-wider select-none">
          mermaid
        </span>
        <CopyButton text={rawCode} />
      </div>
    );
  }

  // mermaid 加载中
  if (isMermaid && !mermaidFailed) {
    return (
      <div className="markdown-code-block my-3 px-4 py-3 rounded bg-paper-warm/80 text-ink-ghost text-[0.85em]">
        流程图渲染中…
      </div>
    );
  }

  // 普通代码块（非 mermaid 或 mermaid 渲染失败）
  return (
    <div className="markdown-code-block my-3 relative group">
      <pre
        className={`markdown-code-scroll m-0 px-4 rounded bg-paper-warm/80 overflow-x-auto ${
          language ? "pt-8 pb-3" : "py-3"
        }`}
      >
        {highlighted ? (
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{children}</code>
        )}
      </pre>
      {language && (
        <span className="absolute top-2 left-3 text-[10px] font-mono text-ink-faint/70 uppercase tracking-wider select-none">
          {language}
        </span>
      )}
      <CopyButton text={rawCode} />
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

interface MarkdownPreviewProps {
  content: string;
  fontSize?: number;
  renderHtml?: boolean;
  imageBaseDir?: string;
}

const remarkPlugins = [remarkLocalImages, remarkGfm, remarkMath, remarkAlerts, remarkAlign];

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "center", "font", "u", "abbr"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "style",
      "className",
      "data-alert-type",
      "dataAlertType",
    ],
    font: ["color", "size", "face"],
    abbr: ["title"],
  },
  // `file:` 要放行：本地绝对路径的图片会被 `remarkLocalImages` 转成 `file://`，
  // 不在这里放行的话 sanitize 会直接把 src 丢掉。
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "file"],
  },
};
const rehypePluginsDefault = [rehypeKatex, rehypeSlug];
const rehypePluginsWithHtml = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  rehypeKatex,
  rehypeSlug,
] as Parameters<typeof Markdown>[0]["rehypePlugins"];

function AlertIcon({ type }: { type: string }) {
  switch (type) {
    case "note":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
        </svg>
      );
    case "tip":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.149-.176.214-.253.56-.679.984-1.32.984-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z" />
        </svg>
      );
    case "important":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
        </svg>
      );
    case "warning":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.396A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.557ZM8.22 2.097a.25.25 0 0 0-.44 0L1.698 13.493a.25.25 0 0 0 .22.382h12.164a.25.25 0 0 0 .22-.382Z" />
          <path d="M8.75 5.75a.75.75 0 0 0-1.5 0v2.5a.75.75 0 0 0 1.5 0v-2.5ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
        </svg>
      );
    case "caution":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
        </svg>
      );
    default:
      return null;
  }
}

function Blockquote({
  children,
  node,
}: {
  children?: React.ReactNode;
  node?: { properties?: Record<string, unknown> };
}) {
  const { t } = useTranslation();
  const alertType =
    ((node?.properties?.dataAlertType || node?.properties?.["data-alert-type"]) as string) ?? "";
  if (alertType) {
    const alertTitleMap: Record<string, string> = {
      note: t("markdown.alert.note", { defaultValue: "备注" }),
      tip: t("markdown.alert.tip", { defaultValue: "提示" }),
      important: t("markdown.alert.important", { defaultValue: "重要" }),
      warning: t("markdown.alert.warning", { defaultValue: "警告" }),
      caution: t("markdown.alert.caution", { defaultValue: "注意" }),
    };

    return (
      <div className={`markdown-alert markdown-alert-${alertType}`} role="note">
        <p className="markdown-alert-title">
          <AlertIcon type={alertType} />
          {alertTitleMap[alertType] ?? alertType.toUpperCase()}
        </p>
        {children}
      </div>
    );
  }
  return (
    <blockquote className="border-l-2 md-quote pl-4 my-3 text-ink-soft/80 italic leading-[1.9]">
      {children}
    </blockquote>
  );
}

/**
 * 表格单元格的样式：在 GFM 给的列对齐之上补一个「默认靠左」。
 *
 * `| :---: |` 这类标记由 remark-gfm 解析成每个单元格的 `align`。**它到不了 `align` 这个
 * prop 上** —— `hast-util-to-jsx-runtime` 会把它转成 `style={{ textAlign }}` 再传进来
 * （实测确认过），所以这里要透传 `style`。以前 `th` 写死了 `text-left`、`style` 直接丢掉，
 * 表现就是**列对齐一直不生效**：写了 `:---:` 还是照样靠左。
 *
 * 没写标记时显式写 `left`，而不是留给继承：列的左右该由表格自己决定，不该被外面的容器
 * （`<center>`、`::: center`）牵着走。
 */
function cellStyle(style?: CSSProperties): CSSProperties {
  return { textAlign: "left", ...style };
}

const staticComponents: Components = {
  h1: ({ children, id }) => (
    <h1 id={id} className="text-[1.57em] font-display font-bold text-ink mt-6 mb-4 tracking-wide">
      {children}
    </h1>
  ),
  h2: ({ children, id }) => (
    <h2 id={id} className="text-[1.21em] font-display font-bold text-ink mt-7 mb-3 tracking-wide">
      {children}
    </h2>
  ),
  h3: ({ children, id }) => (
    <h3 id={id} className="text-[1.07em] font-display font-bold text-ink mt-5 mb-2 tracking-wide">
      {children}
    </h3>
  ),
  h4: ({ children, id }) => (
    <h4 id={id} className="text-[1em] font-display font-semibold text-ink mt-4 mb-2 tracking-wide">
      {children}
    </h4>
  ),
  /**
   * 段落里**含有图片**时改渲染成 `<div>`。
   *
   * 图片渲染器产出 `<figure>`（内含 `<figcaption>` 图注），而 `<figcaption>` 不是 `<p>`
   * 的合法后代 —— 浏览器会擅自把段落闭合，React 也会一直报 "cannot be a descendant of
   * <p>"。返回 `<div>` 等于整段不再有 `<p>`，问题从根上消失。
   *
   * ⚠️ 判断必须**递归整个子树**，不能只看「是不是只有一张图」：行内图片
   * （`文字 ![图](url)`）的段落里还有文字节点，同样会踩到。
   */
  p: ({ children, node }) =>
    containsImage(node) ? (
      <div className="text-ink-soft leading-[1.9]">{children}</div>
    ) : (
      <p className="text-ink-soft leading-[1.9]">{children}</p>
    ),
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic text-bamboo-light">{children}</em>,
  blockquote: Blockquote,
  ul: ({ children }) => (
    <ul className="ml-4 text-ink-soft leading-[1.9] list-disc list-outside marker:text-bamboo/40">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="ml-4 text-ink-soft leading-[1.9] list-decimal list-outside marker:text-bamboo/50 marker:font-mono marker:text-[0.85em]">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="text-ink-soft leading-[1.9]">{children}</li>,
  hr: () => <hr className="my-6 border-none h-px md-divider" />,
  code: ({ className, children }) => {
    const isBlock = className?.startsWith("language-") || String(children).includes("\n");
    if (isBlock) {
      return (
        <code className="text-[0.85em] font-mono text-ink-soft leading-[1.8] whitespace-pre">
          {children}
        </code>
      );
    }
    return (
      <code className="px-1.5 py-0.5 text-[0.85em] font-mono bg-paper-warm rounded text-bamboo">
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    // Extract language from the <code> element's className
    let language = "";
    if (
      children != null &&
      typeof children === "object" &&
      "props" in (children as React.ReactElement)
    ) {
      const codeProps = (children as React.ReactElement<{ className?: string }>).props;
      const match = codeProps.className?.match(/language-(\S+)/);
      if (match) language = match[1];
    }

    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        if (/^https?:\/\//i.test(href)) {
          openUrl(href);
        } else if (href.startsWith("#")) {
          const id = decodeURIComponent(href.slice(1));
          document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
        }
      }}
      className="text-bamboo hover:text-bamboo-light underline underline-offset-2 cursor-pointer"
    >
      {children}
    </a>
  ),
  // ⚠️ 表格**不在这里**：它的复制按钮要回头去切编辑区原文，必须拿得到当前 `content`，
  // 所以挪到下面 `components` 里按需构造。见那里的注释。
  th: ({ children, style }) => (
    <th
      style={cellStyle(style)}
      className="px-3 py-1.5 border md-table font-semibold text-ink text-[0.85em] bg-paper-warm/50"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={cellStyle(style)} className="px-3 py-1.5 border md-table text-ink-soft">
      {children}
    </td>
  ),
  input: ({ checked, node: _node, ...props }) => (
    <input {...props} checked={checked} disabled className="mr-1.5 accent-bamboo" />
  ),
};

function MarkdownPreviewView({
  content,
  fontSize = 14,
  renderHtml = false,
  imageBaseDir,
}: MarkdownPreviewProps) {
  const { t } = useTranslation();

  /**
   * 表格的复制按钮要复制**编辑区原文**，而渲染器手上只有渲染后的子节点 —— 靠 hast 节点的
   * `position`（源码里的起止偏移）回头去切 `content` 才拿得准。
   *
   * ⚠️ 用 ref 而不是把 `content` 塞进 `useMemo` 的依赖：`components` 一旦换了对象，
   * react-markdown 会把**所有**块当成新组件卸载重挂 —— 每个代码块都要重新高亮一遍，
   * 复制按钮的「已复制」也会被打断。ref 让 `components` 保持稳定引用，同时又读得到最新
   * 正文（effect 在提交后写入，用户点按钮时早就更新过了）。
   */
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const components = useMemo<Components>(
    () => ({
      ...staticComponents,
      table: ({ children, node }) => {
        const source = sliceBlockSource(contentRef.current, node?.position);
        return (
          <div className="my-3 relative group">
            <div className="overflow-x-auto">
              <table className="w-full text-[0.93em] border-collapse border md-table">
                {children}
              </table>
            </div>
            {source ? <CopyButton text={source} /> : null}
          </div>
        );
      },
      // `node` 必须显式摘掉：react-markdown 会把它作为 prop 传进来，而 `...props`
      // 会把整个 hast 节点塞成 DOM 属性。
      img: (props) => <MarkdownImage {...props} imageBaseDir={imageBaseDir} />,
    }),
    [imageBaseDir],
  );
  return (
    <div className="font-body markdown-selectable md-body" style={{ fontSize: `${fontSize}px` }}>
      {content.trim() ? (
        <Markdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={renderHtml ? rehypePluginsWithHtml : rehypePluginsDefault}
          components={components}
          // 放行 `file://` 图片（见 `allowLocalFileUrls` 的说明）。
          urlTransform={allowLocalFileUrls}
        >
          {content}
        </Markdown>
      ) : (
        <p className="text-ink-ghost leading-[1.9]">
          {t("markdown.emptyHint", { defaultValue: "预览区会显示当前笔记内容" })}
        </p>
      )}
    </div>
  );
}

/**
 * 预览整篇走 react-markdown（remark / rehype-raw / rehype-sanitize / katex 全套），
 * 十几万字符一次要几百毫秒。**必须 memo**：不包的话，主窗口任何一次重渲染 —— 打开
 * 目录面板、改个选区、切个分栏 —— 都会把整篇文章重新解析排版一遍，表现为「随便点
 * 什么都卡一下」。
 *
 * 配合上游传入的 `content` 是一份**滞后**的正文（见 MainWindow 的 `previewContent`），
 * 打字期间就一次都不会重排。
 */
export const MarkdownPreview = memo(MarkdownPreviewView);
