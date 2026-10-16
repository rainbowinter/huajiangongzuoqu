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
   * 一份 PDF 里「有没有真的字」。
   *
   * 判据是 pdf.js 取出来的那些文字片段：扫描件（整页一张图）**一个片段都没有**；而
   * **文字被转成曲线**的那种（字体是 Type3，每个字形就是一小段画图指令）会取出一串
   * **字形码** —— 没有 ToUnicode 映射时，那些码就是 C0 控制字符。
   *
   * 两种情况都**没法选中、没法搜索**，而且不是我们这边坏了。但界面上什么都不说的话，
   * 用户的结论只能是「花笺的阅读器有毛病」—— 实测他就是这么想的，所以我们得自己说出来。
   */
  const GLYPH_CODE = /[\u0000-\u0008\u000B-\u001F]/;

  function textIsExtractable(items) {
    if (!Array.isArray(items)) return false;
    return items.some((item) => {
      const text = typeof item?.str === "string" ? item.str : "";
      // 有空白之外、又不是字形码的字符，才算「真的取到了字」。
      return text.trim().length > 0 && !GLYPH_CODE.test(text);
    });
  }

  /**
   * 打开文档后抽查头几页，全都没字就提示一次。
   *
   * 为什么要抽查而不是「看第一页」：封面常常是整页图片，后面才是正文。
   * 为什么只抽查头 20 页：再往后翻的文档，早就该看见字了，多查只是白花时间。
   */
  async function probeTextLayer() {
    if (!state.pdf || state.textProbeDone) return;
    state.textProbeDone = true;

    const last = Math.min(state.pdf.numPages, 20);
    for (let index = 1; index <= last; index += 1) {
      try {
        const page = await state.pdf.getPage(index);
        const content = await page.getTextContent();
        if (textIsExtractable(content.items)) return;
      } catch (error) {
        // 取不出来就当作「这一页没字」，继续看下一页。
        floralView.log("warn", `抽查第 ${index} 页的文字层失败：${error?.message ?? error}`);
      }
    }

    floralView.toast(
      "这份 PDF 里没有可提取的文字（多半是扫描件，或者文字已经转成了曲线）—— 选中和搜索都用不了。",
    );
    floralView.log("warn", "PDF 全篇没有可提取的文字（扫描件 / 文字已转曲线）");
  }

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
    /** 每页当前的 PageViewport。扩展插件的坐标换算要用（`floralPdfView.toPdf`）。 */
    viewports: new Map(),
    /** 已经画出来的页（1 基）。 */
    painted: new Set(),
    rendering: new Set(),
    /** 缩放 / 旋转变化时自增：早先那批渲染任务的结果要丢掉，否则会把旧比例的画贴上去。 */
    generation: 0,
    page: 1,
    observer: null,
    /** 「这一篇有没有字」只抽查一次（见 `probeTextLayer`）。 */
    textProbeDone: false,
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
    state.viewports.clear();
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
      state.viewports.set(index, viewport);
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
    // 布局落地之后再补一次（见 `scheduleRepaint` 的说明）：上面那次可能是按「还没有尺寸的
    // 滚动区」算的 —— 打开文档时面板可能正在展开，那一格当时还是 0 高。
    lastScrollerHeight = 0;
    requestAnimationFrame(scheduleRepaint);
    // 页面刚重建过，位置全变了 —— 扩展插件（批注那类）得把自己的图层重摆一遍。
    notifyPages();
  }

  /**
   * 把视口里（以及近旁一屏）的页立刻画出来。
   *
   * 单页模式要单独走：藏起来的页 `getBoundingClientRect()` 全是 0，会被当成「在视口里」，
   * 于是每换一次缩放就把整份文档重画一遍。
   */
  /**
   * 视口尺寸一变，就把「现在应该在视野里」的页补画一遍。
   *
   * ⚠️ 这条是为**刚打开时第二页空白**准备的：打开文档那一刻滚动区可能还没有尺寸（面板正在
   * 展开、或那一格当时还是 0 高）。那时 `paintVisible` 与交叉观察器都按「高度 0」算，
   * 第二页落在「视野」之外，谁都不会画它 —— 而根元素后来变大时，IntersectionObserver
   * **不会再报一次**（它只在交叉状态**变化**时报，而它眼里那页从来就没进过视野）。
   * 用户滚轮缩放一下走的是整页重建，于是看着像「缩放一下就好了」。
   *
   * 只认真实的高度变化 + 防抖：`getBoundingClientRect` 是每页一次，长文档上不能白量。
   */
  let lastScrollerHeight = 0;
  let repaintTimer = 0;
  function scheduleRepaint() {
    const height = scroller.clientHeight;
    if (height === 0 || height === lastScrollerHeight) return;
    lastScrollerHeight = height;
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      repaintTimer = 0;
      void paintVisible();
    }, 120);
  }

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

  /**
   * 给一页铺上**文字层**：叠在画布之上的那一层透明文字。
   *
   * 画布上的字是画出来的图形 —— 选不中、搜不了、也拿不到「这是第几行第几个字」。pdf.js
   * 的 `TextLayer` 按页面里真实的文字位置摆出一堆 span（文字本身是透明的，看到的仍是
   * canvas），于是**选中、复制、以及按文字选区做高亮**都有了着力点。
   *
   * 三个坑：
   *
   * 1. **`--scale-factor` 必须在构造之前设好** —— 它一构造就读这个变量去算容器尺寸，
   *    而每个 span 的字号是 `calc(var(--scale-factor) * …px)`。设晚了或者忘了，
   *    整层的字号全是默认值，选中的位置会偏得离谱。
   * 2. 传进去的 **viewport 不要乘 `devicePixelRatio`**：canvas 为了高清才乘那个系数，
   *    而 `TextLayer` 内部自己会乘（它要知道真实设备像素才能量准字宽）。乘两遍就错了。
   * 3. `render()` 直接返回 Promise（不是 `{ promise }`），而且**失败不该毁掉这一页** ——
   *    最坏情况是这页选不中字，画出来的内容该照旧。
   */
  async function attachTextLayer(holder, page, viewport, generation) {
    const container = document.createElement("div");
    container.className = "textLayer";
    holder.style.setProperty("--scale-factor", String(state.scale));

    try {
      const layer = new globalThis.pdfjsLib.TextLayer({
        // pdf.js 4.x 的参数名是 `textContentSource`（不再叫 `textContent`）。
        textContentSource: await page.getTextContent(),
        container,
        viewport,
      });
      await layer.render();
    } catch (error) {
      floralView.log("warn", `第 ${holder.dataset.index} 页的文字层没能建起来：${error?.message ?? error}`);
      return;
    }

    // 缩放 / 旋转变了就别贴了 —— 这一层的比例是旧的。
    if (generation !== state.generation) return;
    holder.append(container);
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
      // 文字层叠在画布上：**选中文字、按文字选区做高亮**都要它。画布上的字是死的图形，
      // 选不中、也拿不到「第几行、在第几个字」。
      await attachTextLayer(holder, page, viewport, generation);
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
    state.textProbeDone = false;
    await buildPages();
    scroller.scrollTop = 0;
    // 抽查文字是在**画完第一屏之后**才做的：先让用户看到内容，
    // 顺带把「有没有字」这件事说清楚（见 `probeTextLayer`）。
    void probeTextLayer();
  }

  // ---------------------------------------------------------------- 给扩展插件的口子
  //
  // 批注那类插件是被 `api.files.extendView` 拼进**这个帧**的：它的代码和这里在同一个
  // module 里，但两边各包一层 IIFE，互相看不见。所以这里显式交出一小块 API ——
  // **只给必要的**：什么时候页面重建了、以及两个方向的坐标换算。
  //
  // 为什么不把 `state` 整个交出去：那是这个查看器的内部结构，改一次就会连带弄坏别人。
  // 而坐标换算是这里唯一真正需要「知道视口」的事 —— 缩放、旋转之后，同一块批注要落在
  // 同一个地方，就只能存 PDF 的用户空间坐标，换算交给知道当前视口的人做。
  const pageHandlers = [];

  function notifyPages() {
    const pages = [...scroller.querySelectorAll(".page")].map((element) => ({
      index: Number(element.dataset.index),
      element,
    }));
    for (const handler of pageHandlers) {
      try {
        handler(pages);
      } catch (error) {
        floralView.log("error", `扩展插件处理页面变化时出错：${error?.message ?? error}`);
      }
    }
  }

  globalThis.floralPdfView = {
    /** 页面（重新）建好之后叫一次，之后每次重建也会再叫。回调收到 [{ index, element }]。 */
    onPages(handler) {
      pageHandlers.push(handler);
      // 注册时若已经有页面，立刻给一次 —— 不然扩展得等到下一次缩放才画得上东西。
      if (state.pdf) notifyPages();
    },
    /** 页内像素坐标（相对那一页的左上角）→ PDF 用户空间。缩放/旋转都不影响它。 */
    toPdf(index, x, y) {
      const viewport = state.viewports.get(index);
      if (!viewport) return null;
      return viewport.convertToPdfPoint(x, y);
    },
    /** 反过来：PDF 用户空间 → 页内像素坐标（按当前缩放与旋转）。 */
    toPage(index, x, y) {
      const viewport = state.viewports.get(index);
      if (!viewport) return null;
      return viewport.convertToViewportPoint(x, y);
    },
    /** 当前文档有几页（没打开文档时是 0）。 */
    pageCount: () => state.pdf?.numPages ?? 0,
  };

  scroller.addEventListener("scroll", trackCurrentPage, { passive: true });
  // 窗口尺寸变化、面板展开/收起 —— 都算「视口变了」。
  new ResizeObserver(scheduleRepaint).observe(scroller);

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
