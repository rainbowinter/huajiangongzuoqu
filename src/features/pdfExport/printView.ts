/**
 * 导出 / 打印用的那一份 DOM。
 *
 * ## 分页交给浏览器
 *
 * 这里**只管把「标题 + 正文」摆成一份普通文档**，不画纸、不算页、不自己切块。
 * 分页由排版引擎来做 —— 两条出口用的是同一套分页：
 *
 * - **保存为 PDF**：`print_pdf`（WebView2 的 `PrintToPdf`）直接写文件，不弹对话框；
 * - **打印…**：`window.print()`，弹的是 WebView2 自带打印预览。
 *
 * 早先自己算过一套分页（把内容真的摆进固定大小的纸里）。它「预览即产出」，
 * 但遇到「一条列表项里塞着几张图」这种块时只能整块挪页，纸上留下大片空白 ——
 * 用户一眼就看出来了。浏览器按行盒排，能贴得更紧，所以这条路废掉了。
 *
 * ## 几个必须踩准的点
 *
 * 1. **打印色板要钉死**（黑白时）。正文是从预览里抠出来的 HTML，里面全是
 *    `text-ink-soft` 这类 Tailwind 类；黑白档靠 `grayOutTree` 就地换色。
 * 2. **页边距交给 `@page`（打印那条）或后端（`print_pdf`）**，不要用 padding ——
 *    两处都写就是双重边距，一张纸会溢出成两三页。
 * 3. **图片要先把 `loading="lazy"` 摘掉**。屏幕外的图在打印那一刻根本没开始加载，
 *    PDF 里就是一片空白。
 * 4. **文档要挂在 `document.body` 下**：打印 CSS 会把 body 的其它直接子元素
 *    `display: none` 掉，只留下这一份。
 */

import type { PdfExportSettings } from "./settings";
import { paperSizeMm } from "./settings";

/** 容器、正文、标题的类名。打印 CSS 靠它们挑出「留下哪些」。 */
export const PRINT_ROOT_CLASS = "floral-print-root";
const PRINT_DOC_CLASS = "is-print-doc";
const DOC_CLASS = "floral-print-doc";

/**
 * 屏幕上的位置：**扔到视口外**。
 *
 * 这份文档只给打印引擎看，用户不该看见它 —— 预览是拿它生成 PDF 之后再画出来的。
 * 早先它铺满窗口，于是「每改一次设置生成一次预览」都会闪一下白屏。
 *
 * 打印时 `PRINT_CSS` 会把它改回 `static`，屏幕外这一套就都不作数了。
 */
const SCREEN_CSS = `
.${PRINT_ROOT_CLASS} {
  position: absolute;
  top: 0;
  left: -100000px;
  width: 210mm;
  background: var(--color-paper, #ffffff);
}
.${DOC_CLASS} {
  padding: 16mm 18mm;
  background: var(--color-paper, #ffffff);
}
`;

/**
 * 打印时的 CSS。
 *
 * 核心是两件事：**只留下这一份文档**（`display: none` 掉 body 的其它直接子元素 ——
 * 必须用 `display`，`visibility: hidden` 会留着布局空间，前面会多出空白页），
 * 以及**别给文档加内边距**（页边距由 `@page` 或后端给）。
 */
const PRINT_CSS = `
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: transparent !important; }
  body > *:not(.${PRINT_ROOT_CLASS}) { display: none !important; }
  body * { visibility: hidden !important; }
  .${PRINT_ROOT_CLASS}, .${PRINT_ROOT_CLASS} * { visibility: visible !important; }
  .${PRINT_ROOT_CLASS} {
    position: static !important;
    inset: auto !important;
    z-index: auto !important;
    display: block !important;
    /* 屏幕上是 210mm 宽、扔在视口外；打印时要回到页面宽度。 */
    width: auto !important;
    padding: 0 !important;
    overflow: visible !important;
    background: transparent !important;
  }
  .${PRINT_ROOT_CLASS} .${DOC_CLASS} { padding: 0 !important; }
}
`;

const BASE_CSS = `
.${PRINT_ROOT_CLASS} img { max-width: 100%; height: auto; }

/* 预览里那些只在鼠标下才出现的按钮（代码块 / 表格的复制按钮） */
.${PRINT_ROOT_CLASS} button { display: none !important; }

/* 表格跨页时每页都要有列名 */
.${PRINT_ROOT_CLASS} thead { display: table-header-group; }

/*
 * 列表标记画在**列表内容盒的左边**（list-style-position: outside）。正文里的 ul / ol
 * 被重置成 padding-left: 0，标记就只能贴着版心边缘 —— 屏幕上还有个内边距挡着，纸上就
 * 直接顶到纸边了（用户报的「无序列表前面的点超出了边界」）。
 */
.${PRINT_ROOT_CLASS} ul,
.${PRINT_ROOT_CLASS} ol {
  padding-left: 1.4em;
}
`;

/**
 * 一个 CSS 颜色 → **同明度的灰**表达。不想动的返回 `null`。
 *
 * 第一版是按 Rec.709 加权自己算的，**漏了一大类颜色**：应用里到处是 Tailwind 4 的
 * `/透明度` 修饰符，它编译成 `color-mix(in oklab, …)`，而计算样式给出的是
 * `oklab(0.628 0.225 0.126 / 0.7)` —— 根本不是 `rgb(...)`。
 *
 * 改成**让浏览器算**：CSS 相对颜色语法 `oklch(from X l 0 h)` —— 取 X 的感知明度、
 * 彩度压成 0。一行通吃 rgb / hsl / oklab / color(display-p3 …)，alpha 也保留。
 *
 * ⚠️ `transparent` 一动就成了实心黑方块，`currentColor` / `none` 交给它们自己解析。
 */
export function toGrayColor(color: string): string | null {
  const value = color.trim();
  if (!value || value === "transparent" || value === "currentColor" || value === "none") {
    return null;
  }
  return `oklch(from ${value} l 0 h)`;
}

/**
 * 把整棵树的颜色就地换成同明度的灰（只在「黑白」档跑）。
 *
 * **先读完再写**：边读边写会让每一步都触发一次样式重算。
 */
function grayOutTree(root: HTMLElement): void {
  const PROPS = [
    "color",
    "backgroundColor",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
  ] as const;

  const nodes: HTMLElement[] = [root, ...root.querySelectorAll<HTMLElement>("*")];
  const plan: Array<[HTMLElement, string, string]> = [];

  for (const node of nodes) {
    const computed = getComputedStyle(node);
    for (const prop of PROPS) {
      const gray = toGrayColor(computed[prop]);
      if (gray && gray !== computed[prop]) plan.push([node, prop, gray]);
    }
  }

  for (const [node, prop, value] of plan) {
    // `important` 是必须的：语法高亮那些规则带自己的权重，普通内联样式压不住。
    node.style.setProperty(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value, "important");
  }
}

let styleElement: HTMLStyleElement | null = null;

function ensureStyles(): void {
  if (styleElement && styleElement.isConnected) return;
  const style = document.createElement("style");
  style.dataset.floral = "pdf-export";
  style.textContent = `${SCREEN_CSS}\n${PRINT_CSS}\n${BASE_CSS}`;
  document.head.append(style);
  styleElement = style;
}

export interface PrintDocument {
  element: HTMLElement;
  cleanup: () => void;
}

export interface PrintDocumentOptions {
  /**
   * 写 `@page { size }`。**只给 `window.print()` 那条用**：它的纸张默认取打印机自己的，
   * 不写的话面板里选的 B4 到了预览里会变成默认的 A4。
   *
   * `print_pdf` 那条**必须为 false** —— 纸张与方向是后端通过 COM 设的，两处都写会打架，
   * 而 CSS 那一条还不一定生效（Chromium 要 `preferCSSPageSize` 才认）。
   */
  cssPageSize?: boolean;
  /**
   * 用 CSS `zoom` 实现设置里的「缩放」。**只给 `window.print()` 那条用** ——
   * `print_pdf` 那条后端已经 `SetScaleFactor` 了，再乘一遍就是双重缩放。
   */
  cssScale?: boolean;
}

/**
 * 造一份**不分页**的打印文档。
 *
 * `bodyHtml` 是**已经渲染好的 HTML**（预览区抠出来的，或 `markdownToHtml` 转出来的）。
 */
export function mountPrintDocument(
  title: string,
  bodyHtml: string,
  settings: PdfExportSettings,
  options: PrintDocumentOptions = {},
): PrintDocument {
  ensureStyles();

  const root = document.createElement("div");
  root.className = `${PRINT_ROOT_CLASS} ${PRINT_DOC_CLASS}`;

  const body = document.createElement("div");
  body.className = DOC_CLASS;
  body.innerHTML = bodyHtml;
  if (options.cssScale && settings.scale !== 1) {
    body.style.zoom = String(settings.scale);
  }

  const heading = document.createElement("h1");
  heading.className = "floral-print-title";
  heading.textContent = title;
  heading.style.fontSize = `${settings.title.sizePt}pt`;
  heading.style.textAlign = settings.title.align;
  heading.style.fontWeight = "700";
  heading.style.margin = "0 0 8mm 0";
  heading.style.paddingBottom = settings.title.rule ? "3mm" : "0";
  heading.style.borderBottom = settings.title.rule
    ? "2px solid var(--color-ink, #333333)"
    : "none";
  heading.style.color = "var(--color-ink, #1a1a1a)";
  body.prepend(heading);

  root.append(body);
  document.body.append(root);

  /*
   * `@page`：**边距两条路都写**（老版本就是这么干的，实测没有和后端那份叠加成双倍）；
   * `size` 只有打印预览那条写 —— 保存那条的纸张是后端通过 COM 设的，两处都写会打架，
   * 而 CSS 那一条还不一定生效（Chromium 要 `preferCSSPageSize` 才认）。
   */
  const { top, right, bottom, left } = settings.marginMm;
  let pageRule = `@page { margin: ${top}mm ${right}mm ${bottom}mm ${left}mm;`;
  if (options.cssPageSize) {
    const { width, height } = paperSizeMm(settings.paper, settings.landscape);
    pageRule += ` size: ${width}mm ${height}mm;`;
  }
  const pageStyle = document.createElement("style");
  pageStyle.dataset.floral = "pdf-page";
  pageStyle.textContent = pageRule + " }";
  document.head.append(pageStyle);

  // 懒加载的图在屏幕外不会开始加载 —— 打印那一刻它们还没开始，PDF 里就是空白。
  for (const image of root.querySelectorAll("img")) {
    image.loading = "eager";
    image.removeAttribute("loading");
  }

  // 黑白档：把整棵树的颜色就地换成同明度的灰（见 `grayOutTree`）。
  if (settings.colorMode === "mono") {
    grayOutTree(root);
    /*
     * ⚠️ **图片也得去色**。`grayOutTree` 只改 CSS 颜色，管不到位图 —— 笔记里的谱图、
     * 散点图本身就是彩色的，不处理的话「黑白」印出来还是花的（实测整页非灰像素
     * 1.14%，全都落在图上）。
     *
     * 这里可以放心用 `filter: grayscale(1)`：它**只加在 `<img>` 上**，位图本来就是位图，
     * 不会像加在整棵树上那样把整页栅格化（那时文件会暴涨 20 倍，见 `Docs/pdf-export.md`）。
     */
    for (const image of root.querySelectorAll("img")) {
      image.style.filter = "grayscale(1)";
    }
  }

  return {
    element: root,
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
 * 等这一份真的**画得出来**了再打印。
 *
 * 打印机拿到的是某一瞬间的排版：字体还没换好、图还没解码，印出来的就是错版。
 * 所以等字体、等图、再等两帧。
 */
export async function waitForPrintable(element: HTMLElement): Promise<void> {
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
