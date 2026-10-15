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

// 插件的 js 是**逐字读进来内联**的，源码里出现结束标签会截断宿主拼的文档。
for (const name of ["pdf.global.mjs", "pdf.worker.min.mjs"]) {
  const text = readFileSync(join(vendorDir, name), "utf8");
  if (/<\/script|<!--/.test(text)) {
    throw new Error(`${name} 里有会截断 HTML 的片段（结束标签或 <!--），必须转义后再用`);
  }
}
console.log("[pdfjs] 校验通过：两份文件里都没有会截断内联 <script> 的片段");
