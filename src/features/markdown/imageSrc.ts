import { defaultUrlTransform } from "react-markdown";

export type FileSrcConverter = (path: string) => string;

/**
 * react-markdown 默认会过滤 URL：`defaultUrlTransform` 只放行 http / https / mailto 与
 * **相对地址**，别的协议一律换成空串。
 *
 * 本地绝对路径的图片是 `remarkLocalImages` 转出来的 `file://…` —— 不在那个白名单里，
 * 于是 `src` 被清成 `""`，界面上只剩一个破图标和 alt（用户报的）。
 *
 * 这里只对 `src` 放行 `file:`，链接（`href`）仍走默认规则 —— 在 webview 里点 `file:` 链接
 * 本来也打不开。
 */
export function allowLocalFileUrls(url: string, key: string): string {
  if (key === "src" && /^file:/i.test(url)) return url;
  return defaultUrlTransform(url);
}

const NOTE_IMAGE_PREFIX = "images/";

/** `%20` 这种转义还原成真字符；写坏了就原样返回。 */
function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 把 Markdown 图片的原始 `src` 还原成磁盘上的绝对路径。
 *
 * 与 `resolveMarkdownImageSrc` 共用同一套判断，区别只在最后一步：这里不转成 asset URL，
 * 而是留着真实路径 —— 「复制图片」要把**原文件**放进剪贴板，asset URL 是拿不到文件的。
 *
 * 不是本地图片（外链、`data:`、相对的非笔记图片）时返回 `null`。
 */
export function resolveMarkdownImagePath(
  src: string | undefined,
  imageBaseDir: string | undefined,
): string | null {
  if (!src) {
    return null;
  }

  const normalizedSrc = src.replace(/\\/g, "/");

  /*
   * `file://` —— `remarkLocalImages` 会把「带空格的本地绝对路径」转成这种形式
   *（直接写 `E:/…` 会被 sanitize 当成 `e:` 协议丢掉）。
   */
  if (/^file:\/\//i.test(normalizedSrc)) {
    return decodePercent(
      normalizedSrc.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1"),
    );
  }

  /*
   * 绝对路径：Windows 盘符（`E:/…`、`E:\…`）与 UNC（`\\server\share`）。
   * 这些图片不在笔记自己的 `images/` 目录里，但工作文件夹已经登记进 asset scope，
   * 一样能加载。
   */
  if (/^[A-Za-z]:\//.test(normalizedSrc) || /^\/\/[^/]/.test(normalizedSrc)) {
    return decodePercent(normalizedSrc);
  }

  if (!imageBaseDir || !normalizedSrc.startsWith(NOTE_IMAGE_PREFIX)) {
    return null;
  }

  return `${imageBaseDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${normalizedSrc}`;
}

export function resolveMarkdownImageSrc(
  src: string | undefined,
  imageBaseDir: string | undefined,
  convertFileSrc: FileSrcConverter,
): string {
  const path = resolveMarkdownImagePath(src, imageBaseDir);
  return path ? convertFileSrc(path) : (src ?? "");
}
