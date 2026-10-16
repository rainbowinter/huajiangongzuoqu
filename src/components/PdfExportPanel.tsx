import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "../features/notes/api";
import {
  mountPrintView,
  waitForPrintable,
  type PrintView,
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
import { printPdf, printWithSystemDialog } from "../features/pdfExport/api";
import { showToast } from "./Toast";

/**
 * 「导出 PDF」那个界面。
 *
 * 左边是**真的会打出来的那一份**（同一份 DOM，见 `features/pdfExport/printView.ts`），
 * 右边是设置。做完就两条路：保存为 PDF（后端 WebView2 直接写文件）或交给系统打印对话框。
 *
 * ⚠️ 打印之前要把预览挪出面板（`view.toSheet()`）。预览框是 `overflow: auto` 的，
 * 不挪走的话长文档只会打出被裁掉的第一屏 —— 这条踩过，注释留在 `printView.ts` 里。
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
  /** 分页结果：给用户看「共几页」，以及「有块切不开」的提醒。 */
  const [pageInfo, setPageInfo] = useState({ pages: 1, overflowed: false });
  /**
   * 预览的缩放（只影响**眼睛**，不影响产出）。
   *
   * 与设置里的「缩放」是两回事：那个是打印出来的字号，这个纯粹是把纸拉近拉远看细节。
   * Ctrl + 滚轮调它 —— 和浏览器/编辑器里的习惯一致。
   */
  const [previewZoom, setPreviewZoom] = useState(1);

  const previewRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<PrintView | null>(null);

  // 摆一次纸，之后改设置只是就地重排。
  useEffect(() => {
    const parent = previewRef.current;
    if (!parent) return;
    const view = mountPrintView(title, bodyHtml, settings, {
      parent,
      embedded: true,
      topInset,
    });
    viewRef.current = view;
    return () => {
      view.cleanup();
      viewRef.current = null;
    };
    // 只在开面板时摆一次：`settings` 的后续变化走下面那个 effect 的 `update`。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, bodyHtml, topInset]);

  /**
   * 设置一变就重排。
   *
   * **要防抖**：拖一下边距数字、点两下缩放，每次重排都要把整篇 HTML 重新解析 + 逐块测量，
   * 长文档上那就是几百毫秒一次的卡顿。150ms 足够让人「停下来」。
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const view = viewRef.current;
      if (!view) return;
      view.update(settings);
      setPageInfo({ pages: view.pageCount(), overflowed: view.overflowed() });
      savePdfSettings(settings);
    }, 150);
    return () => clearTimeout(timer);
  }, [settings]);

  // 第一次量完还会在「字体与图就位」之后再量一遍（见 printView 的说明），页数可能变，
  // 所以延迟再读一次。
  useEffect(() => {
    const read = () => {
      const view = viewRef.current;
      if (view) setPageInfo({ pages: view.pageCount(), overflowed: view.overflowed() });
    };
    read();
    const timer = setTimeout(read, 1200);
    void viewRef.current?.settled.then(read);
    return () => clearTimeout(timer);
  }, []);

  const patch = useCallback((next: Partial<PdfExportSettings>) => {
    setSettings((current) => normalizePdfSettings({ ...current, ...next }));
  }, []);

  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    setBusy(true);
    let moved = false;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: pdfFileName(title),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof path !== "string") return;

      // 到这里才动 DOM：用户取消对话框的话，界面不该有任何变化。
      view.toSheet();
      moved = true;
      // 等那一次「字体就位后的重排」落地，不然印出来的可能是用替身字体量的那一版。
      await view.settled;
      await waitForPrintable(view.element);
      await printPdf(path, settings);
      showToast(t("pdfExport.saved", { path, defaultValue: "已保存到 {{path}}" }));
      onClose();
    } catch (error) {
      showToast(
        t("pdfExport.failed", {
          message: getErrorMessage(error),
          defaultValue: "导出失败：{{message}}",
        }),
      );
      // 失败了就把纸放回面板里 —— 那张铺满屏幕的纸会让用户以为界面卡死了。
      if (moved) view.toEmbedded();
    } finally {
      setBusy(false);
    }
  }, [onClose, settings, t, title]);

  const handleSystemPrinter = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    setBusy(true);
    try {
      view.toSheet();
      await view.settled;
      await waitForPrintable(view.element);
      // 先把纸摆好再弹系统对话框：那个对话框是**真的窗口**，点打印时读的就是此刻的页面。
      try {
        await printWithSystemDialog();
      } catch (error) {
        // 拿不到原生命令（老系统 / 非 Windows）就退回浏览器自带那条 —— 至少还能打。
        console.warn("[pdf-export] 系统打印对话框打不开，退回 window.print()", error);
        window.print();
      }
      view.toEmbedded();
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Ctrl + 滚轮缩放预览。
   *
   * ⚠️ 必须用**原生**监听 + `{ passive: false }`：React 的 `onWheel` 挂在被动监听上，
   * 里面 `preventDefault()` 是无效的 —— 结果是既缩放了预览、又把整个 WebView 的页面
   * 缩放也一起改了。
   */
  useEffect(() => {
    const node = previewRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setPreviewZoom((current) => Math.min(2, Math.max(0.4, current * factor)));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

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
          onClick={() => void handleSystemPrinter()}
          className="px-3 h-7 rounded-lg text-[11px] text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
        >
          {t("pdfExport.systemPrinter", { defaultValue: "用系统打印机…" })}
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
                {t("pdfExport.colorAsIs", { defaultValue: "原样" })}
              </Choice>
              <Choice active={settings.colorMode === "light"} onClick={() => patch({ colorMode: "light" })}>
                {t("pdfExport.colorLight", { defaultValue: "白底" })}
              </Choice>
              <Choice active={settings.colorMode === "mono"} onClick={() => patch({ colorMode: "mono" })}>
                {t("pdfExport.colorMono", { defaultValue: "黑白" })}
              </Choice>
            </div>
            <p className="text-[10px] text-ink-ghost leading-relaxed mt-1">
              {t("pdfExport.colorHint", {
                defaultValue: "「原样」= 现在看到什么就打什么（跟着主题，深色主题就是深色纸）",
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

        <div className="flex-1 min-w-0 flex flex-col">
          <div
            ref={previewRef}
            className="flex-1 min-h-0 overflow-auto bg-[#6f6d68] p-6"
            style={{ zoom: previewZoom }}
          />
        </div>
      </div>

      {/* 底部状态条：像正文下面那条一样，别让预览直接怼到窗口边上。 */}
      <div className="flex items-center gap-3 h-7 px-4 shrink-0 bg-cloud/95 border-t border-paper-deep/50 text-[10px] text-ink-ghost">
        <span>
          {t("pdfExport.pageCount", { count: pageInfo.pages, defaultValue: "共 {{count}} 页" })}
        </span>
        <button
          type="button"
          onClick={() => setPreviewZoom(1)}
          title={t("pdfExport.zoomHint", { defaultValue: "Ctrl + 滚轮缩放预览，点一下复位" })}
          className="cursor-pointer hover:text-ink-soft tabular-nums"
        >
          {Math.round(previewZoom * 100)}%
        </button>
        <span className="flex-1" />
        {pageInfo.overflowed ? (
          <span className="text-rust">
            {t("pdfExport.overflowed", { defaultValue: "有内容超出一页" })}
          </span>
        ) : null}
        <span className="opacity-70">
          {t("pdfExport.previewNote", {
            defaultValue: "预览就是产出的样子；改设置会立刻重排。",
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
