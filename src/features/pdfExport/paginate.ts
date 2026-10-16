/**
 * 自己分页。
 *
 * ## 为什么不用「让浏览器去分」
 *
 * 之前是把整篇塞进一张无限长的纸，再画几条虚线假装分页 —— 那条线是**估的**：真正的分页
 * 在打印那一刻才由排版引擎决定，预览永远只是近似。
 *
 * 想精确，只能自己算：把内容**真的摆进一张张固定大小的纸里**，放不下就换页。这样
 * ① 预览所见即所得；② 打印时一张纸一个盒子（`break-after: page`），产出与预览**逐页对得上**。
 * 代价是遇到比一页还高的块（长段落、长表格、长代码块）得自己切开。
 *
 * ## 怎么量
 *
 * **不手算 margin** —— 把块真的 append 进当前页，然后看内容区有没有溢出
 * （`scrollHeight > clientHeight`）。行高、外边距折叠、图片高度……全交给排版引擎，
 * 我们只读结果。这是这份代码唯一可靠的地方。
 *
 * ⚠️ 尺寸一律用 **mm**（不是 px）：`@page` 的边距是按 mm 写的，只有两边同样的单位、
 * 同样的取整，纸盒才刚好卡在可打印区里。差半个像素就可能多出一张空白页。
 *
 * ## 切不动怎么办
 *
 * 一页只装一个块、而它比一页还高，且切不开（比如一张特别高的图）——**让这一页长高**，
 * 而不是把内容裁掉。宁可预览里出现一张「高一点的纸」，也不能丢内容；调用方可以拿
 * `PaginateResult.overflowed` 去提示用户。
 */

export interface PageMetrics {
  /** 纸张总尺寸（mm）。 */
  pageWidth: number;
  pageHeight: number;
  /** 页边距（mm）：预览里画成纸上的空白，打印时交给 `@page`。 */
  margin: { top: number; right: number; bottom: number; left: number };
}

/** 一页：`box` 是内容区那个盒子（尺寸 = 内容区），`content` 是往里放东西的那一层。 */
export interface PageBox {
  box: HTMLElement;
  content: HTMLElement;
}

export interface PaginateResult {
  pages: PageBox[];
  /** 有块比一页还高、又切不开 —— 那些页被撑高了，产出页数可能与预览对不上。 */
  overflowed: boolean;
}

export interface PaginateOptions {
  /**
   * 缩放（1 = 100%）。**用它而不是打印接口的 ScaleFactor**：这样分页是按缩放后的
   * 版心算的，预览与产出用的是同一套换算。
   */
  zoom?: number;
  /**
   * 自己造页。默认就是 `createPage`；调用方拿它把新页**立刻挂进文档** ——
   * 不挂进去就量不出高度（`getBoundingClientRect` 对游离节点全是 0）。
   */
  createPage?: (metrics: PageMetrics, zoom: number) => PageBox;
}

/** 内容区尺寸（mm）。 */
export function contentBox(metrics: PageMetrics): { width: number; height: number } {
  return {
    width: Math.max(1, metrics.pageWidth - metrics.margin.left - metrics.margin.right),
    height: Math.max(1, metrics.pageHeight - metrics.margin.top - metrics.margin.bottom),
  };
}

/**
 * 一页的内容盒。**只放内容**，纸与页边距是外面那一层的事。
 *
 * 里面还套一层 `content`：缩放（`zoom`）要加在它身上 —— 加在 box 上会把盒子本身也缩小，
 * 那就不是「把字缩了」而是「纸变小了」。
 */
export function createPage(metrics: PageMetrics, zoom = 1): PageBox {
  const { width, height } = contentBox(metrics);
  const box = document.createElement("div");
  box.className = "floral-page";
  box.style.width = `${width}mm`;
  box.style.height = `${height}mm`;
  // `flow-root`：让它成为独立的排版上下文。少了它，第一个子元素的上外边距会**漏到盒子外面**，
  // 量出来的高度就不对了（预览里那点空隙也会跑到纸外面去）。
  box.style.display = "flow-root";
  box.style.overflow = "hidden";

  const content = document.createElement("div");
  content.className = "floral-page-content";
  content.style.display = "flow-root";
  if (zoom !== 1) content.style.zoom = String(zoom);
  box.append(content);

  return { box, content };
}

function overflows(page: PageBox): boolean {
  // 1px 容差：亚像素舍入会让「刚好放下」的那页算出零点几像素的溢出，那不该换页。
  return page.box.scrollHeight - page.box.clientHeight > 1;
}

/**
 * 分页。
 *
 * `source` 里的顶层节点会被**搬走**（就地取用，不复制）—— 传进来的必须是一份一次性的
 * 内容容器，调用方别指望拿回它。
 */
export function paginate(
  source: HTMLElement,
  metrics: PageMetrics,
  options: PaginateOptions = {},
): PaginateResult {
  const zoom = options.zoom ?? 1;
  const factory = options.createPage ?? createPage;
  const pages: PageBox[] = [];
  let overflowed = false;
  let current = factory(metrics, zoom);
  pages.push(current);

  const newPage = () => {
    current = factory(metrics, zoom);
    pages.push(current);
  };

  // 纯空白的文本节点（标记之间的换行）会干扰「这页只有它一个」的判断，先摘掉。
  const pending: ChildNode[] = [...source.childNodes].filter(
    (node) => !(node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim()),
  );

  // 护栏：切分逻辑万一陷入「切出来还是放不下」的循环，别把界面卡死。
  let guard = 0;

  while (pending.length > 0) {
    if (guard++ > 2000) {
      overflowed = true;
      break;
    }

    const node = pending[0];
    current.content.append(node);

    if (!overflows(current)) {
      pending.shift();
      continue;
    }

    pending.shift();

    // 放不下就**就地切开**：能放下的那半留在本页，剩下的一半去下一页。
    // ⚠️ 早先只有「这页上只有它」时才切 —— 于是标题后面接一张大表格时，整张表被推到
    // 下一页，第一页只剩标题加一大片空白（用户一眼就看出来了）。
    const rest = splitOverflow(current, node);
    if (rest) {
      pending.unshift(rest);
      newPage();
      continue;
    }

    if (current.content.childNodes.length === 1) {
      // 只有它一个、又切不开（一张特别高的图之类）：**让它溢出**。
      // 内容比整齐重要 —— 裁掉用户的字是不可接受的。
      overflowed = true;
      current.box.style.height = "auto";
      current.box.style.minHeight = `${contentBox(metrics).height}mm`;
      current.box.style.overflow = "visible";
      newPage();
      continue;
    }

    // 切不动、而且这页上还有别的东西：整块挪到下一页去。
    node.remove();
    pending.unshift(node);
    newPage();
  }

  // 最后那页可能是空的（刚好在边界上换了页）—— 去掉它。
  while (pages.length > 1) {
    const last = pages[pages.length - 1];
    if (last.content.childNodes.length === 0 && last.box.style.height !== "auto") pages.pop();
    else break;
  }

  return { pages, overflowed };
}

/** 把一个放不下的块切开：留下的部分留在这页，返回「剩下的那半」。切不动返回 `null`。 */
function splitOverflow(page: PageBox, node: ChildNode): ChildNode | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const block = node as HTMLElement;

  const table = tableIn(block);
  if (table) return splitTable(page, block, table);

  return splitByLine(page, block);
}

interface TableInBlock {
  table: HTMLTableElement;
  /** 从 `block` 往下到 `table` 之间的那几层（克隆续页那一半时要照着套回去）。 */
  wrappers: HTMLElement[];
}

/**
 * 找出这个块里那张表格。
 *
 * ⚠️ **表格几乎不会直接是顶层块**：Markdown 预览把它包在
 * `<div class="my-3 relative group"><div class="overflow-x-auto"><table>…` 里（那个外层是
 * 复制按钮的定位容器）。只看顶层节点的 `tagName === "table"` 的话，一张大表格会被当成
 * 「切不动的 div」—— 表现就是**表格在页面底部被生生截断**（用户截图里的样子）。
 *
 * 所以往下找，但只认「这个块基本上就是那张表」的情况：块里有且只有一张表，
 * 且它占了块高度的一大半。别的都不碰 —— 宁可整块挪页，也别把一个复杂的块切坏。
 */
function tableIn(block: HTMLElement): TableInBlock | null {
  if (block.tagName.toLowerCase() === "table") {
    return { table: block as HTMLTableElement, wrappers: [] };
  }

  const tables = block.querySelectorAll("table");
  if (tables.length !== 1) return null;
  const table = tables[0] as HTMLTableElement;

  const blockRect = block.getBoundingClientRect();
  const tableRect = table.getBoundingClientRect();
  if (blockRect.height <= 0 || tableRect.height < blockRect.height * 0.5) return null;

  const wrappers: HTMLElement[] = [];
  for (let el = table.parentElement; el && el !== block; el = el.parentElement) {
    wrappers.unshift(el);
  }
  return { table, wrappers };
}

/**
 * 表格按**行**切。
 *
 * 表头（`<thead>`）在每一页都要重画一遍 —— 不然第二页开始的数字没有列名，没法看。
 */
function splitTable(page: PageBox, block: HTMLElement, found: TableInBlock): HTMLElement | null {
  const { table, wrappers } = found;
  const body = table.tBodies[0];
  if (!body) return null;

  const rows = [...body.rows];
  if (rows.length < 2) return null;

  // 从最后一行往前搬，直搬到这页不再溢出。
  // ⚠️ 每搬一行都要**真的从 DOM 里拿掉**（`row.remove()`）—— 只是收进数组的话，
  // `overflows` 永远不会变，这个循环就转不完了。
  const moved: HTMLTableRowElement[] = [];
  while (overflows(page) && rows.length > 1) {
    const row = rows.pop();
    if (!row) break;
    row.remove();
    moved.unshift(row);
  }
  if (moved.length === 0) return null;

  // 续页那一半：一张新表（表头照着克隆一份，不然第二页开始的数字没有列名），
  // 外面照原样套回那几层包装 —— 少了它们，表格的宽度与样式会跟前半截不一样。
  const restTable = table.cloneNode(false) as HTMLTableElement;
  if (table.tHead) restTable.append(table.tHead.cloneNode(true));
  const restBody = document.createElement("tbody");
  restTable.append(restBody);
  for (const row of moved) restBody.append(row);

  let rest: HTMLElement = restTable;
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    const clone = wrappers[index].cloneNode(false) as HTMLElement;
    clone.append(rest);
    rest = clone;
  }
  void block;
  return rest;
}

/**
 * 其它块按**行**切：二分找出「最后一个还放得下的字符」，在那儿把块劈成两半。
 *
 * `Range.extractContents()` 负责重建祖先链 —— 在 `<p>aa <strong>bb|cc</strong> dd</p>` 的
 * 中间切一刀，它会把 `</strong> dd` 那一段完整抠出来（该补的 `<strong>` 会补上）。
 * 手工搬节点是最容易写出「标签对不上」的地方，所以这一刀交给它。
 */
function splitByLine(page: PageBox, block: HTMLElement): HTMLElement | null {
  const limit = page.box.getBoundingClientRect().bottom;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = document.createRange();

  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (!text.length) continue;

    range.setStart(text, 0);
    range.setEnd(text, text.length);
    // `getBoundingClientRect` 给的是所有行盒的并集，底边就是最后一行的底边。
    if (range.getBoundingClientRect().bottom <= limit) continue;

    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      range.setStart(text, 0);
      range.setEnd(text, mid);
      if (range.getBoundingClientRect().bottom <= limit) lo = mid;
      else hi = mid - 1;
    }

    // 第一行就放不下：这一块切不动，交给调用方去「撑高那页」。
    const at = backToWordBoundary(text.data, lo);
    if (at <= 0) return null;

    return cutAt(block, text, at);
  }

  return null;
}

/** 往回退到最近的空白后面（中文没有空格，退不动就算了）。 */
function backToWordBoundary(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset;
  const before = text[offset - 1];
  const at = text[offset];
  // 只在「两边都是拉丁词字符」时才退 —— 中文、标点在任意处断都正常。
  if (!/[A-Za-z0-9]/.test(before) || !/[A-Za-z0-9]/.test(at)) return offset;
  let cursor = offset;
  let steps = 0;
  while (cursor > 0 && steps < 32) {
    if (/\s/.test(text[cursor - 1])) return cursor;
    cursor -= 1;
    steps += 1;
  }
  return offset;
}

/** 在 (text, offset) 处把块劈开，返回尾巴那一半。 */
function cutAt(block: HTMLElement, text: Text, offset: number): HTMLElement | null {
  try {
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(block, block.childNodes.length);
    const tail = range.extractContents();
    if (tail.childNodes.length === 0) return null;
    const rest = block.cloneNode(false) as HTMLElement;
    rest.append(tail);
    return rest;
  } catch {
    // 偏移量在某个极端情况下不合法（切的过程中节点被改过）—— 不切了，让它整块换页。
    return null;
  }
}
