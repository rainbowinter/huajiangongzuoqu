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
      js: ["view/annotate.js"],
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
        {
          kind: "menu",
          id: "color",
          label: "颜色",
          title: "标注颜色",
          options: [
            { value: "#ffd400", label: "黄", color: "#ffd400" },
            { value: "#9bd67c", label: "绿", color: "#9bd67c" },
            { value: "#7cc7ff", label: "蓝", color: "#7cc7ff" },
            { value: "#ff9ec4", label: "粉", color: "#ff9ec4" },
          ],
        },
      ],
    });
  },
});
