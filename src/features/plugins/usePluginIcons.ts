import { useEffect, useRef, useState } from "react";
import { loadPluginIcon } from "./viewAssets";

/**
 * 把一批「插件目录里的图标」读进来，返回 `键 → 已消毒的内联 SVG`。
 *
 * 两处用它：预览区顶上那排 `view.toolbar` 的图标，和主窗口顶上那一行**文档动作**的图标
 * （`ui.registerDocumentAction` 的 `icon` 写成 `.svg` 路径时）。两边读法、上限、失败姿态
 * 完全一样 —— 差别只在「键」怎么算、从哪个插件目录读，所以那两样由调用方给。
 *
 * 读不到就是从表里缺席（调用方画成「这一项没有图标」），**不抛也不报错**。
 */
export interface PluginIconRequest {
  /** 调用方自己认得的键（文档动作用动作 id，工具栏用 `toolbarIconKey`）。 */
  key: string;
  /** 从**哪个插件目录**读（扩展插件的图标在它自己那儿）。 */
  owner: string;
  /** 插件目录下的相对路径。 */
  path: string;
}

/** 一批请求的身份：键 + 来源都算上，内容一样就不重新读。 */
function signatureOf(requests: readonly PluginIconRequest[]): string {
  return requests.map(({ key, owner, path }) => `${key}\u0000${owner}\u0000${path}`).join("\u0001");
}

export function usePluginIcons(requests: readonly PluginIconRequest[]): Map<string, string> {
  const [icons, setIcons] = useState<Map<string, string>>(() => new Map());

  // ⚠️ 依赖是**签名**而不是数组本身：调用方多半是现场 `flatMap` 出来的，那个数组每次
  // 渲染都是新的，挂上去就成了无限重读。用 ref 兜住最新的那份请求，effect 才不会过期。
  const latest = useRef(requests);
  latest.current = requests;
  const signature = signatureOf(requests);

  useEffect(() => {
    let cancelled = false;
    if (latest.current.length === 0) {
      setIcons(new Map());
      return;
    }

    void Promise.all(
      latest.current.map(async ({ key, owner, path }) => {
        const svg = await loadPluginIcon(owner, path);
        return svg ? ([key, svg] as const) : null;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setIcons(
        new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null)),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [signature]);

  return icons;
}
