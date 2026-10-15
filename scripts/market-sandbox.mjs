/**
 * 插件市场的**本地沙箱**：让「看列表 → 确认权限 → 安装 → 卸载」这条路在真实应用里跑一遍。
 *
 * ```bash
 * node scripts/market-sandbox.mjs            # 起了之后按住它，另开一个终端跑它打印的命令
 * ```
 *
 * 它做四件事：
 *
 * 1. 把 `example-plugins-v2/` 里每个插件打成 zip（**只是本机演示**，不上传任何地方）；
 * 2. 造一份清单并用 `~/.tauri/market-test.key`（**测试密钥**，与生产私钥无关）签名；
 * 3. 在回环端口上托管清单、签名与那些 zip，**把每个请求打出来** —— 于是「应用真的去下载了」
 *    这件事是看得见的，而不是我们假设的；
 * 4. 把配置覆盖写进 `.devdata/market-override.json`，并打印启动隔离实例的命令。
 *
 * ## 为什么不直接改 `tauri.conf.json`
 *
 * 端点与应用公钥是**构建期配置**，改了会进仓库、也会影响正式构建。这里走
 * `tauri dev --config <文件>` 合并一份临时的覆盖文件（写在 `.devdata/` 里，已被 gitignore），
 * 应用本身一个字都不动。
 *
 * ## 演示的是哪一条链路
 *
 * 逻辑层（下载、验签、解压、原子落盘、状态）已经有 Rust 测试与本地 HTTP 端到端测试盯着。
 * **这个脚本补的是另外一段**：配置读取 → 命令 → IPC → 前端渲染 —— 那一段只有在真实运行时
 * 里才走得到。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signFile } from "./lib/sign.mjs";
import { makeZip } from "./lib/zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.findIndex((arg) => arg === name);
  return index >= 0 ? args[index + 1] : undefined;
};

const requestedPort = Number(flagValue("--port") ?? 0);
const keyPath = flagValue("--key") ?? join(homedir(), ".tauri", "market-test.key");
const pluginsRoot = join(root, "example-plugins-v2");
const workDir = join(root, ".devdata", "market-sandbox");

// ---------------------------------------------------------------- 0. 测试密钥

if (!existsSync(keyPath)) {
  console.log(`[sandbox] 没有测试密钥，正在生成：${keyPath}`);
  const generated = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
      "signer",
      "generate",
      "-w",
      keyPath,
      "-p",
      "",
      "--ci",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (generated.status !== 0) {
    console.error("[sandbox] 生成测试密钥失败。可以自己跑：");
    console.error(`[sandbox]   npx tauri signer generate -w "${keyPath}" -p "" --ci`);
    process.exit(1);
  }
}

const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();

// ---------------------------------------------------------------- 1. 打 zip

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** 路径 → 响应体。目录清单式的托管，不必起一个真静态服务器。 */
const files = new Map();

function addFile(name, body) {
  files.set(`/${name}`, body);
}

const releases = [];
for (const name of readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()) {
  const dir = join(pluginsRoot, name);
  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) {
    console.log(`[sandbox] 跳过 ${name}：没有 plugin.json`);
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.log(`[sandbox] 跳过 ${name}：plugin.json 读不了（${error.message}）`);
    continue;
  }

  const version = String(manifest.version ?? "").trim() || "0.0.0";
  const zipName = `${name}-${version}.zip`;
  const zipPath = join(workDir, zipName);
  // 在父目录里打包 → zip 内部是 `<名字>/…`，正是宿主要求的那一层顶层目录。
  makeZip(dir, zipPath, { cwd: pluginsRoot, quiet: true });

  const bytes = readFileSync(zipPath);
  addFile(zipName, bytes);

  releases.push({
    plugin: {
      name,
      description: String(manifest.description ?? ""),
      ...(manifest.author ? { author: String(manifest.author) } : {}),
      ...(manifest.homepage ? { homepage: String(manifest.homepage) } : {}),
    },
    // `url` 里的端口要等服务器真的绑上才知道，先占个位，下面再补。
    release: {
      version,
      apiVersion: Number(manifest.apiVersion ?? 1),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      permissions: manifest.permissions ?? [],
      publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
  });
}

if (releases.length === 0) {
  console.error(`[sandbox] ${pluginsRoot} 里没有可用的插件`);
  process.exit(1);
}

// ---------------------------------------------------------------- 2. 起服务器

const server = createServer((request, response) => {
  const path = request.url ?? "/";
  // **把每个请求打出来**：日志就是「应用真的去下载了」的证据。
  console.log(`[sandbox] ← ${request.method} ${path}`);

  const body = files.get(path);
  if (!body) {
    response.writeHead(404, { "Content-Length": "0" });
    response.end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": path.endsWith(".json") ? "application/json" : "application/octet-stream",
    "Content-Length": String(body.length),
    Connection: "close",
  });
  response.end(body);
});

await new Promise((done) => server.listen(requestedPort, "127.0.0.1", done));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`[sandbox] 清单与插件包托管在 ${base}`);

// ---------------------------------------------------------------- 3. 造清单

const catalog = {
  schema: 1,
  // 每次跑都抬一格：应用记住了上一次的水位，用固定的低版本号会被它当成回滚拒掉。
  catalogVersion: Math.floor(Date.now() / 1000),
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  plugins: releases.map(({ plugin, release }) => ({
    ...plugin,
    releases: [{ ...release, url: `${base}/${plugin.name}-${release.version}.zip` }],
  })),
};

const catalogPath = join(workDir, "plugin-catalog.json");
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
addFile("plugin-catalog.json", readFileSync(catalogPath));

console.log("[sandbox] 签名清单中…");
// 走 `lib/sign.mjs`：它顺带处理了「环境变量里的私钥与 `-f` 打架」那个坑（见其注释）。
signFile({ root, privateKey: keyPath, password: "", file: catalogPath });
if (!existsSync(`${catalogPath}.sig`)) {
  console.error("[sandbox] 签名失败");
  process.exit(1);
}
addFile("plugin-catalog.json.sig", readFileSync(`${catalogPath}.sig`));

for (const { plugin, release } of releases) {
  console.log(`[sandbox] ${plugin.name} ${release.version}（apiVersion ${release.apiVersion}）`);
}

// ---------------------------------------------------------------- 4. 配置覆盖

const overridePath = join(root, ".devdata", "market-override.json");
mkdirSync(dirname(overridePath), { recursive: true });
writeFileSync(
  overridePath,
  `${JSON.stringify(
    {
      plugins: {
        market: {
          endpoints: [`${base}/plugin-catalog.json`],
          // ⚠️ 这是**测试公钥**。放进正式配置的话，应用就再也验不过真正的清单了。
          pubkey: publicKey,
        },
      },
    },
    null,
    2,
  )}\n`,
);

console.log(
  "\n[sandbox] 现在另开一个终端，**先 cd 到仓库目录**再起隔离实例（不会碰正式安装的那个应用）：\n" +
    "\n   PowerShell（必须写 npm.cmd —— 它的执行策略默认拦掉 npm.ps1）：" +
    `\n       cd ${root}` +
    `\n       npm.cmd run dev:isolated -- --config .devdata/market-override.json` +
    "\n\n   Git Bash / cmd：" +
    `\n       cd ${toPosixPath(root)}` +
    `\n       npm run dev:isolated -- --config .devdata/market-override.json` +
    "\n\n[sandbox] 然后：右侧栏 → 插件 → 市场（没配市场时这个页签根本不出现）。",
);
console.log("[sandbox] 这里会实时打出应用发过来的每个请求。Ctrl+C 结束。\n");

/** `E:\a\b` → `/e/a/b`，只是为了把能在 Git Bash 里粘贴的路径打出来。 */
function toPosixPath(path) {
  const posix = path.replace(/\\/g, "/");
  return posix.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`);
}
