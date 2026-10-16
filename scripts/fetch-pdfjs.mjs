/**
 * 把 pdf.js 取到 `example-plugins-v2/pdf-viewer/vendor/`。
 *
 * ```bash
 * npm run pdfjs          # 取（已有且校验通过就不动）
 * npm run pdfjs -- --force
 * ```
 *
 * ## 为什么是「取」而不是「进仓库 / 进安装包」
 *
 * 这两个文件加起来 1.7MB，而**安装包里不该有它们**（用户决定：等插件市场通了从市场装）。
 * 所以：仓库里不放（gitignore），由这个脚本按**钉死的版本 + sha256** 取下来，
 * 打包发布插件时现取。
 *
 * ## 为什么要动 pdf.js 的产物
 *
 * 插件视图把插件的 js **全部拼进同一个内联 module**，而 pdf.js 的压缩包用的是
 * `export{Ut as getDocument,…}` —— 那些别名只对「导出名」成立，模块里的真实绑定名是
 * 压缩过的，后面拼进来的代码拿不到它们。压缩包完全自包含（实测 0 条 import）、末尾只有
 * 一条 export，所以这里把它机械地改成 `globalThis.pdfjsLib={…}`，插件的查看器代码就能用
 * `globalThis.pdfjsLib` 了（也省得它依赖任何模块作用域里的名字）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "example-plugins-v2", "pdf-viewer", "vendor");

/** 钉死的版本与哈希。换版本时**两个哈希都要重新核**（不是照着新的抄上去就算了）。 */
const PDFJS_VERSION = "4.10.38";
const BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;
const SOURCES = [
  {
    name: "pdf.min.mjs",
    url: `${BASE}/pdf.min.mjs`,
    sha256: "27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c",
  },
  {
    name: "pdf.worker.min.mjs",
    url: `${BASE}/pdf.worker.min.mjs`,
    sha256: "1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36",
  },
];

/**
 * 文字层要的那几张样式表。
 *
 * ⚠️ **只有 CSS 要单独取，JS 不用**：`TextLayer` 类与它依赖的 `setLayerDimensions` 本来
 * 就在主包里（`pdf.global.mjs` 的导出里有），而**样式一条都没有**（核心构建不带它）。
 * 没有这几条规则的话，文字层的每个 span 都不定位、字号也全丢 —— 选中文字时高亮的位置
 * 会完全对不上。
 *
 * 从 `web/pdf_viewer.css`（100KB，含整套阅读器界面：对话框、编辑器、注释层……）里
 * **只挑 `.textLayer` 开头的顶层规则**，大约 2KB。整份取回来没有意义：里面还有
 * `url(images/*.svg)` 这类引用，而沙箱帧（opaque origin）取不到任何外部资源。
 */
const VIEWER_CSS = {
  name: "pdf_viewer.css",
  url: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/web/pdf_viewer.css`,
  sha256: "f684e5c55f3baa4516519e8e0d4543726ab2c4223a0ded8c71ed9d5bf3782e7b",
};

/**
 * pdf-lib —— 给批注用的（把标注写成 PDF 自己的注释对象，另存一份）。
 *
 * 与 pdf.js 不同，它**不用改产物**：UMD 的外壳是
 *
 * ```js
 * !function(t,e){…}(this, function(t){…})
 * ```
 *
 * 在我们那个内联 module 里，`exports` / `module` / `define` 三个都探测不到（module 作用域
 * 里没有 CommonJS 的那些名字），于是走最后一个分支：`(t = this || self).PDFLib = {}`。
 * 模块顶层的 `this` 是 `undefined`，`|| self` 兜住 —— 最后落在 `self.PDFLib` 上，
 * 与查看器那边用 `globalThis.pdfjsLib` 是同一个套路。
 *
 * ⚠️ 前提是**这份 UMD 的自包含性不变**：不引入别的文件、外壳还是这个样子。下面有断言盯着。
 */
const PDF_LIB_VERSION = "1.17.1";
const PDF_LIB = {
  name: "pdf-lib.min.js",
  url: `https://cdn.jsdelivr.net/npm/pdf-lib@${PDF_LIB_VERSION}/dist/pdf-lib.min.js`,
  sha256: "0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f",
};
/** pdf-lib 是批注插件的依赖，落在**它自己**的 vendor 里。 */
const pdfLibDir = join(root, "example-plugins-v2", "pdf-annotations", "vendor");

const force = process.argv.slice(2).includes("--force");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * `export{a as A,b as B};` → `globalThis.pdfjsLib={A:a,B:b};`
 *
 * 带三条断言：不变量一旦不成立（出现了 import、export 不止一条、或者 export 后面还有
 * 东西），**停下来**而不是硬凑 —— 硬凑出来的东西只会在运行时以一句看不懂的话失败。
 */
function toGlobalAssignment(source, label) {
  if (/^import|[\s;]import[ {*]/m.test(source)) {
    throw new Error(`${label} 里出现了 import —— 内联拼接的前提（自包含）不成立`);
  }

  const matches = [...source.matchAll(/export\{([^}]*)\};?/g)];
  if (matches.length !== 1) {
    throw new Error(`${label} 里期望恰好一条 export，实际 ${matches.length} 条`);
  }

  const match = matches[0];
  if (source.indexOf(match[0]) + match[0].length < source.trimEnd().length) {
    throw new Error(`${label} 的 export 后面还有别的东西，别再往下凑了`);
  }

  const pairs = match[1]
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => {
      const [local, exported] = entry.split(/\s+as\s+/).map((part) => part.trim());
      if (!local || !exported) throw new Error(`${label} 里有看不懂的导出项：${entry}`);
      return `${exported}:${local}`;
    });

  return `${source.slice(0, match.index)}globalThis.pdfjsLib={${pairs.join(",")}};\n`;
}

/**
 * 从整份 `pdf_viewer.css` 里挑出 `.textLayer` 开头的**顶层**规则。
 *
 * 用括号配平逐条扫，而不是正则抠 —— 规则体里既有 `{}`（`@media` 那种）也有嵌套的
 * `:is(...)`，正则一定会在某条上出错，而出错的后果是**悄悄少一条规则**（文字层看起来
 * 能用，只是选中时位置有点偏），那种问题非常难查。
 *
 * 只收顶层：注释编辑器那一大堆 `:is(.annotationEditorLayer …)` 里也写着 `.textLayer`
 * 这个字符串，但那是别的层的事。收进来只是白添几十条永不生效的规则。
 */
function extractTextLayerCss(source) {
  const rules = [];
  let depth = 0;
  let selectorStart = 0;
  let blockStart = -1;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      if (depth === 0) blockStart = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (source.slice(selectorStart, blockStart).trimStart().startsWith(".textLayer")) {
          rules.push(source.slice(selectorStart, index + 1).trim());
        }
        selectorStart = index + 1;
      }
    }
  }

  return `${rules.join("\n\n")}\n`;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const text = await response.text();
  if (!text) throw new Error(`${url} 返回了空内容`);
  return text;
}

mkdirSync(vendorDir, { recursive: true });

const main = SOURCES[0];
const worker = SOURCES[1];

// 主包：下载 → 核哈希 → 转成挂 globalThis 的版本。
const mainPath = join(vendorDir, "pdf.global.mjs");
if (!force && existsSync(mainPath)) {
  console.log(`[pdfjs] 已有 ${mainPath}（--force 可重取）`);
} else {
  console.log(`[pdfjs] 下载 ${main.name} @ ${PDFJS_VERSION}…`);
  const raw = await download(main.url);
  const actual = sha256(raw);
  if (actual !== main.sha256) {
    throw new Error(
      `${main.name} 的 sha256 对不上：\n  期望 ${main.sha256}\n  实际 ${actual}\n` +
        "要么版本号写错了，要么上游重新发布了同一个版本号 —— 都该先人看一眼。",
    );
  }

  const converted = toGlobalAssignment(raw, main.name);
  writeFileSync(mainPath, converted);
  console.log(
    `[pdfjs] 已生成 vendor/pdf.global.mjs（${(converted.length / 1024).toFixed(0)} KB，` +
      `sha256 ${sha256(converted).slice(0, 16)}…）`,
  );
}

// worker：原样落盘（它自己是完整的 module，pdf.js 会用 `new Worker(url,{type:"module"})` 加载）。
const workerPath = join(vendorDir, "pdf.worker.min.mjs");
if (!force && existsSync(workerPath)) {
  console.log(`[pdfjs] 已有 ${workerPath}（--force 可重取）`);
} else {
  console.log(`[pdfjs] 下载 ${worker.name} @ ${PDFJS_VERSION}…`);
  const raw = await download(worker.url);
  const actual = sha256(raw);
  if (actual !== worker.sha256) {
    throw new Error(`${worker.name} 的 sha256 对不上：期望 ${worker.sha256}，实际 ${actual}`);
  }
  writeFileSync(workerPath, raw);
  console.log(`[pdfjs] 已生成 vendor/pdf.worker.min.mjs（${(raw.length / 1024).toFixed(0)} KB）`);
}

// 文字层的样式（只挑 `.textLayer` 那几条，理由见 VIEWER_CSS 的注释）。
const cssPath = join(vendorDir, "text-layer.css");
if (!force && existsSync(cssPath)) {
  console.log(`[pdfjs] 已有 ${cssPath}（--force 可重取）`);
} else {
  console.log(`[pdfjs] 下载 ${VIEWER_CSS.name} @ ${PDFJS_VERSION}…`);
  const raw = await download(VIEWER_CSS.url);
  const actual = sha256(raw);
  if (actual !== VIEWER_CSS.sha256) {
    throw new Error(
      `${VIEWER_CSS.name} 的 sha256 对不上：期望 ${VIEWER_CSS.sha256}，实际 ${actual}`,
    );
  }

  const css = extractTextLayerCss(raw);
  // 抽出来的东西必须**看着像那套规则**：少了主规则的话文字层会一片错位，而不是报错。
  for (const required of [".textLayer{", ".textLayer :is(span,br){", ".textLayer ::selection{"]) {
    if (!css.includes(required)) {
      throw new Error(`抽出来的文字层样式里没有 ${required} —— 上游把选择器写改了？`);
    }
  }
  writeFileSync(cssPath, css);
  console.log(
    `[pdfjs] 已生成 vendor/text-layer.css（${(css.length / 1024).toFixed(1)} KB / ` +
      `整份 ${(raw.length / 1024).toFixed(0)} KB）`,
  );
}

// pdf-lib：给批注插件，原样落盘（UMD 在我们那个内联 module 里直接就能用，见上面的注释）。
mkdirSync(pdfLibDir, { recursive: true });
const pdfLibPath = join(pdfLibDir, "pdf-lib.js");
if (!force && existsSync(pdfLibPath)) {
  console.log(`[pdfjs] 已有 ${pdfLibPath}（--force 可重取）`);
} else {
  console.log(`[pdfjs] 下载 ${PDF_LIB.name} @ ${PDF_LIB_VERSION}…`);
  const raw = await download(PDF_LIB.url);
  const actual = sha256(raw);
  if (actual !== PDF_LIB.sha256) {
    throw new Error(
      `${PDF_LIB.name} 的 sha256 对不上：\n  期望 ${PDF_LIB.sha256}\n  实际 ${actual}\n` +
        "要么版本号写错了，要么上游重新发布了同一个版本号 —— 都该先人看一眼。",
    );
  }

  // 落盘前把 sourceMappingURL 那行去掉：内联进 srcdoc 之后它只会让浏览器去拉一个
  // 取不到的 .map（帧是 opaque origin），白记一条网络错误。
  const cleaned = `${raw.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, "")}\n`;
  // 包装方式一换，上面那套「靠 self 兜底」的推理就不成立了 —— 宁可在这里停下。
  for (const marker of ["!function(", "PDFLib"]) {
    if (!cleaned.includes(marker)) {
      throw new Error(`${PDF_LIB.name} 里找不到 ${marker} —— 上游换了包装方式，别再按老样子拼`);
    }
  }
  writeFileSync(pdfLibPath, cleaned);
  console.log(
    `[pdfjs] 已生成 pdf-annotations/vendor/pdf-lib.js（${(cleaned.length / 1024).toFixed(0)} KB）`,
  );
}

// 插件的 js / css 是**逐字读进来内联**的，源码里出现结束标签会截断宿主拼的文档。
for (const name of ["pdf.global.mjs", "pdf.worker.min.mjs", "text-layer.css"]) {
  const text = readFileSync(join(vendorDir, name), "utf8");
  if (name.endsWith(".css")) {
    if (/<\/style/i.test(text)) {
      throw new Error(`${name} 里有 </style>，会截断宿主拼的 <style>`);
    }
    continue;
  }
  if (/<\/script|<!--/.test(text)) {
    throw new Error(`${name} 里有会截断 HTML 的片段（结束标签或 <!--），必须转义后再用`);
  }
}
// pdf-lib 同样会被逐字内联（它在批注插件的 js 列表里）。
{
  const text = readFileSync(pdfLibPath, "utf8");
  if (/<\/script|<!--/.test(text)) {
    throw new Error("pdf-lib.js 里有会截断 HTML 的片段（结束标签或 <!--），必须转义后再用");
  }
}

console.log("[pdfjs] 校验通过：四份文件里都没有会截断内联标签的片段");
