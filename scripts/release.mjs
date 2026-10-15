/**
 * 一条命令产出「可以发布的更新产物」。
 *
 * ```bash
 * npm run release                  # 构建 + 打包 + 签名 + 写 latest.json
 * npm run release -- --skip-build  # 产物不满意时，不重新构建只重出
 * ```
 *
 * 产物统一放在 `src-tauri/target/release/upload-<版本>/`，四个文件一次拖进 GitHub Release 即可。
 *
 * ## 为什么产物名是纯 ASCII
 *
 * Tauri 打出来的安装器叫 `花笺_<版本>_x64-setup.exe`。**这个中文名不能在发布资产里用**：
 * GitHub 上传后会把开头的「花笺」吃掉，实际存成 `_2.0.1_x64-setup.exe.zip`，
 * 于是 `latest.json` 里写的 URL 直接 404 —— 更新器下载不到任何东西，
 * 而这个失败是**静默**的（界面上什么都不会发生）。
 * 已经实测踩过一次（v2.0.1 首发），所以这里一律换成 ASCII 名字再上传。
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
 * <ASCII 名>_x64-setup.exe.zip
 *   └── <ASCII 名>_x64-setup.exe
 * ```
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToken, tokenHelp, uploadReleaseAssets } from "./lib/github.mjs";
import { assertPrivateKeyExists, readSignature, resolvePrivateKey, signFile } from "./lib/sign.mjs";
import { makeZip } from "./lib/zip.mjs";

/** 发布仓库。改了仓库就改这一行，或者用 `--repo` / `FLORAL_RELEASE_REPO` 覆盖。 */
const DEFAULT_REPO = "rainbowinter/huajiangongzuoqu";

/** 发布资产的名字前缀，**必须是纯 ASCII**（见文件头的说明）。 */
const ASSET_SLUG = "floral-notepaper";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const configPath = join(root, "src-tauri", "tauri.conf.json");

const args = process.argv.slice(2);
const repoArg = (() => {
  const index = args.findIndex((arg) => arg === "--repo");
  if (index >= 0) return args[index + 1];
  return process.env.FLORAL_RELEASE_REPO ?? DEFAULT_REPO;
})();

const config = JSON.parse(readFileSync(configPath, "utf8"));
const version = config.version;
const productName = config.productName;

/** Tauri 打出来的那个安装器（名字带中文，只用来当输入，不直接上传）。 */
const builtInstaller = join(nsisDir, `${productName}_${version}_x64-setup.exe`);

/** 上传用的名字，全 ASCII。 */
const assetBase = `${ASSET_SLUG}_${version}_x64-setup`;
const uploadDir = join(root, "src-tauri", "target", "release", `upload-${version}`);

/** 私钥：环境变量优先，否则用默认位置。 */
const privateKey = resolvePrivateKey({ fallback: join(homedir(), ".tauri", "floral-notepaper.key") });
assertPrivateKeyExists(privateKey);

console.log(`[release] 版本 ${version}，产品名 ${productName}`);
console.log(`[release] 上传用名 ${assetBase}.exe[.zip]`);

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

if (!existsSync(builtInstaller)) {
  console.error(`[release] 找不到安装器：${builtInstaller}`);
  process.exit(1);
}

// -------------------------------------------- 2. 用 ASCII 名字重整一份产物

rmSync(uploadDir, { recursive: true, force: true });
mkdirSync(uploadDir, { recursive: true });

const installer = join(uploadDir, `${assetBase}.exe`);
copyFileSync(builtInstaller, installer);

const zipPath = `${installer}.zip`;
// 在安装器所在目录里执行，好让 zip 内部的路径就是文件名本身（更新器按这个名字找安装器）。
makeZip(installer, zipPath, { cwd: dirname(installer), quiet: true });
console.log(`[release] 已打包 ${zipPath}`);

// ---------------------------------------------------------------- 3. 签名

console.log("[release] 签名中…");
signFile({
  root,
  privateKey,
  password: signingEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  file: zipPath,
});

const signaturePath = `${zipPath}.sig`;
if (!existsSync(signaturePath)) {
  console.error(`[release] 签名文件没生成：${signaturePath}`);
  process.exit(1);
}
const signature = readSignature(signaturePath);

// ------------------------------------------------------------ 4. latest.json

const assetName = `${assetBase}.exe.zip`;
const assetUrl = `https://github.com/${repoArg}/releases/latest/download/${assetName}`;

const manifest = {
  version,
  notes: process.env.FLORAL_RELEASE_NOTES ?? "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": { signature, url: assetUrl },
  },
};
writeFileSync(join(uploadDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// ---------------------------------------------------------------- 5. 收尾

const uploadFiles = [`${assetBase}.exe`, assetName, `${assetName}.sig`, "latest.json"];

console.log(`\n[release] 产物就绪（目录：src-tauri/target/release/upload-${version}/）：`);
for (const file of uploadFiles) {
  console.log(`    ${file}`);
}
console.log(`[release] url 写的是：${assetUrl}`);

// ---------------------------------------------------------------- 6. 上传

const token = resolveToken();

if (args.includes("--upload")) {
  if (!token) {
    console.error(`\n[release] --upload ${tokenHelp()}`);
    process.exit(1);
  }

  // **必须发成正式 Release**（draft / prerelease 都为 false）：更新端点是
  // `releases/latest/download/…`，草稿与预发布都不会被它指到。
  await uploadReleaseAssets({
    repo: repoArg,
    tag: `v${version}`,
    title: `${productName} ${version}`,
    body: manifest.notes,
    token,
    draft: false,
    prerelease: false,
    files: uploadFiles.map((name) => ({ name, path: join(uploadDir, name) })),
    log: (line) => console.log(line.replace("[github]", "[release]")),
  })
    .then((url) => {
      console.log(`\n[release] 上传完成：${url}`);
      console.log("[release] 装了这个版本之后的机器，下次发版就会自动收到提示。");
    })
    .catch((error) => {
      console.error(`\n[release] 上传失败：${error.message}`);
      process.exit(1);
    });
} else {
  console.log("\n[release] 没带 --upload，上面四个文件请手工拖进 GitHub Release。");
  console.log("[release] 想一条命令发完，设好 token 后加 --upload。");
}
