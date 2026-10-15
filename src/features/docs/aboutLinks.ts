/**
 * 从**更新源地址**推出发布页地址。
 *
 * 更新源长这样（见 `tauri.conf.json` 的 `plugins.updater.endpoints`）：
 *
 * ```text
 * https://github.com/<用户名>/<仓库>/releases/latest/download/latest.json
 * ```
 *
 * 而人想看的是这一页：
 *
 * ```text
 * https://github.com/<用户名>/<仓库>/releases
 * ```
 *
 * 从更新源推、而不是再写死一个常量：**只有一个事实来源**。将来换仓库时改一处就够，
 * 不会出现「更新源换了、关于面板里还指着老地址」。
 *
 * 认不出来就返回 `null` —— 调用方据此把那一行整块藏掉，而不是显示一个半截的链接。
 */
export function releasePageFromEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }

  // 段数不够的（自建静态托管之类）就不猜了。
  const segments = url.pathname.split("/").filter(Boolean);
  const releasesAt = segments.indexOf("releases");
  if (releasesAt <= 0) return null;

  return `${url.origin}/${segments.slice(0, releasesAt + 1).join("/")}`;
}
