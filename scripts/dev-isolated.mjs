/**
 * 隔离调试入口：`npm run dev:isolated`
 *
 * 目的：在机器上已安装了正式版花笺（例如 `C:\Program Files\floral-notepaper_1.0.7`）
 * 并且它正在运行时，源码调试不能干扰那个实例。这里做三件事：
 *
 *  1. `FLORAL_NOTEPAPER_CONFIG_DIR` / `FLORAL_NOTEPAPER_DATA_DIR`
 *     指向项目内的 `.devdata/`，不碰 `%APPDATA%\floral-notepaper\config.json`
 *     与 `Documents\花笺`。
 *  2. `FLORAL_NOTEPAPER_NO_SINGLE_INSTANCE=1`
 *     跳过单实例插件。单实例锁按应用 identifier 生效，否则调试实例会被
 *     已安装实例抢走锁后直接退出，根本起不来。
 *  3. 只跑 `tauri dev`，不跑 `tauri build`。后者的 beforeBuildCommand 里有
 *     `taskkill /F /IM floral-notepaper.exe`，且会产出安装包。
 *
 * 隔离数据目录里的 config.json 需要自行准备（见 Docs/dev-isolated.md）。
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devdata = join(root, ".devdata");
const configDir = join(devdata, "config");
const dataDir = join(devdata, "notes");

mkdirSync(configDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

// 首次运行时从真实配置派生一份模板，并把会互相干扰的字段清空。
const devConfig = join(configDir, "config.json");
if (!existsSync(devConfig) && process.platform === "win32") {
  const appData = process.env.APPDATA;
  const source = appData && join(appData, "floral-notepaper", "config.json");
  if (source && existsSync(source)) {
    copyFileSync(source, devConfig);
    console.log(`[dev:isolated] 已从 ${source} 派生隔离配置，请检查其中以下字段：`);
    console.log("[dev:isolated]   globalShortcut / toggleVisibilityShortcut 应为空");
    console.log("[dev:isolated]   autostart 应为 false");
    console.log("[dev:isolated]   dataDir 应指向 .devdata/notes");
  }
}

const env = {
  ...process.env,
  FLORAL_NOTEPAPER_CONFIG_DIR: configDir,
  FLORAL_NOTEPAPER_DATA_DIR: dataDir,
  FLORAL_NOTEPAPER_NO_SINGLE_INSTANCE: "1",
};

console.log(`[dev:isolated] 配置目录 : ${configDir}`);
console.log(`[dev:isolated] 数据目录 : ${dataDir}`);
console.log("[dev:isolated] 单实例锁 : 已跳过，不会与已安装实例互相影响");

const child = spawn("npm", ["run", "tauri", "--", "dev"], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[dev:isolated] 被信号终止：${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
