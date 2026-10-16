/**
 * 插件图标的消毒。
 *
 * ## 为什么不能直接用 `sanitizePluginHtml`
 *
 * 那个白名单里**没有 SVG 标签**（`svg` / `path` / `circle`…），而且它放行 `style` 属性 ——
 * 对 HTML 面板够用，对 SVG 就不行了：SVG 里 `<style>`、`<use href>`、`<foreignObject>`
 * 都能绕出去（外链、覆盖整页样式、甚至塞回一段 HTML）。与其放宽那一份，不如给 SVG 单写
 * 一份更严的白名单 —— 形状标签 + 画图属性，别的一律丢掉。
 *
 * ## 它是怎么被用上的
 *
 * 图标**内联进宿主文档**（不是 `<img src>`）：这样能跟着主题色走（作者写
 * `fill="currentColor"`），也不必为几个小图标去动 asset 协议。而"内联进宿主文档"就意味着
 * 它能拿到宿主的 DOM —— 所以这里的白名单是**安全边界**，不是排版偏好。
 *
 * 图标是插件目录里的普通 `.svg` 文件，由 `readPluginAsset` 读成文本（那条路已经限了
 * 类型与体积）。这里只管**内容**。
 */

/** 允许保留的标签。就这几样能画出图标，别的都丢掉。 */
const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "title",
]);

/**
 * 允许保留的属性。
 *
 * 注意**没有**：`href` / `xlink:href`（外链与 `<use>` 的引用）、`style`（能塞 `url()`）、
 * 以及一切 `on*` 事件属性。`transform` 留着 —— 画图标时旋转镜像很常见，而它只接受
 * 一串变换函数，跑不出去。
 */
const ALLOWED_ATTRS = new Set([
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-opacity",
  "opacity",
  "transform",
]);

/** 允许的根标签 —— 不是 `svg` 的整份丢掉。 */
const ROOT_TAG = "svg";

/**
 * 清洗一份 SVG，返回可以直接 `innerHTML` 的字符串。
 *
 * 认不出来、解析失败、根不是 `svg` —— 都返回空串（调用方据此不画图标）。
 */
export function sanitizeSvg(source: string): string {
  if (!source || typeof source !== "string") return "";
  if (typeof DOMParser === "undefined") return "";

  try {
    // `image/svg+xml` 而不是 `text/html`：HTML 解析器会把 `<path>` 当成未知元素、
    // 大小写与自闭合也全乱掉。
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return "";

    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== ROOT_TAG) return "";

    clean(root);

    const markup = new XMLSerializer().serializeToString(root);
    // 万一里面还藏着一段脚本（白名单理论上已经挡住），序列化后再兜一道。
    if (/<script/i.test(markup)) return "";
    return markup;
  } catch {
    return "";
  }
}

function clean(element: Element): void {
  for (const child of [...element.children]) {
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // ⚠️ 这里**整棵子树**都不要（不是把标签换成它的孩子）：`<foreignObject>` 里面
      // 装的就是一段 HTML，放它的孩子进来等于绕开了整个白名单。
      child.remove();
      continue;
    }
    clean(child);
  }

  for (const attribute of [...element.attributes]) {
    const name = attribute.name;
    const lower = name.toLowerCase();
    const allowed =
      ALLOWED_ATTRS.has(name) &&
      // `on*` 一个不留；`xmlns` 由序列化时补，不靠作者写。
      !lower.startsWith("on");
    if (!allowed) element.removeAttribute(name);
  }
}
