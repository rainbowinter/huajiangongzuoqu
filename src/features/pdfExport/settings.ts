/**
 * 导出 PDF 的设置。
 *
 * 分为两类：
 * - **交给 Chromium 的**（页眉页脚、缩放、纸张、边距、方向、背景色）—— 这几项在
 *   `ICoreWebView2PrintSettings` 上有对应的开关，原样递过去就行；
 * - **只有我们自己用的**（标题样式、配色）—— 它们是**页面长什么样**的一部分，
 *   在打印之前就把 DOM 摆好即可（见 `printView.ts` 里那三档配色）。
 *
 * ⚠️ 递出去那一份的字段名必须与 Rust 的 `PdfPrintSettings` 一一对应
 * （那边 `rename_all = "camelCase"`），改一边就得改另一边。
 */

export type PaperId = "a4" | "a5" | "letter";

/** 纸张尺寸（英寸）—— WebView2 的 `SetPageWidth/Height` 收的就是英寸。 */
export const PAPERS: Record<PaperId, { label: string; width: number; height: number }> = {
  a4: { label: "A4", width: 8.27, height: 11.69 },
  a5: { label: "A5", width: 5.83, height: 8.27 },
  letter: { label: "Letter", width: 8.5, height: 11 },
};

/** 纸张按毫米报给界面（预览要按 mm 排版）。1 英寸 = 25.4 毫米。 */
export function paperSizeMm(paper: PaperId, landscape: boolean): { width: number; height: number } {
  const size = PAPERS[paper];
  const width = size.width * 25.4;
  const height = size.height * 25.4;
  return landscape ? { width: height, height: width } : { width, height };
}

export type PdfColorMode = "as-is" | "light" | "mono";

export interface PdfTitleStyle {
  /** 标题字号（磅）。 */
  sizePt: number;
  align: "left" | "center";
  /** 标题下面那条横线 —— 原来导出就有，做成可以关。 */
  rule: boolean;
}

export interface PdfExportSettings {
  /** 打不打印页眉页脚那一行。 */
  headerFooter: boolean;
  /** 页眉文字（默认笔记标题）。 */
  headerTitle: string;
  /** 页脚文字（默认空；页码由 Chromium 自己画，改不了）。 */
  footerText: string;
  /** 缩放倍数，1 = 100%。 */
  scale: number;
  paper: PaperId;
  landscape: boolean;
  marginMm: { top: number; right: number; bottom: number; left: number };
  /** 打印背景色 / 底纹。关掉的话表格底色、代码块底色都没了。 */
  backgrounds: boolean;
  /**
   * 用什么配色打。
   *
   * - `as-is`：**当前渲染成什么样就打什么样** —— 跟随应用主题（深色主题就是深色纸）、
   *   笔记自己的表格底色与文字颜色原样保留。默认这一档。
   * - `light`：把色板钉成浅色（白纸深字）。深色主题下想把笔记打成浅色纸时用。
   * - `mono`：浅色纸 + 文字全压成灰，语法高亮那些彩色一起压平。
   */
  colorMode: PdfColorMode;
  title: PdfTitleStyle;
}

export const DEFAULT_PDF_SETTINGS: PdfExportSettings = {
  headerFooter: true,
  headerTitle: "",
  footerText: "",
  scale: 1,
  paper: "a4",
  landscape: false,
  // 上下 18mm、左右 20mm 是原来那套打印样式的值，先照搬当默认。
  marginMm: { top: 18, right: 20, bottom: 18, left: 20 },
  backgrounds: true,
  colorMode: "as-is",
  title: { sizePt: 22, align: "left", rule: true },
};

/** 缩放的可选档位（百分比）。 */
export const SCALE_CHOICES = [0.6, 0.8, 1, 1.2, 1.5, 2];

const INCH = 25.4;

/** 换算成 Rust 那份 `PdfPrintSettings` 要的形状。 */
export function toPrintSettings(settings: PdfExportSettings) {
  const paper = PAPERS[settings.paper];
  return {
    headerFooter: settings.headerFooter,
    headerTitle: settings.headerTitle,
    footerText: settings.footerText,
    scale: settings.scale,
    pageWidth: paper.width,
    pageHeight: paper.height,
    marginTop: settings.marginMm.top / INCH,
    marginBottom: settings.marginMm.bottom / INCH,
    marginLeft: settings.marginMm.left / INCH,
    marginRight: settings.marginMm.right / INCH,
    landscape: settings.landscape,
    backgrounds: settings.backgrounds,
  };
}

/**
 * 从 `localStorage` 读回上次的设置。
 *
 * 逐项校验而不是整份信：设置是**用户手边的东西**，某个字段坏了（旧版本留下的、
 * 手改过的）不该让整份设置回落到默认 —— 那样用户会以为自己没保存成功。
 */
export function loadPdfSettings(): PdfExportSettings {
  try {
    const raw = localStorage.getItem("floral.pdfExport.settings");
    if (!raw) return { ...DEFAULT_PDF_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<PdfExportSettings>;
    return normalizePdfSettings(parsed);
  } catch {
    return { ...DEFAULT_PDF_SETTINGS };
  }
}

export function savePdfSettings(settings: PdfExportSettings): void {
  try {
    localStorage.setItem("floral.pdfExport.settings", JSON.stringify(settings));
  } catch {
    // 存不下就算了（隐私模式、配额满）—— 不该因为记不住设置就让导出失败。
  }
}

/** 逐项挑选 + clamp。导出的东西最终会变成打印参数，不能让 NaN / 负数混进去。 */
export function normalizePdfSettings(raw: Partial<PdfExportSettings>): PdfExportSettings {
  const defaults = DEFAULT_PDF_SETTINGS;
  const paper: PaperId =
    raw.paper && raw.paper in PAPERS ? (raw.paper as PaperId) : defaults.paper;
  const margin = raw.marginMm ?? defaults.marginMm;
  const title = raw.title ?? defaults.title;

  return {
    headerFooter: typeof raw.headerFooter === "boolean" ? raw.headerFooter : defaults.headerFooter,
    headerTitle: typeof raw.headerTitle === "string" ? raw.headerTitle : defaults.headerTitle,
    footerText: typeof raw.footerText === "string" ? raw.footerText : defaults.footerText,
    scale: clampNumber(raw.scale, 0.1, 2, defaults.scale),
    paper,
    landscape: typeof raw.landscape === "boolean" ? raw.landscape : defaults.landscape,
    marginMm: {
      top: clampNumber(margin.top, 0, 60, defaults.marginMm.top),
      right: clampNumber(margin.right, 0, 60, defaults.marginMm.right),
      bottom: clampNumber(margin.bottom, 0, 60, defaults.marginMm.bottom),
      left: clampNumber(margin.left, 0, 60, defaults.marginMm.left),
    },
    backgrounds: typeof raw.backgrounds === "boolean" ? raw.backgrounds : defaults.backgrounds,
    colorMode:
      raw.colorMode === "light" || raw.colorMode === "mono" || raw.colorMode === "as-is"
        ? raw.colorMode
        : defaults.colorMode,
    title: {
      sizePt: clampNumber(title.sizePt, 8, 48, defaults.title.sizePt),
      align: title.align === "center" ? "center" : "left",
      rule: typeof title.rule === "boolean" ? title.rule : defaults.title.rule,
    },
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 把标题变成能当文件名用的样子。空标题有兜底，路径分隔符必须去掉。 */
export function pdfFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 80);
  return `${cleaned || "未命名笔记"}.pdf`;
}
