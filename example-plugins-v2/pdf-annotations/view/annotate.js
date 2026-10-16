/**
 * 标注层：跑在 pdf-viewer 的沙箱视图里（宿主用 `files.extendView` 把这份 js 拼进了
 * 同一个内联 module，所以 `globalThis.floralPdfView` 是现成的）。
 *
 * ## 一切坐标都存 PDF 的用户空间
 *
 * 屏幕坐标（页内像素）**会随缩放与旋转变化**：同一块高亮，100% 时在一处、200% 时在另一处，
 * 转 90° 之后更是完全对不上。所以落盘的每一处几何都先经过 `floralPdfView.toPdf()` 换成
 * PDF 自己的坐标系，显示时再用 `toPage()` 换回来。这样缩放、旋转、换台机器都落在同一处。
 *
 * ## 为什么整段包在 IIFE 里
 *
 * 和查看器同一个道理：插件的 js 都拼在同一个 module 作用域里，pdf.js 的压缩代码也在那儿。
 * 包一层之后这里的名字不会和别人撞车（重名会让整个模块报错、视图全白）。
 */
(() => {
  const PLUGIN = "pdf-annotations";
  const pdf = globalThis.floralPdfView;
  if (!pdf) {
    floralView.log("error", "没找到 PDF 查看器的接口（floralPdfView）—— pdf-viewer 没装好？");
    return;
  }

  const store = floralView.extension(PLUGIN);

  /** 存盘前的等待。拖拽时每一帧都写一次盘太浪费，停手之后再写。 */
  const SAVE_DELAY = 400;
  /** 自由笔的取点间隔（页内像素）：太密会让数据白胖几十倍，太疏会看出折线。 */
  const INK_MIN_DISTANCE = 2.5;
  /** 自由笔的粗细（PDF 点，1 点 = 1/72 英寸）。2 点大约是一支马克笔的手感。 */
  const INK_WIDTH_PT = 2;

  const state = {
    /** 全部标注。每条的几何都是 PDF 用户空间坐标。 */
    marks: [],
    tool: "pointer",
    color: "#ffd400",
    /** 当前页元素表（`onPages` 给的）。 */
    pages: [],
    /** 正在拖拽的那个（还没落下来）。 */
    draft: null,
    /** 正在写字的图钉：{ page, at, id | null }。 */
    editing: null,
    saveTimer: 0,
    /** 原文件名（导出时的默认文件名）。 */
    fileName: "",
  };

  // ---------------------------------------------------------------- 小工具

  function pageOf(index) {
    return state.pages.find((entry) => entry.index === index) ?? null;
  }

  /** 两个对角点 → `[left, top, width, height]`（PDF 空间里 y 是朝上的，所以要取极值）。 */
  function boxOf(a, b) {
    return {
      x: Math.min(a[0], b[0]),
      y: Math.min(a[1], b[1]),
      width: Math.abs(b[0] - a[0]),
      height: Math.abs(b[1] - a[1]),
    };
  }

  /** 一条标注在**当前**视口下占的那几块矩形（页内像素）。算不出来（页还没建好）就跳过。 */
  function boxesInViewport(mark) {
    const boxes = [];
    for (const [a, b] of mark.rects ?? []) {
      const from = pdf.toPage(mark.page, a[0], a[1]);
      const to = pdf.toPage(mark.page, b[0], b[1]);
      if (!from || !to) continue;
      boxes.push(boxOf(from, to));
    }
    return boxes;
  }

  function colorWithAlpha(color, alpha) {
    // 高亮要透：底下是正文，盖死了就没法读了。
    return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
  }

  let nextId = 0;
  function makeId() {
    nextId += 1;
    return `a${Date.now().toString(36)}-${nextId}`;
  }

  // ---------------------------------------------------------------- 存 / 取

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      state.saveTimer = 0;
      store.write({ version: 1, marks: state.marks });
    }, SAVE_DELAY);
  }

  /**
   * 文件字节**按需另要**，不缓存 `document` 那条里的。
   *
   * ⚠️ `document` 里的 ArrayBuffer 是视图里两个插件**共用同一个**，而 pdf.js 会把它
   * **转移给 worker**（转移过的 buffer 在原处就废了）。查看器注册在前、先用先废，
   * 我们后收到的那份已经是空的了 —— 所以导出时单独要一份（宿主会重新读磁盘）。
   */
  floralView.onMessage((message) => {
    if (!message || typeof message !== "object") return;
    if (message.t === "init" && typeof message.name === "string") {
      state.fileName = message.name;
      return;
    }
    if (message.t === "documentCopy" && message.bytes) {
      const pending = copyWaiters.shift();
      if (pending) pending.resolve(message.bytes);
    }
  });

  /** 等一份字节副本的排队人。一次一条足够，但用队列更省心。 */
  const copyWaiters = [];

  function requestBytesCopy(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (bytes) => {
          clearTimeout(timer);
          resolve(bytes);
        },
      };
      const timer = setTimeout(() => {
        const index = copyWaiters.indexOf(waiter);
        if (index >= 0) copyWaiters.splice(index, 1);
        reject(new Error("等原文件超时"));
      }, timeoutMs);
      copyWaiters.push(waiter);
      floralView.requestDocumentCopy();
    });
  }

  store.onData((data) => {
    const marks = data && typeof data === "object" ? data.marks : null;
    state.marks = Array.isArray(marks) ? marks.filter(isSaneMark) : [];
    render();
  });

  /** 落盘的数据是从 JSON 读回来的，形状未必还靠谱 —— 坏的那些直接不要。 */
  function isSaneMark(mark) {
    if (!mark || typeof mark !== "object") return false;
    if (typeof mark.id !== "string" || !Number.isInteger(mark.page)) return false;
    if (mark.kind === "pin") return Array.isArray(mark.at) && mark.at.length === 2;
    if (mark.kind === "ink") return Array.isArray(mark.points) && mark.points.length > 1;
    return Array.isArray(mark.rects) && mark.rects.length > 0;
  }

  // ---------------------------------------------------------------- 渲染

  function render() {
    document.body.dataset.annoTool = state.tool;
    for (const { index, element } of state.pages) renderPage(index, element);
  }

  function layerOf(element) {
    let layer = element.querySelector(".anno-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "anno-layer";
      element.append(layer);
    }
    return layer;
  }

  function renderPage(index, element) {
    const layer = layerOf(element);
    // 逐页重建：一页上的标注通常只有几条，没必要做增量。
    layer.replaceChildren();

    const ink = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ink.setAttribute("class", "anno-ink");
    let hasInk = false;

    for (const mark of state.marks) {
      if (mark.page !== index) continue;

      if (mark.kind === "pin") {
        layer.append(pinElement(mark));
        continue;
      }

      if (mark.kind === "ink") {
        const points = mark.points
          .map(([x, y]) => pdf.toPage(index, x, y))
          .filter(Boolean)
          .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
          .join(" ");
        if (!points) continue;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        line.setAttribute("points", points);
        line.setAttribute("stroke", mark.color);
        // 线宽跟着缩放走：按视口尺寸算一个大约 1.5pt 的粗细。
        line.setAttribute("stroke-width", String(Math.max(1, inkWidth(index))));
        ink.append(line);
        hasInk = true;
        continue;
      }

      for (const box of boxesInViewport(mark)) {
        const node = document.createElement("div");
        node.className = `anno anno-${mark.kind}`;
        node.dataset.markId = mark.id;
        node.style.cssText = positionCss(box);
        if (mark.kind === "text") {
          // 一行一条矩形，接缝处会露出细细的白线，稍微放大一点盖住。
          node.style.background = colorWithAlpha(mark.color, 0.42);
        } else {
          node.style.background = colorWithAlpha(mark.color, 0.28);
          node.style.border = `1.5px solid ${colorWithAlpha(mark.color, 0.85)}`;
        }
        node.append(deleteButton(mark.id));
        layer.append(node);
      }
    }

    if (hasInk) layer.append(ink);
  }

  /**
   * 自由笔的线宽（页内像素）。
   *
   * 线宽得**跟着缩放走**：存的是 PDF 点，100% 和 400% 下看着该一样粗。所以先量出「72 个
   * PDF 点在当前视口里有多长」，除以 72 就是「1 个 PDF 点 = 几像素」，再乘上想要的粗细。
   *
   * ⚠️ 取两点的**距离**而不是横坐标之差 —— 页面转 90° 时那个位移整个落到 y 上，
   * 只看 `[0]` 会算出 0（线细成一根头发）。
   */
  function inkWidth(index) {
    const origin = pdf.toPage(index, 0, 0);
    const unit = pdf.toPage(index, 72, 0);
    if (!origin || !unit) return 2;
    const perPoint = Math.hypot(unit[0] - origin[0], unit[1] - origin[1]) / 72;
    return Math.max(1, perPoint * INK_WIDTH_PT);
  }

  function positionCss(box) {
    return [
      `left:${box.x.toFixed(1)}px`,
      `top:${box.y.toFixed(1)}px`,
      `width:${box.width.toFixed(1)}px`,
      `height:${box.height.toFixed(1)}px`,
    ].join(";");
  }

  function deleteButton(id) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "anno-del";
    button.title = "删掉这个标注";
    button.textContent = "×";
    button.addEventListener("pointerdown", (event) => {
      // 别让这一下冒到页面上（那会开始画一个新的）。
      event.stopPropagation();
      removeMark(id);
    });
    return button;
  }

  function pinElement(mark) {
    const at = pdf.toPage(mark.page, mark.at[0], mark.at[1]);
    if (!at) return document.createDocumentFragment();

    const wrap = document.createElement("div");
    wrap.className = "anno anno-pin-wrap";
    wrap.dataset.markId = mark.id;
    wrap.style.cssText = `left:${at[0].toFixed(1)}px;top:${at[1].toFixed(1)}px;width:0;height:0;position:absolute`;

    const hit = document.createElement("div");
    hit.className = "anno-pin-hit";
    hit.title = "点一下看批注，× 删掉";

    const dot = document.createElement("div");
    dot.className = "anno-pin";
    dot.style.background = mark.color;

    const note = document.createElement("div");
    note.className = "anno-pin-note";
    note.textContent = mark.note || "（空的批注）";

    wrap.append(hit, dot, note, deleteButton(mark.id));
    return wrap;
  }

  function removeMark(id) {
    state.marks = state.marks.filter((mark) => mark.id !== id);
    render();
    scheduleSave();
  }

  // ---------------------------------------------------------------- 交互

  /**
   * 给一页挂上画图用的指针事件。
   *
   * ⚠️ 监听挂在**页面元素**上而不是标注层上：标注层是 `pointer-events: none`（那样文字才
   * 选得中），事件本来就落不到它身上。
   */
  function bindPage(index, element) {
    if (element.dataset.annoBound === "1") return;
    element.dataset.annoBound = "1";

    element.addEventListener("pointerdown", (event) => {
      if (state.tool === "pointer" || state.tool === "text") return;
      if (event.button !== 0) return;
      if (state.editing) return;

      // 别让浏览器顺手开始选字 / 拖图片。
      event.preventDefault();
      element.setPointerCapture(event.pointerId);

      const local = localPoint(element, event);
      if (state.tool === "pin") {
        startPin(index, local);
        return;
      }
      state.draft =
        state.tool === "ink"
          ? { index, kind: "ink", points: [local] }
          : { index, kind: state.tool, from: local, to: local };
      renderPage(index, element);
      drawDraft(index, element);
    });

    element.addEventListener("pointermove", (event) => {
      const draft = state.draft;
      if (!draft || draft.index !== index) return;
      const local = localPoint(element, event);

      if (draft.kind === "ink") {
        const last = draft.points[draft.points.length - 1];
        if (Math.hypot(local.x - last.x, local.y - last.y) < INK_MIN_DISTANCE) return;
        draft.points.push(local);
      } else {
        draft.to = local;
      }
      drawDraft(index, element);
    });

    const finish = (event) => {
      const draft = state.draft;
      if (!draft || draft.index !== index) return;
      state.draft = null;
      if (element.hasPointerCapture?.(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      commitDraft(draft, element);
    };
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);

    // 文字选区：**不拦** pointerdown（要让浏览器正常选字），等松开时看选到了什么。
    element.addEventListener("pointerup", () => {
      if (state.tool !== "text") return;
      // 选区在 mouseup 之后才定型，挪到下一个任务里读。
      setTimeout(commitSelection, 0);
    });
  }

  function localPoint(element, event) {
    const box = element.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  /** 拖拽中的预览：直接画一个临时 div，不进 state。 */
  function drawDraft(index, element) {
    const layer = layerOf(element);
    layer.querySelectorAll(".anno-draft").forEach((node) => node.remove());
    const draft = state.draft;
    if (!draft) return;

    if (draft.kind === "ink") {
      const ink = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      ink.setAttribute("class", "anno-ink anno-draft");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", draft.points.map((p) => `${p.x},${p.y}`).join(" "));
      line.setAttribute("stroke", state.color);
      line.setAttribute("stroke-width", String(inkWidth(index)));
      ink.append(line);
      layer.append(ink);
      return;
    }

    const box = boxOf([draft.from.x, draft.from.y], [draft.to.x, draft.to.y]);
    const node = document.createElement("div");
    node.className = `anno anno-${draft.kind} anno-draft`;
    node.style.cssText = positionCss(box);
    node.style.color = state.color;
    node.style.borderRadius = draft.kind === "ellipse" ? "50%" : "2px";
    layer.append(node);
  }

  /** 松手：把草稿换成真正的标注（坐标换算成 PDF 用户空间）。 */
  function commitDraft(draft, element) {
    const toPdf = (point) => pdf.toPdf(draft.index, point.x, point.y);

    if (draft.kind === "ink") {
      const points = draft.points.map(toPdf).filter(Boolean);
      if (points.length > 1) {
        state.marks.push({ id: makeId(), page: draft.index, kind: "ink", color: state.color, points });
      }
    } else {
      // 太小的框多半是手滑点了一下，别留下一个看不见的色块。
      const box = boxOf([draft.from.x, draft.from.y], [draft.to.x, draft.to.y]);
      if (box.width >= 4 && box.height >= 4) {
        const from = toPdf(draft.from);
        const to = toPdf(draft.to);
        if (from && to) {
          state.marks.push({
            id: makeId(),
            page: draft.index,
            kind: draft.kind,
            color: state.color,
            rects: [[from, to]],
          });
        }
      }
    }

    renderPage(draft.index, element);
    scheduleSave();
  }

  /**
   * 文字选区 → 高亮。
   *
   * 选中的是**文字层的 span**（那一层文字是透明的，选中了才看得出），这里把选区的每一个
   * 行盒换算成 PDF 坐标，一行一条矩形。跨页选择会分别落在各自的页上。
   */
  function commitSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const byPage = new Map();
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      for (const clientRect of range.getClientRects()) {
        if (clientRect.width < 2 || clientRect.height < 2) continue;
        const page = pageUnder(clientRect);
        if (!page) continue;
        const box = page.element.getBoundingClientRect();
        const from = pdf.toPdf(page.index, clientRect.left - box.left, clientRect.top - box.top);
        const to = pdf.toPdf(page.index, clientRect.right - box.left, clientRect.bottom - box.top);
        if (!from || !to) continue;
        const list = byPage.get(page.index) ?? [];
        list.push([from, to]);
        byPage.set(page.index, list);
      }
    }

    if (byPage.size === 0) return;
    for (const [page, rects] of byPage) {
      state.marks.push({ id: makeId(), page, kind: "text", color: state.color, rects });
    }
    selection.removeAllRanges();
    render();
    scheduleSave();
  }

  /** 这一块客户端矩形落在哪一页上。 */
  function pageUnder(clientRect) {
    const midX = (clientRect.left + clientRect.right) / 2;
    const midY = (clientRect.top + clientRect.bottom) / 2;
    return (
      state.pages.find(({ element }) => {
        const box = element.getBoundingClientRect();
        return midX >= box.left && midX <= box.right && midY >= box.top && midY <= box.bottom;
      }) ?? null
    );
  }

  // ---------------------------------------------------------------- 图钉的写字框

  function startPin(index, local) {
    const at = pdf.toPdf(index, local.x, local.y);
    if (!at) return;
    openEditor(index, at, local);
  }

  function openEditor(index, at, local) {
    const page = pageOf(index);
    if (!page) return;
    const layer = layerOf(page.element);
    layer.querySelector(".anno-editor")?.remove();

    const editor = document.createElement("div");
    editor.className = "anno-editor";
    editor.style.cssText = `left:${(local.x + 10).toFixed(1)}px;top:${(local.y + 10).toFixed(1)}px`;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "写点什么，回车保存";

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "保存";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";

    const close = () => {
      editor.remove();
      state.editing = null;
      document.removeEventListener("keydown", onKey, true);
    };

    const commit = () => {
      const text = input.value.trim();
      close();
      if (!text) return;
      state.marks.push({
        id: makeId(),
        page: index,
        kind: "pin",
        color: state.color,
        at,
        note: text,
      });
      renderPage(index, page.element);
      scheduleSave();
    };

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };

    save.addEventListener("click", commit);
    cancel.addEventListener("click", close);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
    });

    editor.append(input, save, cancel);
    layer.append(editor);
    state.editing = { index, at };
    document.addEventListener("keydown", onKey, true);
    input.focus();
  }

  // ---------------------------------------------------------------- 工具栏

  function updateToolbar() {
    // 报给宿主的那份状态**归属这个插件**（`extension().setState`）：pdf-viewer 也在报它
    // 自己那几项，不带归属的话两边会互相把对方的表盖掉。
    store.setState({ tool: state.tool, color: state.color }, []);
  }

  floralView.onCommand((message) => {
    if (!message || typeof message !== "object") return;
    if (message.id === "tool" && typeof message.value === "string") {
      state.tool = message.value;
      // 换工具时把没写完的图钉收掉，免得它挂在那儿。
      if (state.editing) {
        document.querySelectorAll(".anno-editor").forEach((node) => node.remove());
        state.editing = null;
      }
      render();
      updateToolbar();
      return;
    }
    if (message.id === "color" && typeof message.value === "string") {
      state.color = message.value;
      updateToolbar();
    }
    if (message.id === "export-pdf") {
      void exportAnnotatedPdf();
    }
  });

  // ---------------------------------------------------------------- 导出带批注的 PDF
  //
  // 把标注写成 **PDF 自己的注释对象**（`/Square` / `/Circle` / `/Ink` / `/Highlight` /
  // `/Text`），另存成一份新文件 —— **原文件一个字都不动**（用户明确要的）。
  //
  // 为什么值得这么做：批注从此不再是「花笺的私有数据」，Edge / Acrobat / WPS 打
  // 开就是真批注；而旁边那份 JSON 仍然留着，应用里继续用。
  //
  // 坐标**直接用落盘的那份**：我们存的是 `viewport.convertToPdfPoint` 的未旋转用户空间，
  // 注释的 `/Rect` 也是这个空间（页面自带的 `/Rotate` 由阅读器再套一层）—— 缩放、旋转
  // 都不会跑偏。

  /** 把 `#rrggbb` 变成 PDF 要的 0~1 三元组。 */
  function toRgb01(hex) {
    const text = String(hex).replace("#", "");
    const full =
      text.length === 3
        ? text
            .split("")
            .map((c) => c + c)
            .join("")
        : text;
    const value = Number.parseInt(full.slice(0, 6), 16);
    if (!Number.isFinite(value)) return [1, 0.83, 0];
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  }

  /** 一对角点 → `[x0, y0, x1, y1]`（PDF 空间里 y 朝上，所以要取极值）。 */
  function rectOf(from, to) {
    return [
      Math.min(from[0], to[0]),
      Math.min(from[1], to[1]),
      Math.max(from[0], to[0]),
      Math.max(from[1], to[1]),
    ];
  }

  /**
   * 一条标注 → 一份注释字典。认不出来的（页面越界、点太少）返回 `null`。
   *
   * `F 4` 是「打印时也画」—— 少了它，注释只出现在屏幕上，打印出来一片干净。
   */
  function annotationOf(context, PDFLib, mark) {
    const { PDFName, PDFString, PDFHexString, PDFNumber } = PDFLib;
    const color = toRgb01(mark.color || "#ffd400");
    const base = {
      Type: PDFName.of("Annot"),
      F: PDFNumber.of(4),
      C: context.obj(color),
      CA: PDFNumber.of(mark.kind === "text" ? 0.45 : 0.35),
    };

    if (mark.kind === "pin") {
      const [x, y] = mark.at;
      // 图标要有个框，不然阅读器不知道该在哪儿画。16 点见方，围着那个点。
      const rect = [x - 8, y - 8, x + 8, y + 8];
      return context.obj({
        ...base,
        Subtype: PDFName.of("Text"),
        Rect: context.obj(rect),
        Name: PDFName.of("Comment"),
        Open: false,
        // ⚠️ 中文要走 UTF-16 的 HexString：`PDFString` 只认 latin1，塞进去就是乱码。
        Contents: PDFHexString.fromText(String(mark.note || "")),
      });
    }

    if (mark.kind === "ink") {
      const points = mark.points.flatMap(([x, y]) => [x, y]);
      if (points.length < 4) return null;
      const xs = mark.points.map(([x]) => x);
      const ys = mark.points.map(([, y]) => y);
      const rect = rectOf([Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]);
      // 线宽存的是…没存。用默认 2 点，跟屏幕上的手感接近。
      return context.obj({
        ...base,
        Subtype: PDFName.of("Ink"),
        Rect: context.obj(rect),
        InkList: context.obj([points]),
        BS: context.obj({ W: PDFNumber.of(2) }),
      });
    }

    const rects = (mark.rects || [])
      .map(([from, to]) => rectOf(from, to))
      .filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0);
    if (rects.length === 0) return null;

    const bounds = rects.reduce(
      (acc, [x0, y0, x1, y1]) => [
        Math.min(acc[0], x0),
        Math.min(acc[1], y0),
        Math.max(acc[2], x1),
        Math.max(acc[3], y1),
      ],
      rects[0],
    );

    if (mark.kind === "text") {
      // `/QuadPoints` 的顺序是：左上、右上、左下、右下（y 朝上）。
      const quads = rects.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]);
      return context.obj({
        ...base,
        Subtype: PDFName.of("Highlight"),
        Rect: context.obj(bounds),
        QuadPoints: context.obj(quads),
      });
    }

    // 矩形 / 圆形：PDF 里叫 Square / Circle（Rectangle 早就废了，Square 就是矩形）。
    return context.obj({
      ...base,
      Subtype: PDFName.of(mark.kind === "ellipse" ? "Circle" : "Square"),
      Rect: context.obj(bounds),
      IC: context.obj(color),
      BS: context.obj({ W: PDFNumber.of(1.5) }),
    });
  }

  async function exportAnnotatedPdf() {
    const PDFLib = globalThis.PDFLib;
    if (!PDFLib) {
      floralView.toast("导出要用到的 pdf-lib 没加载上，先刷新一下插件。");
      return;
    }
    if (state.marks.length === 0) {
      floralView.toast("这一份上还没有任何标注。");
      return;
    }

    let source;
    try {
      source = await requestBytesCopy();
    } catch (error) {
      floralView.log("error", `拿原文件失败：${error?.message ?? error}`);
      floralView.toast("拿不到这份 PDF 的原文件，导出没做成。");
      return;
    }

    let doc;
    try {
      doc = await PDFLib.PDFDocument.load(source, { updateMetadata: false });
    } catch (error) {
      // 加密的、结构特殊的一律在这里失败 —— 明确说出来，别写出一份坏文件。
      floralView.log("error", `读原 PDF 失败：${error?.message ?? error}`);
      floralView.toast("这份 PDF 读不了（可能加过密或者结构特殊），没法导出批注。");
      return;
    }

    const context = doc.context;
    const pages = doc.getPages();
    let written = 0;
    for (const mark of state.marks) {
      const page = pages[mark.page - 1];
      if (!page) continue;
      const annotation = annotationOf(context, PDFLib, mark);
      if (!annotation) continue;

      const existing = page.node.lookupMaybe(PDFLib.PDFName.of("Annots"), PDFLib.PDFArray);
      const array = existing ?? context.obj([]);
      array.push(context.register(annotation));
      page.node.set(PDFLib.PDFName.of("Annots"), array);
      written += 1;
    }

    if (written === 0) {
      floralView.toast("没有一条标注能写进这份 PDF。");
      return;
    }

    let bytes;
    try {
      bytes = await doc.save();
    } catch (error) {
      floralView.log("error", `生成 PDF 失败：${error?.message ?? error}`);
      floralView.toast("生成带批注的 PDF 时出错了。");
      return;
    }

    // `save()` 给的是 Uint8Array，可能挂在一个更大的 buffer 上 —— 按视图切一份干净的。
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    floralView.saveFile(exportedName(state.fileName), buffer);
    floralView.log("info", `已写出 ${written} 条批注`);
  }

  /** `论文.pdf` → `论文-批注.pdf`。没有扩展名就补一个。 */
  function exportedName(name) {
    const base = (name || "文档").replace(/\.pdf$/i, "");
    return `${base}-批注.pdf`;
  }

  // ---------------------------------------------------------------- 起步

  pdf.onPages((pages) => {
    state.pages = pages;
    for (const { index, element } of pages) bindPage(index, element);
    render();
  });

  document.body.dataset.annoTool = state.tool;
  updateToolbar();
})();
