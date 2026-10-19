import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * 导出面板右侧的预览。
 *
 * 画的是**后端刚生成的那份 PDF** —— 也就是 `PrintToPdf` 用和「保存为 PDF」完全一样的
 * 参数排出来的字节。所以这不是近似：**右边看到的就是会写进文件的那一页**，页数、断点、
 * 表格怎么切，全由浏览器排版引擎决定（用户要的正是这个）。
 *
 * ## 怎么看
 *
 * - **Ctrl + 滚轮**缩放（40%–300%），以**指针所在处**为锚点 —— 和看图、看 PDF 的习惯一致；
 * - **空格 + 左键拖动**平移（两个方向都能拖）；
 * - 放大后横向、纵向都能滚 —— 缩放加在滚动容器**里面**那一层，`scrollWidth` 才包得住，
 *   加在容器自己身上会「滑到头了内容还没到边」（这个坑在旧预览里踩过）。
 *
 * ## 分辨率
 *
 * 缩放先用 CSS `zoom` 立即生效（不卡），停手 300ms 后再按新的缩放**重画一遍** canvas，
 * 字就不会糊。重画只改 canvas 的像素尺寸、不改它的 CSS 尺寸，所以不会跳版面。
 */

// worker 走 Vite 的 `?url`：它会把这个文件单独打包成一个资源，路径在打包后依然正确。
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
/** 重画时最多按 2 倍分辨率画 —— 再高就只是吃内存，看不出差别。 */
const MAX_RENDER_ZOOM = 2;
/** 停手多久之后重画。太短会在连滚时反复重排。 */
const RERENDER_DELAY = 300;

interface PdfPreviewProps {
  /** PDF 字节。`null` = 还没有（第一版正在生成）。 */
  bytes: ArrayBuffer | null;
  /** 渲染完一版报一下总页数，给状态栏用。 */
  onPages?: (pages: number) => void;
  /** 正在生成新的一版。旧的那一版仍然留在屏幕上，不用闪白。 */
  generating?: boolean;
  /** 还没有任何一版时显示的文案。 */
  emptyText?: string;
}

interface PageEntry {
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
}

export function PdfPreview({ bytes, onPages, generating = false, emptyText = "" }: PdfPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 正在等「停手后重画」—— 用来显示缩放百分比旁边那个小点。 */
  const [sharpening, setSharpening] = useState(false);

  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  /** 滚动容器的**内容宽**（左右各 24px 内边距之外），缩小时的居中要拿它算。 */
  const [frameWidth, setFrameWidth] = useState(0);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const measure = () => setFrameWidth(Math.max(0, scroll.clientWidth - 48));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  /**
   * 缩小时左右留白。
   *
   * ⚠️ 不能用 `margin-inline: auto`：`zoom` 会把外边距**也按比例缩掉**，于是 auto 算出来
   * 的那点空白再被缩小，纸就贴到左边去了（用户报的「缩小后是左对齐」）。
   * 这里按**缩放后的实际宽度**反算：布局里的 M 乘上 zoom 之后，正好等于剩下一半的空白。
   */
  const centerInset =
    zoom < 1 && frameWidth > 0 ? (frameWidth * (1 / zoom - 1)) / 2 : 0;

  const pagesRef = useRef<PageEntry[]>([]);
  const baseWidthRef = useRef(600);

  /**
   * 所有绘制排成**一条队**。
   *
   * `page.render()` 不能在同一个 canvas 上并发，而「换一份 PDF 后逐页画」与
   * 「缩放停手后按新分辨率重画」随时可能撞上。
   */
  const paintChainRef = useRef<Promise<void>>(Promise.resolve());
  const enqueuePaint = (task: () => Promise<void>): Promise<void> => {
    const next = paintChainRef.current.then(task, task).then(
      () => undefined,
      () => undefined,
    );
    paintChainRef.current = next;
    return next;
  };

  /** 按当前缩放重画一页。canvas 的 **CSS 尺寸不变**，只换像素尺寸。 */
  const paint = async (entry: PageEntry): Promise<void> => {
    // 换了一份 PDF 之后，旧页面已经不在文档里了 —— 排到它的活儿直接丢掉。
    if (!entry.canvas.isConnected) return;

    const base = entry.page.getViewport({ scale: 1 });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resolutionZoom = Math.min(MAX_RENDER_ZOOM, Math.max(1, zoomRef.current));
    const viewport = entry.page.getViewport({
      scale: (baseWidthRef.current / base.width) * resolutionZoom * dpr,
    });

    entry.canvas.width = Math.floor(viewport.width);
    entry.canvas.height = Math.floor(viewport.height);

    const context = entry.canvas.getContext("2d");
    if (!context) throw new Error("拿不到 2D 画布");
    await entry.page.render({ canvasContext: context, viewport }).promise;
  };

  // 换了一份 PDF：重建全部页面。
  useEffect(() => {
    const scroll = scrollRef.current;
    const layer = layerRef.current;
    if (!scroll || !layer) return;

    let cancelled = false;
    let document: PDFDocumentProxy | null = null;

    layer.replaceChildren();
    pagesRef.current = [];
    setError(null);
    if (!bytes) return;

    void (async () => {
      try {
        // ⚠️ 传副本：pdf.js 会把 ArrayBuffer **转移**给 worker，原对象当场变成 detached。
        document = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
        if (cancelled) return;
        onPages?.(document.numPages);

        // 版心宽度按滚动容器的**内容宽**算（左右各 24px 内边距），与缩放无关 ——
        // 缩放是加在里层上的，所以容器宽度不会变。
        baseWidthRef.current = Math.max(240, scroll.clientWidth - 48);

        for (let number = 1; number <= document.numPages; number += 1) {
          if (cancelled) break;

          const page = await document.getPage(number);
          const base = page.getViewport({ scale: 1 });
          const ratio = base.height / base.width;

          const canvas = window.document.createElement("canvas");
          canvas.className = "block bg-white";
          canvas.style.width = `${baseWidthRef.current}px`;
          canvas.style.height = `${Math.round(baseWidthRef.current * ratio)}px`;

          const frame = window.document.createElement("div");
          frame.className = "relative mx-auto mb-4 shadow-[0_6px_24px_rgba(0,0,0,0.32)]";

          const label = window.document.createElement("div");
          label.className = "absolute -top-4 right-0 text-[10px] text-white/55 tabular-nums";
          label.textContent = `${number} / ${document.numPages}`;

          frame.append(canvas, label);
          layer.append(frame);

          const entry: PageEntry = { page, canvas };
          pagesRef.current.push(entry);
          await enqueuePaint(() => paint(entry));
        }
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    })();

    return () => {
      cancelled = true;
      void document?.destroy();
    };
    // `onPages` 由调用方固定，不参与依赖 —— 否则每帧都会重建整份预览。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  // 缩放停手之后，按新的分辨率重画一遍（CSS 尺寸不变，版面不跳）。
  useEffect(() => {
    if (pagesRef.current.length === 0) return;
    setSharpening(true);

    let cancelled = false;
    const timer = setTimeout(() => {
      void enqueuePaint(async () => {
        for (const entry of pagesRef.current) {
          if (cancelled) return;
          await paint(entry);
        }
      }).finally(() => {
        if (!cancelled) setSharpening(false);
      });
    }, RERENDER_DELAY);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Ctrl + 滚轮缩放。原生监听 + `passive: false` —— React 的 onWheel 在被动监听上，
  // 里面 preventDefault() 无效，结果会连带把整个 WebView 的页面缩放也改掉。
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();

      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomRef.current * factor));
      if (next === zoomRef.current) return;

      // 以指针为中心：先记下指针在**内容坐标**里的位置，缩放后把同一处挪回指针底下。
      const rect = scroll.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const contentX = pointerX + scroll.scrollLeft;
      const contentY = pointerY + scroll.scrollTop;
      const ratio = next / zoomRef.current;

      // 先把 zoom 直接写到 DOM 上 —— React 的 setState 要等到下一次渲染，
      // 那一帧再调 scrollLeft 就已经晚了（位置会先跳一下）。
      if (layerRef.current) layerRef.current.style.zoom = String(next);
      zoomRef.current = next;
      setZoom(next);

      requestAnimationFrame(() => {
        scroll.scrollLeft = contentX * ratio - pointerX;
        scroll.scrollTop = contentY * ratio - pointerY;
      });
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, []);

  // 空格按住 = 进入拖动模式。输入框里按空格不算。
  useEffect(() => {
    const typing = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      // 输入框里按空格是打字；按钮上按空格是「点它」—— 这两种都不该进拖动模式。
      return (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "BUTTON" ||
        element.tagName === "SELECT" ||
        element.isContentEditable
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || typing(event.target)) return;
      // 别让页面跟着空格往下滚。
      event.preventDefault();
      setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    // 切走窗口时松开的事件收不到 —— 不清掉的话回来还卡在拖动模式里。
    const onBlur = () => setSpaceHeld(false);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const scroll = scrollRef.current;
    if (!scroll || !spaceHeld || event.button !== 0) return;
    event.preventDefault();

    const start = {
      x: event.clientX,
      y: event.clientY,
      left: scroll.scrollLeft,
      top: scroll.scrollTop,
    };
    setDragging(true);

    const onMove = (move: MouseEvent) => {
      scroll.scrollLeft = start.left - (move.clientX - start.x);
      scroll.scrollTop = start.top - (move.clientY - start.y);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const resetZoom = () => {
    if (layerRef.current) layerRef.current.style.zoom = "1";
    zoomRef.current = 1;
    setZoom(1);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onMouseDown={onMouseDown}
        className={`flex-1 min-h-0 overflow-auto bg-[#6f6d68] px-6 py-8 [scrollbar-gutter:stable] ${
          dragging ? "cursor-grabbing" : spaceHeld ? "cursor-grab" : ""
        }`}
      >
        {error ? (
          <p className="mx-auto max-w-md text-center text-[11px] text-white/70">{error}</p>
        ) : null}
        {!bytes && !error ? (
          <p className="mx-auto max-w-md text-center text-[11px] text-white/60">{emptyText}</p>
        ) : null}
        {/*
          ⚠️ 这一层**只给命令式渲染用**（pdf.js 往里面 append canvas）。React 不要管它的
          子节点 —— 所以 `error` / 空状态那两段放在外面，别混进来。
          ⚠️ `zoom` 必须加在**这一层**：加在滚动容器自己身上，容器会被放大、`scrollWidth`
          却不跟着涨，右边那半截就永远滚不到。
        */}
        <div
          ref={layerRef}
          className="select-none"
          style={{ zoom, width: "max-content", marginLeft: centerInset }}
          data-generating={generating ? "true" : undefined}
        />
      </div>

      {/* 右下角的缩放指示：点一下复位。 */}
      <button
        type="button"
        onClick={resetZoom}
        title="Ctrl + 滚轮缩放，点一下复位"
        className="absolute bottom-3 right-4 h-6 rounded-md bg-black/40 px-2 text-[10px] text-white/80 tabular-nums cursor-pointer hover:bg-black/60 transition-colors"
      >
        {Math.round(zoom * 100)}%{sharpening ? " …" : ""}
      </button>
    </div>
  );
}
