/**
 * 一条命令产出「可以发布的更新产物」。
 *
 * ```bash
 * npm run release                       # 只产出产物，放在 bundle/nsis/ 下
 * npm run release -- --repo me/floral   # 顺带把 latest.json 里的 URL 写成该仓库的地址
 * ```
 *
 * 产出三样东西（外加安装器本身）：
 *
 * 1. `<产品名>_<版本>_x64-setup.exe`        —— 安装器，给人手动下载用
 * 2. `<产品名>_<版本>_x64-setup.exe.zip`    —— 更新器要的产物：一个**装着安装器的 zip**
 * 3. 上面那个 zip 的 `.sig`                 —— minisign 签名
 * 4. `latest.json`                          —— 更新端点要读的清单
 *
 * ## 为什么自己打包，而不是靠 `createUpdaterArtifacts`
 *
 * 配置里的 `bundle.createUpdaterArtifacts: true` **在这个组合下不生效**（配置位置对、
 * CLI 也认识该字段，但 `tauri build` 只出安装器）。所以这里自己 zip + 签名 —— 这条路
 * 已经端到端验证过（应用真的下载下来并通过了签名校验）。等哪天升级 tauri-cli 之后可以
 * 再回头看那个开关。
 *
 * 产物结构是照 updater 插件源码里的说明来的：
 *
 * ```text
 * [AppName]_[version]_x64-setup.exe.zip
 *   └── [AppName]_[version]_x64-setup.exe
 * ```
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const configPath = join(root, "src-tauri", "tauri.conf.json");

/** 发布仓库。改了仓库就改这一行，或者用 `--repo` / `FLORAL_RELEASE_REPO` 覆盖。 */
const DEFAULT_REPO = "rainbowinter/huajiangongzuoqu";

const args = process.argv.slice(2);
const repoArg = (() => {
  const index = args.findIndex((arg) => arg === "--repo");
  if (index >= 0) return args[index + 1];
  return process.env.FLORAL_RELEASE_REPO ?? DEFAULT_REPO;
})();

const config = JSON.parse(readFileSync(configPath, "utf8"));
const version = config.version;
const productName = config.productName;
const bundleBase = `${productName}_${version}_x64-setup`;
const installer = join(nsisDir, `${bundleBase}.exe`);

/** 私钥：环境变量优先，否则用默认位置。这一步失败就别往下走了。 */
const privateKey =
  process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() ||
  join(homedir(), ".tauri", "floral-notepaper.key");

if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(privateKey)) {
  console.error(
    `[release] 找不到签名私钥：${privateKey}\n` +
      "[release] 用 `npx tauri signer generate -w <路径>` 生成，或用 TAURI_SIGNING_PRIVATE_KEY 指定。",
  );
  process.exit(1);
}

console.log(`[release] 版本 ${version}，产品名 ${productName}`);

// ---------------------------------------------------------------- 1. 构建

// 私钥没有密码时，CLI 仍会交互式地问 —— 必须显式给一个空密码，否则会一直挂着。
const signingEnv = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: privateKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
};

if (args.includes("--skip-build")) {
  console.log("[release] 跳过构建（--skip-build），直接拿现成的安装器重新出产物");
} else {
  console.log("[release] 开始构建（这一步要几分钟）…");
  const build = spawnSync("npm", ["run", "tauri", "--", "build"], {
    cwd: root,
    env: signingEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) {
    console.error(`[release] 构建失败（退出码 ${build.status}）`);
    process.exit(1);
  }
}

if (!existsSync(installer)) {
  console.error(`[release] 找不到安装器：${installer}`);
  process.exit(1);
}

// ------------------------------------------------------- 2. 打更新用的 zip

const zipPath = `${installer}.zip`;
makeZip(installer, zipPath);
console.log(`[release] 已打包 ${zipPath}`);

// ---------------------------------------------------------------- 3. 签名

console.log("[release] 签名中…");
// 用 node 直接跑 CLI 的 JS 入口，不走 `npx`：Windows 上 `.cmd` 不经 shell 是启动不了的
// （execFileSync 会以 `pid: 0` 失败），而把 shell 打开又要操心一整套引号转义。
execFileSync(
  process.execPath,
  [
    join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "signer",
    "sign",
    "-p",
    signingEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    "-f",
    privateKey,
    zipPath,
  ],
  { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
);

const signaturePath = `${zipPath}.sig`;
if (!existsSync(signaturePath)) {
  console.error(`[release] 签名文件没生成：${signaturePath}`);
  process.exit(1);
}
const signature = readFileSync(signaturePath, "utf8").trim();

// ------------------------------------------------------------ 4. latest.json

const assetName = `${bundleBase}.exe.zip`;
const assetUrl = repoArg
  ? `https://github.com/${repoArg}/releases/latest/download/${encodeURIComponent(assetName)}`
  : `https://<把这里换成你的发布地址>/${assetName}`;

const manifest = {
  version,
  notes: process.env.FLORAL_RELEASE_NOTES ?? "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": { signature, url: assetUrl },
  },
};
const manifestPath = join(nsisDir, "latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log("\n[release] 完成。要上传的东西：");
for (const file of [`${bundleBase}.exe`, assetName, `${assetName}.sig`, "latest.json"]) {
  console.log(`  src-tauri/target/release/bundle/nsis/${file}`);
}
if (!repoArg) {
  console.log(
    "\n[release] 注意：这次没给 --repo，latest.json 里的 url 是占位的。\n" +
      "[release] 用 `npm run release -- --repo <用户名>/<仓库>` 可以让它直接写好。",
  );
}
console.log(
  "\n[release] 提醒：更新端点必须是 https，且 endpoints 要填在 tauri.conf.json 里（见 Docs/auto-update.md）。",
);

/** 用 7-Zip（如果装了）或 PowerShell 的 Compress-Archive 打一个 zip。 */
function makeZip(source, destination) {
  const sevenZip = join(process.env["ProgramFiles"] ?? "C:/Program Files", "7-Zip", "7z.exe");

  if (existsSync(sevenZip)) {
    // 在目录里执行，好让 zip 内部的路径就是文件名本身（插件按这个名字找安装器）。
    execFileSync(sevenZip, ["a", "-tzip", destination, source], {
      cwd: dirname(source),
      stdio: "ignore",
    });
    return;
  }

  if (process.platform !== "win32") {
    execFileSync("zip", ["-j", "-q", destination, source], { stdio: "inherit" });
    return;
  }

  mkdirSync(dirname(destination), { recursive: true });
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${source}' -DestinationPath '${destination}' -Force`,
    ],
    { stdio: "inherit" },
  );
}
