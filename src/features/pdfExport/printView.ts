/**
 * 摆在屏幕上、也拿去打印的那一份 DOM。
 *
 * ## 为什么预览与打印必须是同一份
 *
 * 以前是两码事：预览看的是 Markdown 面板，打印时再另拼一个覆盖层。两边只要有一点不一样
 * （字号、边距、标题那条横线），用户看到的和拿到的就对不上 —— 而这恰恰是「导出」最不能
 * 出的错。所以这里只造一份：屏幕上它就是那张纸，打印时把周围的东西藏起来、只剩它。
 *
 * ## 几个必须踩准的点
 *
 * 1. **打印色板要钉死**。正文是从预览里抠出来的 HTML，里面全是 `text-ink-soft` 这类
 *    Tailwind 类，而它们最终解析到 `--color-*` 这些变量。用户开着深色主题时 `--color-ink`
 *    是浅灰 —— 白纸浅字，打出来几乎空白。所以容器自己重新声明一整套浅色值，
 *    把祖先主题的影响挡在外面。
 * 2. **边距交给 `@page`，不用 padding**。`@page` 的边距是排版意义上的页边距，分页时
 *    每页都会留出来；用 padding 的话只有第一页和最后一页看着对。
 * 3. **图片要先把 `loading="lazy"` 摘掉**。预览里的图是懒加载的，屏幕外的那些在打印那一刻
 *    根本没开始加载 —— PDF 里就是一片空白。这是「长笔记导出后图片没了」的根因。
 */

import type { PdfExportSettings } from "./settings";
import { paperSizeMm } from "./settings";

/** 容器与纸张的类名。打印 CSS 靠它挑出「留下哪一个」。 */
export const PRINT_ROOT_CLASS = "floral-print-root";
/** 摆在导出面板里的那一份：不铺满屏幕，老老实实待在面板的预览框里。 */
const EMBEDDED_CLASS = "is-embedded";

/** 屏幕上的观感：一张灰底上的白纸。 */
const SCREEN_CSS = `
.${PRINT_ROOT_CLASS} {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  display: flex;
  justify-content: center;
  padding: 20px 0 40px;
  overflow: auto;
  background: #6f6d68;
}
/*
 * 面板里的那一份：不铺满屏幕，老老实实待在预览框里。
 *
 * ⚠️ **打印之前必须把它挪回 document.body**（见 printView.ts 的 toSheet）：预览框是
 * overflow: auto 的，position: absolute 的纸会被这个滚动容器**裁掉** ——
 * 长笔记打出来只剩第一屏。挪到 body 底下就不受任何祖先的裁剪与滚动影响。
 */
.${PRINT_ROOT_CLASS}.${EMBEDDED_CLASS} {
  position: static;
  inset: auto;
  z-index: auto;
  display: block;
  padding: 0;
  overflow: visible;
  background: transparent;
}
.${PRINT_ROOT_CLASS} .floral-print-paper {
  position: relative;
  flex: none;
  /* 「原样」档下纸就是主题的纸（深色主题是深色纸）；浅色 / 黑白两档由 PAPER_CSS
     把 --color-paper 钉成白色。 */
  background: var(--color-paper, #ffffff);
  color: var(--color-ink-soft, #2c2c2c);
  box-shadow: 0 8px 34px rgb(0 0 0 / 0.35);
  /* 分页提示线：每 297mm 一条虚线（预览专用，打印时不要）。真分页是打印那一刻才定的，
     所以这只是「大致会断在这儿」，界面上说清楚了。 */
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent calc(var(--floral-page-h) - 1px),
    #dcdcdc calc(var(--floral-page-h) - 1px),
    #dcdcdc var(--floral-page-h)
  );
}
.${PRINT_ROOT_CLASS} .floral-print-paper > * { position: relative; }
`;

/**
 * 打印时的 CSS。
 *
 * ## 为什么是「兄弟全部 display:none」而不是 `position: absolute`
 *
 * 打印最要命的是**分页**。第一版把这张纸设成 `position: absolute; inset: 0`，指望它覆盖
 * 整个页面 —— 但绝对定位的盒子在分页里是另一套规则，长文档很可能只印出第一屏。
 *
 * 稳的做法是把纸变成**普通流里的一个块**（`position: static`），再把 body 的其它直接子元素
 * `display: none` 掉 —— 必须用 `display`，不能用 `visibility`：后者把元素藏了却**留着
 * 布局空间**，于是 PDF 前面会多出几页空白。这要求那张纸**是 body 的直接子元素**，
 * 所以打印之前一定要先调 `toSheet()`。
 *
 * 后面那两行 `visibility` 是**兜底**：万一有人在没 `toSheet()` 的情况下打印（纸还嵌在面板
 * 里），至少不会把整个应用界面打进 PDF。
 */
const PRINT_CSS = `
@media print {
  html, body { background: #ffffff !important; margin: 0 !important; padding: 0 !important; }
  body > *:not(.${PRINT_ROOT_CLASS}) { display: none !important; }
  body * { visibility: hidden !important; }
  .${PRINT_ROOT_CLASS}, .${PRINT_ROOT_CLASS} * { visibility: visible !important; }
  .${PRINT_ROOT_CLASS} {
    position: static !important;
    inset: auto !important;
    z-index: auto !important;
    display: block !important;
    width: auto !important;
    padding: 0 !important;
    overflow: visible !important;
    background: #ffffff !important;
    background-image: none !important;
  }
  .${PRINT_ROOT_CLASS} .floral-print-paper {
    width: auto !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    box-shadow: none !important;
    background: var(--color-paper, #ffffff) !important;
    background-image: none !important;
  }
}
`;

/**
 * 三档配色**共用**的那点东西：图片别撑破纸、预览里那些只在鼠标下才出现的按钮、
 * 以及分页规则。**这里不碰颜色与字体** —— 那是下面两段的事。
 */
const BASE_CSS = `
.${PRINT_ROOT_CLASS} .floral-print-body img { max-width: 100%; height: auto; }

/* 预览里那些只在鼠标下才出现的东西（代码块的复制按钮之类） */
.${PRINT_ROOT_CLASS} button { display: none !important; }

/* 分页：这几类块尽量别从中间断开；表格的标题行每页重复。 */
.${PRINT_ROOT_CLASS} pre,
.${PRINT_ROOT_CLASS} blockquote,
.${PRINT_ROOT_CLASS} table tr { page-break-inside: avoid; }
.${PRINT_ROOT_CLASS} h1,
.${PRINT_ROOT_CLASS} h2,
.${PRINT_ROOT_CLASS} h3,
.${PRINT_ROOT_CLASS} h4 { page-break-after: avoid; }
.${PRINT_ROOT_CLASS} thead { display: table-header-group; }
`;

/**
 * 「白底」与「黑白」用的那套：把**浅色色板钉死在容器上**，再按纸面重新排一遍正文。
 *
 * 为什么要钉色板：正文是从预览里抠出来的 HTML，带着一堆 `text-ink-soft` 这样的类，
 * 而它们最终落到 `--color-*` 这些变量上。用户开着深色主题时那是浅灰 —— 白纸浅字，
 * 打出来几乎空白。直接在容器上重声明一套浅色值，祖先的主题就影响不到这里了。
 */
const PAPER_CSS = `
.${PRINT_ROOT_CLASS}[data-palette="light"],
.${PRINT_ROOT_CLASS}[data-palette="mono"] {
  --color-paper: #ffffff;
  --color-paper-warm: #f5f1e8;
  --color-paper-deep: #eae4d8;
  --color-ink: #1a1a18;
  --color-ink-soft: #3d3d38;
  --color-ink-ghost: #b8b8ae;
  --color-bamboo: #2d5a3d;
  --color-bamboo-mist: #e8f0eb;
  --color-cloud: #ffffff;
  font-family: var(--font-serif, "Source Han Serif SC", "SimSun", Georgia, serif);
  font-size: 12pt;
  line-height: 1.85;
}
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body { color: #2c2c2c; }
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body p,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body li,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body p,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body li { color: #2c2c2c !important; }
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body h1,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body h2,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body h3,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body h4,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body h5,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body h6,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body h1,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body h2,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body h3,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body h4,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body h5,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body h6 { color: #1a1a1a !important; }

.${PRINT_ROOT_CLASS}[data-palette="light"] pre,
.${PRINT_ROOT_CLASS}[data-palette="mono"] pre {
  background: #f4f4f4 !important;
  border: 1px solid #dddddd !important;
  border-radius: 4px;
  padding: 10px 14px;
  font-size: 10pt;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.${PRINT_ROOT_CLASS}[data-palette="light"] code,
.${PRINT_ROOT_CLASS}[data-palette="mono"] code {
  background: #f0f0f0 !important;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10pt;
}
.${PRINT_ROOT_CLASS}[data-palette="light"] pre code,
.${PRINT_ROOT_CLASS}[data-palette="mono"] pre code { background: none !important; padding: 0; }

.${PRINT_ROOT_CLASS}[data-palette="light"] table,
.${PRINT_ROOT_CLASS}[data-palette="mono"] table {
  border-collapse: collapse;
  width: 100%;
  margin: 5mm 0;
  font-size: 11pt;
}
.${PRINT_ROOT_CLASS}[data-palette="light"] th,
.${PRINT_ROOT_CLASS}[data-palette="light"] td,
.${PRINT_ROOT_CLASS}[data-palette="mono"] th,
.${PRINT_ROOT_CLASS}[data-palette="mono"] td {
  border: 1px solid #cccccc;
  padding: 2mm 3mm;
  text-align: left;
  vertical-align: top;
}
.${PRINT_ROOT_CLASS}[data-palette="light"] th,
.${PRINT_ROOT_CLASS}[data-palette="mono"] th {
  background: #eeeef0 !important;
  font-weight: 700;
}
.${PRINT_ROOT_CLASS}[data-palette="light"] blockquote,
.${PRINT_ROOT_CLASS}[data-palette="mono"] blockquote {
  border-left: 3px solid #bbbbbb;
  padding: 2mm 5mm;
  margin: 4mm 0;
  color: #555555 !important;
  background: #fafafa !important;
}
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-print-body a,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body a {
  color: #2c2c2c;
  text-decoration: underline;
}
`;

/**
 * 黑白：把所有彩色压平。
 *
 * ⚠️ **不许用 `filter: grayscale(1)`**。实测过：同一份长文档，加与不加那个 filter 的
 * 页数一样（10 页），但文件从 31KB 涨到 **11.8MB** —— Chromium 会把整个子树**先栅格化
 * 成一张图**再印。那正是「导出来怎么变成图片了、还选不中字」的来源，而且大到离谱。
 *
 * 所以这里改成**换颜色**：文字一律压成深灰（把语法高亮的那些彩色 token 也一起压平），
 * 底色只留浅灰。字还是字，文件还是几十 KB。
 */
const MONO_CSS = `
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body *,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-title {
  color: #222222 !important;
  text-decoration-color: #222222 !important;
}
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body pre,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body blockquote {
  background: #f4f4f4 !important;
}
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body th {
  background: #e8e8e8 !important;
}
/* 表头那层淡底色、隔行灰：转成中性的透明，免得灰上叠灰 */
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body td,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-body tr {
  background: transparent !important;
}
`;

let styleElement: HTMLStyleElement | null = null;

function ensureStyles(): void {
  if (styleElement && styleElement.isConnected) return;
  const style = document.createElement("style");
  style.dataset.floral = "pdf-export";
  style.textContent = `${SCREEN_CSS}\n${PRINT_CSS}\n${BASE_CSS}\n${PAPER_CSS}\n${MONO_CSS}`;
  document.head.append(style);
  styleElement = style;
}

export interface PrintView {
  /** 摆好的那个容器。 */
  element: HTMLElement;
  /** 改设置（用户还在调）时就地重排，不用重建 DOM。 */
  update: (settings: PdfExportSettings) => void;
  /** 挪到 `document.body` 底下、铺满屏幕 —— **打印之前必须调**（见 `EMBEDDED` 那段 CSS）。 */
  toSheet: () => void;
  /** 挪回面板的预览框里（用户取消打印时用）。 */
  toEmbedded: () => void;
  /** 收拾干净：把容器、样式、`@page` 规则都撤掉。 */
  cleanup: () => void;
}

export interface MountOptions {
  /** 挂在哪儿。默认 `document.body`。 */
  parent?: HTMLElement;
  /** 是不是面板里的那一份（不铺满屏幕）。 */
  embedded?: boolean;
}

/**
 * 把「标题 + 正文」摆成一张纸。
 *
 * `bodyHtml` 是**已经渲染好的 HTML**（预览区抠出来的，或 `markdownToHtml` 转出来的）。
 */
export function mountPrintView(
  title: string,
  bodyHtml: string,
  settings: PdfExportSettings,
  options: MountOptions = {},
): PrintView {
  ensureStyles();

  const root = document.createElement("div");
  root.className = options.embedded ? `${PRINT_ROOT_CLASS} ${EMBEDDED_CLASS}` : PRINT_ROOT_CLASS;
  root.dataset.palette = settings.colorMode;

  const paper = document.createElement("div");
  paper.className = "floral-print-paper";

  const heading = document.createElement("h1");
  heading.className = "floral-print-title";
  heading.textContent = title;

  const body = document.createElement("div");
  body.className = "floral-print-body";
  body.innerHTML = bodyHtml;

  // 懒加载的图在屏幕外根本不会开始加载（见文件头第 3 条）。
  for (const image of body.querySelectorAll("img")) {
    image.loading = "eager";
    image.removeAttribute("loading");
  }

  paper.append(heading, body);
  root.append(paper);
  (options.parent ?? document.body).append(root);

  // `@page` 的边距只能靠注入一条规则来改 —— 它不吃 CSS 变量。
  const pageStyle = document.createElement("style");
  pageStyle.dataset.floral = "pdf-page";
  document.head.append(pageStyle);

  const apply = (next: PdfExportSettings) => {
    const { width, height } = paperSizeMm(next.paper, next.landscape);
    const { top, right, bottom, left } = next.marginMm;
    paper.style.width = `${width}mm`;
    paper.style.minHeight = `${height}mm`;
    // 屏幕上的纸用 padding 模拟页边距；打印时归零，交给 `@page`（见 PRINT_CSS）。
    paper.style.padding = `${top}mm ${right}mm ${bottom}mm ${left}mm`;
    paper.style.setProperty("--floral-page-h", `${height}mm`);
    root.dataset.palette = next.colorMode;

    heading.style.fontSize = `${next.title.sizePt}pt`;
    heading.style.textAlign = next.title.align;
    heading.style.fontWeight = "700";
    heading.style.margin = "0 0 8mm 0";
    heading.style.paddingBottom = next.title.rule ? "3mm" : "0";
    heading.style.borderBottom = next.title.rule
      ? "2px solid var(--color-ink, #333333)"
      : "none";
    heading.style.color = "var(--color-ink, #1a1a1a)";

    pageStyle.textContent =
      `@page { size: ${next.landscape ? "landscape" : "portrait"};` +
      ` margin: ${top}mm ${right}mm ${bottom}mm ${left}mm; }`;
  };

  apply(settings);

  return {
    element: root,
    update: apply,
    toSheet: () => {
      // 挪一个节点不会重建它 —— 图已经加载好的状态原样带过去。
      root.classList.remove(EMBEDDED_CLASS);
      document.body.append(root);
    },
    toEmbedded: () => {
      const parent = options.parent;
      if (!parent) return;
      root.classList.add(EMBEDDED_CLASS);
      parent.append(root);
    },
    cleanup: () => {
      root.remove();
      pageStyle.remove();
      if (styleElement) {
        styleElement.remove();
        styleElement = null;
      }
    },
  };
}

/**
 * 等这一份真的**画得出来**了再动手打印。
 *
 * 打印机拿到的是某一瞬间的排版结果：字体还没换好、图还没解码，印出来的就是错版。
 * 所以等字体、等图、再等两帧。
 */
export async function waitForPrintable(element: HTMLElement): Promise<void> {
  // 字体：没装好时量出来的行高是错的，分页会跟着错。
  await Promise.race([
    document.fonts?.ready ?? Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);

  const images = [...element.querySelectorAll("img")];
  await Promise.race([
    Promise.all(
      images.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => resolve(), { once: true });
            }),
      ),
    ),
    // 一张图挂住不该让整次导出卡死 —— 到点就走，缺一张图好过导不出来。
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);

  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
