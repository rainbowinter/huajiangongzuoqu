/**
 * pdf-viewer（v2）—— 让 `.pdf` 在花笺里打开。
 *
 * 这个插件本身**不读文件、也不渲染任何东西**：它只登记一条「pdf 归谁管」的规则，
 * 外加一份**视图声明**（html / css / js / worker 的路径，以及顶上那排控件）。
 * 真正的渲染发生在宿主给它的沙箱视图里（`sandbox="allow-scripts"` 的 iframe），
 * 文件字节由宿主读好之后递进去 —— 插件拿不到路径，也够不到文件系统。
 *
 * 两个权限是分开的：
 *
 * * `files:register` —— 登记扩展名规则（侧栏能认出 `.pdf`）；
 * * `files:view` —— 交出会在沙箱里**真的跑起来**的代码（能画 canvas）。比前者能力强，
 *   所以单独可撤销：用户不想让插件跑自己的界面时，撤掉它就能让视图失效，而不必停用整个插件。
 *
 * ⚠️ `vendor/` 里的两个文件是 pdf.js，**不在仓库里**（1.7MB，也不进安装包）。
 * 跑 `npm run pdfjs` 取下来，见 `Docs/pdf-viewer.md`。
 */
floral.register({
  onLoad(api) {
    api.files.registerType({
      id: "pdf",
      extensions: ["pdf"],
      label: "PDF",
      badge: "PDF",
      // PDF 的惯用红，卡片左侧那条竖标一眼能认出来。
      color: "#c0392b",
      kind: "view",
      view: {
        html: "view/index.html",
        css: ["view/viewer.css"],
        // 顺序有意义：pdf.js 先（它把自己挂到 globalThis.pdfjsLib 上），查看器后。
        js: ["vendor/pdf.global.mjs", "view/viewer.js"],
        // worker 的**源码**。宿主会把它当成文本塞进视图（不执行），查看器自己读出来
        // 做成 blob 再 new Worker —— 帧是 opaque origin，直接给地址会被 CORS 挡掉。
        worker: "vendor/pdf.worker.min.mjs",
        // 顶上那排控件。**宿主渲染**：视图是沙箱里的一块孤岛，自己画工具栏的话跟窗口的
        // 排版对不齐（而且得等 pdf.js 解析完才出得来）；交给宿主画，位置与样式就跟
        // Markdown 那排格式化按钮一模一样，进页面就能点。
        //
        // 交互只有两条路：这里声明 id，宿主点了发 `command` 进来，查看器用 `setState`
        // 把当前状态报回去（values 覆盖各项文字、pressed 点亮开关）。
        // 文件名**不在**这里 —— 标题栏里已经有了。
        toolbar: [
          { kind: "button", id: "zoom-out", label: "−", title: "缩小" },
          { kind: "readout", id: "zoom", title: "缩放比例" },
          { kind: "button", id: "zoom-in", label: "+", title: "放大" },
          { kind: "button", id: "fit-width", label: "适应宽度", title: "按宽度铺满", toggle: true },
          { kind: "separator" },
          { kind: "button", id: "page-prev", label: "‹", title: "上一页" },
          { kind: "readout", id: "page", title: "当前页 / 总页数" },
          { kind: "button", id: "page-next", label: "›", title: "下一页" },
          { kind: "input", id: "goto", title: "跳转到页（回车）", placeholder: "页码", width: 46 },
          { kind: "separator" },
          { kind: "button", id: "spread", label: "连续", title: "单页 / 连续", toggle: true },
          { kind: "button", id: "rotate", label: "⟳", title: "顺时针旋转 90°" },
          { kind: "readout", id: "rotation", title: "旋转角度" },
        ],
      },
    });
  },
});
