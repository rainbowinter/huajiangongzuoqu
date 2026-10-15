/**
 * 从**编辑区原文**里切出某个块对应的那一段。
 *
 * 预览区的复制按钮要复制的不是渲染结果，而是「这一块在编辑区里长什么样」——
 * 表格尤其明显：渲染成 `<table>` 之后再抽文本，`|` 那套结构就没了，粘回笔记里
 * 就是一堆散字。react-markdown 会把 hast 节点的 `position`（源码里的起止偏移）
 * 一路传进来，拿它去切 `content` 就是原文本身，没有任何重建的误差。
 *
 * 之所以抽成独立模块：这是**纯函数**，而组件里的东西在这个仓库里测不了
 * （测试环境没有 jsdom / testing-library）。
 */

/** hast 节点的 `position`，只关心我们用得到的两个偏移。 */
export interface SourcePosition {
  start?: { offset?: number | null } | null;
  end?: { offset?: number | null } | null;
}

/**
 * 切出 `position` 覆盖的那段源码。拿不到位置（或位置不合法）时返回 `null`，
 * 调用方据此**不显示**复制按钮 —— 宁可不给，也不给一个会复制错内容出去的按钮。
 *
 * 首尾空白会被去掉：源码里块的边界通常连着空行，复制出来不该带一串空行。
 */
export function sliceBlockSource(
  content: string,
  position?: SourcePosition | null,
): string | null {
  const start = position?.start?.offset;
  const end = position?.end?.offset;

  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > content.length || end <= start) return null;

  const slice = content.slice(start, end).trim();
  return slice.length > 0 ? slice : null;
}
