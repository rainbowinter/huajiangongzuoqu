/**
 * 把 `src/` 打成 `view/viewer.js`。
 *
 * 宿主的插件视图会把 `view.js` 里列的文件**拼进同一个内联 module**，所以插件只交一个
 * bundle 最干净：源码可以拆模块，分发时还是一个文件。
 *
 * ```bash
 * node example-plugins-v2/office-viewer/build.mjs
 * ```
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "view", "viewer.js");

const bundle = await rolldown({
  input: join(root, "src", "main.js"),
  platform: "browser",
});

await bundle.write({
  file: output,
  format: "esm",
});

await bundle.close();

const size = statSync(output).size;
console.log(`view/viewer.js  ${(size / 1024).toFixed(1)} KB`);
