/**
 * 查看器：跑在宿主给的沙箱视图里。
 *
 * ## 三条环境约束（都是实测出来的，见 `Docs/plugin-view-sandbox.md`）
 *
 * 1. 帧是 **opaque origin**：拿不到任何外部资源 —— 这也是宿主为什么把 js / css / worker
 *    都**内联**进来。
 * 2. `new Worker(<地址>)` 会被 CORS 挡掉，**`new Worker(blob:)` 可以**。所以第二份 js
 *    （pdf.js 的 worker 源码）是由宿主当**文本**塞在 `<script type="text/plain">` 里的，
 *    这里读出来做成 blob 再交给 pdf.js（它自己会带 `{ type: "module" }`）。
 * 3. 除了 `floralView` 那几个方法和 postMessage，**没有别的通道** —— 文件字节要主动问宿主
 *    要（`requestDocument()`），拿到的是一条 `ArrayBuffer`。
 *
 * ## 为什么整段包在 IIFE 里
 *
 * 插件的 js 是**全部拼进同一个内联 module** 的，pdf.js 那份压缩代码的顶层名字（`Ut`、`Gt`…）
 * 就在同一个作用域里。包一层之后这里的名字不会和它撞车（重名会让整个模块报错、视图全白）。
 */
(() => {
  const MAX_SCALE = 5;
  const MIN_SCALE = 0.2;

  const scroller = document.getElementById("scroller");
  const hint = document.getElementById("hint");
  const nameLabel = document.getElementById("doc-name");
  const zoomLabel = document.getElementById("zoom-label");
  const pageLabel = document.getElementById("page-label");

  const state = {
    pdf: null,
    scale: null,
    /** 已经画出来的页（1 基）。 */
    painted: new Set(),
    rendering: new Set(),
    /** 缩放变化时自增：早先那批渲染任务的结果要丢掉，否则会把旧比例的画贴上去。 */
    generation: 0,
    page: 1,
    observer: null,
  };

  /**
   * pdf.js 的 worker：源码是宿主塞进来的纯文本块。
   *
   * 读不到也不致命 —— pdf.js 会退回主线程跑（大文件会卡住界面），所以只记一条日志。
   */
  function workerBlobUrl() {
    const source = document.getElementById("floral-worker-src")?.textContent ?? "";
    if (!source) {
      floralView.log("warn", "没拿到 worker 源码，pdf.js 会退回主线程");
      return null;
    }
    return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  }

  function showHint(text, kind) {
    hint.textContent = text;
    hint.className = kind ? `hint ${kind}` : "hint";
    hint.hidden = false;
    hint.style.display = "";
  }

  function hideHint() {
    hint.style.display = "none";
  }

  /** 按比例把每页的占位先摆好：不然滚动条长度是错的，边滚边变会很跳。 */
  async function buildPages() {
    state.generation += 1;
    state.painted.clear();
    state.rendering.clear();
    for (const holder of [...scroller.querySelectorAll(".page")]) holder.remove();

    const first = await state.pdf.getPage(1);
    const base = first.getViewport({ scale: 1 });
    if (state.scale === null) state.scale = fitScale(base);

    for (let index = 1; index <= state.pdf.numPages; index += 1) {
      const page = index === 1 ? first : await state.pdf.getPage(index);
      const viewport = page.getViewport({ scale: state.scale });

      const holder = document.createElement("section");
      holder.className = "page";
      holder.dataset.index = String(index);
      holder.style.width = `${Math.floor(viewport.width)}px`;
      holder.style.height = `${Math.floor(viewport.height)}px`;
      holder.append(Object.assign(document.createElement("span"), { className: "loading", textContent: "…" }));

      scroller.append(holder);
    }

    state.observer?.disconnect();
    state.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) void paint(Number(entry.target.dataset.index));
        }
      },
      // 提前一屏开始画，滚过去时通常已经好了。
      { root: scroller, rootMargin: "800px 0px" },
    );
    for (const holder of scroller.querySelectorAll(".page")) state.observer.observe(holder);

    updateLabels();
  }

  function fitScale(base) {
    const available = scroller.clientWidth - 32;
    return clamp(available / base.width);
  }

  function clamp(scale) {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  }

  async function paint(index) {
    const holder = scroller.querySelector(`.page[data-index="${index}"]`);
    if (!holder || state.painted.has(index) || state.rendering.has(index)) return;

    state.rendering.add(index);
    const generation = state.generation;

    try {
      const page = await state.pdf.getPage(index);
      const viewport = page.getViewport({ scale: state.scale });
      // 高分屏上按设备像素画，否则字会糊。上限 2 倍，免得 4K 屏上白烧一倍时间。
      const ratio = Math.min(window.devicePixelRatio || 1, 2);

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      }).promise;

      // 缩放变了就别贴了 —— 这张是按旧比例画的。
      if (generation !== state.generation) return;
      holder.replaceChildren(canvas);
      state.painted.add(index);
    } catch (error) {
      // 单页失败不该让整个文档白屏：把原因画在那一页上。
      holder.replaceChildren(
        Object.assign(document.createElement("span"), {
          className: "loading",
          textContent: `第 ${index} 页渲染失败`,
        }),
      );
      floralView.log("error", `渲染第 ${index} 页失败：${error?.message ?? error}`);
    } finally {
      state.rendering.delete(index);
    }
  }

  function updateLabels() {
    zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
    pageLabel.textContent = `${state.page} / ${state.pdf?.numPages ?? 0}`;
  }

  /** 滚动时把「当前页」更新成最靠上的那一页。 */
  function trackCurrentPage() {
    let current = 1;
    for (const holder of scroller.querySelectorAll(".page")) {
      if (holder.offsetTop - scroller.scrollTop <= 8) current = Number(holder.dataset.index);
      else break;
    }
    if (current !== state.page) {
      state.page = current;
      updateLabels();
    }
  }

  async function rebuild() {
    const keep = scroller.scrollTop;
    await buildPages();
    scroller.scrollTop = keep;
    // 视口里（以及近旁）的那几页立刻重画，剩下的等 IntersectionObserver 叫。
    for (const holder of scroller.querySelectorAll(".page")) {
      const rect = holder.getBoundingClientRect();
      if (rect.bottom > -800 && rect.top < scroller.clientHeight + 800) {
        await paint(Number(holder.dataset.index));
      }
    }
  }

  async function zoomBy(factor) {
    state.scale = clamp(state.scale * factor);
    await rebuild();
  }

  async function fitWidth() {
    const first = await state.pdf.getPage(1);
    state.scale = fitScale(first.getViewport({ scale: 1 }));
    await rebuild();
  }

  async function open(bytes, name, theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    if (name) nameLabel.textContent = name;

    const worker = workerBlobUrl();
    if (worker) globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = worker;

    try {
      state.pdf = await globalThis.pdfjsLib.getDocument({
        data: bytes,
        // 沙箱里不需要 eval 那条路径。
        isEvalSupported: false,
        verbosity: 0,
      }).promise;
    } catch (error) {
      // 加密的、损坏的、根本不是 PDF 的 —— 都会走到这儿。
      showHint(`这个文件打不开：${error?.message ?? error}`, "error");
      floralView.log("error", `打开 PDF 失败：${error?.message ?? error}`);
      return;
    }

    hideHint();
    state.page = 1;
    state.scale = null;
    await buildPages();
    scroller.scrollTop = 0;
  }

  document.getElementById("zoom-in").addEventListener("click", () => void zoomBy(1.2));
  document.getElementById("zoom-out").addEventListener("click", () => void zoomBy(1 / 1.2));
  document.getElementById("zoom-fit").addEventListener("click", () => void fitWidth());
  scroller.addEventListener("scroll", trackCurrentPage, { passive: true });

  // Ctrl/⌘ + 滚轮缩放：PDF 阅读器里人人都在用的手势。
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      void zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: false },
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") void zoomBy(1.2);
    else if (event.key === "-") void zoomBy(1 / 1.2);
  });

  floralView.onMessage((message) => {
    if (!message || typeof message !== "object") return;

    if (message.t === "init") {
      if (message.theme) document.documentElement.dataset.theme = message.theme;
      nameLabel.textContent = message.name ?? "";
      // 字节要主动问宿主要 —— 插件拿不到路径。
      floralView.requestDocument();
      return;
    }

    if (message.t === "document") {
      void open(message.bytes, nameLabel.textContent, document.documentElement.dataset.theme);
      return;
    }

    if (message.t === "documentError") {
      showHint(`读不到这个文件：${message.message}`, "error");
    }
  });

  floralView.ready();
})();
