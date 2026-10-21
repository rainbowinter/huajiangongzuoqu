/**
 * 把编辑重放器打成浏览器可加载的模块。
 *
 *   node differential/tools/build_edit.mjs
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "..", "out", "edit-engine.js");

const bundle = await rolldown({
  input: join(here, "edit-entry.js"),
  platform: "browser",
});

await bundle.write({ file: output, format: "esm" });
await bundle.close();

const size = statSync(output).size;
console.log(`out/edit-engine.js  ${(size / 1024).toFixed(1)} KB`);
