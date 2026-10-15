/**
 * GitHub Release 的创建与资产上传。应用发版与插件市场都用它。
 *
 * 用 REST API 而不是 `gh`（不保证装了）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API_VERSION = "2022-11-28";

/**
 * token 从哪来：环境变量优先，其次读 `~/.tauri/github-token.txt`。
 *
 * 留一个文件兜底是因为「设了环境变量但当前进程读不到」很常见（Windows 的 `setx` 只对
 * **之后新起**的进程生效，而外层应用早就启动了）。文件放在 `~/.tauri/` —— 和签名私钥
 * 同一个地方，**在仓库之外**，不会被提交进去。
 */
export function resolveToken({
  envNames = ["FLORAL_RELEASE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"],
  fileEnv = "FLORAL_RELEASE_TOKEN_FILE",
  scopes = "Contents: Read and write",
} = {}) {
  for (const name of envNames) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }

  const tokenFile = process.env[fileEnv] ?? join(homedir(), ".tauri", "github-token.txt");
  if (existsSync(tokenFile)) {
    try {
      const value = readFileSync(tokenFile, "utf8").trim();
      if (value) return value;
    } catch {
      // 读不动就当没有 —— 下面会把怎么给 token 说清楚。
    }
  }

  return "";
}

/** 没找到 token 时打给用户看的说明。 */
export function tokenHelp() {
  return (
    "需要一个 GitHub token，但没找到。两种给法：\n" +
    "  1) 环境变量 FLORAL_RELEASE_TOKEN（或 GITHUB_TOKEN）\n" +
    `  2) 写进文件 ${join(homedir(), ".tauri", "github-token.txt")}（推荐，重启应用也还在）\n` +
    "token 用 fine-grained，只勾这个仓库的 Contents: Read and write。**别写进仓库。**"
  );
}

/**
 * 建（或复用）一个 Release，把资产传上去。
 *
 * 要注意的都在这：
 *
 * * **同名资产已存在时要先删再传**，否则 API 会 422。
 * * 二进制走 `uploads.github.com`，不是 `api.github.com`。
 * * `draft` / `prerelease` 由调用方决定 —— 应用的更新端点用的是
 *   `releases/latest/download/…`，指不到草稿与预发布；插件市场的地址是**带 tag 的**
 *   固定地址，所以那边可以随意。
 *
 * @param {{repo: string, tag: string, title: string, body?: string,
 *          files: Array<{name: string, path: string}>, token: string,
 *          draft?: boolean, prerelease?: boolean, log?: (line: string) => void}} options
 * @returns {Promise<string>} Release 的网页地址
 */
export async function uploadReleaseAssets(options) {
  const {
    repo,
    tag,
    title,
    body = "",
    files,
    token,
    draft = false,
    prerelease = false,
    log = console.log,
  } = options;

  const api = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "floral-notepaper-release",
  };

  const request = async (url, init = {}) => {
    const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `${init.method ?? "GET"} ${url} → ${response.status} ${text.slice(0, 300)}`,
      );
    }
    return response.status === 204 ? null : response.json();
  };

  let release = await fetch(`${api}/releases/tags/${tag}`, { headers }).then((response) =>
    response.ok ? response.json() : null,
  );

  if (!release) {
    log(`[github] 新建 Release ${tag}…`);
    release = await request(`${api}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_name: tag, name: title, body, draft, prerelease }),
    });
  } else {
    log(`[github] Release ${tag} 已存在，复用（资产按名字覆盖）`);
  }

  const existing = new Map((release.assets ?? []).map((asset) => [asset.name, asset.id]));

  for (const file of files) {
    if (existing.has(file.name)) {
      log(`[github] 删除同名旧资产 ${file.name}`);
      await request(`${api}/releases/assets/${existing.get(file.name)}`, { method: "DELETE" });
    }

    const payload = readFileSync(file.path);
    log(`[github] 上传 ${file.name}（${(payload.length / 1048576).toFixed(2)} MB）…`);
    await request(
      `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(payload.length),
        },
        body: payload,
      },
    );
  }

  return `https://github.com/${repo}/releases/tag/${tag}`;
}
