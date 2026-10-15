/**
 * math-symbols（v2）—— 公式符号面板
 *
 * 面板分两段：**结构模板**（分式、上下标、积分上下限、矩阵…）与**符号表**（希腊字母、
 * 运算符、箭头…）。模板插的是骨架并把光标送进第一个占位符 —— 点「分式」直接接着打分子，
 * 不用自己补 `rac{}{}` 的那几个括号。
 *
 * 「不记得某个符号的 LaTeX 怎么打」是手写 Markdown 笔记时最常卡住的一步；中文输入法也
 * 打不出希腊字母。这个插件把常用符号按类别铺在右侧侧拉面板里，**每个格子同时显示字形与
 * 命令** —— 只给字形认不出要打什么，只给命令又不知道是哪个符号，两样并排才解决那个问题。
 *
 * ---------------------------------------------------------------------------
 *
 * 这是「静态 HTML 面板 + 点击」这个模式的最小完整样例，三个要点：
 *
 * 1. **`render()` 返回稳定字符串。** 宿主在正文每次变化时都会重拉面板
 *    （`refreshPanelList`），返回值与上次相同时宿主会短路掉整条更新链路，DOM 不重建，
 *    于是**滚动位置不会被打字打断**。所以面板里不放「当前文件名」这类动态内容 ——
 *    一变就重排、滚回顶部。
 *
 * 2. **点击靠 `data-value` 传参。** 面板 HTML 会经宿主消毒，`data-*` 是严格白名单，
 *    只有 `data-index` / `data-id` / `data-key` / `data-value` 四个键能活下来。取值写法
 *    见 `onClick` 里的注释 —— 那里**不能**照抄 `ref.data()`。
 *
 * 3. **写入走 `replaceRange` + `setSelection`**，也就是宿主的可撤销写入路径，所以原生
 *    撤销栈照常工作，和工具栏的格式化按钮一致。
 */

/**
 * 符号表：`[字形, LaTeX 命令, 英文名]`。
 *
 * 字形全部取自 Unicode 数学区，不依赖 KaTeX —— 面板 HTML 是字符串，插件跑在 Worker 里，
 * 没法调用渲染器。少数冷门字符（黑板粗体、花体）在某些字体下可能缺字，属已知取舍。
 */
const CATEGORIES = [
  {
    title: "希腊字母 · 小写",
    items: [
      ["α", "\\alpha", "alpha"],
      ["β", "\\beta", "beta"],
      ["γ", "\\gamma", "gamma"],
      ["δ", "\\delta", "delta"],
      ["ε", "\\varepsilon", "varepsilon"],
      ["ϵ", "\\epsilon", "epsilon"],
      ["ζ", "\\zeta", "zeta"],
      ["η", "\\eta", "eta"],
      ["θ", "\\theta", "theta"],
      ["ϑ", "\\vartheta", "vartheta"],
      ["ι", "\\iota", "iota"],
      ["κ", "\\kappa", "kappa"],
      ["λ", "\\lambda", "lambda"],
      ["μ", "\\mu", "mu"],
      ["ν", "\\nu", "nu"],
      ["ξ", "\\xi", "xi"],
      ["π", "\\pi", "pi"],
      ["ϖ", "\\varpi", "varpi"],
      ["ρ", "\\rho", "rho"],
      ["ϱ", "\\varrho", "varrho"],
      ["σ", "\\sigma", "sigma"],
      ["ς", "\\varsigma", "varsigma"],
      ["τ", "\\tau", "tau"],
      ["υ", "\\upsilon", "upsilon"],
      ["φ", "\\varphi", "varphi"],
      ["ϕ", "\\phi", "phi"],
      ["χ", "\\chi", "chi"],
      ["ψ", "\\psi", "psi"],
      ["ω", "\\omega", "omega"],
    ],
  },
  {
    title: "希腊字母 · 大写",
    items: [
      ["Γ", "\\Gamma", "Gamma"],
      ["Δ", "\\Delta", "Delta"],
      ["Θ", "\\Theta", "Theta"],
      ["Λ", "\\Lambda", "Lambda"],
      ["Ξ", "\\Xi", "Xi"],
      ["Π", "\\Pi", "Pi"],
      ["Σ", "\\Sigma", "Sigma"],
      ["Υ", "\\Upsilon", "Upsilon"],
      ["Φ", "\\Phi", "Phi"],
      ["Ψ", "\\Psi", "Psi"],
      ["Ω", "\\Omega", "Omega"],
    ],
  },
  {
    title: "运算与算术",
    items: [
      ["±", "\\pm", "pm"],
      ["∓", "\\mp", "mp"],
      ["×", "\\times", "times"],
      ["÷", "\\div", "div"],
      ["⋅", "\\cdot", "cdot"],
      ["∗", "\\ast", "ast"],
      ["∘", "\\circ", "circ"],
      ["∙", "\\bullet", "bullet"],
      ["⊕", "\\oplus", "oplus"],
      ["⊖", "\\ominus", "ominus"],
      ["⊗", "\\otimes", "otimes"],
      ["⊙", "\\odot", "odot"],
      ["√", "\\surd", "surd"],
      ["∞", "\\infty", "infty"],
    ],
  },
  {
    title: "关系与比较",
    items: [
      ["≠", "\\neq", "neq"],
      ["≈", "\\approx", "approx"],
      ["≃", "\\simeq", "simeq"],
      ["≅", "\\cong", "cong"],
      ["≡", "\\equiv", "equiv"],
      ["∼", "\\sim", "sim"],
      ["≐", "\\doteq", "doteq"],
      ["≪", "\\ll", "ll"],
      ["≫", "\\gg", "gg"],
      ["≤", "\\leq", "leq（也可 \\le）"],
      ["≥", "\\geq", "geq（也可 \\ge）"],
      ["≺", "\\prec", "prec"],
      ["≻", "\\succ", "succ"],
      ["⪯", "\\preceq", "preceq"],
      ["⪰", "\\succeq", "succeq"],
      ["∝", "\\propto", "propto"],
    ],
  },
  {
    title: "集合与逻辑",
    items: [
      ["∈", "\\in", "in"],
      ["∉", "\\notin", "notin"],
      ["∋", "\\ni", "ni"],
      ["⊂", "\\subset", "subset"],
      ["⊃", "\\supset", "supset"],
      ["⊆", "\\subseteq", "subseteq"],
      ["⊇", "\\supseteq", "supseteq"],
      ["⊄", "\\nsubseteq", "nsubseteq"],
      ["∪", "\\cup", "cup"],
      ["∩", "\\cap", "cap"],
      ["∅", "\\emptyset", "emptyset"],
      ["∖", "\\setminus", "setminus"],
      ["∀", "\\forall", "forall"],
      ["∃", "\\exists", "exists"],
      ["∄", "\\nexists", "nexists"],
      ["∧", "\\wedge", "wedge"],
      ["∨", "\\vee", "vee"],
      ["¬", "\\neg", "neg"],
      ["∴", "\\therefore", "therefore"],
      ["∵", "\\because", "because"],
      ["⊢", "\\vdash", "vdash"],
      ["⊨", "\\models", "models"],
      ["⊤", "\\top", "top"],
      ["⊥", "\\bot", "bot"],
    ],
  },
  {
    title: "箭头",
    items: [
      ["→", "\\to", "to（也可 \\rightarrow）"],
      ["←", "\\leftarrow", "leftarrow"],
      ["↑", "\\uparrow", "uparrow"],
      ["↓", "\\downarrow", "downarrow"],
      ["↔", "\\leftrightarrow", "leftrightarrow"],
      ["⇀", "\\rightharpoonup", "rightharpoonup"],
      ["⇌", "\\rightleftharpoons", "rightleftharpoons"],
      ["⇒", "\\Rightarrow", "Rightarrow"],
      ["⇐", "\\Leftarrow", "Leftarrow"],
      ["⇔", "\\Leftrightarrow", "Leftrightarrow"],
      ["⟶", "\\longrightarrow", "longrightarrow"],
      ["⟹", "\\Longrightarrow", "Longrightarrow"],
      ["↦", "\\mapsto", "mapsto"],
      ["↪", "\\hookrightarrow", "hookrightarrow"],
      ["↺", "\\circlearrowleft", "circlearrowleft"],
      ["↻", "\\circlearrowright", "circlearrowright"],
    ],
  },
  {
    title: "大型运算符与微积分",
    items: [
      ["∑", "\\sum", "sum"],
      ["∏", "\\prod", "prod"],
      ["∐", "\\coprod", "coprod"],
      ["∫", "\\int", "int"],
      ["∬", "\\iint", "iint"],
      ["∭", "\\iiint", "iiint"],
      ["∮", "\\oint", "oint"],
      ["⋃", "\\bigcup", "bigcup"],
      ["⋂", "\\bigcap", "bigcap"],
      ["∂", "\\partial", "partial"],
      ["∇", "\\nabla", "nabla"],
      ["△", "\\triangle", "triangle"],
      ["□", "\\square", "square"],
    ],
  },
  {
    title: "括号与定界符",
    items: [
      ["⟨", "\\langle", "langle"],
      ["⟩", "\\rangle", "rangle"],
      ["⌈", "\\lceil", "lceil"],
      ["⌉", "\\rceil", "rceil"],
      ["⌊", "\\lfloor", "lfloor"],
      ["⌋", "\\rfloor", "rfloor"],
      ["‖", "\\Vert", "Vert"],
    ],
  },
  {
    title: "数集与花体",
    items: [
      ["ℝ", "\\mathbb{R}", "实数集"],
      ["ℕ", "\\mathbb{N}", "自然数集"],
      ["ℤ", "\\mathbb{Z}", "整数集"],
      ["ℚ", "\\mathbb{Q}", "有理数集"],
      ["ℂ", "\\mathbb{C}", "复数集"],
      ["ℙ", "\\mathbb{P}", "概率 / 多项式"],
      ["ℱ", "\\mathcal{F}", "花体 F"],
      ["ℒ", "\\mathcal{L}", "花体 L"],
    ],
  },
  {
    title: "特殊字符与省略号",
    items: [
      ["°", "\\degree", "degree"],
      ["′", "\\prime", "prime"],
      ["″", "\\prime\\prime", "双撇"],
      ["ℓ", "\\ell", "ell"],
      ["ℏ", "\\hbar", "hbar"],
      ["Å", "\\AA", "埃"],
      ["†", "\\dagger", "dagger"],
      ["‡", "\\ddagger", "ddagger"],
      ["§", "\\S", "小节号"],
      ["¶", "\\P", "段落号"],
      ["∠", "\\angle", "angle"],
      ["∡", "\\measuredangle", "measuredangle"],
      ["…", "\\dots", "dots"],
      ["⋯", "\\cdots", "cdots"],
      ["⋮", "\\vdots", "vdots"],
      ["⋱", "\\ddots", "ddots"],
    ],
  },
];

/**
 * 结构模板：插一段**骨架**，并把光标送进第一个占位符。
 *
 * 与上面的符号表不同，这里的每条是 `before` + `after` 两截 —— 光标落在两截中间，
 * 所以点「分式」得到的是 `\frac{|}{}`，直接就能接着打分子。
 *
 * `display: true` 的那几条自带 `$$` 与换行：矩阵、分段函数这类**行间公式**不能挤在
 * 行内（`parseBlocks` 要求 `$$` 独占一行），骨架里写死比让用户自己去补更省事。
 * 它们也因此在插入时**不做 $ 包裹**。
 */
const TEMPLATES = [
  { g: "a/b", tip: "分式", before: "\\frac{", after: "}{}" },
  { g: "√", tip: "根号", before: "\\sqrt{", after: "}" },
  { g: "ⁿ√", tip: "n 次根（光标先落在次数上）", before: "\\sqrt[", after: "]{ }" },
  { g: "x²", tip: "上标", before: "^{", after: "}" },
  { g: "x₂", tip: "下标", before: "_{", after: "}" },
  { g: "x₂²", tip: "上下标同时", before: "_{", after: "}^{}" },
  { g: "∑", tip: "求和，带上下限", before: "\\sum_{", after: "}^{}" },
  { g: "∏", tip: "连乘，带上下限", before: "\\prod_{", after: "}^{}" },
  { g: "∫", tip: "积分，带上下限", before: "\\int_{", after: "}^{}" },
  { g: "∮", tip: "环路积分，带上下限", before: "\\oint_{", after: "}^{}" },
  { g: "lim", tip: "极限", before: "\\lim_{", after: " \\to }" },
  { g: "d/dx", tip: "导数", before: "\\frac{d}{d", after: "}" },
  { g: "∂/∂x", tip: "偏导", before: "\\frac{\\partial }{\\partial ", after: "}" },
  { g: "d²/dx²", tip: "二阶导", before: "\\frac{d^{2}}{d", after: "^{2}}" },
  { g: "a⃗", tip: "向量", before: "\\vec{", after: "}" },
  { g: "â", tip: "尖帽", before: "\\hat{", after: "}" },
  { g: "ā", tip: "上横线", before: "\\bar{", after: "}" },
  { g: "ã", tip: "波浪线", before: "\\tilde{", after: "}" },
  { g: "ȧ", tip: "一点", before: "\\dot{", after: "}" },
  { g: "( )", tip: "自适应圆括号", before: "\\left( ", after: " \\right)" },
  { g: "[ ]", tip: "自适应方括号", before: "\\left[ ", after: " \\right]" },
  { g: "{ }", tip: "自适应花括号", before: "\\left\\{ ", after: " \\right\\}" },
  { g: "| |", tip: "绝对值", before: "\\left| ", after: " \\right|" },

  {
    g: "▦",
    tip: "矩阵（圆括号）",
    display: true,
    before: "\n$$\n\\begin{pmatrix}\n",
    after: "\n\\end{pmatrix}\n$$\n",
  },
  {
    g: "▥",
    tip: "矩阵（方括号）",
    display: true,
    before: "\n$$\n\\begin{bmatrix}\n",
    after: "\n\\end{bmatrix}\n$$\n",
  },
  {
    g: "▤",
    tip: "行列式",
    display: true,
    before: "\n$$\n\\begin{vmatrix}\n",
    after: "\n\\end{vmatrix}\n$$\n",
  },
  {
    g: "{",
    tip: "分段函数",
    display: true,
    before: "\n$$\n\\begin{cases}\n",
    after: "\n\\end{cases}\n$$\n",
  },
  {
    g: "≡",
    tip: "多行对齐",
    display: true,
    before: "\n$$\n\\begin{aligned}\n",
    after: "\n\\end{aligned}\n$$\n",
  },
];

const PANEL_HINT =
  "点一下插到光标处。光标已经在 $…$ 里就只插 LaTeX，否则自动补一层 $…$（可在插件设置里关）。" +
  "结构模板会把光标送进第一个 {}，接着往下打就行。";

/**
 * 面板样式。
 *
 * 面板 HTML 只有 `class` 与内联 `style` 两种着色手段，而**悬停反馈表达不了** —— 一屏
 * 上百个格子没有 hover，根本不知道自己要点哪个。所以走 `ui.registerStyle` 注入一份带
 * `msym-` 前缀的全局样式（这个口子不做消毒，前缀命名是必须的）。
 *
 * 颜色全用主题变量，深色 / 浅色主题会自动跟着变。
 */
const STYLE = `
.msym { font-size: 12px; color: var(--color-ink-soft); }
.msym-hint {
  margin: 0 0 10px; font-size: 11px; line-height: 1.7; color: var(--color-ink-ghost);
}
.msym-group { margin-bottom: 14px; }
.msym-title {
  position: sticky; top: 0; z-index: 1;
  margin: 0 0 6px; padding: 4px 0 3px;
  font-size: 11px; font-weight: 600; letter-spacing: .02em;
  color: var(--color-ink-faint);
  background: var(--color-cloud);
}
.msym-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(62px, 1fr)); gap: 4px;
}
.msym-cell {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px; padding: 5px 2px 4px; min-height: 40px;
  border: 1px solid transparent; border-radius: 6px; background: transparent;
  cursor: pointer; transition: background .12s ease, border-color .12s ease;
}
.msym-cell:hover {
  background: var(--color-bamboo-mist); border-color: var(--color-bamboo);
}
.msym-cell:active { background: var(--color-bamboo-glow); }
.msym-glyph { font-size: 16px; line-height: 1.15; color: var(--color-ink); }
.msym-cmd {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono); font-size: 9px; color: var(--color-ink-ghost);
}
`;

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

/**
 * 生成整块面板 HTML。纯函数，输入是常量，所以结果可以缓存成一份。
 *
 * 只使用 `<div> <section> <h4> <p> <span> <button>` 与 `class` / `title` /
 * `data-value` —— 全在宿主消毒器的白名单里。多出来的信息一律塞进 `title`，自造
 * `data-glyph` 这类键会被静默剥掉。
 */
function buildPanelHtml() {
  // 结构模板排在符号前面：写公式时先要的是「一个分数」，不是某个具体的希腊字母。
  const templates = TEMPLATES.map((template, index) => {
    const skeleton = `${template.before}${template.after}`.replace(/\s+/g, " ").trim();
    return (
      `<button type="button" class="msym-cell msym-tpl" data-value="${index}"` +
      ` title="${escapeHtml(`${template.tip}　${skeleton}`)}">` +
      `<span class="msym-glyph">${escapeHtml(template.g)}</span>` +
      `<span class="msym-cmd">${escapeHtml(skeleton)}</span>` +
      `</button>`
    );
  }).join("");

  const groups =
    `<section class="msym-group">` +
    `<h4 class="msym-title">结构模板</h4>` +
    `<div class="msym-grid">${templates}</div>` +
    `</section>` +
    CATEGORIES.map((category) => {
      const cells = category.items
        .map(([glyph, latex, name]) => {
          const tip = name ? `${latex}（${name}）` : latex;
          return (
            `<button type="button" class="msym-cell"` +
            ` data-value="${escapeHtml(latex)}" title="${escapeHtml(tip)}">` +
            `<span class="msym-glyph">${escapeHtml(glyph)}</span>` +
            `<span class="msym-cmd">${escapeHtml(latex)}</span>` +
            `</button>`
          );
        })
        .join("");

      return (
        `<section class="msym-group">` +
        `<h4 class="msym-title">${escapeHtml(category.title)}</h4>` +
        `<div class="msym-grid">${cells}</div>` +
        `</section>`
      );
    }).join("");

  return `<div class="msym"><p class="msym-hint">${escapeHtml(PANEL_HINT)}</p>${groups}</div>`;
}

/**
 * 判断 `offset` 落在哪个数学环境里，返回 `"inline"` / `"display"` / `null`。
 *
 * 只看 `$` 与 `$$` 的配对，`\` 后面的字符跳过（所以 `\$` 不算定界符）。这是**启发式**，
 * 不是解析器：判错的代价只是多一层或少一层 `$`，用户一眼看得见、手改一下即可，比为了
 * 严谨去实现一个 Markdown 解析器划算得多。
 */
function mathContextAt(text, offset) {
  const limit = Math.max(0, Math.min(offset, text.length));
  let state = null;

  for (let index = 0; index < limit; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "$") continue;

    if (text[index + 1] === "$") {
      index += 1;
      state = state === "display" ? null : "display";
    } else {
      state = state === "inline" ? null : "inline";
    }
  }

  return state;
}

floral.register({
  onLoad(api) {
    /** 面板 HTML 只算一次。返回同一个字符串，宿主就不会白白重建 DOM。 */
    let cachedHtml = null;

    /**
     * 统一的插入路径。符号与结构模板都走这里。
     *
     * `caretInLatex` 有两种含义：
     *
     * * **数字** —— 光标落在插入文本内部的这个偏移上。模板用它停在第一个占位符里
     *   （`\frac{|}{}` 这样接着打分子）。
     * * **`null`** —— 光标停在**整段插入之后**。符号用它：光标被送出公式，
     *   接着随手打字就是普通文本。
     *
     * ⚠️ 符号以前是「停在收尾的 `$` 之前」，为的是「连着点几个符号都还在数学环境里」。
     * 那个便利换来的是一个很难查的 bug：插完 `\alpha` 顺手打个 `m`，正文就成了
     * `$\alpham$` —— KaTeX 不认这个命令，预览里**直接变成一块红色报错**。
     * 现在改成送出公式，那个便利改由 `merging` 那条分支保住（见下）。
     *
     * `allowWrap = false` 用于自带 `$$` 的行间公式 —— 那类骨架不能再套一层 `$`。
     */
    const insertLatex = async (latex, caretInLatex, allowWrap = true) => {
      const content = await api.editor.getContent();
      const selection = await api.editor.getSelection();
      const start = selection ? selection.start : content.length;
      const end = selection ? selection.end : content.length;

      // 三种落点，决定要不要补 `$`、以及往哪儿插：
      //  1. 光标已经在数学环境里 → 就地插（不补）
      //  2. 光标紧跟在某个行内公式的收尾 `$` 后面 → 插进**那个公式里**（不补）
      //  3. 其它 → 补一层 `$…$`
      //
      // 第 2 条就是「连着点几个符号」原来的体验：点完 `\alpha` 再点 `\beta`，
      // 得到的是 `$\alpha\beta$` 而不是 `$\alpha$$\beta$`。
      const insideMath = mathContextAt(content, start) !== null;
      const merging =
        !insideMath &&
        start === end &&
        start > 0 &&
        content[start - 1] === "$" &&
        content[start - 2] !== "$";

      let wrap = false;
      if (allowWrap && !insideMath && !merging) {
        try {
          const values = await api.settings.get();
          // 设置是用户随手改的，只认真正的 false；其它一律按默认（开）处理。
          wrap = !(values && values.wrapInMath === false);
        } catch (error) {
          wrap = true;
          api.log.warn(`读取设置失败，按默认（自动包裹）处理：${error && error.message}`);
        }
      }

      // 合并进已有公式时插在收尾 `$` **之前**，也就是插进公式内部。
      const insertAt = merging ? start - 1 : start;
      const text = wrap ? `$${latex}$` : latex;
      await api.editor.replaceRange(insertAt, merging ? start - 1 : end, text);

      const caret =
        caretInLatex === null
          ? // 送出公式：补了 `$` 就停在收尾的 `$` 之后，没补就停在命令末尾。
            insertAt + latex.length + (wrap ? 2 : 0)
          : // 停在插入文本内部（模板的占位符），补了 `$` 就多让开开头那一个。
            insertAt + caretInLatex + (wrap ? 1 : 0);
      await api.editor.setSelection(caret, caret);
    };

    api.ui.registerStyle({ id: "math-symbols", css: STYLE });

    api.ui.registerPanel({
      id: "math-symbols",
      title: "符号",
      standalone: true,

      render() {
        if (cachedHtml === null) cachedHtml = buildPanelHtml();
        return cachedHtml;
      },

      onClick(ref) {
        // 结构模板先判：它的 class 里也带 `msym-cell`，两条路靠 `msym-tpl` 区分。
        const templateCell = ref.closestClass("msym-tpl");
        if (templateCell) {
          const index = Number(templateCell.attrs && templateCell.attrs["data-value"]);
          const template = TEMPLATES[index];
          if (!template) return;
          void insertLatex(
            `${template.before}${template.after}`,
            template.before.length,
            // 自带 `$$` 的行间公式不能再被包裹一次。
            !template.display,
          );
          return;
        }

        const cell = ref.closestClass("msym-cell");
        if (!cell) return;

        /**
         * 从**按钮自己的**描述符取 `data-value`，而不是 `ref.data("value")`。
         *
         * `ref` 描述的是**点击落点**：落在格子里的字形或命令那两个 `<span>` 上时，`ref`
         * 就是那个 span，它身上没有 `data-value`，`ref.data("value")` 会返回 null，表现
         * 为「点在字上没反应、点在格子边上才有反应」。`closestClass` 会沿着描述符的祖先
         * 链往上找，`cell.attrs` 就是按钮那一条的 `data-*`。
         */
        const latex = cell.attrs && cell.attrs["data-value"];
        if (!latex) return;

        // `null` = 光标送出公式。以前是停在收尾的 `$` 之前，结果插完符号顺手打个字母
        // 就合成 `$\alpham$`，预览里变成一块红色报错（见 `insertLatex` 的说明）。
        void insertLatex(latex, null);
      },
    });
  },
});
