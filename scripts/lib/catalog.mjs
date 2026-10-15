/**
 * 插件清单的读写与更新。**纯函数**，发布脚本只负责日志与网络。
 *
 * 单独成模块的理由与仓库里其他地方一样：这些规则（版本能不能比、能不能重复发布、
 * catalogVersion 怎么走）都是判据，值得被测试钉住，而不该埋在一条到处 `console.log`
 * 的脚本里。清单的形状必须与 Rust 侧 `plugins/market/catalog.rs` 的 DTO 对得上，
 * `catalog.test.ts` 里有一条专门盯这个的用例。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 清单格式版本。与 Rust 的 `CATALOG_SCHEMA` 必须一致。 */
export const SCHEMA = 1;

/** 版本号拆成数字段（与宿主 `sync::version_segments` 同一条规则）。拆不出来返回 `null`。 */
export function segments(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  // 预发布与构建后缀不参与比较：`1.1.0-beta.2` 与 `1.1.0` 同版。
  const core = trimmed.split(/[-+]/)[0] ?? trimmed;
  const parts = core.split(".");
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  return parts.map(Number);
}

/** 这个版本号能不能参与比较。**发布前必须为真** —— 比不了大小的版本号在应用里没法判新旧。 */
export function comparableVersion(value) {
  return segments(value) !== null;
}

/** 标准约定：`a > b` 返回正数。拆不出数字段的一律当相等（排序时保持原位）。 */
export function compareVersions(a, b) {
  const left = segments(a);
  const right = segments(b);
  if (!left || !right) return 0;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function emptyCatalog() {
  return { schema: SCHEMA, catalogVersion: 0, plugins: [] };
}

/** 图标源文件的大小上限。与宿主的 `manifest::MAX_ICON_BYTES` 一致。 */
export const MAX_ICON_BYTES = 32 * 1024;
/** 允许的图标扩展名（白名单 —— 这个内容会被内联进清单、渲染成 `<img>`）。 */
const ICON_EXTENSIONS = ["svg", "png", "jpg", "jpeg"];

/**
 * 把插件目录里的图标读成 **data URL**，内联进清单。
 *
 * 为什么内联而不是让发布脚本把图标也传上去、清单里写个地址：清单是一份**签过名的静态
 * 文件**，内联之后图标也跟着被签名覆盖（换个图标必须重新签名），而且应用打开市场时不会
 * 为了一堆小图标额外发请求，离线也能看。图标本身很小，几 KB。
 *
 * 读不到、扩展名不对、太大 → 返回 `null`（界面用默认图标），**不报错**：图标是装饰，
 * 不该拦着发布。
 */
export function readIconDataUrl(pluginDir, relativePath) {
  if (!relativePath || typeof relativePath !== "string") return null;

  const relative = relativePath.trim();
  // 相对路径的安全检查与宿主一致：不许绝对路径、不许 `..`、不许反斜杠与 `:`。
  if (!relative || relative !== relativePath.trim()) return null;
  if (relative.startsWith("/") || relative.includes("\\") || relative.includes(":")) return null;
  if (relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  const extension = relative.split(".").pop()?.toLowerCase() ?? "";
  if (!ICON_EXTENSIONS.includes(extension)) return null;

  const path = join(pluginDir, relative);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;

  const mime =
    extension === "png"
      ? "image/png"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : "image/svg+xml";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** 解析一份已有清单；格式不认识就抛错（别硬着头皮往上写）。 */
export function readCatalog(raw) {
  const catalog = JSON.parse(raw);
  if (catalog.schema !== SCHEMA) {
    throw new Error(`清单的 schema 是 ${catalog.schema}，本脚本只认 ${SCHEMA}`);
  }
  if (!Array.isArray(catalog.plugins)) {
    throw new Error("清单里没有 plugins 数组");
  }
  return catalog;
}

/** 写回文件的字节。签名覆盖的就是这些字节，所以**序列化只有这一个入口**。 */
export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/**
 * 造一条 release。
 *
 * ⚠️ **键名与 Rust 侧 DTO 一一对应**（那边是 `rename_all = "camelCase"`）。这条契约由
 * `catalog.test.ts` 钉住：键名写错的话应用会解不出来，而那种失败在发布时是看不见的。
 */
export function buildRelease(input) {
  const { version, apiVersion, url, sha256, size, permissions } = input;

  return {
    version,
    apiVersion,
    url,
    sha256,
    size,
    permissions,
    // 可选字段干脆不写：清单是给人看、也可能给人手改的，一串 `null` 只是噪音。
    ...(input.minAppVersion ? { minAppVersion: input.minAppVersion } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    publishedAt: input.publishedAt,
  };
}

/** 在清单里找到（或新建）某个插件的条目。 */
export function upsertPlugin(catalog, meta) {
  let entry = catalog.plugins.find((item) => item.name === meta.name);
  if (!entry) {
    entry = { name: meta.name, description: meta.description, releases: [] };
    catalog.plugins.push(entry);
  }

  // 描述/作者跟着 plugin.json 走：作者改了简介，不该因为「条目已存在」而留在旧文案上。
  entry.description = meta.description;
  if (meta.author) entry.author = meta.author;
  if (meta.homepage) entry.homepage = meta.homepage;

  // 图标**完全跟着 plugin.json**：这一版把 icon 去掉了，清单里那条也要跟着没
  // （`undefined` 在序列化时会被丢掉）。不然用户会看到一个已经不存在的旧图标。
  entry.icon = meta.icon ?? undefined;

  return entry;
}

/**
 * 往条目里加一版，版本从新到旧排。
 *
 * **同一个版本不许发第二次**（除非 `force`）：每个版本对应一个不可变 tag，清单里的
 * sha256 才对得上。允许覆盖的话，同一版本两次发布可以是不一样的文件，而「已装 1.2.0」
 * 的机器永远不知道自己装的是哪一份。
 */
export function addRelease(entry, release, options = {}) {
  const { force = false } = options;
  const index = entry.releases.findIndex((item) => item.version === release.version);

  if (index >= 0 && !force) {
    throw new Error(
      `${entry.name} ${release.version} 已经在清单里了。要改内容就发下一个版本号；` +
        "上一次发布卡在半路时加 --force 重来。",
    );
  }

  if (index >= 0) entry.releases[index] = release;
  else entry.releases.push(release);

  entry.releases.sort((a, b) => compareVersions(b.version, a.version));

  return entry;
}

/**
 * 抬一格 `catalogVersion`。
 *
 * 这是应用**防回滚**的水位线：不抬的话，新清单会被它当成旧清单拒掉（签名只保证来源，
 * 不保证最新）。
 */
export function bumpCatalog(catalog, generatedAt) {
  catalog.catalogVersion = (catalog.catalogVersion ?? 0) + 1;
  catalog.generatedAt = generatedAt;
  return catalog.catalogVersion;
}

/** 插件按名字排，纯粹为了人看清单时顺眼。 */
export function catalogPluginsSort(catalog) {
  const plugins = catalog.plugins ?? [];
  catalog.plugins = plugins;
  plugins.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return catalog;
}
