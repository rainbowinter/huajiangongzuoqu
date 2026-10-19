export type FileSrcConverter = (path: string) => string;

const NOTE_IMAGE_PREFIX = "images/";

/** `%20` 这种转义还原成真字符；写坏了就原样返回。 */
function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveMarkdownImageSrc(
  src: string | undefined,
  imageBaseDir: string | undefined,
  convertFileSrc: FileSrcConverter,
): string {
  if (!src) {
    return "";
  }

  const normalizedSrc = src.replace(/\\/g, "/");

  /*
   * `file://` —— `remarkLocalImages` 会把「带空格的本地绝对路径」转成这种形式
   *（直接写 `E:/…` 会被 sanitize 当成 `e:` 协议丢掉）。
   */
  if (/^file:\/\//i.test(normalizedSrc)) {
    const path = decodePercent(
      normalizedSrc.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1"),
    );
    return convertFileSrc(path);
  }

  /*
   * 绝对路径：Windows 盘符（`E:/…`、`E:\…`）与 UNC（`\\server\share`）。
   * 这些图片不在笔记自己的 `images/` 目录里，但工作文件夹已经登记进 asset scope，
   * 一样能加载。
   */
  if (/^[A-Za-z]:\//.test(normalizedSrc) || /^\/\/[^/]/.test(normalizedSrc)) {
    return convertFileSrc(decodePercent(normalizedSrc));
  }

  if (!imageBaseDir || !normalizedSrc.startsWith(NOTE_IMAGE_PREFIX)) {
    return src;
  }

  return convertFileSrc(`${imageBaseDir}/${normalizedSrc}`);
}
