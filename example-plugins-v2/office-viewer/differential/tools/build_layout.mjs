/**
 * 把 differential/tools/layout-entry.js 打成浏览器可加载的模块。
 * 与插件自己的 build.mjs 同构，但入口不同、输出到 out/。
 *
 *   node differential/tools/build_layout.mjs
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, "..", "..", "..", "..");
const output = join(here, "..", "out", "layout-engine.js");

const bundle = await rolldown({
  input: join(here, "layout-entry.js"),
  platform: "browser",
});

await bundle.write({ file: output, format: "esm" });
await bundle.close();

const size = statSync(output).size;
console.log(`out/layout-engine.js  ${(size / 1024).toFixed(1)} KB  (project: ${project})`);
