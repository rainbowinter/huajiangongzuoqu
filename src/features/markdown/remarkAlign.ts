import type { Paragraph, Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";
import { isAlignClose, parseAlignMarker, type AlignKind } from "./alignText";

/**
 * 段落对齐（`::: center` / `::: left` / `::: right`）的渲染那一侧。
 * 编辑区那一侧在 `alignText.ts`，两边共用同一套标记行解析。
 *
 * ## mdast 长什么样
 *
 * `:::` 不是 Markdown 自带的语法，所以它不会被解析成什么特殊节点 —— 整块内容就是
 * **普通的段落**，标记行混在段落的文本里，行与行之间是字面量的 `\n`：
 *
 * ```text
 * ::: center           ← paragraph: text("::: center\n这段居中\n:::")
 * 这段居中
 * :::
 * ```
 *
 * 多段时更容易看错：**标记行会和相邻那一段粘在一起**，收尾那行粘在最后一段的尾巴上，
 * 而且两者之间会多出空段落分隔。所以下面是在**兄弟节点**这个层面做扫描，而不是在
 * 一个段落内部做替换。
 *
 * ## 为什么用 `data.hName` 而不是自己造节点类型
 *
 * `mdast-util-to-hast` 会把 `data.hName` / `data.hProperties` 应用到转换结果上，这是
 * 官方留给「我要换个标签」的口子。走它就不必再给一个自定义节点类型配 handler，
 * 也让下游的 rehype 插件（比如消毒）看到的始终是普通的 `element`。
 *
 * ## 认不出来就原样留着
 *
 * 写了一半（只有开头的 `::: center` 没有收尾）时**不吞内容**，那段就按普通文字渲染，
 * 用户能一眼看见自己少写了什么。宁可显示得难看，也不要默默吃掉正文。
 */

/**
 * 我们造出来的容器节点。
 *
 * mdast 的联合类型里当然没有它（`:::` 不是 Markdown 语法），所以单独标一个类型出来，
 * 而不是一路 `as unknown as` —— 那样调用方（包括测试）就再也拿不到它的 `children`。
 * 真正交给 `mdast-util-to-hast` 时会经过一次收窄转换，见文件末尾。
 */
export interface AlignBlockNode {
  type: "alignBlock";
  data: { hName: "div"; hProperties: { className: string[] } };
  children: RootContent[];
}

export type AlignedContent = RootContent | AlignBlockNode;

/** 取段落**第一行**的对齐标记，没有就返回 `null`。 */
function openingKindOf(node: RootContent): AlignKind | null {
  if (node.type !== "paragraph") return null;
  const first = node.children[0];
  if (first?.type !== "text") return null;

  const newline = first.value.indexOf("\n");
  const line = newline === -1 ? first.value : first.value.slice(0, newline);
  return parseAlignMarker(line);
}

/** 段落**最后一行**是不是收尾的 `:::`。 */
function hasCloseLine(node: RootContent): boolean {
  if (node.type !== "paragraph") return false;
  const last = node.children[node.children.length - 1];
  if (last?.type !== "text") return false;

  const newline = last.value.lastIndexOf("\n");
  const line = newline === -1 ? last.value : last.value.slice(newline + 1);
  return isAlignClose(line);
}

/** 段落里第一个文本节点。 */
function firstText(node: Paragraph): Text | null {
  const child = node.children[0];
  return child?.type === "text" ? child : null;
}

/** 段落里最后一个文本节点。 */
function lastText(node: Paragraph): Text | null {
  const child = node.children[node.children.length - 1];
  return child?.type === "text" ? child : null;
}

/** 切掉第一个文本节点的前 `length` 个字符；整个节点被切空时返回 `null`。 */
function dropFromStart(node: Paragraph, length: number): Paragraph | null {
  const text = firstText(node);
  if (!text) return node;

  const rest = text.value.slice(length);
  const children = [...node.children];
  if (rest) children[0] = { ...text, value: rest };
  else children.shift();

  return children.length > 0 ? { ...node, children } : null;
}

/** 切掉最后一个文本节点的后 `length` 个字符；整个节点被切空时返回 `null`。 */
function dropFromEnd(node: Paragraph, length: number): Paragraph | null {
  const text = lastText(node);
  if (!text) return node;

  // ⚠️ 必须先夹到 0：`slice(0, -1)` 是「去掉最后一个字符」而不是「全切空」，
  // 长度算过头时它会悄悄留下内容。
  const rest = text.value.slice(0, Math.max(0, text.value.length - length));
  const children = [...node.children];
  if (rest) children[children.length - 1] = { ...text, value: rest };
  else children.pop();

  return children.length > 0 ? { ...node, children } : null;
}

/** 去掉段落开头那一行标记。 */
function stripOpening(node: Paragraph): Paragraph | null {
  const text = firstText(node);
  if (!text) return node;

  const newline = text.value.indexOf("\n");
  const line = newline === -1 ? text.value : text.value.slice(0, newline);
  if (parseAlignMarker(line) === null) return node;

  return dropFromStart(node, newline === -1 ? text.value.length : newline + 1);
}

/** 去掉段落末尾那一行收尾标记。 */
function stripClosing(node: Paragraph): Paragraph | null {
  const text = lastText(node);
  if (!text) return node;

  const newline = text.value.lastIndexOf("\n");
  const line = newline === -1 ? text.value : text.value.slice(newline + 1);
  if (!isAlignClose(line)) return node;

  // 要切掉的是「收尾标记 + 它前面那个换行」。两种边界都得照顾：
  // - `newline >= 0`：从那个换行切到末尾；
  // - `newline === -1`（整段就是光秃秃一个 `:::`）：整段切空。
  // 这里少切一个字符会留下一个孤立换行、多切一个字符会把 `:::` 削成 `::` ——
  // 两种都不会报错，只会安静地传到渲染结果里，所以测试把这两条都钉住了。
  const drop = newline === -1 ? text.value.length : text.value.length - newline;
  return dropFromEnd(node, drop);
}

/**
 * 把 `::: kind` … `:::` 之间的兄弟节点收进一个容器。
 *
 * 抽成纯函数是为了能直接喂 mdast 测 —— 不必起整条 unified 管线。
 */
export function extractAlignBlocks(children: RootContent[]): AlignedContent[] {
  const result: AlignedContent[] = [];
  let index = 0;

  while (index < children.length) {
    const kind = openingKindOf(children[index]);

    if (kind) {
      // 收尾那行可能在同一个段落里（单段容器），也可能在后面某个段落里。
      let closeAt = -1;
      for (let i = index; i < children.length; i++) {
        if (hasCloseLine(children[i])) {
          closeAt = i;
          break;
        }
      }

      if (closeAt >= 0) {
        const body: RootContent[] = [];

        if (closeAt === index) {
          const opened = stripOpening(children[index] as Paragraph);
          const only = opened ? stripClosing(opened) : null;
          if (only && only.children.length > 0) body.push(only);
        } else {
          const head = stripOpening(children[index] as Paragraph);
          if (head) body.push(head);
          for (let i = index + 1; i < closeAt; i++) body.push(children[i]);
          const tail = stripClosing(children[closeAt] as Paragraph);
          if (tail) body.push(tail);
        }

        result.push({
          type: "alignBlock",
          data: {
            hName: "div",
            hProperties: { className: ["md-align", `md-align-${kind}`] },
          },
          children: body,
        });

        index = closeAt + 1;
        continue;
      }
    }

    // 不是容器开头，或者开了头却没等到收尾 —— 原样留着。
    result.push(children[index]);
    index += 1;
  }

  return result;
}

const remarkAlign: Plugin<[], Root> = () => (tree) => {
  // 唯一一次类型收窄：`AlignBlockNode` 不是 mdast 的原生节点类型，但下游
  // （`mdast-util-to-hast`）只按 `type` 分派、认不出来的走 `data.hName`，
  // 所以这里放行是安全的 —— 见文件头部的说明。
  tree.children = extractAlignBlocks(tree.children) as RootContent[];
};

export default remarkAlign;
