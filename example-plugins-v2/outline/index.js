/**
 * outline（v2）—— 目录导航
 *
 * 同一个面板，按**当前打开的文件类型**换一套解析规则：
 *
 * | 文件 | 解析依据 |
 * |---|---|
 * | 笔记 / `.md` | Markdown 标题（`#` 层级） |
 * | `.py` | 行首**缩进**（类 → 方法 → 嵌套函数） |
 * | `.js` `.ts` `.jsx` `.tsx` | 花括号深度 + 声明关键字 |
 * | `.json` | 键的嵌套路径 |
 * | `.css` `.scss` | 规则（选择器）与 `@` 规则，按花括号嵌套 |
 * | 其余代码格式 | 通用兜底：一套更宽的关键字 + 花括号深度 |
 * | 其它 | 明说「该格式没有目录」，**不**回退成扫 `#` |
 *
 * 最后那条是有意的：拿 Markdown 规则去扫一个 `.txt`，得到的永远是「暂无标题」，
 * 用户只会以为插件坏了。说不支持，比给个假结果强。
 *
 * ---------------------------------------------------------------------------
 *
 * 这是最有价值的一个 v2 迁移样例，它同时演示了 v2 相对 v1 的**三个关键差异**：
 *
 * 1. **同步读正文。** v1 在 `render()` 里直接 `api.getActiveNoteContent()` 同步读。
 *    Worker 里没有 DOM、也不能同步 RPC，但宿主会把编辑器状态作为「镜像」推送过来，
 *    于是 `api.editor.getContentSync()` 依然同步可用，渲染逻辑几乎不用改。
 *
 * 2. **同步读文件身份。** `api.editor.getFileSync()` 返回
 *    `{ path, typeId, kind, language }`，笔记为 `null`。上面那张分派表就靠它 ——
 *    v1 时代插件拿不到这个，只能嗅探正文猜自己面对的是什么文件。
 *
 * 3. **点击事件拿到的是描述符而不是 DOM 节点。** v1 写
 *    `target.closest(".outline-item")` + `btn.getAttribute("data-index")`，
 *    v2 里 `target` 是可序列化的 ElementRef，对应写法是
 *    `ref.closestClass("outline-item")` + `ref.data("index")`。
 *
 *    注意 `closest()` 只支持极小的选择器语法：`tag`、`.class`、`#id`、
 *    `[data-x]`、`[data-x="v"]`，以及 `tag.class` 这样的两段组合，
 *    **不是**完整的 CSS 选择器引擎。
 *
 *    另外：面板 HTML 会被宿主消毒，`data-*` 走**严格白名单**，只有
 *    `data-index` / `data-id` / `data-key` / `data-value` 四个键能活下来；
 *    `<svg>` 会被整棵剥掉。所以元信息只能塞进这四个键，图标只能用文字与 `<span>`。
 */

floral.register({
  onLoad(api) {
    /**
     * 解析结果统一成这一种条目，渲染与点击因此完全共用，不必为每种语言各写一套 UI。
     *
     * `level` 是**嵌套深度**（0 起），不是语言本身的层级编号 —— Markdown 的 `#`
     * 也折算成 0 起，这样不同文件之间的缩进观感一致。
     */
    const KINDS = {
      class: "class",
      def: "def",
      func: "func",
      method: "fn",
      key: "key",
      rule: "rule",
      at: "@",
      md: "",
    };

    api.ui.registerPanel({
      id: "outline",
      title: "目录",
      standalone: true,

      render() {
        const content = api.editor.getContentSync();
        if (!content || !content.trim()) {
          return hint("请先选中一篇笔记");
        }

        const outline = buildOutline(content, api.editor.getFileSync());
        if (outline.items === null) return hint(outline.empty);
        if (outline.items.length === 0) return hint(outline.empty);

        return outline.items.map(renderItem).join("");
      },

      onClick(ref) {
        const button = ref.closestClass("outline-item");
        if (!button) return;

        const index = Number(ref.data("index"));
        if (!Number.isFinite(index)) return;

        // 点击时**重新解析一次**，而不是把 offset 写进 DOM。
        //
        // 两个理由：一是面板从渲染到点击之间，正文可能已经被编辑过，重算得到的是
        // 当前位置的偏移；二是 `data-*` 是严格白名单，本来也放不下额外字段。
        // 解析是纯函数，对同一份正文结果稳定，所以下标一定对得上。
        const outline = buildOutline(api.editor.getContentSync(), api.editor.getFileSync());
        if (!outline.items) return;

        const item = outline.items[index];
        if (!item) return;

        // 代码文件没有预览面板，scrollPreviewTo 会自然空转（宿主侧 previewScrollRef
        // 为 null 时直接返回）。两个都留着，.md 的预览跳转才不会被砍掉。
        api.editor.scrollTo(item.offset);
        api.editor.scrollPreviewTo(item.offset);
      },
    });

    /** 面板里的一行。关键字做成灰阶小标，扫读时能一眼分出类/函数。 */
    function renderItem(item) {
      const pad = 8 + item.level * 12;
      const label = KINDS[item.kind] ?? "";
      const badge = label
        ? '<span style="display:inline-block;min-width:26px;margin-right:6px;opacity:.4;font-size:10px;">' +
          label +
          "</span>"
        : "";
      return (
        '<button class="outline-item" data-index="' +
        item.__index +
        '" style="display:block;width:100%;text-align:left;border:0;background:transparent;cursor:pointer;padding:4px 8px 4px ' +
        pad +
        'px;font-size:12px;color:var(--color-ink-soft);">' +
        badge +
        escapeHtml(item.text) +
        "</button>"
      );
    }

    function hint(text) {
      return (
        '<p style="font-size:12px;color:var(--color-ink-ghost);text-align:center;padding:16px 0;">' +
        text +
        "</p>"
      );
    }

    /** 按文件类型分派。返回 `items === null` 表示「这个格式没有目录」。 */
    function buildOutline(content, file) {
      if (!file || file.kind === "markdown") {
        return { items: parseMarkdown(content), empty: "暂无标题，用 # 添加标题" };
      }
      if (file.language === "python") {
        return { items: parsePython(content), empty: "这个文件里没有类或函数" };
      }
      if (file.language === "json") {
        return { items: parseJson(content), empty: "没有可显示的键" };
      }
      if (file.language === "css" || file.language === "scss") {
        return { items: parseCss(content), empty: "这个文件里没有样式规则" };
      }
      if (file.kind === "code") {
        return { items: parseBraced(content), empty: "没有找到类或函数定义" };
      }
      return { items: null, empty: "该格式没有目录" };
    }
  },
});

/* ========================================================================== */
/* 解析器                                                                      */
/*                                                                            */
/* 一律是纯函数：正文进、条目数组出。没有宿主依赖，所以能在测试里直接喂样例。      */
/* ========================================================================== */

/** 统一补上 `__index`，供渲染时写进 `data-index`。 */
function withIndex(items) {
  return items.map((item, index) => Object.assign({ __index: index }, item));
}

/* ---------------------------------------------------------------- Markdown */

function parseMarkdown(content) {
  const items = [];
  let offset = 0;

  for (const line of content.split("\n")) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      // `#` 是 1 起，这里折成 0 起，好与代码文件的顶层对齐。
      items.push({ level: match[1].length - 1, offset, text: match[2].trim(), kind: "md" });
    }
    offset += line.length + 1;
  }

  return withIndex(items);
}

/* ------------------------------------------------------------------ Python */

/**
 * Python 靠**行首缩进**判断嵌套，不靠花括号。
 *
 * 用一个「缩进栈」：遇到定义时把比它缩进深的层全部弹出，剩下的栈深就是它的层级。
 * 这天然处理了「类里的方法」「函数里的嵌套函数」，也天然处理了「回到顶层」。
 */
function parsePython(content) {
  const items = [];
  const stack = [];
  let offset = 0;
  // 三引号字符串可以跨很多行，里面的 `def` 只是文本，不能被当成定义。
  let inTripleQuote = false;

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();

    const quotes = countOccurrences(trimmed, '"""') + countOccurrences(trimmed, "'''");
    if (inTripleQuote) {
      if (quotes > 0) inTripleQuote = false;
      offset += line.length + 1;
      continue;
    }
    if (quotes % 2 === 1) inTripleQuote = true;

    if (!trimmed || trimmed.startsWith("#")) {
      offset += line.length + 1;
      continue;
    }

    const match = /^(\s*)(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/.exec(line);
    if (match) {
      const indent = match[1].replace(/\t/g, "    ").length;
      while (stack.length > 0 && stack[stack.length - 1] >= indent) stack.pop();
      items.push({
        level: stack.length,
        offset,
        text: match[3],
        kind: match[2] === "class" ? "class" : "def",
      });
      stack.push(indent);
    }

    offset += line.length + 1;
  }

  return withIndex(items);
}

/* ------------------------------------------------- JS / TS 与通用兜底 ------ */

/**
 * 花括号语言共用一套：**声明关键字**认定义，**花括号深度**认嵌套。
 *
 * JS/TS 与「其它代码格式」走的是同一个函数 —— 区别只在关键字宽窄，而把 Go 的 `func`、
 * Rust 的 `fn`、Java 的修饰符一并写进来之后，一套规则就够两边用了。多写一套只会多一份
 * 要维护的东西。
 *
 * 这是启发式，不是语法分析：字符串与注释会被剥掉，但模板字面量里的花括号、
 * 同一行写完的 `{ ... }` 仍可能让深度短时间失真。目录只是导航，够用即可。
 */
const DECLARATIONS = [
  // class Foo / export default class Foo / public final class Foo
  {
    re: /^[^A-Za-z]*class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
  },
  // function foo / async function* foo / export default function foo
  {
    re: /^(?:export\s+|default\s+)*function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: "func",
  },
  // const foo = () => / let foo = async function / const foo = bar => …
  {
    re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
    kind: "func",
  },
  // Go：func Foo() / func (r *T) Method()
  { re: /^(?:func)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/, kind: "func" },
  // Rust：pub async unsafe fn foo
  {
    re: /^(?:pub(?:\([^)]*\))?\s+)*(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_$][\w$]*)/,
    kind: "func",
  },
  // 类内方法：foo() { / public static async foo(): Promise<void> {
  {
    re: /^(?:(?:public|private|protected|internal|static|final|virtual|override|abstract|async|readonly|export|default|open|pub)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*(?::\s*[^{;]+)?\{\s*$/,
    kind: "method",
  },
];

/** 这些长得像方法调用，但其实是控制流 —— 认成定义会让目录塞满噪声。 */
const NOT_DECLARATIONS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "do",
  "else",
  "function",
  "class",
  "new",
  "delete",
  "typeof",
  "await",
  "yield",
  "with",
  "case",
]);

function parseBraced(content) {
  const items = [];
  let depth = 0;
  let offset = 0;
  let inBlockComment = false;

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let code = stripStrings(line.replace(/\/\/.*$/, ""));

    // 跨行块注释：进出各一次，里面的内容一律不认。
    const opens = countOccurrences(code, "/*");
    const closes = countOccurrences(code, "*/");
    if (inBlockComment) {
      if (closes > 0) inBlockComment = false;
      offset += line.length + 1;
      continue;
    }
    if (opens > closes) inBlockComment = true;
    code = code.replace(/\/\*[\s\S]*?\*\//g, "");

    const trimmed = code.trim();
    if (trimmed) {
      for (const { re, kind } of DECLARATIONS) {
        const match = re.exec(trimmed);
        if (!match) continue;
        const name = match[1];
        if (NOT_DECLARATIONS.has(name)) break;
        // 层级取**这一行之前**的深度：定义所在的那对花括号还没被算进去。
        items.push({ level: Math.max(0, depth), offset, text: name, kind });
        break;
      }
    }

    for (const char of code) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }

    offset += line.length + 1;
  }

  return withIndex(items);
}

/* -------------------------------------------------------------------- JSON */

/**
 * JSON 的目录是**键的嵌套路径**。
 *
 * 层级数的是「当前套在几层**对象**里」，数组不计数也不算一层 —— 否则
 * `{"list": [{"a": 1}]}` 里的 `a` 会莫名其妙比 `list` 深两级。数组元素若是对象，
 * 那个对象的键与同级的键齐平，这正是阅读时期望的样子。
 */
function parseJson(content) {
  const items = [];
  const stack = [];
  let offset = 0;

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();

    const key = /^"((?:[^"\\]|\\.)*)"\s*:/.exec(trimmed);
    if (key) {
      const objectDepth = stack.filter((kind) => kind === "object").length;
      const quoteAt = raw.indexOf('"');
      items.push({
        level: Math.max(0, objectDepth - 1),
        offset: offset + (quoteAt >= 0 ? quoteAt : 0),
        text: key[1],
        kind: "key",
      });
    }

    // 先剥掉字符串字面量再数括号，免得更键名里带 `{` 把深度带偏。
    const code = trimmed.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const char of code) {
      if (char === "{") stack.push("object");
      else if (char === "[") stack.push("array");
      else if (char === "}" || char === "]") stack.pop();
    }

    offset += line.length + 1;
  }

  return withIndex(items);
}

/* --------------------------------------------------------------- CSS / SCSS */

/**
 * 列出规则：选择器，以及 `@media` / `@theme` 这类 `@` 规则。
 *
 * 这一节**不是按行扫**的，和上面几个解析器不同。原因是 CSS 里行不构成边界：一条规则
 * 的选择器列表可以铺好几行，也可能一行里挤着好几条规则，行号在这儿帮不上忙。所以改成
 * 按**字符**走，用花括号深度定嵌套层级（SCSS 的嵌套规则因此自动就对）。
 *
 * 有两处必须跳过，否则整棵结构会错位 —— 这两样在本仓库的 `App.css` 里都真实存在：
 *
 *   · **注释**里的花括号。`App.css` 里大段带 `{` 的注释，不跳就会被当成真的规则；
 *   · **字符串 / `url(...)`** 里的 `{ } ;`。内联 SVG 的 data URI 就带这些字符。
 *
 * 只列**规则**，声明一概不进（`--x: 1` 这种自定义属性也不进）。面板要的是结构，
 * 属性清单只会把它淹掉 —— 一个 App.css 里声明有几百条、变量也有几十个，
 * 而规则只有百来条，那才是拿来跳转的东西。
 */
function parseCss(content) {
  const items = [];
  let depth = 0;
  let start = 0; // 当前「语句」的起点：可能是一条规则头，也可能是一条声明
  let index = 0;

  /** 语句起点要落在第一个非空白字符上，否则点一下会跳到上一行的行尾。 */
  const firstVisible = (offset, text) => offset + (text.length - text.trimStart().length);

  const pushItem = (offset, level, text, kind) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    items.push({ level, offset, text: trimmed, kind });
  };

  while (index < content.length) {
    const char = content[index];

    if (char === "/" && content[index + 1] === "*") {
      const end = content.indexOf("*/", index + 2);
      const after = end < 0 ? content.length : end + 2;
      // 注释若出现在**语句开头**，把语句起点一起推过去。不推的话，被跳过的注释
      // 仍留在 `start` 到当前之间的那段切片里，会跟着规则头一起显示出来。
      // 文件头的版权块、分节注释都属这一类，所以这条很常见。
      if (content.slice(start, index).trim() === "") start = after;
      index = after;
      continue;
    }

    if (char === '"' || char === "'") {
      index = skipQuoted(content, index);
      continue;
    }

    if (char === "{") {
      const head = content.slice(start, index);
      pushItem(
        firstVisible(start, head),
        depth,
        shortCss(trimLine(head)),
        head.trim().startsWith("@") ? "at" : "rule",
      );
      depth += 1;
      start = index + 1;
      index += 1;
      continue;
    }

    if (char === "}" || char === ";") {
      const statement = content.slice(start, index);
      const text = statement.trim();
      const offset = firstVisible(start, statement);

      // 声明一律不列。原先还会把 `--x` / `$x` 这类自定义属性挂进来，但一个
      // App.css 里就有几十个变量，占的篇幅比规则还多 —— 面板要的是**结构**，
      // 不是属性清单。
      //
      // 唯一的例外是顶层没有块、以分号收尾的 `@` 语句（`@import` / `@charset`）。
      // 块内的那些（`@apply` / `@include`）仍然不列 —— 它们是声明，不是结构。
      if (depth === 0 && text.startsWith("@")) {
        pushItem(offset, 0, shortCss(text), "at");
      }

      if (char === "}") depth = Math.max(0, depth - 1);
      start = index + 1;
      index += 1;
      continue;
    }

    index += 1;
  }

  return withIndex(items);
}

/* ------------------------------------------------------------------- 工具 */

/**
 * 把多行压成一行 —— 选择器列表经常铺好几行，铺进面板里没法看。
 * 顺带清掉夹在语句中间的注释残留（`a /* x *\/ b {` 这种写法，起点推不过去）。
 */
function trimLine(text) {
  return stripComments(text).replace(/\s+/g, " ").trim();
}

/** 抹掉注释。只用于显示，不影响偏移量。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** 压成一行后再截断：结构比完整文本重要，想知道全貌点进去看。 */
function shortCss(text) {
  const collapsed = trimLine(text);
  return collapsed.length > 72 ? collapsed.slice(0, 71) + "…" : collapsed;
}

/** 越过一段引号包裹的字符串，返回结束引号之后的位置。 */
function skipQuoted(content, index) {
  const quote = content[index];
  index += 1;
  while (index < content.length) {
    if (content[index] === "\\") {
      index += 2;
      continue;
    }
    if (content[index] === quote) return index + 1;
    index += 1;
  }
  return index;
}

function stripStrings(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
