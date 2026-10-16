/**
 * 摆在屏幕上、也拿去打印的那一份 DOM。
 *
 * ## 预览与打印必须是同一份
 *
 * 以前是两码事：预览看的是 Markdown 面板，打印时再另拼一个覆盖层。两边只要有一点不一样
 * （字号、边距、标题那条横线），用户看到的和拿到的就对不上 —— 而这恰恰是「导出」最不能
 * 出的错。所以这里只造一份，屏幕上它就是那几张纸。
 *
 * ## 分页是自己算的
 *
 * 见 `paginate.ts`：内容被真的摆进一张张固定大小的纸里，**一张纸一个盒子**。打印时一句
 * `break-after: page` 就得到同样的分页 —— 不再是「画几条虚线估一估」。
 *
 * ## 几个必须踩准的点
 *
 * 1. **打印色板要钉死**（白底 / 黑白两档时）。正文是从预览里抠出来的 HTML，里面全是
 *    `text-ink-soft` 这类 Tailwind 类，最终落到 `--color-*` 上；用户开着深色主题时那是
 *    浅灰 —— 白纸浅字，打出来几乎空白。所以那两档在容器上重声明一整套浅色值。
 *    「原样」档反过来：**什么都不覆盖**，主题是什么样就打什么样。
 * 2. **页边距交给 `@page`，不靠 padding**。打印时纸盒只是内容区，四周的空白由 `@page`
 *    留出来 —— 那个位置也正好是 WebView2 画页眉页脚的地方（我们在预览里近似画一遍）。
 * 3. **图片要先把 `loading="lazy"` 摘掉**。屏幕外的图在打印那一刻根本没开始加载，
 *    PDF 里就是一片空白。
 * 4. **打印前必须 `toSheet()`**：把整叠纸挪成 `body` 的直接子元素，别让面板的
 *    `overflow: auto` 把它们裁掉。
 */

import { paginate, type PageBox, type PageMetrics } from "./paginate";
import type { PdfExportSettings } from "./settings";
import { paperSizeMm } from "./settings";

/** 容器、纸、内容盒的类名。打印 CSS 靠它们挑出「留下哪些」。 */
export const PRINT_ROOT_CLASS = "floral-print-root";
const FRAME_CLASS = "floral-sheet";
/** 摆在导出面板里的那一份：不铺满屏幕，老老实实待在预览框里。 */
const EMBEDDED_CLASS = "is-embedded";

/** 屏幕上的观感：灰底上一张张白纸。 */
const SCREEN_CSS = `
.${PRINT_ROOT_CLASS} {
  position: fixed;
  /* 顶上留出标题栏：主窗口没有系统边框，那一条是**拖窗口的手柄**，盖住它用户就
     「拖不动窗口」了。默认 0，由 mountPrintView 的 topInset 给。 */
  top: var(--floral-top-inset, 0px);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2147483600;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 18px 0 40px;
  overflow: auto;
  background: #6f6d68;
}
/*
 * 面板里的那一份：不铺满屏幕，待在预览框里。
 *
 * ⚠️ **打印之前必须把它挪回 document.body**（见 toSheet）：预览框是 overflow: auto 的，
 * 纸会被那个滚动容器**裁掉** —— 长笔记打出来只剩第一屏。
 */
.${PRINT_ROOT_CLASS}.${EMBEDDED_CLASS} {
  position: static;
  inset: auto;
  z-index: auto;
  display: flex;
  padding: 0;
  overflow: visible;
  background: transparent;
}
.${FRAME_CLASS} {
  position: relative;
  flex: none;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.32);
  /* 纸的底色跟着主题走（「原样」档）；白底 / 黑白两档由 PAPER_CSS 把变量钉成白色。 */
  background: var(--color-paper, #ffffff);
}
/*
 * 预览里给**版心**描一圈极淡的虚线：打印时内容正好到这儿为止，光看白纸「怼到头」很别扭，
 * 有条线就知道边界在哪。打印时不要（PRINT_CSS 里关掉）。
 */
.${FRAME_CLASS} .floral-page { outline: 1px dashed rgb(0 0 0 / 0.10); outline-offset: 0; }

/* 预览里的页眉页脚：真打出来时那两行是 WebView2 画的，位置样式只能近似。 */
.${FRAME_CLASS} .floral-sheet-margin {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2mm;
  font: 9px/1.2 system-ui, sans-serif;
  color: var(--color-ink-ghost, #b8b8ae);
  overflow: hidden;
  white-space: nowrap;
}
.${FRAME_CLASS} .floral-sheet-head { top: 3mm; }
.${FRAME_CLASS} .floral-sheet-foot { bottom: 3mm; }
`;

/**
 * 打印时的 CSS。
 *
 * 核心是两件事：**只留下这叠纸**（`display: none` 掉 body 的其它直接子元素 —— 必须用
 * `display`，`visibility: hidden` 会留着布局空间，前面会多出空白页），以及**一张纸一页**
 * （`break-after: page`）。页边距交给 `@page`，所以纸四周的空白（以及 WebView2 画的
 * 页眉页脚）都在可打印区之外 —— 预览里那两行属于「近似」，打印时藏掉。
 */
const PRINT_CSS = `
@media print {
  html, body { margin: 0 !important; padding: 0 !important; }
  /*
   * ⚠️ **纸的底色不要在这里写死白色**（原来这几条都带着 background: #ffffff !important，
   * 那是个 bug）。「原样」档（默认那一档）用的是 var(--color-paper) —— 主题、或者
   * src/styles/custom.css 改过它的时候，屏幕上是一张调过的纸、**导出的 PDF 却是纯白**。
   *
   * 浅色 / 黑白两档不需要写死白色：PAPER_CSS 已经把 --color-paper 钉成 #ffffff，
   * 纸自己就是白的。所以下面 .floral-sheet 那条干脆不写 background，让它用
   * SCREEN_CSS 里那句 var(--color-paper)。
   *
   * ❗**@page 留出来的那圈页边上不了色**（实测记在这里，免得以后有人再试一遍）：
   * html / body 的背景压根铺不进去，换成固定定位、inset: -100mm 的伪元素也只盖住
   * 一小块 —— Chromium 的 @page margin box 不在 CSS 的绘制范围里。所以那圈一直是白的，
   * 纸本身（.floral-sheet）的颜色才是要紧的。
   */
  body { background: transparent !important; }
  body > *:not(.${PRINT_ROOT_CLASS}) { display: none !important; }
  body * { visibility: hidden !important; }
  .${PRINT_ROOT_CLASS}, .${PRINT_ROOT_CLASS} * { visibility: visible !important; }
  .${PRINT_ROOT_CLASS} {
    position: static !important;
    inset: auto !important;
    z-index: auto !important;
    display: block !important;
    padding: 0 !important;
    gap: 0 !important;
    overflow: visible !important;
    /* 屏幕上是灰底（或预览里的透明），打印时都不要 —— 底色交给纸自己。 */
    background: transparent !important;
    background-image: none !important;
  }
  .${FRAME_CLASS} {
    box-shadow: none !important;
    /* 纸的底色**不写死**：SCREEN_CSS 给的就是 var(--color-paper)，
       PAPER_CSS 会把浅色 / 黑白两档的 --color-paper 钉成白色。 */
    /*
     * ⚠️ 打印时纸要**缩回内容盒**：纸张的尺寸与四周的空白都已经由 @page 管了，
     * 这里再算一遍就是双重边距 —— 一张 210×297 的盒子塞进 170×261 的可打印区，
     * 结果是**每张纸溢出成两三页**（实测 5 张纸印成 12 页）。
     */
    width: var(--floral-content-w) !important;
    height: var(--floral-content-h) !important;
    padding: 0 !important;
    border: 0 !important;
    /* 一张纸换一页。最后一张不加 —— 加了会多出一张空白页。 */
    break-after: page;
    page-break-after: always;
  }
  .${FRAME_CLASS}:last-child { break-after: auto; page-break-after: auto; }
  /* 页眉页脚由 WebView2 在可打印区外面画，预览里那一份别跟着印进去。 */
  .${FRAME_CLASS} .floral-sheet-margin { display: none !important; }
  /* 版心那圈虚线是给人看的，别印进 PDF。 */
  .${FRAME_CLASS} .floral-page { outline: none !important; }
}
`;

/**
 * 三档配色**共用**的那点东西：图片别撑破纸、预览里那些只在鼠标下才出现的按钮、
 * 以及「别把一块劈成两半」。**这里不碰颜色与字体** —— 那是下面两段的事。
 */
const BASE_CSS = `
.${PRINT_ROOT_CLASS} .floral-page img { max-width: 100%; height: auto; }

/* 预览里那些只在鼠标下才出现的东西（代码块的复制按钮之类） */
.${PRINT_ROOT_CLASS} .floral-page button { display: none !important; }

/* 表格切分时重画的表头：每一页顶上都要有一份列名 */
.${PRINT_ROOT_CLASS} .floral-page thead { display: table-header-group; }
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
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page-content,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page-content { color: #2c2c2c; }
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page p,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page li,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page p,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page li { color: #2c2c2c !important; }
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page h1,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page h2,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page h3,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page h4,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page h5,
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page h6,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page h1,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page h2,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page h3,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page h4,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page h5,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page h6 { color: #1a1a1a !important; }

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
.${PRINT_ROOT_CLASS}[data-palette="light"] .floral-page a,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page a {
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
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page *,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-print-title {
  color: #222222 !important;
  text-decoration-color: #222222 !important;
}
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page pre,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page blockquote {
  background: #f4f4f4 !important;
}
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page th {
  background: #e8e8e8 !important;
}
/* 表头那层淡底色、隔行灰：转成中性透明，免得灰上叠灰 */
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page td,
.${PRINT_ROOT_CLASS}[data-palette="mono"] .floral-page tr {
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
  /** 整叠纸（含面板里那一层）。 */
  element: HTMLElement;
  /**
   * 等「字体与图就位之后的第二次排版」完成。
   *
   * ⚠️ **打印之前一定要等它**：不等的话可能正好印在「用替身字体量的那一版」上 ——
   * 分页、行高全是错的。面板里等它顺手刷新页数，直接导出那条路等它才开始写文件。
   */
  settled: Promise<void>;
  /** 现在一共有几页。 */
  pageCount: () => number;
  /** 有块比一页还高、又切不开 —— 产出页数可能与预览对不上，界面上该说一句。 */
  overflowed: () => boolean;
  /** 改设置（用户还在调）时重排一遍，不用重建 DOM 外壳。 */
  update: (settings: PdfExportSettings) => void;
  /** 挪到 `document.body` 底下、铺满屏幕 —— **打印之前必须调**。 */
  toSheet: () => void;
  /** 挪回面板的预览框里（用户取消打印、或导出失败时）。 */
  toEmbedded: () => void;
  /** 收拾干净：把容器、样式、`@page` 规则都撤掉。 */
  cleanup: () => void;
}

export interface MountOptions {
  /** 挂在哪儿。默认 `document.body`。 */
  parent?: HTMLElement;
  /** 是不是面板里的那一份（不铺满屏幕）。 */
  embedded?: boolean;
  /** 铺满屏幕时顶上留多少像素给标题栏（拖窗口用）。默认 0。 */
  topInset?: number;
}

/**
 * 把「标题 + 正文」摆成一叠纸。
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
  if (options.topInset) root.style.setProperty("--floral-top-inset", `${options.topInset}px`);

  // `@page` 的边距只能靠注入一条规则来改 —— 它不吃 CSS 变量。
  const pageStyle = document.createElement("style");
  pageStyle.dataset.floral = "pdf-page";
  document.head.append(pageStyle);

  // 量内容用的隐藏容器。必须**在文档里**才量得到（游离节点全是 0）。
  const source = document.createElement("div");
  source.className = "floral-print-source";
  source.style.position = "absolute";
  source.style.left = "-100000px";
  source.style.top = "0";
  source.style.visibility = "hidden";
  source.style.pointerEvents = "none";

  (options.parent ?? document.body).append(root);
  document.body.append(source);

  let pages: PageBox[] = [];
  let didOverflow = false;
  /** 当前这份设置；`update()` 换它，稳下来之后的重排也用它。 */
  let latest = settings;
  let disposed = false;

  const metricsOf = (next: PdfExportSettings): PageMetrics => {
    const { width, height } = paperSizeMm(next.paper, next.landscape);
    return {
      pageWidth: width,
      pageHeight: height,
      margin: {
        top: next.marginMm.top,
        right: next.marginMm.right,
        bottom: next.marginMm.bottom,
        left: next.marginMm.left,
      },
    };
  };

  /** 造一张「纸」：纸面 + 页边距 + 页眉页脚预览，里面放分页器给的内容盒。 */
  const makeSheet = (metrics: PageMetrics, zoom: number): PageBox => {
    const sheet = document.createElement("div");
    sheet.className = FRAME_CLASS;
    sheet.style.width = `${metrics.pageWidth}mm`;
    sheet.style.height = `${metrics.pageHeight}mm`;
    // 页边距是纸上的空白：内容盒靠它定位。打印时这套 padding 会被清掉，
    // 空白改由 `@page` 留（见 PRINT_CSS）。
    sheet.style.padding = `${metrics.margin.top}mm ${metrics.margin.right}mm ${metrics.margin.bottom}mm ${metrics.margin.left}mm`;
    sheet.style.position = "relative";
    sheet.style.overflow = "hidden";
    // ⚠️ 必须显式写：`width: 210mm` + 左右各 20mm 的内边距，在 `content-box` 下就是
    // **250mm 宽**的一「张」纸 —— 比 A4 还宽，打印时会被缩掉或被裁掉。应用里
    // Tailwind 的 preflight 已经把它设成 border-box 了，但这里不能靠环境。
    sheet.style.boxSizing = "border-box";
    // 打印时用它们把纸缩回**内容盒**（见 PRINT_CSS 里那段说明）。
    const contentSize = {
      width: metrics.pageWidth - metrics.margin.left - metrics.margin.right,
      height: metrics.pageHeight - metrics.margin.top - metrics.margin.bottom,
    };
    sheet.style.setProperty("--floral-content-w", `${contentSize.width}mm`);
    sheet.style.setProperty("--floral-content-h", `${contentSize.height}mm`);

    const box = document.createElement("div");
    box.style.width = "100%";
    box.style.height = "100%";
    box.style.overflow = "hidden";
    box.style.display = "flow-root";

    const content = document.createElement("div");
    content.className = "floral-page-content";
    content.style.display = "flow-root";
    if (zoom !== 1) content.style.zoom = String(zoom);
    box.append(content);

    const header = document.createElement("div");
    header.className = "floral-sheet-margin floral-sheet-head";
    const footer = document.createElement("div");
    footer.className = "floral-sheet-margin floral-sheet-foot";

    sheet.append(header, box, footer);
    root.append(sheet);

    // 分页器要的是 `{ box, content }`，`box` 得能报出「有没有溢出」。
    return { box, content };
  };

  /**
   * 重排一遍。
   *
   * 每次都从原始 HTML 重建 —— 分页会把节点**搬走**，第二次不能指着旧的在。
   */
  const render = (next: PdfExportSettings) => {
    root.replaceChildren();
    root.dataset.palette = next.colorMode;

    const metrics = metricsOf(next);
    const { top, right, bottom, left } = next.marginMm;
    // ⚠️ 这里**只写边距**，不写 `size`：纸张与方向已经在打印设置里给了
    //（`PageWidth/PageHeight` + `SetOrientation`）。两处都写就是在互相打架，
    // 而 CSS 那一条还不一定生效（Chromium 要 `preferCSSPageSize` 才认）。
    pageStyle.textContent = `@page { margin: ${top}mm ${right}mm ${bottom}mm ${left}mm; }`;

    // 内容源：标题 + 正文，宽度 = 版心宽。
    source.style.width = `${Math.max(1, metrics.pageWidth - right - left)}mm`;
    source.innerHTML = bodyHtml;
    // 懒加载的图在屏幕外根本不会开始加载（见文件头第 3 条）。
    for (const image of source.querySelectorAll("img")) {
      image.loading = "eager";
      image.removeAttribute("loading");
    }

    const heading = document.createElement("h1");
    heading.className = "floral-print-title";
    heading.textContent = title;
    heading.style.fontSize = `${next.title.sizePt}pt`;
    heading.style.textAlign = next.title.align;
    heading.style.fontWeight = "700";
    heading.style.margin = "0 0 8mm 0";
    heading.style.paddingBottom = next.title.rule ? "3mm" : "0";
    heading.style.borderBottom = next.title.rule
      ? "2px solid var(--color-ink, #333333)"
      : "none";
    heading.style.color = "var(--color-ink, #1a1a1a)";
    source.prepend(heading);

    const result = paginate(source, metrics, {
      zoom: next.scale,
      createPage: (pageMetrics, zoom) => makeSheet(pageMetrics, zoom),
    });
    pages = result.pages;
    didOverflow = result.overflowed;

    // 画上页眉页脚与页码（真打出来时这两行是 WebView2 画的，位置样式只能近似）。
    const sheets = [...root.children] as HTMLElement[];
    sheets.forEach((sheet, index) => {
      const head = sheet.querySelector<HTMLElement>(".floral-sheet-head");
      const foot = sheet.querySelector<HTMLElement>(".floral-sheet-foot");
      // 页眉：只在左上角写标题（Chromium 那条页眉也是这么排的）。
      if (head) {
        head.append(document.createTextNode(next.headerFooter ? next.headerTitle : ""));
      }
      // 页脚：左边页脚文字、右边页码 —— 那个 `1 / 3` 原本在两个地方都出现，看着像印重了。
      if (foot) {
        foot.append(document.createTextNode(next.headerFooter ? next.footerText : ""));
        const number = document.createElement("span");
        number.textContent = next.headerFooter ? `${index + 1} / ${sheets.length}` : "";
        // 页脚文字为空时 `space-between` 会把它顶到左边（只有一个弹性项）——
        // 页码固定在右下角，与打印出来的一致。
        number.style.marginLeft = "auto";
        foot.append(number);
      }
    });
  };

  render(settings);

  /**
   * ⚠️ **量完还得再量一遍**。
   *
   * 第一次 render 时字体可能还没换好、图还没解码 —— 用**替身字体**量出来的行高是错的，
   * 于是分页也错。这一步等字体与图都就位了再排一次，那次才是准的。
   *
   * 实测过：同一份内容，字体就位前后差了**整整一页**（5 → 6）。而 PDF 是按就位后的排版
   * 出的，所以不重排的话预览会比产出少一页。
   */
  const settled = waitForPrintable(root).then(() => {
    if (disposed) return;
    render(latest);
  });

  return {
    element: root,
    settled,
    pageCount: () => Math.max(1, pages.length),
    overflowed: () => didOverflow,
    update: (next) => {
      latest = next;
      render(next);
    },
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
      disposed = true;
      root.remove();
      source.remove();
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
 * 所以等字体、等图、再等两帧 —— 分页已经量过了，这里只是等资源。
 */
export async function waitForPrintable(element: HTMLElement): Promise<void> {
  // 字体：没装好时量出来的行高是错的（分页也跟着错，不过我们已经量完了 —— 真正要紧的
  // 是别把没换好字的那一版印出去）。
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
