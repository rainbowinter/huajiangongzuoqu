/**
 * 查看器：跑在宿主给的沙箱视图里。
 *
 * ## 四条环境约束（都是实测出来的，见 `Docs/plugin-view-sandbox.md`）
 *
 * 1. 帧是 **opaque origin**：拿不到任何外部资源 —— 这也是宿主为什么把 js / css / worker
 *    都**内联**进来。
 * 2. `new Worker(<地址>)` 会被 CORS 挡掉，**`new Worker(blob:)` 可以**。所以第二份 js
 *    （pdf.js 的 worker 源码）是由宿主当**文本**塞在 `<script type="text/plain">` 里的，
 *    这里读出来做成 blob 再交给 pdf.js（它自己会带 `{ type: "module" }`）。
 * 3. 除了 `floralView` 那几个方法和 postMessage，**没有别的通道** —— 文件字节要主动问宿主
 *    要（`requestDocument()`），拿到的是一条 `ArrayBuffer`。
 * 4. **顶上那排控件不在这个文档里**：它们由宿主渲染（`view.toolbar` 声明），点了之后
 *    通过 `command` 消息发进来，这里只负责照做并把当前状态用 `setState` 报回去。
 *    所以本文件里没有任何按钮、没有 DOM 事件绑定，只有命令处理。
 *
 * ## 为什么整段包在 IIFE 里
 *
 * 插件的 js 是**全部拼进同一个内联 module** 的，pdf.js 那份压缩代码的顶层名字（`Ut`、`Gt`…）
 * 就在同一个作用域里。包一层之后这里的名字不会和它撞车（重名会让整个模块报错、视图全白）。
 */
(() => {
  const MAX_SCALE = 5;
  const MIN_SCALE = 0.2;
  /** 点一次「+」「−」、按一次 +/- 键走多少。 */
  const ZOOM_STEP = 1.2;
  /** 滚动的内边距（与 .scroller 的 padding 一致），算「适应宽度」时要扣掉。 */
  const PAGE_MARGIN = 16;
  /**
   * 跳到某一页时，那一页的上边缘离可视区顶边留多少。
   *
   * ⚠️ 它同时是「哪一页算当前页」的判据（见 `trackCurrentPage`），而且两边必须是**同一个值**：
   * 跳转把目标页恰好停在判据的边界上，只要判据稍微严一点（例如 `<= 8` 对上一个被浏览器
   * 抖成 8.0001 的 `scrollTop`），跳过去之后当前页会变成**上一页**。
   */
  const PAGE_GAP = 12;
  /** 上面那个边界给亚像素留的余量：`scrollTop` 可以是小数。 */
  const PAGE_GAP_EPSILON = 0.5;

  const scroller = document.getElementById("scroller");
  const hint = document.getElementById("hint");

  /**
   * 宿主给的调色板接到哪几个变量上。
   *
   * 视图自己的变量名与宿主的不一样（宿主那套是 `--color-paper` 这种），所以要对一次表 ——
   * 好处是**这份样式表在没有宿主时也是完整的**（见 viewer.css 里的回退值），
   * 而宿主给了什么就用什么。
   */
  const TOKEN_MAP = {
    "--bg": "--color-paper-warm",
    "--ink": "--color-ink",
    "--ink-soft": "--color-ink-soft",
    "--ink-ghost": "--color-ink-ghost",
    "--line": "--color-paper-deep",
    "--shadow": "--color-shadow-deep",
  };

  const state = {
    pdf: null,
    /** 缩放比例。`null` = 还没定过，下一次建页时按「适应宽度」算。 */
    scale: null,
    /** 顺时针 0 / 90 / 180 / 270。 */
    rotation: 0,
    /** 单页模式：一次只显示当前这一页。 */
    single: false,
    /** 第一页在当前旋转下、比例 1 时的宽度 —— 「适应宽度」与「是不是正在适应宽度」都靠它。 */
    baseWidth: 0,
    /** 已经画出来的页（1 基）。 */
    painted: new Set(),
    rendering: new Set(),
    /** 缩放 / 旋转变化时自增：早先那批渲染任务的结果要丢掉，否则会把旧比例的画贴上去。 */
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

  /** 把宿主递进来的调色板接到自己的变量上。`data-theme` 留给 CSS 里的回退值与 color-scheme。 */
  function applyTheme(message) {
    if (message.theme === "light" || message.theme === "dark") {
      document.documentElement.dataset.theme = message.theme;
    }
    const tokens = message.tokens;
    if (!tokens) return;
    for (const [target, source] of Object.entries(TOKEN_MAP)) {
      const value = tokens[source];
      // 空值宁可不动：设成空串会让 `var(--bg)` 变成无效值，整条背景声明直接失效。
      if (typeof value === "string" && value.length > 0) {
        document.documentElement.style.setProperty(target, value);
      }
    }
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

  function clamp(scale) {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  }

  /** 按当前基准宽度算「适应宽度」的比例。 */
  function fitScale() {
    if (state.baseWidth <= 0) return 1;
    return clamp((scroller.clientWidth - PAGE_MARGIN * 2) / state.baseWidth);
  }

  /** 现在是不是正停在「适应宽度」上（用来点亮那个按钮）。 */
  function isFit() {
    return state.scale !== null && Math.abs(state.scale - fitScale()) < 0.005;
  }

  function pages() {
    return scroller.querySelectorAll(".page");
  }

  /** 单页模式：隐藏别的页、只在当前页上打 `data-current`。 */
  function applyMode() {
    scroller.classList.toggle("single", state.single);
    for (const holder of pages()) {
      const current = state.single && Number(holder.dataset.index) === state.page;
      holder.dataset.current = current ? "true" : "false";
    }
  }

  /** 按比例把每页的占位先摆好：不然滚动条长度是错的，边滚边变会很跳。 */
  async function buildPages() {
    state.generation += 1;
    state.painted.clear();
    state.rendering.clear();
    for (const holder of [...pages()]) holder.remove();

    const first = await state.pdf.getPage(1);
    // ⚠️ 基准宽度取**旋转之后**的：旋转 90° 时页面的宽高会换个个儿，
    // 拿没转过的宽度去算「适应宽度」，转完必然冒出一条横向滚动条。
    state.baseWidth = first.getViewport({ scale: 1, rotation: state.rotation }).width;
    if (state.scale === null) state.scale = fitScale();

    for (let index = 1; index <= state.pdf.numPages; index += 1) {
      const page = index === 1 ? first : await state.pdf.getPage(index);
      const viewport = page.getViewport({ scale: state.scale, rotation: state.rotation });

      const holder = document.createElement("section");
      holder.className = "page";
      holder.dataset.index = String(index);
      holder.style.width = `${Math.floor(viewport.width)}px`;
      holder.style.height = `${Math.floor(viewport.height)}px`;
      holder.append(
        Object.assign(document.createElement("span"), { className: "loading", textContent: "…" }),
      );

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
    for (const holder of pages()) state.observer.observe(holder);

    applyMode();
    await paintVisible();
    updateState();
  }

  /**
   * 把视口里（以及近旁一屏）的页立刻画出来。
   *
   * 单页模式要单独走：藏起来的页 `getBoundingClientRect()` 全是 0，会被当成「在视口里」，
   * 于是每换一次缩放就把整份文档重画一遍。
   */
  async function paintVisible() {
    if (state.single) {
      await paint(state.page);
      return;
    }
    for (const holder of pages()) {
      const rect = holder.getBoundingClientRect();
      if (rect.bottom > -800 && rect.top < scroller.clientHeight + 800) {
        await paint(Number(holder.dataset.index));
      }
    }
  }

  async function paint(index) {
    const holder = scroller.querySelector(`.page[data-index="${index}"]`);
    if (!holder || state.painted.has(index) || state.rendering.has(index)) return;

    state.rendering.add(index);
    const generation = state.generation;

    try {
      const page = await state.pdf.getPage(index);
      const viewport = page.getViewport({ scale: state.scale, rotation: state.rotation });
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

      // 缩放 / 旋转变了就别贴了 —— 这张是按旧比例画的。
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

  /** 把工具栏要显示的东西报上去。宿主**不自己记账** —— 比例、页码都以这里为准。 */
  function updateState() {
    const pressed = [];
    if (isFit()) pressed.push("fit-width");
    if (state.single) pressed.push("spread");

    floralView.setState(
      {
        zoom: state.scale === null ? "—" : `${Math.round(state.scale * 100)}%`,
        page: state.pdf ? `${state.page} / ${state.pdf.numPages}` : "—",
        rotation: `${state.rotation}°`,
        // 「单页 / 连续」就一个按钮：文字用当前模式，点亮表示在单页模式。
        spread: state.single ? "单页" : "连续",
      },
      pressed,
    );
  }

  /** 滚动时把「当前页」更新成最靠上的那一页。 */
  function trackCurrentPage() {
    if (state.single || !state.pdf) return;

    // ⚠️ 滚到底了就认最后一页。文档末尾那几页常常短到撑不满一屏，「谁的顶边进了可视区」
    // 这条规则永远算不到它们 —— 于是「跳到最后一页」会显示成倒数第二页（跳过去之后
    // 滚不动了，算出来的还是上一页）。滚到底显示总页数也是各家阅读器一致的做法。
    const scrollable = scroller.scrollHeight > scroller.clientHeight + 2;
    if (scrollable && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      if (state.page !== state.pdf.numPages) {
        state.page = state.pdf.numPages;
        updateState();
      }
      return;
    }

    const top = scroller.getBoundingClientRect().top;
    let current = 1;
    for (const holder of pages()) {
      // ⚠️ 用 rect 而不是 `offsetTop`：那个是相对 offsetParent 的，滚动容器的
      // padding / 边框 / 祖先定位都会让它偏，而这里要的就是「离可视区顶边多远」。
      if (holder.getBoundingClientRect().top - top <= PAGE_GAP + PAGE_GAP_EPSILON) {
        current = Number(holder.dataset.index);
      } else break;
    }
    if (current !== state.page) {
      state.page = current;
      updateState();
    }
  }

  function scrollToPage(index) {
    const holder = scroller.querySelector(`.page[data-index="${index}"]`);
    if (!holder) return;
    const offset =
      holder.getBoundingClientRect().top - scroller.getBoundingClientRect().top - PAGE_GAP;
    scroller.scrollTop += offset;
  }

  async function rebuild() {
    const keep = state.single ? 0 : scroller.scrollTop;
    await buildPages();
    if (!state.single) scroller.scrollTop = keep;
  }

  async function zoomBy(factor) {
    if (!state.pdf) return;
    state.scale = clamp(state.scale * factor);
    await rebuild();
  }

  async function fitWidth() {
    if (!state.pdf) return;
    const first = await state.pdf.getPage(1);
    state.baseWidth = first.getViewport({ scale: 1, rotation: state.rotation }).width;
    state.scale = fitScale();
    await rebuild();
  }

  async function goToPage(target) {
    if (!state.pdf) return;
    const total = state.pdf.numPages;
    const page = Math.max(1, Math.min(total, Math.round(target)));
    const changed = page !== state.page;
    state.page = page;

    if (state.single) {
      applyMode();
      scroller.scrollTop = 0;
      if (changed) await paint(page);
    } else {
      scrollToPage(page);
      // 刚滚过来的那几页立刻画 —— 光等 IntersectionObserver 会先白一下。
      await paintVisible();
    }
    updateState();
  }

  async function setRotation(degrees) {
    if (!state.pdf) return;
    // 刚才就是「适应宽度」的话，转完还得是：宽高换了个个儿，基准也跟着变，
    // 不重算就会冒出一条横向滚动条（或缩得太小）。
    const wasFit = isFit();
    state.rotation = ((degrees % 360) + 360) % 360;

    const first = await state.pdf.getPage(1);
    state.baseWidth = first.getViewport({ scale: 1, rotation: state.rotation }).width;
    state.scale = wasFit ? fitScale() : clamp(state.scale);
    await rebuild();
  }

  async function setSingle(on) {
    if (!state.pdf || state.single === on) return;
    state.single = on;
    applyMode();
    scroller.scrollTop = 0;

    if (on) {
      await paint(state.page);
    } else {
      scrollToPage(state.page);
      await paintVisible();
    }
    updateState();
  }

  /**
   * 宿主那排工具栏发下来的命令。
   *
   * 认不出的 id 直接忽略：宿主与插件各改各的时候版本对不上是常态，为此报错只会更吵。
   */
  function handleCommand(message) {
    switch (message.id) {
      case "zoom-in":
        return void zoomBy(ZOOM_STEP);
      case "zoom-out":
        return void zoomBy(1 / ZOOM_STEP);
      case "fit-width":
        return void fitWidth();
      case "page-prev":
        return void goToPage(state.page - 1);
      case "page-next":
        return void goToPage(state.page + 1);
      case "goto": {
        const page = Number.parseInt(String(message.value ?? ""), 10);
        if (Number.isFinite(page)) void goToPage(page);
        return;
      }
      case "rotate":
        return void setRotation(state.rotation + 90);
      case "spread":
        return void setSingle(!state.single);
      default:
        return;
    }
  }

  async function open(bytes) {
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
      state.pdf = null;
      updateState();
      return;
    }

    hideHint();
    state.page = 1;
    state.scale = null;
    await buildPages();
    scroller.scrollTop = 0;
  }

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
    if (event.key === "+" || event.key === "=") void zoomBy(ZOOM_STEP);
    else if (event.key === "-") void zoomBy(1 / ZOOM_STEP);
  });

  floralView.onCommand(handleCommand);

  floralView.onMessage((message) => {
    if (!message || typeof message !== "object") return;

    if (message.t === "init") {
      applyTheme(message);
      // 字节要主动问宿主要 —— 插件拿不到路径。
      floralView.requestDocument();
      return;
    }

    if (message.t === "theme") {
      applyTheme(message);
      return;
    }

    if (message.t === "document") {
      void open(message.bytes);
      return;
    }

    if (message.t === "documentError") {
      showHint(`读不到这个文件：${message.message}`, "error");
    }
  });

  // 工具栏那排控件从进页面起就能点，宿主会把 ready 之前的命令排队补发 ——
  // 但状态得先报一次，否则那排东西要等到文档打开才有字。
  updateState();
  floralView.ready();
})();
