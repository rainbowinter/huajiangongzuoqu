import type { FileViewSpec } from "../workspace/fileTypes";

/**
 * 插件视图（沙箱 iframe）与宿主之间的那一层。
 *
 * 视图里跑的是**插件自己的代码**，所以从视图过来的每一条消息都当成不可信输入：
 * 形状要校验、尺寸要设上限，落盘之前宿主还要再过一次权限。安全边界本身
 * （`sandbox="allow-scripts"`）与理由见 `Docs/plugin-view-sandbox.md`。
 *
 * 这个文件是纯函数，不碰 DOM —— 拼 srcdoc 与校验消息都是最容易出错、又最适合单测的部分。
 */

/** 视图 → 宿主。 */
export type ViewMessage =
  | { t: "ready" }
  | { t: "requestDocument" }
  | { t: "saveAnnotations"; data: unknown }
  | { t: "log"; level: "info" | "warn" | "error"; message: string }
  | { t: "toast"; message: string };

/** 宿主 → 视图。 */
export type HostMessage =
  | { t: "init"; name: string; path: string; theme: "light" | "dark" }
  | { t: "document"; bytes: ArrayBuffer }
  | { t: "annotations"; data: unknown }
  | { t: "documentError"; message: string };

/** 单条消息里文本字段的上限。视图是插件代码，不能让它一发就是几百 MB。 */
const MAX_TEXT_LENGTH = 100_000;
/** 批注一次最多交上来这么大（序列化后的字符数）。 */
export const MAX_ANNOTATION_CHARS = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把视图发来的消息校验成 `ViewMessage`；形状不对就返回 `null`（调用方直接丢弃）。
 *
 * 刻意**不做**「尽力理解」：认不出来的一律丢掉，而不是猜一个最接近的。视图那边是插件代码，
 * 猜错了就是拿不可信输入去驱动宿主。
 */
export function parseViewMessage(raw: unknown): ViewMessage | null {
  if (!isRecord(raw)) return null;

  switch (raw.t) {
    case "ready":
      return { t: "ready" };

    case "requestDocument":
      return { t: "requestDocument" };

    case "saveAnnotations": {
      // 尺寸先在这里挡一道（序列化一遍，超了就丢）。真正的落盘上限在 Rust 侧才作数。
      let serialized: string;
      try {
        serialized = JSON.stringify(raw.data ?? null);
      } catch {
        return null;
      }
      if (serialized.length > MAX_ANNOTATION_CHARS) return null;
      return { t: "saveAnnotations", data: raw.data ?? null };
    }

    case "log": {
      const level = raw.level === "warn" || raw.level === "error" ? raw.level : "info";
      const message = typeof raw.message === "string" ? raw.message.slice(0, MAX_TEXT_LENGTH) : "";
      if (!message) return null;
      return { t: "log", level, message };
    }

    case "toast": {
      const message = typeof raw.message === "string" ? raw.message.slice(0, 1000) : "";
      if (!message) return null;
      return { t: "toast", message };
    }

    default:
      return null;
  }
}

/** 防止插件内容里出现 `</script>` 把宿主拼的那一段提前截断。 */
function escapeForScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/** 同理，样式里出现 `</style>` 会把 `<style>` 提前结束。 */
function escapeForStyle(source: string): string {
  return source.replace(/<\/style/gi, "<\\/style");
}

/**
 * 注入给视图的那一小段桥接代码。
 *
 * 视图是一张白纸，连「怎么跟宿主说话」都得宿主给它 —— 插件作者只需要面对
 * `window.floralView` 这几个方法，不必知道 postMessage 的细节。
 */
const VIEW_PRELUDE = `
const floralViewMessage = (payload) => parent.postMessage(payload, "*");
const floralViewListeners = [];
window.floralView = {
  ready: () => floralViewMessage({ t: "ready" }),
  requestDocument: () => floralViewMessage({ t: "requestDocument" }),
  saveAnnotations: (data) => floralViewMessage({ t: "saveAnnotations", data }),
  toast: (message) => floralViewMessage({ t: "toast", message }),
  log: (level, message) => floralViewMessage({ t: "log", level, message }),
  onMessage: (handler) => { floralViewListeners.push(handler); },
};
window.addEventListener("message", (event) => {
  for (const handler of floralViewListeners) {
    try { handler(event.data); } catch (error) { console.error("[view] 处理消息出错", error); }
  }
});
`;

/**
 * 拼出 iframe 的 `srcdoc`。
 *
 * **为什么是内联而不是给一串资源 URL**：帧是 opaque origin，外部 `<script type="module">`
 * 与 `new Worker(assetUrl)` 在那儿都会被 CORS 挡掉（实测，见 `Docs/plugin-view-sandbox.md`）。
 * 内联之后既跑得起来，也不必为了视图去放宽 asset 协议范围 —— 那会逼着我们去掉沙箱。
 *
 * 插件的 js **全部拼进同一个内联 module**：这样它们共享一个模块作用域，
 * 插件把 pdf.js 和它自己的代码分开写也能互相看见。
 */
export function buildViewDocument(options: {
  /** 读好的骨架 HTML（作为 body 的内容）。 */
  html: string;
  /** 读好的样式表，按顺序。 */
  css: string[];
  /** 读好的脚本，按顺序，拼在桥接代码之后。 */
  js: string[];
}): string {
  const styles = options.css.map((sheet) => `<style>${escapeForStyle(sheet)}</style>`).join("\n");
  const script = escapeForScript([VIEW_PRELUDE, ...options.js].join("\n;\n"));

  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    // 视图是插件的界面，不该被外面的样式影响，也不该能点开外部链接。
    '<meta name="color-scheme" content="light dark">',
    "<style>html,body{margin:0;height:100%}body{overflow:hidden}</style>",
    styles,
    "</head><body>",
    options.html,
    `<script type="module">${script}</script>`,
    "</body></html>",
  ].join("\n");
}

/**
 * 判断插件交上来的视图声明是否齐全（缺 html 就没法拼）。
 *
 * 写成类型谓词而不是普通布尔：调用方 `if (!isCompleteViewSpec(spec)) throw` 之后
 * 就能直接当 `spec` 一定存在用，不必再补一次非空断言。
 */
export function isCompleteViewSpec(
  spec: FileViewSpec | undefined,
): spec is FileViewSpec & { html: string } {
  return typeof spec?.html === "string" && spec.html.length > 0;
}
