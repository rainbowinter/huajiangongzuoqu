/**
 * 把一个插件发布到插件市场。
 *
 * ```bash
 * npm run plugin -- --dir example-plugins-v2/pdf-viewer
 * npm run plugin -- --dir example-plugins-v2/pdf-viewer --upload
 * ```
 *
 * 干的四件事：
 *
 * 1. 按约定打 zip —— **恰好一层顶层目录，名字等于插件名**（`pdf-viewer/plugin.json`）。
 *    宿主那边就是这么校验的（见 `market/archive.rs`），不对的话装不进去。
 * 2. 算 sha256、写进清单。
 * 3. **用私钥签清单**（与应用自更新同一套 minisign 密钥体系）。
 * 4. `--upload` 时：zip 传到 `plugin-<名字>-v<版本>` 这个**不可变 tag**，清单传到固定
 *    tag `catalog`。
 *
 * ## 为什么不覆盖已发布的版本
 *
 * 每个版本一个 tag、tag 不可变，清单里的 sha256 才对得上 —— 否则同一版本两次发布的内容
 * 可以不一样，而「已装 1.2.0」的机器永远不知道自己装的是哪一份。要改就发 `1.2.1`。
 * 上一次发布卡在半路（zip 传上去了、清单没更新）时用 `--force` 重来。
 *
 * ## 版本号从哪来
 *
 * **只从插件的 `plugin.json` 读**，不另开一个 `--version`：两处写版本号迟早会不一致，
 * 而不一致的后果是「装上去的版本和清单里写的不是一个」。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addRelease,
  buildRelease,
  bumpCatalog,
  catalogPluginsSort,
  comparableVersion,
  emptyCatalog,
  readCatalog,
  readIconDataUrl,
  serializeCatalog,
  upsertPlugin,
} from "./lib/catalog.mjs";
import { resolveToken, tokenHelp, uploadReleaseAssets } from "./lib/github.mjs";
import { assertPrivateKeyExists, readSignature, resolvePrivateKey, signFile } from "./lib/sign.mjs";
import { makeZip } from "./lib/zip.mjs";

const SCHEMA = 1;
/** 清单文件名。**这个名字会成为 URL 的最后一段**，应用会去取 `<它>.sig`。 */
const CATALOG_ASSET = "plugin-catalog.json";
/** 清单放在这个固定 tag 下，于是地址永久稳定（不用 latest 那种会变的）。 */
const CATALOG_TAG = "catalog";
const MAX_NAME_LENGTH = 64;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogDir = join(root, "plugin-market");
const catalogPath = join(catalogDir, CATALOG_ASSET);

const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.findIndex((arg) => arg === name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dirArg = flagValue("--dir");
if (!dirArg) {
  console.error(
    "用法：npm run plugin -- --dir <插件目录> [--repo owner/name] [--notes 说明] [--upload] [--force]",
  );
  process.exit(1);
}

/**
 * 插件仓库。**不给默认值**：猜错了会往一个不存在的仓库传东西（或者更糟，传进别人的），
 * 而「先建好仓库再把地址给它」本来就是一次性的动作。
 */
const repo = flagValue("--repo") ?? process.env.FLORAL_PLUGIN_REPO ?? "";
if (!repo) {
  console.error(
    "需要插件仓库地址（owner/name）。两种给法：\n" +
      "  --repo rainbowinter/huajiangongzuo-plugins\n" +
      "  环境变量 FLORAL_PLUGIN_REPO\n" +
      "仓库可以是空的，但必须已经存在。",
  );
  process.exit(1);
}

const pluginDir = resolve(root, dirArg);
if (!existsSync(join(pluginDir, "plugin.json"))) {
  console.error(`找不到 ${join(pluginDir, "plugin.json")}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 1. 校验清单

const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
const name = basename(pluginDir);
const version = String(manifest.version ?? "").trim();
const apiVersion = Number(manifest.apiVersion ?? 1);

/** 与宿主的 `validate_plugin_name` 同一条规则：名字会直接变成目录名。 */
function checkName(value) {
  if (!value || value.length > MAX_NAME_LENGTH) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

const problems = [];
if (manifest.name !== name) {
  problems.push(
    `plugin.json 里的 name 是「${manifest.name}」，但目录名是「${name}」—— 目录名才是标识`,
  );
}
if (!checkName(name)) {
  problems.push(`插件名不合法（只允许字母数字与 . _ -，首字符必须是字母或数字）：${name}`);
}
if (apiVersion < 2) {
  problems.push(
    `apiVersion 是 ${apiVersion}。v1 跑在主线程里没有沙箱，市场**只收 v2**，装不进去。`,
  );
}
if (!comparableVersion(version)) {
  problems.push(
    `版本号「${version}」没法比较（只允许 1.2.3 这种数字段，可以有 -beta 后缀）。` +
      "比不了大小的版本号在应用里没法判断新旧。",
  );
}
if (!/\.(js|mjs)$/i.test(String(manifest.main ?? ""))) {
  problems.push(`入口不是 JavaScript：${manifest.main}`);
} else if (!existsSync(join(pluginDir, String(manifest.main)))) {
  problems.push(`入口文件不存在：${manifest.main}`);
}
if (problems.length > 0) {
  console.error("[plugin] 这个插件现在发布不了：");
  for (const problem of problems) console.error(`    · ${problem}`);
  process.exit(1);
}

warnAboutUnknownPermissions(manifest.permissions ?? []);

// ---------------------------------------------------------------- 2. 打 zip

const distDir = join(root, "plugin-market", "dist");
mkdirSync(distDir, { recursive: true });
const zipName = `${name}-${version}.zip`;
const zipPath = join(distDir, zipName);
rmSync(zipPath, { force: true });

// 在**父目录**里打包，于是 zip 内部的路径是 `pdf-viewer/…` —— 正是宿主要求的
// 「恰好一层顶层目录，名字等于插件名」。
makeZip(pluginDir, zipPath, { cwd: dirname(pluginDir), quiet: true });

const zipBytes = readFileSync(zipPath);
const sha256 = createHash("sha256").update(zipBytes).digest("hex");
console.log(`[plugin] 已打包 ${zipName}（${(zipBytes.length / 1024).toFixed(1)} KB，sha256 ${sha256.slice(0, 16)}…）`);

// ---------------------------------------------------------------- 3. 更新清单

let catalog;
try {
  catalog = existsSync(catalogPath)
    ? readCatalog(readFileSync(catalogPath, "utf8"))
    : emptyCatalog();
} catch (error) {
  console.error(`[plugin] 读不了 ${CATALOG_ASSET}：${error.message}`);
  process.exit(1);
}

const publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const release = buildRelease({
  version,
  apiVersion,
  url: `https://github.com/${repo}/releases/download/plugin-${name}-v${version}/${zipName}`,
  sha256,
  size: zipBytes.length,
  permissions: manifest.permissions ?? [],
  ...(manifest.minAppVersion ? { minAppVersion: String(manifest.minAppVersion) } : {}),
  ...(flagValue("--notes") ? { notes: flagValue("--notes") } : {}),
  publishedAt,
});

const entry = upsertPlugin(catalog, {
  name,
  description: String(manifest.description ?? ""),
  ...(manifest.author ? { author: String(manifest.author) } : {}),
  ...(manifest.homepage ? { homepage: String(manifest.homepage) } : {}),
  // 图标内联进清单：市场在**装之前**也得有图可看，而那时本地还没有这个插件的文件。
  icon: readIconDataUrl(pluginDir, manifest.icon),
});

try {
  addRelease(entry, release, { force: args.includes("--force") });
} catch (error) {
  console.error(`[plugin] ${error.message}`);
  process.exit(1);
}

catalogPluginsSort(catalog);
bumpCatalog(catalog, publishedAt);

writeFileSync(catalogPath, serializeCatalog(catalog));
console.log(`[plugin] 清单已更新（catalogVersion ${catalog.catalogVersion}）`);

// ---------------------------------------------------------------- 4. 签名

const privateKey = resolvePrivateKey({ fallback: join(homedir(), ".tauri", "floral-notepaper.key") });
assertPrivateKeyExists(privateKey);

console.log("[plugin] 签名清单中…");
signFile({ root, privateKey, password: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "", file: catalogPath });

const signaturePath = `${catalogPath}.sig`;
const signature = readSignature(signaturePath);
console.log(`[plugin] 签名已写入 ${CATALOG_ASSET}.sig`);

printEndpointConfig({ repo, privateKey });
printManualUploadInstructions({ repo, name, version, zipPath, signature });

// ---------------------------------------------------------------- 5. 上传

if (args.includes("--upload")) {
  const token = resolveToken();
  if (!token) {
    console.error(`\n[plugin] --upload ${tokenHelp()}`);
    process.exit(1);
  }

  await uploadReleaseAssets({
    repo,
    tag: `plugin-${name}-v${version}`,
    title: `${name} ${version}`,
    body: release.notes ?? "",
    token,
    files: [{ name: zipName, path: zipPath }],
    log: (line) => console.log(line.replace("[github]", "[plugin]")),
  })
    .then((url) => console.log(`\n[plugin] 插件包已发布：${url}`))
    .catch((error) => {
      console.error(`\n[plugin] 上传失败：${error.message}`);
      process.exit(1);
    });

  // 清单最后传：先传清单的话，应用会先看到一份指向「还没传上去的 zip」的清单。
  await uploadReleaseAssets({
    repo,
    tag: CATALOG_TAG,
    title: "插件清单",
    token,
    files: [
      { name: CATALOG_ASSET, path: catalogPath },
      { name: `${CATALOG_ASSET}.sig`, path: signaturePath },
    ],
    log: (line) => console.log(line.replace("[github]", "[plugin]")),
  })
    .then((url) =>
      console.log(
        `\n[plugin] 清单已发布：${url}\n[plugin] 应用里的更新端点就是上面那个 catalog 地址。`,
      ),
    )
    .catch((error) => {
      console.error(
        `\n[plugin] 清单上传失败：${error.message}\n` +
          "[plugin] 清单没更新的话，应用看到的还是上一份 —— 修好之后重跑一次上传即可" +
          "（zip 已经传上去了，不必担心重复）。",
      );
      process.exit(1);
    });
} else {
  console.log("\n[plugin] 没带 --upload。zip 与清单都在 plugin-market/ 下，可以手工传。");
}

// ---------------------------------------------------------------- 辅助

/**
 * 权限词汇表只存在于前端（`src/features/plugins/permissions.ts`）。这里读它一遍只为**提醒**
 * 拼错的权限名 —— 宿主遇到不认识的权限只会忽略（界面上标成「不认识」），不会报错，
 * 所以发布时提一句是唯一能拦住手滑的地方。
 */
function warnAboutUnknownPermissions(permissions) {
  if (permissions.length === 0) return;

  const source = join(root, "src", "features", "plugins", "permissions.ts");
  let known = null;
  if (existsSync(source)) {
    const text = readFileSync(source, "utf8");
    const block = /export const PERMISSIONS = \[([\s\S]*?)\] as const/.exec(text)?.[1] ?? "";
    known = new Set([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  }

  if (!known) return;
  const unknown = permissions.filter((permission) => !known.has(permission));
  if (unknown.length > 0) {
    console.warn(
      `[plugin] ⚠️ 这些权限当前版本不认识，装进应用里不会生效：${unknown.join("、")}\n` +
        "[plugin] 确认没拼错的话，可能是应用要更新到支持它的版本。",
    );
  }
}

/** 把该抄进 `tauri.conf.json` 的那段打出来。 */
function printEndpointConfig({ repo, privateKey }) {
  // `.pub` 就躺在私钥旁边，**它的内容本身就是配置要的那个 base64** ——
  // `tauri.conf.json` 里的 `plugins.updater.pubkey` 与这个文件逐字节相同（实测）。
  // ⚠️ 别再做一次 base64：那是双层编码，应用会报「公钥解析失败：Invalid encoding」。
  const pubkeyPath = `${privateKey}.pub`;
  const publicKey = existsSync(pubkeyPath)
    ? readFileSync(pubkeyPath, "utf8").trim()
    : "<私钥旁边那个 .pub 文件的内容，原样>";

  console.log(
    "\n[plugin] 应用里要这样配置（`src-tauri/tauri.conf.json` 的 plugins.market）：\n" +
      JSON.stringify(
        {
          market: {
            endpoints: [
              `https://github.com/${repo}/releases/download/${CATALOG_TAG}/${CATALOG_ASSET}`,
            ],
            pubkey: publicKey,
          },
        },
        null,
        2,
      )
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );
}

function printManualUploadInstructions({ repo, name, version, zipPath, signature }) {
  console.log("\n[plugin] 手工上传的话，两个 Release：");
  console.log(`    tag plugin-${name}-v${version}：上传 ${basename(zipPath)}`);
  console.log(`    tag ${CATALOG_TAG}：上传 ${CATALOG_ASSET} 与 ${CATALOG_ASSET}.sig`);
  console.log(`    仓库：https://github.com/${repo}`);
  console.log(`    清单签名（前 40 字符）：${signature.slice(0, 40)}…`);
}
