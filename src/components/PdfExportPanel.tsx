import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "../features/notes/api";
import {
  mountPrintDocument,
  waitForPrintable,
  type PrintDocument,
} from "../features/pdfExport/printView";
import {
  PAPERS,
  SCALE_CHOICES,
  loadPdfSettings,
  normalizePdfSettings,
  pdfFileName,
  savePdfSettings,
  type PaperId,
  type PdfExportSettings,
} from "../features/pdfExport/settings";
import { printPdf, printPdfPreview, printWithSystemDialog } from "../features/pdfExport/api";
import { PdfPreview } from "./PdfPreview";
import { showToast } from "./Toast";

/**
 * 「导出 PDF」那个界面：**左边设置，右边预览**。
 *
 * ## 预览是谁排的版
 *
 * 右边画的**不是**我们自己画的近似图，而是后端刚用 `PrintToPdf` 排出来的那份 **PDF**
 *（`print_pdf_preview` 把字节直接还回来，前端用 pdf.js 画）。参数与「保存为 PDF」
 * 完全一致，所以**预览就是产出** —— 页数、断点、表格在哪里切，全由浏览器说了算。
 *
 * 早先自己算过分页（把内容摆进固定大小的纸里）。遇到「一条列表项里塞着几张图」时它只能
 * 整块挪页，纸上留大片空白 —— 那正是浏览器排得好的地方，所以那一套已经废掉了。
 *
 * ## 两条出口
 *
 * - **保存为 PDF**：`print_pdf` 直接写文件（不弹对话框，产出是真文字）；
 * - **打印…**：`window.print()` 弹浏览器自带的打印预览（纸、缩放、背景都能调）。
 */

interface PdfExportPanelProps {
  title: string;
  /** 已经渲染好的正文 HTML（预览区抠出来的，或 Markdown 转的）。 */
  bodyHtml: string;
  onClose: () => void;
  /**
   * 顶上给标题栏让出多少像素（默认 44 = 主窗口的 `h-11`）。
   *
   * ⚠️ **必须让**：主窗口是 `decorations: false`，那一条就是**拖拽窗口的手柄**。
   * 面板铺满整个窗口的话，标题栏被盖住 —— 用户的第一反应是「窗口拖不动了」。
   * （踩过。）
   */
  topInset?: number;
}

export function PdfExportPanel({ title, bodyHtml, onClose, topInset = 44 }: PdfExportPanelProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PdfExportSettings>(() => {
    const remembered = loadPdfSettings();
    // 页眉默认写笔记标题 —— 但用户改过就尊重他改的，别每次都盖回去。
    return remembered.headerTitle
      ? remembered
      : { ...remembered, headerTitle: title };
  });
  const [busy, setBusy] = useState(false);
  /** 预览用的 PDF 字节；`null` = 第一版还在生成。 */
  const [previewBytes, setPreviewBytes] = useState<ArrayBuffer | null>(null);
  const [previewPages, setPreviewPages] = useState(0);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    savePdfSettings(settings);
  }, [settings]);

  /**
   * 同一时刻**只能有一份打印文档**挂在页面上。
   *
   * `PrintToPdf` 印的是**整个 webview**，而打印 CSS 只留下 `.floral-print-root` 那一层。
   * 两份文档同时挂上去的话，两边都会被印进同一份 PDF —— 所以预览、保存、打印全部排进
   * 同一个队列，一次只跑一个。
   */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const runExclusive = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(task, task);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  /** 最新的那一次预览请求；旧的排队任务看到编号变了就直接放弃。 */
  const jobRef = useRef(0);

  /**
   * 系统打印对话框弹出来之后**留在页面上的**那份文档。
   *
   * `ShowPrintUI` 弹出来就返回，真正的打印要等用户确认 —— 这期间文档必须还在。
   * 它会在下一次「要挂新文档」时（生成预览、保存）被收掉，面板关闭时也收掉。
   */
  const printDocRef = useRef<PrintDocument | null>(null);

  /** 在一份临时文档上跑一次打印动作，跑完立刻收拾干净。 */
  const withPrintDocument = useCallback(
    async (options: { cssPageSize: boolean; cssScale: boolean }, task: (doc: PrintDocument) => Promise<void>) => {
      // 上一次系统打印留下的那份还在 —— 不清掉的话两份会一起被印进同一份 PDF。
      printDocRef.current?.cleanup();
      printDocRef.current = null;

      const doc = mountPrintDocument(title, bodyHtml, settings, options);
      try {
        await waitForPrintable(doc.element);
        await task(doc);
      } finally {
        doc.cleanup();
      }
    },
    [bodyHtml, settings, title],
  );

  // 面板关掉时把可能还挂着的那份系统打印文档收掉。
  useEffect(() => {
    return () => {
      printDocRef.current?.cleanup();
      printDocRef.current = null;
    };
  }, []);

  /**
   * 设置一变就重新生成预览（防抖 400ms）。
   *
   * 生成一版要走一次完整的 `PrintToPdf`，所以**不能**在每次按键时都跑；旧的预览留在
   * 屏幕上，新的好了再换，界面不闪白。
   */
  useEffect(() => {
    const job = ++jobRef.current;
    const timer = setTimeout(() => {
      void runExclusive(async () => {
        // 更晚的设置已经排队了 —— 这一版不用跑。
        if (job !== jobRef.current) return;
        setPreviewing(true);
        try {
          const bytes = await (async () => {
            let result: ArrayBuffer | null = null;
            await withPrintDocument({ cssPageSize: false, cssScale: false }, async () => {
              result = await printPdfPreview(settings);
            });
            return result as ArrayBuffer | null;
          })();
          if (job === jobRef.current && bytes) setPreviewBytes(bytes);
        } catch (error) {
          if (job === jobRef.current) {
            showToast(
              t("pdfExport.previewFailed", {
                message: getErrorMessage(error),
                defaultValue: "预览生成失败：{{message}}",
              }),
            );
          }
        } finally {
          if (job === jobRef.current) setPreviewing(false);
        }
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [runExclusive, settings, t, withPrintDocument]);

  const patch = useCallback((next: Partial<PdfExportSettings>) => {
    setSettings((current) => normalizePdfSettings({ ...current, ...next }));
  }, []);

  /** 「保存为 PDF」：问路径 → 造一份不分页文档 → 让后端 `PrintToPdf` 写文件。 */
  const handleSave = useCallback(async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: pdfFileName(title),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof path !== "string") return;

    setBusy(true);
    try {
      await runExclusive(() =>
        // 纸张、边距、缩放都由后端通过 COM 设，CSS 里不再写一遍。
        withPrintDocument({ cssPageSize: false, cssScale: false }, async () => {
          await printPdf(path, settings);
        }),
      );
      showToast(t("pdfExport.saved", { path, defaultValue: "已保存到 {{path}}" }));
      onClose();
    } catch (error) {
      showToast(
        t("pdfExport.failed", {
          message: getErrorMessage(error),
          defaultValue: "导出失败：{{message}}",
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [onClose, runExclusive, settings, t, title, withPrintDocument]);

  /**
   * 「打印…」——**系统打印对话框**（Windows 自己那个），接上打印机就能直接打。
   *
   * 纸张、份数这些由对话框与打印机首选项说了算，所以这边**不写 `@page size`**；
   * 「缩放」仍然用 CSS `zoom`（系统对话框里没有这一项）。
   *
   * ⚠️ `ShowPrintUI` **弹出来就返回**，真正的打印要等用户点确认 —— 文档不能在这时候
   * 拆掉，所以这里不 cleanup，交给 `printDocRef` 管着。
   */
  const handlePrint = useCallback(async () => {
    setBusy(true);
    try {
      await runExclusive(async () => {
        printDocRef.current?.cleanup();
        printDocRef.current = null;

        const doc = mountPrintDocument(title, bodyHtml, settings, {
          cssPageSize: false,
          cssScale: true,
        });
        try {
          await waitForPrintable(doc.element);
          await printWithSystemDialog();
        } catch (error) {
          doc.cleanup();
          throw error;
        }
        printDocRef.current = doc;
      });
    } catch (error) {
      showToast(
        t("pdfExport.failed", {
          message: getErrorMessage(error),
          defaultValue: "导出失败：{{message}}",
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [bodyHtml, runExclusive, settings, t, title]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="fixed left-0 right-0 bottom-0 z-[9500] flex flex-col bg-ink/25 backdrop-blur-[2px]"
      style={{ top: topInset }}
    >
      <div className="flex items-center gap-3 h-12 px-4 shrink-0 bg-cloud/95 border-b border-paper-deep/50">
        <span className="text-[13px] text-ink">{t("pdfExport.title", { defaultValue: "导出 PDF" })}</span>
        <span className="text-[11px] text-ink-ghost truncate">{title}</span>
        <span className="flex-1" />
        <span className="text-[11px] text-ink-ghost">
          {busy ? t("pdfExport.saving", { defaultValue: "正在生成…" }) : ""}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="px-3 h-7 rounded-lg text-[11px] text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
        >
          {t("common.cancel", { defaultValue: "取消" })}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handlePrint()}
          className="px-3 h-7 rounded-lg text-[11px] text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
        >
          {t("pdfExport.systemPrinter", { defaultValue: "打印…" })}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleSave()}
          className="px-3 h-7 rounded-lg text-[11px] text-bamboo bg-bamboo-mist/50 hover:bg-bamboo-mist transition-colors cursor-pointer disabled:opacity-40"
        >
          {t("pdfExport.save", { defaultValue: "保存为 PDF" })}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 设置在**左**边（用户的习惯），预览在右。 */}
        <aside className="w-[252px] shrink-0 overflow-y-auto bg-cloud/95 border-r border-paper-deep/50 px-4 py-3">
          <Section title={t("pdfExport.scale", { defaultValue: "缩放" })}>
            <div className="flex flex-wrap items-center gap-1">
              {SCALE_CHOICES.map((choice) => (
                <Choice
                  key={choice}
                  active={settings.scale === choice}
                  onClick={() => patch({ scale: choice })}
                >
                  {Math.round(choice * 100)}%
                </Choice>
              ))}
              {/* 自定义：直接填百分比。用输入框是为了能填 85 这种值 —— 档位不可能穷举。 */}
              <span className="inline-flex items-center gap-0.5 ml-0.5">
                <NumberInput
                  value={Math.round(settings.scale * 100)}
                  width="w-12"
                  onChange={(percent) => patch({ scale: percent / 100 })}
                />
                <span className="text-[10px] text-ink-ghost">%</span>
              </span>
            </div>
          </Section>

          <Section title={t("pdfExport.paper", { defaultValue: "纸张" })}>
            <div className="flex flex-wrap gap-1">
              {(Object.keys(PAPERS) as PaperId[]).map((id) => (
                <Choice
                  key={id}
                  active={settings.paper === id}
                  onClick={() => patch({ paper: id })}
                >
                  {PAPERS[id].label}
                </Choice>
              ))}
              <Choice
                active={settings.landscape}
                onClick={() => patch({ landscape: !settings.landscape })}
              >
                {t("pdfExport.landscape", { defaultValue: "横向" })}
              </Choice>
            </div>
          </Section>

          <Section title={t("pdfExport.margins", { defaultValue: "页边距（毫米）" })}>
            <div className="grid grid-cols-4 gap-1">
              <MarginInput
                label={t("pdfExport.marginTop", { defaultValue: "上" })}
                value={settings.marginMm.top}
                onChange={(top) => patch({ marginMm: { ...settings.marginMm, top } })}
              />
              <MarginInput
                label={t("pdfExport.marginRight", { defaultValue: "右" })}
                value={settings.marginMm.right}
                onChange={(right) => patch({ marginMm: { ...settings.marginMm, right } })}
              />
              <MarginInput
                label={t("pdfExport.marginBottom", { defaultValue: "下" })}
                value={settings.marginMm.bottom}
                onChange={(bottom) => patch({ marginMm: { ...settings.marginMm, bottom } })}
              />
              <MarginInput
                label={t("pdfExport.marginLeft", { defaultValue: "左" })}
                value={settings.marginMm.left}
                onChange={(left) => patch({ marginMm: { ...settings.marginMm, left } })}
              />
            </div>
          </Section>

          <Section title={t("pdfExport.headerFooter", { defaultValue: "页眉页脚" })}>
            <Toggle
              checked={settings.headerFooter}
              onChange={(headerFooter) => patch({ headerFooter })}
              label={t("pdfExport.headerFooter", { defaultValue: "页眉页脚" })}
            />
            <p className="text-[10px] text-ink-ghost leading-relaxed mt-1">
              {t("pdfExport.headerHint", {
                defaultValue: "页眉写标题、页脚带页码；页码由浏览器绘制，文案改不了",
              })}
            </p>
            <div className="mt-2 space-y-1">
              <TextInput
                placeholder={t("pdfExport.headerText", { defaultValue: "页眉文字" })}
                value={settings.headerTitle}
                onChange={(headerTitle) => patch({ headerTitle })}
              />
              <TextInput
                placeholder={t("pdfExport.footerText", { defaultValue: "页脚文字" })}
                value={settings.footerText}
                onChange={(footerText) => patch({ footerText })}
              />
            </div>
          </Section>

          <Section title={t("pdfExport.titleStyle", { defaultValue: "标题" })}>
            <div className="flex items-center gap-1">
              <NumberInput
                value={settings.title.sizePt}
                suffix="pt"
                onChange={(sizePt) => patch({ title: { ...settings.title, sizePt } })}
              />
              <Choice
                active={settings.title.align === "left"}
                onClick={() => patch({ title: { ...settings.title, align: "left" } })}
              >
                {t("pdfExport.alignLeft", { defaultValue: "左" })}
              </Choice>
              <Choice
                active={settings.title.align === "center"}
                onClick={() => patch({ title: { ...settings.title, align: "center" } })}
              >
                {t("pdfExport.alignCenter", { defaultValue: "居中" })}
              </Choice>
            </div>
            <div className="mt-2">
              <Toggle
                checked={settings.title.rule}
                onChange={(rule) => patch({ title: { ...settings.title, rule } })}
                label={t("pdfExport.titleRule", { defaultValue: "标题下加一条横线" })}
              />
            </div>
          </Section>

          <Section title={t("pdfExport.color", { defaultValue: "颜色" })}>
            <div className="flex gap-1">
              <Choice active={settings.colorMode === "as-is"} onClick={() => patch({ colorMode: "as-is" })}>
                {t("pdfExport.colorAsIs", { defaultValue: "彩色" })}
              </Choice>
              <Choice active={settings.colorMode === "mono"} onClick={() => patch({ colorMode: "mono" })}>
                {t("pdfExport.colorMono", { defaultValue: "黑白" })}
              </Choice>
            </div>
            <p className="text-[10px] text-ink-ghost leading-relaxed mt-1">
              {t("pdfExport.colorHint", {
                defaultValue:
                  "彩色 = 界面上什么样就印什么样（含你在样式目录里改的底色与配色）；黑白 = 全保持明度，只去掉颜色",
              })}
            </p>
            <div className="mt-2">
              <Toggle
                checked={settings.backgrounds}
                onChange={(backgrounds) => patch({ backgrounds })}
                label={t("pdfExport.backgrounds", { defaultValue: "打印背景色" })}
              />
              <p className="text-[10px] text-ink-ghost leading-relaxed mt-1">
                {t("pdfExport.backgroundsHint", {
                  defaultValue: "关掉之后代码块与表头会变成一片白",
                })}
              </p>
            </div>
          </Section>
        </aside>

        {/* 预览：画的是后端刚生成的那份 PDF，也就是「保存为 PDF」会写出来的样子。 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <PdfPreview
            bytes={previewBytes}
            onPages={setPreviewPages}
            generating={previewing}
            emptyText={t("pdfExport.previewGenerating", { defaultValue: "正在生成预览…" })}
          />
        </div>
      </div>

      <div className="flex items-center gap-3 h-7 px-4 shrink-0 bg-cloud/95 border-t border-paper-deep/50 text-[10px] text-ink-ghost">
        <span>
          {t("pdfExport.pageCount", { count: previewPages, defaultValue: "共 {{count}} 页" })}
        </span>
        <span className="flex-1" />
        <span className="opacity-70">
          {previewing
            ? t("pdfExport.previewGenerating", { defaultValue: "正在生成预览…" })
            : t("pdfExport.previewNote", {
                defaultValue: "预览由浏览器排版生成，与导出的 PDF 逐页一致。",
              })}
        </span>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="py-2 border-b border-paper-deep/30 last:border-b-0">
      <h4 className="text-[11px] text-ink-soft mb-1.5">{title}</h4>
      {children}
    </section>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-6 px-2 rounded text-[11px] transition-colors cursor-pointer ${
        active ? "text-bamboo bg-bamboo-mist/60" : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/40"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-ink-soft cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-[var(--color-bamboo)]"
      />
      {label}
    </label>
  );
}

function MarginInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] text-ink-ghost text-center">{label}</span>
      <NumberInput value={value} onChange={onChange} />
    </label>
  );
}

function NumberInput({
  value,
  suffix,
  width,
  onChange,
}: {
  value: number;
  suffix?: string;
  /** 覆盖输入框宽度（默认铺满所在的那一格）。 */
  width?: string;
  onChange: (value: number) => void;
}) {
  // 数字框里打字时会有「空串」「半个数字」这种中间态，直接回写会被 clamp 打断输入。
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className="relative inline-flex items-center">
      <input
        type="text"
        inputMode="numeric"
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const parsed = Number.parseFloat(draft ?? "");
          setDraft(null);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={`h-6 rounded bg-paper-warm px-1.5 text-center text-[11px] text-ink-soft tabular-nums focus:outline-none focus:ring-1 focus:ring-bamboo/40 ${width ?? "w-full"}`}
      />
      {suffix ? (
        <span className="absolute right-1 text-[9px] text-ink-ghost pointer-events-none">
          {suffix}
        </span>
      ) : null}
    </span>
  );
}

function TextInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="w-full h-6 rounded bg-paper-warm px-2 text-[11px] text-ink-soft placeholder:text-ink-ghost/70 focus:outline-none focus:ring-1 focus:ring-bamboo/40"
    />
  );
}
