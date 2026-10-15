/**
 * 段落对齐：编辑区那一侧（往正文里写 / 撤掉 `::: center`）。
 *
 * 渲染那一侧在 `remarkAlign.ts`。两边共用这套写法：
 *
 * ```text
 * ::: center
 * 这段字居中
 * :::
 * ```
 *
 * **为什么不用 HTML**：Markdown 原生没有段落对齐，直接能想到的办法都是写
 * `<div align="center">` 或 `<center>` —— 那是把排版混进了正文，笔记拿到别处就露馅，
 * 用户也明说了不想在笔记里看到这类东西。`:::` 是 Markdown 圈已有的容器写法
 * （VitePress、Docusaurus 都用），看着仍然像 Markdown。
 *
 * 整个文件都是**纯字符串函数**：处理的全是行边界与偏移，正是最容易算错、又最适合用
 * 测试钉死的那一类（组件在这个仓库的测试环境里跑不起来）。
 */

export const ALIGN_KINDS = ["left", "center", "right"] as const;
export type AlignKind = (typeof ALIGN_KINDS)[number];

/** 标记行。`::: center`（空格随意）与 `:::center` 都认。 */
const OPEN_MARKER = new RegExp(`^:::[ \\t]*(${ALIGN_KINDS.join("|")})[ \\t]*$`);

/** 收尾标记行。 */
const CLOSE_MARKER = /^:::[ \t]*$/;

/** 这一行是哪种对齐标记；不是标记行返回 `null`。 */
export function parseAlignMarker(line: string): AlignKind | null {
  return (line.trim().match(OPEN_MARKER)?.[1] as AlignKind | undefined) ?? null;
}

/** 这一行是不是收尾用的 `:::`。 */
export function isAlignClose(line: string): boolean {
  return CLOSE_MARKER.test(line.trim());
}

export interface TextRange {
  start: number;
  end: number;
}

export interface AlignEdit extends TextRange {
  /** 替换后的全文。 */
  text: string;
}

interface Line {
  start: number;
  end: number;
  text: string;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      lines.push({ start, end: i, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  return lines;
}

/** 把行重新拼成文本，并给出每行的起始偏移。 */
function joinLines(lines: string[]): { text: string; starts: number[] } {
  let text = "";
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    starts.push(text.length);
    text += lines[i];
    if (i < lines.length - 1) text += "\n";
  }
  return { text, starts };
}

/** 偏移落在第几行。 */
function lineIndexAt(lines: Line[], offset: number): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (offset >= lines[i].start) return i;
  }
  return 0;
}

const isBlank = (line: string) => line.trim() === "";

/**
 * 这一行会不会把**紧跟其后的那一行**当成自己的续行吃掉。
 *
 * 这是 Markdown 的「惰性续行」规则，也正是 `:::` 这套写法最容易翻车的地方。实测：
 *
 * ```text
 * ::: center
 * - 甲
 * - 乙
 * :::
 * ```
 *
 * 最后那行 `:::` 会被并进最后一个列表项（渲染出来是列表里多了一行 `:::`）；
 * 换成表格更糟，它会变成**新增的一行数据**。所以内容以这几种块结尾时，收尾的 `:::`
 * 前面必须空一行 —— 下面的 `applyAlign` 会自动补，手工写的人照这个规则来也不会错。
 *
 * ⚠️ 只有这几种。实测**围栏代码块、缩进代码块、标题**都不会吃掉下一行：它们遇到 `:::`
 * 会正常结束，`:::` 自成一段。多判几种只是白白多一行空行，所以这里宁可窄一点。
 */
export function absorbsFollowingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (/^[|>]/.test(trimmed)) return true; // 表格行 / 引用
  if (/^([-*+]|\d+[.)])\s/.test(trimmed)) return true; // 列表项
  return false;
}

/** 标记行既是容器边界，也**不能**被「扩到整段」吃进去 —— 吃进去就认不出容器了。 */
const isBoundary = (line: string) => isBlank(line) || parseAlignMarker(line) !== null || isAlignClose(line);

/**
 * 把 `first..last` 这几行扩到**整段**：上下吃进所有非空、且不是标记行的行。
 *
 * 为什么要扩：Markdown 里连续几行是**同一段**，只包光标那一行会把这一段劈成两半 ——
 * 上面那半居中、下面那半掉回左边，用户会觉得「怎么只动了一半」。
 */
function blockLineBounds(raw: string[], first: number, last: number): { first: number; last: number } {
  if (isBlank(raw[first]) && first === last) return { first, last };

  while (first > 0 && !isBoundary(raw[first - 1])) first--;
  while (last < raw.length - 1 && !isBoundary(raw[last + 1])) last++;

  return { first, last };
}

/** 光标 / 选区所在的那一整段在全文里的区间。 */
export function blockRangeAt(text: string, start: number, end: number): TextRange {
  const lines = splitLines(text);
  const raw = lines.map((line) => line.text);
  const { first, last } = blockLineBounds(
    raw,
    lineIndexAt(lines, Math.min(start, end)),
    lineIndexAt(lines, Math.max(start, end)),
  );

  return { start: lines[first].start, end: lines[last].end };
}

/** 用 `starts` 把第 `from..to` 行（含）拼回一个选区。 */
function rangeOfLines(starts: number[], lines: string[], from: number, to: number): TextRange {
  return { start: starts[from], end: starts[to] + lines[to].length };
}

/**
 * 在当前段上套 / 换 / 撤对齐标记。
 *
 * - 段外面没有标记 → 套上；
 * - 已经有标记、且是同一种 → 撤掉（「再点一下取消」）；
 * - 已有标记但是另一种 → 换过去（居中改居右不该先撤再加）；
 * - 光标停在空行上 → 放一个空容器，光标落在中间那行。
 *
 * 返回的选区间**始终盖住那批正文行**，所以连续点几次能一路切下去。
 */
export function applyAlign(
  text: string,
  start: number,
  end: number,
  kind: AlignKind,
): AlignEdit {
  const lines = splitLines(text);
  const raw = lines.map((line) => line.text);
  let first = lineIndexAt(lines, Math.min(start, end));
  let last = lineIndexAt(lines, Math.max(start, end));

  // 光标正好停在容器的**标记行**上：挪进容器里那行正文。
  // 不挪的话会被当成「独立的一行」再包一层，套出一个嵌套容器 —— 那种结果既不是
  // 用户想要的，也很难看懂。
  if (first === last && (parseAlignMarker(raw[first]) !== null || isAlignClose(raw[first]))) {
    if (parseAlignMarker(raw[first]) !== null && first + 1 < raw.length) {
      first += 1;
      last += 1;
    } else if (isAlignClose(raw[first]) && first > 0) {
      first -= 1;
      last -= 1;
    }
  }

  // 光标停在空行上：换成一个空容器，光标落在中间那行。
  if (first === last && isBlank(raw[first])) {
    const replaced = [...raw.slice(0, first), `::: ${kind}`, "", ":::", ...raw.slice(first + 1)];
    const { text: next, starts } = joinLines(replaced);
    const caret = starts[first + 1];
    return { text: next, start: caret, end: caret };
  }

  const block = blockLineBounds(raw, first, last);
  const openedKind = block.first > 0 ? parseAlignMarker(raw[block.first - 1]) : null;

  // 收尾标记可能在紧邻的下一行，也可能隔着一个空行 —— 内容以列表 / 表格 / 引用结尾时
  // 就必须隔那一行，否则 `:::` 会被当成它们的续行吃掉（见 `absorbsFollowingLine`）。
  const nextIsClose = isAlignClose(raw[block.last + 1] ?? "");
  const gapThenClose = isBlank(raw[block.last + 1] ?? "") && isAlignClose(raw[block.last + 2] ?? "");
  const closeAt = nextIsClose ? block.last + 1 : gapThenClose ? block.last + 2 : -1;

  /** 收尾那行要不要先空一行。 */
  const tail = absorbsFollowingLine(raw[block.last]) ? ["", ":::"] : [":::"];

  if (openedKind && closeAt >= 0) {
    if (openedKind === kind) {
      // 撤掉：连上下两行标记（以及为列表补的那个空行）一起去掉，还原成原来的样子
      const kept = [
        ...raw.slice(0, block.first - 1),
        ...raw.slice(block.first, block.last + 1),
        ...raw.slice(closeAt + 1),
      ];
      const joined = joinLines(kept);
      return {
        text: joined.text,
        ...rangeOfLines(joined.starts, kept, block.first - 1, block.last - 1),
      };
    }

    // 换一种：只改标记行
    const kept = [...raw];
    kept[block.first - 1] = `::: ${kind}`;
    const joined = joinLines(kept);
    return {
      text: joined.text,
      ...rangeOfLines(joined.starts, kept, block.first, block.last),
    };
  }

  if (openedKind) {
    // 上面开着标记却没有收尾 —— 用户正在手写、写到一半。顺手把它合上，
    // 而不是在它里面再套一层。
    const kept = [...raw];
    if (openedKind !== kind) kept[block.first - 1] = `::: ${kind}`;
    kept.splice(block.last + 1, 0, ...tail);
    const joined = joinLines(kept);
    return {
      text: joined.text,
      ...rangeOfLines(joined.starts, kept, block.first, block.last),
    };
  }

  const kept = [
    ...raw.slice(0, block.first),
    `::: ${kind}`,
    ...raw.slice(block.first, block.last + 1),
    ...tail,
    ...raw.slice(block.last + 1),
  ];
  const joined = joinLines(kept);
  return {
    text: joined.text,
    ...rangeOfLines(joined.starts, kept, block.first + 1, block.last + 1),
  };
}
