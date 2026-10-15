/**
 * file-reader（v2）—— 让工作文件夹认识更多文件格式
 *
 * **这个插件不读任何文件。** 它只做一件事：告诉宿主「`.py` 是 Python、徽章是 PY、
 * 颜色是这个、用 highlight.js 的 python 语法着色」。至于文件夹里有哪些文件、内容
 * 是什么，全部由宿主提供 —— 因此它不需要、也拿不到任何文件系统权限。
 *
 * 这正是把「文件浏览」和「格式知识」拆开的好处：
 *
 * - 不装这个插件时，宿主只内置一条 Markdown 规则，工作文件夹里就只看得见 `.md`；
 * - 装上之后，侧栏、颜色、徽章、预览方式一次性全部就位，宿主代码一行没改。
 *
 * `kind` 决定宿主怎么展示：
 *   code     → 走 highlight.js 着色，**可编辑并写回磁盘**（沿用普通编辑器）
 *   text     → 纯文本，同样可编辑
 *   markdown → 走完整的 Markdown 预览管线
 *   table    → 解析成表格（只读）
 *   image    → 直接显示图片（只读）
 *   media    → 音频/视频播放器（只读）
 *   none     → 只在侧栏出现，点开提示暂不支持
 *   custom   → 自己提供 render(file) 返回 HTML（本插件没用到）
 */
floral.register({
  onLoad(api) {
    /**
     * 颜色取的是各语言社区的惯用色（GitHub linguist 那一套），
     * 目的是让卡片扫一眼就能认出类型，而不是追求和品牌色完全一致。
     */
    const TYPES = [
      // ---- 代码：可编辑 + 语法着色
      { id: "javascript", extensions: ["js", "mjs", "cjs", "jsx"], label: "JavaScript", badge: "JS", color: "#f1e05a", kind: "code", language: "javascript" },
      { id: "typescript", extensions: ["ts", "tsx"], label: "TypeScript", badge: "TS", color: "#3178c6", kind: "code", language: "typescript" },
      { id: "python", extensions: ["py", "pyw", "pyi"], label: "Python", badge: "PY", color: "#3572a5", kind: "code", language: "python" },
      { id: "rust", extensions: ["rs"], label: "Rust", badge: "RS", color: "#dea584", kind: "code", language: "rust" },
      { id: "go", extensions: ["go"], label: "Go", badge: "GO", color: "#00add8", kind: "code", language: "go" },
      { id: "java", extensions: ["java"], label: "Java", badge: "JV", color: "#b07219", kind: "code", language: "java" },
      { id: "kotlin", extensions: ["kt", "kts"], label: "Kotlin", badge: "KT", color: "#a97bff", kind: "code", language: "kotlin" },
      { id: "swift", extensions: ["swift"], label: "Swift", badge: "SW", color: "#f05138", kind: "code", language: "swift" },
      { id: "c", extensions: ["c", "h"], label: "C", badge: "C", color: "#5a5a5a", kind: "code", language: "c" },
      { id: "cpp", extensions: ["cpp", "cc", "cxx", "hpp", "hh"], label: "C++", badge: "C+", color: "#f34b7d", kind: "code", language: "cpp" },
      { id: "csharp", extensions: ["cs"], label: "C#", badge: "C#", color: "#178600", kind: "code", language: "csharp" },
      { id: "ruby", extensions: ["rb"], label: "Ruby", badge: "RB", color: "#701516", kind: "code", language: "ruby" },
      { id: "php", extensions: ["php"], label: "PHP", badge: "PHP", color: "#4f5d95", kind: "code", language: "php" },
      // 数据类格式单独指定一套配色：它们的 token 类型少，用 atom-one 这组比默认的
      // github 更耐看。`{ light, dark }` 让它在两种应用主题下各取一套。
      { id: "json", extensions: ["json"], label: "JSON", badge: "{}", color: "#cbcb41", kind: "code", language: "json", highlightTheme: { light: "atom-one-light", dark: "atom-one-dark" } },
      { id: "yaml", extensions: ["yml", "yaml"], label: "YAML", badge: "YA", color: "#cb171e", kind: "code", language: "yaml" },
      { id: "toml", extensions: ["toml"], label: "TOML", badge: "TO", color: "#9c4221", kind: "code", language: "toml" },
      { id: "xml", extensions: ["xml"], label: "XML", badge: "XM", color: "#0f7d3c", kind: "code", language: "xml" },
      { id: "html", extensions: ["html", "htm"], label: "HTML", badge: "<>", color: "#e34c26", kind: "code", language: "html" },
      { id: "css", extensions: ["css", "less"], label: "CSS", badge: "CS", color: "#563d7c", kind: "code", language: "css" },
      { id: "scss", extensions: ["scss", "sass"], label: "Sass", badge: "SC", color: "#c6538c", kind: "code", language: "scss" },
      { id: "sql", extensions: ["sql"], label: "SQL", badge: "SQ", color: "#e38c00", kind: "code", language: "sql" },
      { id: "shell", extensions: ["sh", "bash", "zsh"], label: "Shell", badge: "SH", color: "#89e051", kind: "code", language: "shell" },
      { id: "powershell", extensions: ["ps1", "psm1"], label: "PowerShell", badge: "PS", color: "#3b6ea5", kind: "code", language: "powershell" },

      // ---- 纯文本：可编辑，不着色
      //
      // 字体刻意拆成两类：`.txt` 主要是**读**的，用正文字体更舒服；`.ini` / `.log` /
      // `.env` 是**看结构**的，等宽才对得上列。这就是 `font` 的用处 —— 不填则按 kind
      // 取默认（文本类默认等宽）。
      { id: "prose", extensions: ["txt", "text"], label: "文本", badge: "TXT", color: "#8a8a80", kind: "text", font: "var(--font-body)" },
      { id: "config-log", extensions: ["log", "ini", "cfg", "conf", "env", "properties"], label: "配置 / 日志", badge: "CFG", color: "#8a8a80", kind: "text" },
      { id: "markdown-md", extensions: ["markdown", "mdx"], label: "Markdown", badge: "MD", color: "#083fa1", kind: "markdown" },

      // ---- 只读预览
      { id: "table", extensions: ["csv", "tsv"], label: "表格", badge: "CSV", color: "#2f7d4f", kind: "table" },
      { id: "image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"], label: "图片", badge: "IMG", color: "#a855f7", kind: "image" },
      { id: "vector", extensions: ["svg"], label: "SVG", badge: "SVG", color: "#ffb13b", kind: "image" },
      { id: "audio", extensions: ["mp3", "wav", "ogg", "flac", "m4a"], label: "音频", badge: "♪", color: "#0ea5e9", kind: "media" },
      { id: "video", extensions: ["mp4", "webm", "mov", "mkv", "avi"], label: "视频", badge: "▶", color: "#ef4444", kind: "media" },
    ];

    // v2 的调用一律是异步的。逐个 await 会拖慢加载，所以并发注册；失败必须**报到
    // 日志里** —— 注册失败的唯一表现是「这类文件没出现在侧栏」，静默吞掉根本查不出来。
    for (const type of TYPES) {
      api.files
        .registerType(type)
        .catch((error) => api.log.error(`注册文件类型 ${type.id} 失败：${error.message}`));
    }

    api.log.info(`file-reader 已加载，声明了 ${TYPES.length} 种文件类型`);
  },
});
