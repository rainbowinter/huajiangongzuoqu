import type { FileType } from "../workspace/fileTypes";
import { readPluginAsset } from "./api";
import { buildViewDocument, isCompleteViewSpec } from "./viewBridge";

/**
 * 把插件声明的视图资源读出来、拼成 iframe 的 `srcdoc`。
 *
 * **为什么要读成文本再内联**：视图帧是 opaque origin，外部 `<script type="module">`
 * 与 `new Worker(assetUrl)` 在那儿都会被 CORS 挡掉；内联之后既跑得起来，也不必为了视图
 * 去放宽 asset 协议范围（那会逼着我们去掉沙箱）。实测见 `Docs/plugin-view-sandbox.md`。
 */

/**
 * 从文件类型 id 里取出插件名。
 *
 * `v2Host.registerFileType` 会给插件的 id 加上 `<插件名>:` 前缀（避免两个插件撞名），
 * 读插件目录下的资源正需要这个名字。前缀不存在时返回 `null` —— 那种类型不是插件注册的，
 * 也就没有视图资源可读。
 */
export function ownerOfFileType(typeId: string): string | null {
  const index = typeId.indexOf(":");
  return index > 0 ? typeId.slice(0, index) : null;
}

/** 同一种文件类型只读一次：pdf.js 那种库读进来是兆级字符串，别每次打开都重来一遍。 */
const documentCache = new Map<string, Promise<string>>();

export function loadViewDocument(type: FileType): Promise<string> {
  const cached = documentCache.get(type.id);
  if (cached) return cached;

  const pending = (async () => {
    const owner = ownerOfFileType(type.id);
    const spec = type.view;
    if (!owner || !isCompleteViewSpec(spec)) {
      throw new Error("这个文件类型的视图声明不完整（缺少 html，或不是插件注册的）");
    }

    const read = (relativePath: string) => readPluginAsset(owner, relativePath);

    const [html, css, js, worker] = await Promise.all([
      read(spec.html),
      Promise.all((spec.css ?? []).map(read)),
      Promise.all((spec.js ?? []).map(read)),
      // worker 只是**文本**：pdf.js 那份 1.4MB 的 worker 源码要原样进到帧里，
      // 由插件自己做成 blob 再 new Worker（帧是 opaque origin，外部地址会被 CORS 挡掉）。
      spec.worker ? read(spec.worker) : Promise.resolve(undefined),
    ]);

    return buildViewDocument({ html, css, js, worker });
  })();

  documentCache.set(type.id, pending);
  // 失败不进缓存 —— 否则一次读盘失败会让这个类型永久坏掉，重试都没机会。
  void pending.catch(() => documentCache.delete(type.id));

  return pending;
}

/** 测试用：清掉缓存。 */
export function clearViewDocumentCache(): void {
  documentCache.clear();
}
