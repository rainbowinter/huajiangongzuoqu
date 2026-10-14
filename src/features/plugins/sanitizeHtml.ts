/**
 * 插件面板 HTML 的消毒。
 *
 * **为什么这是必需的，而不是可选的「加固」**：`MainWindow` 用
 * `dangerouslySetInnerHTML` 把面板 HTML 注入主世界 DOM。插件里一句
 * `<img src=x onerror="window.__TAURI_INTERNALS__.invoke('config_save',…)">`
 * 就能直接在宿主权限下执行——沙箱 Worker 的意义会被完全绕过。
 * `capabilities/default.json` 又把 `dialog:allow-*`、`clipboard-manager:allow-*-text`、
 * `opener:default` 授予了所有窗口，没有 per-plugin ACL 兜底，所以注入即是接管。
 *
 * 这里用 `DOMParser` 做白名单清洗：解析成游离文档后逐节点过滤，再序列化回来。
 * 游离文档里的 `<img>` 不会真的发起请求，因此解析阶段本身是安全的。
 *
 * 这是**过渡方案**。更彻底的做法是把 v2 面板放进
 * `<iframe sandbox="allow-scripts">`（不加 allow-same-origin，得到 opaque origin），
 * 那是后续工作。
 */

const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "button", "code", "dd", "div", "dl", "dt",
  "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "kbd", "label",
  "li", "mark", "ol", "p", "pre", "s", "section", "select", "option", "small", "span",
  "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

/** 允许保留的属性（无 `on*`，那类属性一律丢弃）。 */
const ALLOWED_ATTRS = new Set([
  "class", "id", "title", "style", "value", "type", "name", "placeholder", "disabled",
  "checked", "selected", "role", "aria-label", "aria-hidden", "aria-expanded",
  "href", "src", "alt", "width", "height", "target", "rel", "colspan", "rowspan",
  "data-index", "data-id", "data-key", "data-value",
]);

/**
 * 允许在 `href` / `src` 上出现的协议。
 *
 * `data:` 只允许图片，否则 `data:text/html` 就能当导航载体。
 */
function isSafeUrl(raw: string): boolean {
  const value = raw.trim().toLowerCase();

  if (value.startsWith("javascript:") || value.startsWith("vbscript:")) return false;
  if (value.startsWith("data:")) return /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(value);

  return true;
}

/** `style` 里可能藏 `url(javascript:…)` 或旧 IE 的 `expression()`。 */
function sanitizeStyle(value: string): string {
  return value
    .replace(/expression\s*\(/gi, "")
    .replace(/url\s*\(\s*['"]?\s*(javascript|vbscript|data):[^)]*\)/gi, "")
    .replace(/behavior\s*:/gi, "")
    .replace(/@import/gi, "");
}

function sanitizeElement(element: Element): void {
  for (const child of Array.from(element.children)) {
    const tag = child.tagName.toLowerCase();

    // 不在白名单里的元素整棵丢掉，而不是展开子节点——展开会给 `<script>` 制造机会。
    if (!ALLOWED_TAGS.has(tag)) {
      child.remove();
      continue;
    }

    for (const attribute of Array.from(child.attributes)) {
      const name = attribute.name.toLowerCase();

      if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) {
        child.removeAttribute(attribute.name);
        continue;
      }

      if ((name === "href" || name === "src") && !isSafeUrl(attribute.value)) {
        child.removeAttribute(attribute.name);
        continue;
      }

      if (name === "style") {
        child.setAttribute("style", sanitizeStyle(attribute.value));
      }
    }

    // 外链统一加 rel，避免被 window.opener 反向控制。
    if (tag === "a" && child.hasAttribute("href")) {
      child.setAttribute("rel", "noreferrer noopener");
    }

    sanitizeElement(child);
  }
}

/**
 * 清洗插件产出的 HTML，返回可安全注入主世界的字符串。
 *
 * 解析失败（不是合法 HTML 片段）时返回空串，宁可什么都不显示也不要冒险注入。
 */
export function sanitizePluginHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return "";

  try {
    const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
    const root = doc.getElementById("root");
    if (!root) return "";

    sanitizeElement(root);
    return root.innerHTML;
  } catch (error) {
    console.error("[plugins] 面板 HTML 清洗失败", error);
    return "";
  }
}
