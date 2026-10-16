/**
 * pdf-annotations —— 在 PDF 上做标注（矩形 / 圆形 / 自由笔 / 文字选区 / 图钉批注）。
 *
 * ## 它是怎么挤进 PDF 阅读器里的
 *
 * 它**不注册文件类型**，而是用 `api.files.extendView` 把几样东西并进
 * **pdf-viewer 注册的那个视图**（`pdf-viewer:pdf`）：一份样式、一份脚本，以及顶上工具栏
 * 里属于自己的那几项。宿主把两份 js 拼进**同一个内联 module**、塞进同一张沙箱帧 ——
 * 于是两边共享一个帧，但各包一层 IIFE，互相看不见对方的内部。
 *
 * 两边要说的话全在 `globalThis.floralPdfView` 上（pdf-viewer 显式交出来的一小块）：
 * 页面什么时候重建、以及**两个方向的坐标换算**。没有它，缩放或旋转之后标注就会飘走。
 *
 * ## 数据存在哪
 *
 * `floralView.extension("pdf-annotations")` 给一条**私有数据通道**：宿主把它落到
 * **这个 PDF 旁边**的 `__floral-notepaper__/pdf-annotations/<相对路径>.json` 里。
 * 把 PDF 拷走、发给别人，标注跟着走 —— 而不是锁在这台机器的应用数据目录里。
 * 这条通道要 `workspace:cache` 权限：写的是用户的文件夹，用户该在权限清单里看见它。
 *
 * ⚠️ **`requires: ["pdf-viewer"]`**：宿主会按依赖顺序加载，pdf-viewer 不在时这个插件
 * 根本不会启动 —— 否则它会去扩展一个不存在的视图。
 */
floral.register({
  onLoad(api) {
    api.files.extendView({
      typeId: "pdf-viewer:pdf",
      // 要一条数据通道（标注落在文件旁边）。
      data: true,
      css: ["view/annotate.css"],
      // 顺序有意义：pdf-lib 要在标注脚本之前求值（后者用 `globalThis.PDFLib`）。
      // 它是 UMD，拼进内联 module 时会走 `self.PDFLib = {}` 那条分支 —— 见
      // `scripts/fetch-pdfjs.mjs` 里的说明。
      js: ["vendor/pdf-lib.js", "view/annotate.js"],
      // 顶上那排控件是**两个插件共用**的：这几项接在 pdf-viewer 自己的翻页/缩放之后。
      // `values.tool` / `values.color` 由查看器那边的脚本报回来，按钮上写的就是当前
      // 选中的那一项。
      toolbar: [
        { kind: "separator" },
        {
          kind: "menu",
          id: "tool",
          label: "指针",
          title: "标注方式",
          // `icon` 是插件目录下的相对路径（见 pdf-viewer 里的说明）。菜单的触发按钮
          // 显示的是**当前选中那一项**的图标，所以不必再给它单独配一个。
          options: [
            { value: "pointer", label: "指针", icon: "icons/pointer.svg" },
            { value: "rect", label: "矩形", icon: "icons/rect.svg" },
            { value: "ellipse", label: "圆形", icon: "icons/ellipse.svg" },
            { value: "ink", label: "自由笔", icon: "icons/ink.svg" },
            { value: "text", label: "文字选区", icon: "icons/text.svg" },
            { value: "pin", label: "图钉批注", icon: "icons/pin.svg" },
          ],
        },
        // 「任意取色」：宿主画一个小色块，点开**系统调色盘**。
        // 以前是四个固定色的下拉；颜色这东西是想调就调的，不该被四个色框住。
        // （`menu` + 带 `color` 的选项那种仍然保留 —— 几个常用色一眼看全、点一下就好。）
        { kind: "color", id: "color", title: "标注颜色" },
        // 「导出批注」**不在这排** —— 它是文档级动作，在主窗口顶上那一行，
        // 见下面的 `registerDocumentAction`。
      ],
    });

    /**
     * 「另存为带批注的 PDF」：把标注写成 PDF 自己的注释对象，原文件一个字不动。
     *
     * 🔑 **放在主窗口顶上那一行**（`ui.registerDocumentAction`），不是这一排视图小工具里。
     * 分界线是「这是对这一份文档做的事，还是对这一屏画面做的事」—— 翻页、缩放、选标注
     * 工具都是后者，导出是前者，跟「另存为」「打印」是一类。
     *
     * ⚠️ 真正的活要在**帧里**干（`view/annotate.js` 的 `exportAnnotatedPdf` ——
     * 它拿得到 pdf-lib、原文件字节、和所有标注的坐标），而这段代码跑在 **Worker** 里，
     * 够不到那些东西。所以这里只声称一条命令 id，宿主点到时把 `{t:"command", id}` 转给
     * 当前那个视图帧 —— 与 `view.toolbar` 控件收到的是同一条消息，`annotate.js` 里那句
     * `if (message.id === "export-pdf")` 原样能用。
     *
     * `typeIds` 指名道姓：这条命令只有 pdf-viewer 那个视图认得。没它的话，将来多一个别的
     * 视图插件，打开它也会冒出这个按钮，点下去却什么都发不出去。
     */
    api.ui.registerDocumentAction({
      id: "export-pdf",
      title: "导出批注",
      typeIds: ["pdf-viewer:pdf"],
      viewCommand: "export-pdf",
    });
  },
});
