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

/** 插件名的形状。数据通道按它归属，所以这一层也要挡一道。 */
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** 视图 → 宿主。 */
export type ViewMessage =
  | { t: "ready" }
  | { t: "requestDocument" }
  /**
   * 要一份**独立的**文件字节副本（扩展插件用）。
   *
   * ⚠️ 为什么要单独来一条：`document` 那条消息里的 ArrayBuffer 是**大家共用的同一个**，
   * 而 pdf.js 拿到手之后会把它**转移给 worker** —— 转移过的 buffer 在原处就作废了
   * （`byteLength` 变 0，构造任何视图都报 "detached ArrayBuffer"）。查看器先拿到、
   * 先用，扩展插件后拿到就已经是一份废纸。所以扩展要自己**另要一份**（宿主每次都会重新
   * 从磁盘读）。
   */
  | { t: "requestDocumentCopy" }
  /** 这个文件上、**某个插件**的数据（批注这类）。见 `HostMessage.data`。 */
  | { t: "saveData"; plugin: string; data: unknown }
  | { t: "log"; level: "info" | "warn" | "error"; message: string }
  | { t: "toast"; message: string }
  /**
   * 视图要把一份**字节**存到用户选的位置（「另存为带批注的 PDF」这种）。
   *
   * ⚠️ 这不是「插件可以随便写文件」：宿主会弹**原生的保存对话框**，路径由用户挑、
   * 文件名由用户看着。插件只能提出「我想存这份东西」，拍板的是人。
   * 见 `Docs/plugin-api.md` 里 `floralView.saveFile` 那一节。
   */
  | { t: "saveFile"; name: string; bytes: ArrayBuffer }
  /**
   * 工具栏要显示的东西。`values[id]` 覆盖那一项的显示文本（按钮也能覆盖，于是
   * 「单页 / 连续」这种一个按钮两种状态不必拆成两个），`pressed` 是点亮的开关 id。
   *
   * ⚠️ `plugin` 不能省：一个视图里可能同时跑着两个插件的代码，各报各的状态。不带归属
   * 的话，后报的那份会把前一份**整张表**盖掉（「缩放比例」被涂掉那种）。
   */
  | { t: "state"; plugin: string | null; values: Record<string, string>; pressed: string[] };

/** 宿主 → 视图。 */
export type HostMessage =
  | {
      t: "init";
      name: string;
      path: string;
      theme: "light" | "dark";
      /**
       * 应用主题的调色板（`--color-*` 的**解析值**）。视图是独立文档，拿不到宿主的
       * CSS 变量，用户改了主题/强调色它也看不见 —— 所以由宿主把值递进去。
       */
      tokens: Record<string, string>;
    }
  | { t: "document"; bytes: ArrayBuffer }
  /** 上面那条的「另给扩展一份」版本。与 `document` 分开，免得查看器又重开一次文档。 */
  | { t: "documentCopy"; bytes: ArrayBuffer }
  /**
   * 已存的那份数据（打开文件时按插件各推一份）。`plugin` 说是谁的。
   *
   * ⚠️ 视图里可能同时跑着**两个插件**的代码（被扩展的视图 + 扩展它的插件），所以数据
   * 必须带归属 —— 否则扩展插件分不清哪份是自己的。
   */
  | { t: "data"; plugin: string; data: unknown }
  | { t: "documentError"; message: string }
  /**
   * 用户改了主题（深浅色 / 主题色 / 自定义颜色）。
   *
   * 与 `init` 分开的**一条独立消息**：`init` 在插件那边意味着「重新来一遍」
   * （PDF 查看器收到就会重开文档、回到第一页），换主题时可不能这么干。
   */
  | { t: "theme"; theme: "light" | "dark"; tokens: Record<string, string> }
  /** 工具栏被点了。`value` 只有输入框会用。 */
  | { t: "command"; id: string; value?: string };

/** 单条消息里文本字段的上限。视图是插件代码，不能让它一发就是几百 MB。 */
const MAX_TEXT_LENGTH = 100_000;
/** 批注一次最多交上来这么大（序列化后的字符数）。 */
export const MAX_ANNOTATION_CHARS = 4 * 1024 * 1024;
/**
 * 「另存为」一次最多交上来多少字节。
 *
 * 256MB：比任何正常的 PDF 都宽，而它挡的是「插件把内存当硬盘用」——字节要在宿主的
 * 对话框与 IPC 之间整个搬一遍，没有上限就等于把界面的命交给插件。
 */
const MAX_SAVE_FILE_BYTES = 256 * 1024 * 1024;
/** 文件名长度上限（原始名，宿主还会再洗一遍）。 */
const MAX_SAVE_FILE_NAME = 200;
/** 一次 `state` 最多带几项、每项多长。工具栏本就十几个控件，多了就是有人在灌。 */
const MAX_STATE_ENTRIES = 32;
const MAX_STATE_KEY = 48;
const MAX_STATE_VALUE = 200;

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

    case "requestDocumentCopy":
      return { t: "requestDocumentCopy" };

    case "saveData": {
      const plugin = typeof raw.plugin === "string" ? raw.plugin : "";
      if (!PLUGIN_NAME_PATTERN.test(plugin)) return null;
      // 尺寸先在这里挡一道（序列化一遍，超了就丢）。真正的落盘上限在 Rust 侧才作数。
      let serialized: string;
      try {
        serialized = JSON.stringify(raw.data ?? null);
      } catch {
        return null;
      }
      if (serialized.length > MAX_ANNOTATION_CHARS) return null;
      return { t: "saveData", plugin, data: raw.data ?? null };
    }

    case "saveFile": {
      const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_SAVE_FILE_NAME) : "";
      if (!name) return null;
      // ⚠️ 只认 **ArrayBuffer**，不认 Uint8Array / 数字数组：视图那边来自 `pdfDoc.save()`
      // 的就是 ArrayBuffer，别的一律当成形状不对（结构克隆会原样把类型带过来）。
      if (!(raw.bytes instanceof ArrayBuffer)) return null;
      if (raw.bytes.byteLength === 0 || raw.bytes.byteLength > MAX_SAVE_FILE_BYTES) return null;
      return { t: "saveFile", name, bytes: raw.bytes };
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

    case "state": {
      // 两个字段都不是形状对的对象/数组，就是一条空消息 —— 丢掉。
      if (!isRecord(raw.values) && !Array.isArray(raw.pressed)) return null;
      // 没带 `plugin` 就是视图所有者自己；带了就必须是个像样的名字。
      const plugin =
        raw.plugin === undefined || raw.plugin === null
          ? null
          : typeof raw.plugin === "string" && PLUGIN_NAME_PATTERN.test(raw.plugin)
            ? raw.plugin
            : undefined;
      if (plugin === undefined) return null;
      const values: Record<string, string> = {};
      if (isRecord(raw.values)) {
        for (const [key, value] of Object.entries(raw.values).slice(0, MAX_STATE_ENTRIES)) {
          if (key.length === 0 || key.length > MAX_STATE_KEY) continue;
          if (typeof value !== "string") continue;
          values[key] = value.slice(0, MAX_STATE_VALUE);
        }
      }
      const pressed = Array.isArray(raw.pressed)
        ? raw.pressed
            .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_STATE_KEY)
            .slice(0, MAX_STATE_ENTRIES)
        : [];
      return { t: "state", plugin, values, pressed };
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
const floralCommandHandlers = [];
const floralDataListeners = [];
window.floralView = {
  ready: () => floralViewMessage({ t: "ready" }),
  requestDocument: () => floralViewMessage({ t: "requestDocument" }),
  /**
   * 另要一份文件字节（**扩展插件**用，见 viewBridge.ts 里 requestDocumentCopy 的说明）。
   * 收到的是一条 t 为 documentCopy、带 bytes 的消息。
   */
  requestDocumentCopy: () => floralViewMessage({ t: "requestDocumentCopy" }),
  toast: (message) => floralViewMessage({ t: "toast", message }),
  /**
   * 把一份字节存到用户选的位置 —— 宿主会弹原生保存对话框，用户挑路径、看文件名。
   * 插件拿不到路径，也写不了别的地方：这是「导出」，不是「写文件」。
   */
  saveFile: (name, bytes) => floralViewMessage({ t: "saveFile", name, bytes }),
  log: (level, message) => floralViewMessage({ t: "log", level, message }),
  onMessage: (handler) => { floralViewListeners.push(handler); },
  // 宿主那排工具栏：点是点在宿主上，命令从这儿进来。
  onCommand: (handler) => { floralCommandHandlers.push(handler); },
  // 工具栏要显示什么也由视图说：values 覆盖各项文本（按钮的也能盖），pressed 是点亮的开关。
  setState: (values, pressed) => floralViewMessage({ t: "state", values: values || {}, pressed: pressed || [] }),
  /**
   * 这个文件上、**属于某个插件**的数据（批注这类）。
   *
   * 一个视图里可能同时跑着两个插件的代码（被扩展的 + 扩展它的），所以数据要按插件分开：
   * 各写各的，各收各的。**名字是自己报的** —— 宿主认不了「你到底是哪个插件」，这一点写在
   * 文档里：扩展方与被扩展方本来就共享同一个沙箱帧，属于同一个信任域。
   */
  extension: (plugin) => ({
    write: (data) => floralViewMessage({ t: "saveData", plugin, data }),
    onData: (handler) => { floralDataListeners.push({ plugin, handler }); },
    // 工具栏上属于这个插件的那几项要显示什么，也**按插件各报各的** —— 不带名字的话，
    // 两边各报一次就把对方那张表整个盖掉了。
    setState: (values, pressed) => floralViewMessage({ t: "state", plugin, values: values || {}, pressed: pressed || [] }),
  }),
};
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.t === "command") {
    for (const handler of floralCommandHandlers) {
      try { handler(data); } catch (error) { console.error("[view] 处理命令出错", error); }
    }
  }
  if (data.t === "data") {
    for (const entry of floralDataListeners) {
      if (entry.plugin !== data.plugin) continue;
      try { entry.handler(data.data); } catch (error) { console.error("[view] 处理数据出错", error); }
    }
  }
  for (const handler of floralViewListeners) {
    try { handler(data); } catch (error) { console.error("[view] 处理消息出错", error); }
  }
});
`;

/**
 * worker 源码那个块的 id。**插件作者要在自己的视图代码里读它**，所以这是一个约定：
 *
 * ```js
 * const source = document.getElementById("floral-worker-src").textContent;
 * pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
 * ```
 *
 * （写成 `type="text/plain"` 是为了**不执行**它 —— 那份文件是给 worker 用的。）
 */
export const VIEW_WORKER_ELEMENT_ID = "floral-worker-src";

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
  /**
   * 读好的 worker 源码：塞进一个 `type="text/plain"` 的块里，**不执行**，
   * 只等插件自己读出来做成 blob（见 `VIEW_WORKER_ELEMENT_ID`）。
   */
  worker?: string;
}): string {
  const styles = options.css.map((sheet) => `<style>${escapeForStyle(sheet)}</style>`).join("\n");
  const script = escapeForScript([VIEW_PRELUDE, ...options.js].join("\n;\n"));
  const worker = options.worker
    ? [
        `<script type="text/plain" id="${VIEW_WORKER_ELEMENT_ID}">`,
        escapeForScript(options.worker),
        "</script>",
        "",
      ].join("")
    : "";

  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    // 视图是插件的界面，不该被外面的样式影响，也不该能点开外部链接。
    '<meta name="color-scheme" content="light dark">',
    "<style>html,body{margin:0;height:100%}body{overflow:hidden}</style>",
    styles,
    "</head><body>",
    options.html,
    // worker 的源码放在主脚本**之前**：插件在模块求值时就能读到它。
    worker,
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
