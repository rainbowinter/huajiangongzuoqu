/**
 * office-viewer（v2）—— 让 `.docx` 在花笺里打开。
 *
 * 这个插件本身**不读文件、也不渲染任何东西**：它只做三件事：
 *
 * 1. 登记「docx 归谁管」这条规则；
 * 2. 在打开的是 Word 文档时，注册一个 **`standalone` 面板「开始」** ——
 *    它和「目录」在同一级，点开进右侧栏；
 * 3. 面板里的按钮 / 下拉框通过 `api.ui.sendToView()` 把格式命令发给**自己的**沙箱视图。
 *
 * ## 面板的两种形态
 *
 * 主视图是 Office 的字体组：两行、用线分块、右下角一个小箭头。点箭头后，
 * **整个侧栏**换成「字体」详细页（顶部有返回）。切换用纯 CSS 的 radio + `:has()`，
 * 不重新注册面板 —— 面板 HTML 一变，宿主就会重建 DOM、把滚动位置归零。
 *
 * ## 为什么面板要按文件类型注册 / 注销
 *
 * `standalone` 面板的页签是**全局**列出来的，不会按文件类型过滤。而这个「开始」只该在
 * 打开 Word 文档时出现，所以插件监听当前文件身份（`api.editor.getFileSync()`）：
 * 是 docx 就注册面板，换成别的文件就 dispose。`getFileSync()` 读的是宿主推送的镜像，
 * 没有事件可订阅，所以用一个很轻的轮询（500ms）—— 只读一个对象，代价可以忽略。
 *
 * ## 权限
 *
 * * `files:register` / `files:view` —— 登记扩展名 + 交出沙箱视图代码；
 * * `editor:read` —— 读当前文件身份（判断要不要显示「开始」）；
 * * `ui:panel` —— 注册右侧栏面板；
 * * `ui:style` —— 给面板注入一小段样式（字体组、详细页）。
 *
 * 排版引擎的架构、分页规则与里程碑见同目录的 `DESIGN.md`。
 */

const DOCX_TYPE_ID = "docx";

/**
 * 「在花笺里新建 .docx」时宿主先写进去的骨架。
 *
 * 花笺默认新建一个 **0 字节**文件，而 DOCX 是 ZIP 包 —— 0 字节的文件 Word 打不开，
 * 我们自己的视图也得在内存里临时补一份。把 `blankDocxBytes()` 的结果作为文件类型的
 * `newFile` 模板交出去，新文件从出生起就是合法 DOCX。
 *
 * 这是 `test/blank-docx.test.js` 里那份最小文档的 base64；改模板时两边要一起改。
 * 不写成 `import` 是因为 v2 插件主文件由宿主求值，不经过打包器。
 */
const BLANK_DOCX_BASE64 =
  "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";

/**
 * 面板的静态样式。
 *
 * 面板渲染在**主世界**，所以 `--color-*` 这些宿主变量是拿得到的；用它们而不是写死颜色，
 * 深浅色与主题色就自动跟着走。
 */
const TABLE_HOVER_CSS = Array.from({ length: 8 }, (_, row) =>
  Array.from({ length: 8 }, (_, col) => {
    const cells = [];
    for (let r = 1; r <= row + 1; r += 1) {
      for (let c = 1; c <= col + 1; c += 1) {
        cells.push(`button[data-value="insert-table:${r}:${c}"]`);
      }
    }
    return `.office-table-grid:has(button[data-value="insert-table:${row + 1}:${col + 1}"]:hover) :is(${cells.join(", ")}) { border-color: var(--color-bamboo); background: var(--color-paper-warm); }`;
  }).join("\n")
).join("\n");

const PANEL_CSS = `
.office-panel, .office-panel * { box-sizing: border-box; }
.office-panel { display: flex; flex-direction: column; gap: 20px; }
.office-note { margin: 0; color: var(--color-ink-ghost); font-size: 11px; line-height: 1.65; }
.office-group-box {
  padding: 10px;
  border: 1px solid var(--color-paper-deep);
  border-radius: 10px;
}
.office-group-box h4 { margin: 0 0 8px; color: var(--color-ink); font-size: 11px; font-weight: 600; letter-spacing: .08em; }
.office-table-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; width: max-content; margin-top: 8px; }
.office-table-grid button { width: 20px; height: 16px; padding: 0; border: 1px solid var(--color-paper-deep); border-radius: 3px; background: var(--color-paper); cursor: pointer; }
.office-table-grid button:hover { border-color: var(--color-bamboo); background: var(--color-paper-warm); }
.office-insert-row { display: flex; flex-wrap: wrap; gap: 6px; }
.office-insert-row .office-icon-btn { width: auto; min-width: 54px; height: 30px; padding: 0 10px; font-size: 12px; }
.office-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
.office-btn {
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--color-paper-deep);
  border-radius: 7px;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: 12px;
  line-height: 24px;
  cursor: pointer;
}
.office-btn:hover { border-color: var(--color-bamboo); color: var(--color-bamboo); }
.office-btn.is-action { border-color: var(--color-bamboo); color: var(--color-bamboo); }
.office-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.office-row > span { flex: 0 0 30px; color: var(--color-ink-ghost); font-size: 11px; }

/* ---- 工具组：两行、分块线、右下角箭头（字体组与段落组共用） ------------ */

.office-font-group,
.office-para-group {
  position: relative;
  padding: 8px 8px 15px;
  border: 1px solid var(--color-paper-deep);
  border-radius: 10px;
}
.office-font-row,
.office-para-row { display: flex; align-items: center; gap: 6px; }
.office-font-row + .office-font-row,
.office-para-row + .office-para-row {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--color-paper-deep);
}
.office-font-pair {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--color-paper-deep);
  border-radius: 7px;
  overflow: hidden;
}
.office-font-pair .office-select {
  height: 28px;
  border: 0;
  background: transparent;
  color: var(--color-ink);
  font-size: 12px;
  outline: none;
}
.office-font-name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 8px;
  border-right: 1px solid var(--color-paper-deep);
}
.office-font-size { flex: 0 0 70px; padding: 0 6px; }
.office-tool-block {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 6px;
  border-left: 1px solid var(--color-paper-deep);
}
.office-tool-block:first-child { padding-left: 0; border-left: 0; }
.office-icon-btn {
  min-width: 26px;
  height: 26px;
  padding: 0 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: 13px;
  line-height: 26px;
  cursor: pointer;
}
.office-icon-btn:hover { background: var(--color-paper-warm); color: var(--color-ink); }
.office-icon-btn:disabled { opacity: .4; cursor: default; }
.office-icon-btn:disabled:hover { background: transparent; color: var(--color-ink-soft); }
.office-caret { margin-left: 2px; font-size: 8px; opacity: .55; }
.office-color-bar {
  display: block;
  width: 14px;
  height: 3px;
  margin: 1px auto 0;
  border-radius: 2px;
  background: var(--color-bamboo);
}
.office-highlight {
  padding: 0 2px;
  border-radius: 2px;
  background: #ffe66d;
  color: #1a1a18;
}
.office-eraser-icon {
  display: inline-block;
  width: 14px;
  height: 9px;
  margin: 0 2px;
  border: 1px solid currentColor;
  border-radius: 2px;
  background: linear-gradient(180deg, #f2a6a6 0 45%, transparent 45% 100%);
  transform: rotate(-35deg);
}
.office-more {
  position: absolute;
  right: 4px;
  bottom: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 16px;
  border-radius: 4px;
  color: var(--color-ink-ghost);
  font-size: 11px;
  cursor: pointer;
}
.office-more:hover { background: var(--color-paper-warm); color: var(--color-bamboo); }

/* ---- 段落组：Word 样的图标 ---------------------------------------------- */

.office-para-select {
  width: 76px;
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--color-paper-deep);
  border-radius: 6px;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: 11px;
  outline: none;
  cursor: pointer;
}
.office-para-select:hover { border-color: var(--color-bamboo); color: var(--color-bamboo); }

.office-ico {
  display: inline-block;
  position: relative;
  width: 16px;
  height: 14px;
  vertical-align: -2px;
  color: inherit;
}
/* 对齐：三条长短不一的横线。 */
.office-ico-align {
  background-image:
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor);
  background-size: 100% 1.5px, 70% 1.5px, 100% 1.5px;
  background-position: 0 1px, 0 6px, 0 11px;
  background-repeat: no-repeat;
}
.office-ico-align.is-center { background-position: 0 1px, center 6px, 0 11px; }
.office-ico-align.is-right { background-position: 0 1px, right 6px, 0 11px; }
.office-ico-align.is-justify { background-size: 100% 1.5px, 100% 1.5px, 100% 1.5px; }
/* 项目符号：左边三个圆点，右边三条线。 */
.office-ico-bullets {
  background-image:
    radial-gradient(circle at 2px 2px, currentColor 1.4px, transparent 1.6px),
    radial-gradient(circle at 2px 7px, currentColor 1.4px, transparent 1.6px),
    radial-gradient(circle at 2px 12px, currentColor 1.4px, transparent 1.6px),
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor);
  background-size: 5px 5px, 5px 5px, 5px 5px, 9px 1.5px, 9px 1.5px, 9px 1.5px;
  background-position: 0 0, 0 5px, 0 10px, 7px 1px, 7px 6px, 7px 11px;
  background-repeat: no-repeat;
}
/* 编号：左边一个 1，右边三条线。 */
.office-ico-numbered::before {
  content: "1";
  position: absolute;
  left: 0;
  top: -3px;
  font-size: 8px;
  font-weight: 600;
  line-height: 1;
}
.office-ico-numbered {
  background-image:
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor);
  background-size: 9px 1.5px, 9px 1.5px, 9px 1.5px;
  background-position: 7px 1px, 7px 6px, 7px 11px;
  background-repeat: no-repeat;
}
/* 缩进：半透明的横线 + 一个三角箭头。 */
.office-ico-indent {
  background-image:
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor);
  background-size: 16px 1.5px, 16px 1.5px, 16px 1.5px;
  background-position: 0 1px, 0 6px, 0 11px;
  background-repeat: no-repeat;
  opacity: .85;
}
.office-ico-indent::before {
  content: "";
  position: absolute;
  top: 4px;
  border-top: 3px solid transparent;
  border-bottom: 3px solid transparent;
}
.office-ico-indent.is-out::before { left: 0; border-right: 4px solid currentColor; }
.office-ico-indent.is-in::before { right: 0; border-left: 4px solid currentColor; }
/* 排序：A ↓ Z。 */
.office-ico-sort {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: -.5px;
}
.office-ico-sort em { font-style: normal; font-size: 10px; font-weight: 400; }
/* 行距：三条线 + 右侧上下箭头。 */
.office-ico-line-spacing {
  background-image:
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor),
    linear-gradient(currentColor, currentColor);
  background-size: 11px 1.5px, 11px 1.5px, 11px 1.5px;
  background-position: 0 1px, 0 6px, 0 11px;
  background-repeat: no-repeat;
}
.office-ico-line-spacing::after {
  content: "↕";
  position: absolute;
  right: -1px;
  top: -2px;
  font-size: 10px;
  line-height: 1;
}
/* 边框与底纹。 */
.office-ico-borders {
  width: 13px;
  height: 13px;
  border: 1.5px solid currentColor;
  border-radius: 1px;
}
.office-ico-shading {
  width: 13px;
  height: 13px;
  border: 1px solid currentColor;
  border-radius: 1px;
  background: repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 4px);
}
/* 段落标记 ¶ 用字形本身。 */
.office-ico-marks { font-size: 15px; line-height: 14px; text-align: center; }

/* ---- 详细页（整个侧栏）：字体页与段落页 --------------------------------- */

.office-detail-view,
.office-para-detail { display: none; }
.office-panel:has(.office-detail-radio:checked) .office-main-view,
.office-panel:has(.office-para-detail-radio:checked) .office-main-view { display: none; }
.office-panel:has(.office-detail-radio:checked) .office-detail-view { display: block; }
.office-panel:has(.office-para-detail-radio:checked) .office-para-detail { display: block; }
.office-view-radio {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.office-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--color-ink-soft);
  font-size: 17px;
  line-height: 24px;
  cursor: pointer;
}
.office-back:hover { background: var(--color-paper-warm); color: var(--color-bamboo); }
.office-detail-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.office-detail-tabs {
  display: flex;
  flex: 1;
  gap: 18px;
  margin: 0 0 12px;
  border-bottom: 1px solid var(--color-paper-deep);
}
.office-detail-tab { padding: 0 0 6px; color: var(--color-ink-ghost); font-size: 12px; }
.office-detail-tab.is-active { color: var(--color-bamboo); border-bottom: 2px solid var(--color-bamboo); }
.office-detail-section { margin: 0 0 14px; }
.office-detail-section h5 { margin: 0 0 6px; color: var(--color-ink); font-size: 11px; font-weight: 600; }
.office-detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.office-detail-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.office-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; color: var(--color-ink-soft); font-size: 11px; }
.office-field select {
  width: 100%;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--color-paper-deep);
  border-radius: 6px;
  background: var(--color-paper-warm);
  color: var(--color-ink);
  font-size: 12px;
  outline: none;
}
.office-field select:disabled { opacity: .55; }
.office-effects { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 10px; }
.office-effects label { display: flex; align-items: center; gap: 6px; color: var(--color-ink-soft); font-size: 11px; }
.office-effects input { margin: 0; accent-color: var(--color-bamboo); }
.office-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 56px;
  border: 1px solid var(--color-paper-deep);
  border-radius: 8px;
  background: var(--color-paper-warm);
  color: var(--color-ink);
}
.office-preview strong { font-size: 28px; font-weight: 700; }
.office-detail-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 4px;
}
${TABLE_HOVER_CSS}
`;

const FONT_OPTIONS = [
  // 「跟随文档 / 不可识别」时留空，和 Word 一样；选中具体字体后才显示名字。
  ["follow", ""],
  ["SimSun", "宋体"],
  ["SimHei", "黑体"],
  ["Microsoft YaHei", "微软雅黑"],
  ["DengXian", "等线"],
  ["KaiTi", "楷体"],
  ["FangSong", "仿宋"],
  ["Arial", "Arial"],
  ["Calibri", "Calibri"],
  ["Times New Roman", "Times New Roman"],
];

/** 字号用 Word 的叫法，值仍是 pt。 */
const SIZE_OPTIONS = [
  ["follow", ""],
  ["10.5", "五号"],
  ["12", "小四"],
  ["14", "四号"],
  ["15", "小三"],
  ["16", "三号"],
  ["18", "小二"],
  ["22", "二号"],
  ["24", "小一"],
  ["26", "一号"],
];

const SHAPE_OPTIONS = [
  ["regular", "常规"],
  ["bold", "加粗"],
  ["italic", "倾斜"],
  ["bold-italic", "加粗倾斜"],
];

/** 段落组里的行距下拉：空白 = 跟随文档（当前仍是整篇预览）。 */
const LINE_OPTIONS = [
  ["follow", ""],
  ["1", "1.0"],
  ["1.15", "1.15"],
  ["1.5", "1.5"],
  ["2", "2.0"],
  ["2.5", "2.5"],
  ["3", "3.0"],
];

const ALIGN_OPTIONS = [
  ["follow", "跟随文档"],
  ["left", "左对齐"],
  ["center", "居中"],
  ["right", "右对齐"],
  ["both", "两端对齐"],
  ["distribute", "分散对齐"],
];

const SPACING_OPTIONS = [
  ["follow", "跟随"],
  ["0", "0 磅"],
  ["6", "6 磅"],
  ["12", "12 磅"],
  ["18", "18 磅"],
  ["24", "24 磅"],
];

function optionList(items) {
  return items
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
}

function button(value, label, extraClass = "") {
  const className = extraClass ? `office-btn ${extraClass}` : "office-btn";
  return `<button class="${className}" data-value="${value}">${label}</button>`;
}

function buttons(items) {
  return `<div class="office-buttons">${items.map(([value, label]) => button(value, label)).join("")}</div>`;
}

function iconButton(value, label, ariaLabel, extraClass = "") {
  const className = extraClass ? `office-icon-btn ${extraClass}` : "office-icon-btn";
  return `<button class="${className}" data-value="${value}" aria-label="${ariaLabel}">${label}</button>`;
}

function disabledIcon(label, ariaLabel) {
  return `<button class="office-icon-btn" disabled aria-label="${ariaLabel}">${label}</button>`;
}

/**
 * 面板 HTML。
 *
 * **必须稳定**：宿主按字符串缓存面板，内容每变一次就会重建 DOM、把滚动位置归零。
 * 所以这里不写文件名、时间戳、当前选中项之类的动态内容；主视图 / 详细页的切换
 * 用 radio + `:has()`，不依赖重新渲染。
 */
const TABLE_GRID_HTML = Array.from({ length: 8 }, (_, row) =>
  Array.from({ length: 8 }, (_, col) =>
    `<button class="office-btn office-table-cell" data-value="insert-table:${row + 1}:${col + 1}" title="${row + 1} × ${col + 1}" aria-label="插入 ${row + 1} 行 ${col + 1} 列表格"></button>`
  ).join("")
).join("");

const PANEL_HTML = `
<div class="office-panel">
  <div class="office-main-view">
    <p class="office-note">
      字体、字号、对齐与行距可立即预览；选中文字后可用加粗 / 斜体 / 下划线 / 删除线 / 上下标。
    </p>

    <div class="office-font-group">
      <div class="office-font-row">
        <div class="office-font-pair">
          <select class="office-select office-font-name" data-key="font" aria-label="字体">
            ${optionList(FONT_OPTIONS)}
          </select>
          <select class="office-select office-font-size" data-key="size" aria-label="字号">
            ${optionList(SIZE_OPTIONS)}
          </select>
        </div>
        <div class="office-tool-block">
          ${iconButton("size-plus", "A⁺", "增大字号")}
          ${iconButton("size-minus", "A⁻", "减小字号")}
        </div>
        <div class="office-tool-block">
          ${disabledIcon("A", "文本效果")}
          ${iconButton("reset", '<span class="office-eraser-icon"></span>', "清除格式")}
        </div>
      </div>

      <div class="office-font-row">
        <div class="office-tool-block">
          ${iconButton("run:bold", "<b>B</b>", "加粗")}
          ${iconButton("run:italic", "<i>I</i>", "倾斜")}
          ${iconButton("run:underline", '<u>U</u>', "下划线")}
          ${iconButton("run:strike", "<s>ab</s>", "删除线")}
          ${iconButton("run:sup", "X<sup>2</sup>", "上标")}
          ${iconButton("run:sub", "X<sub>2</sub>", "下标")}
        </div>
        <div class="office-tool-block">
          ${disabledIcon('A<span class="office-color-bar"></span>', "字体颜色")}
          ${disabledIcon('<span class="office-highlight">A</span>', "突出显示")}
          ${disabledIcon("Aa", "更改大小写")}
        </div>
      </div>

      <label class="office-more" aria-label="更多字体设置">
        <input type="radio" name="office-font-view" class="office-view-radio office-detail-radio" />
        <span>↘</span>
      </label>
    </div>

    <div class="office-para-group">
      <div class="office-para-row">
        <div class="office-tool-block">
          ${disabledIcon('<span class="office-ico office-ico-bullets"></span><span class="office-caret">▾</span>', "项目符号")}
          ${disabledIcon('<span class="office-ico office-ico-numbered"></span><span class="office-caret">▾</span>', "编号")}
        </div>
        <div class="office-tool-block">
          ${disabledIcon('<span class="office-ico office-ico-indent is-out"></span>', "减少缩进量")}
          ${disabledIcon('<span class="office-ico office-ico-indent is-in"></span>', "增加缩进量")}
        </div>
        <div class="office-tool-block">
          ${disabledIcon('<span class="office-ico-sort">A<em>↓</em>Z</span>', "排序")}
        </div>
        <div class="office-tool-block">
          ${iconButton("marks", '<span class="office-ico-marks">¶</span>', "显示 / 隐藏编辑标记")}
        </div>
      </div>

      <div class="office-para-row">
        <div class="office-tool-block">
          ${iconButton("align:left", '<span class="office-ico office-ico-align"></span>', "左对齐")}
          ${iconButton("align:center", '<span class="office-ico office-ico-align is-center"></span>', "居中")}
          ${iconButton("align:right", '<span class="office-ico office-ico-align is-right"></span>', "右对齐")}
          ${iconButton("align:both", '<span class="office-ico office-ico-align is-justify"></span>', "两端对齐")}
        </div>
        <div class="office-tool-block">
          <span class="office-ico office-ico-line-spacing" aria-hidden="true"></span>
          <select class="office-para-select" data-key="line" aria-label="行距">
            ${optionList(LINE_OPTIONS)}
          </select>
        </div>
        <div class="office-tool-block">
          ${disabledIcon('<span class="office-ico office-ico-shading"></span>', "底纹")}
          ${disabledIcon('<span class="office-ico office-ico-borders"></span>', "边框")}
        </div>
      </div>

      <label class="office-more" aria-label="更多段落设置">
        <input type="radio" name="office-para-view" class="office-view-radio office-para-detail-radio" />
        <span>↘</span>
      </label>
    </div>

    <section class="office-group-box">
      <h4>显示</h4>
      ${buttons([["numbers", "切换段落序号"]])}
    </section>
  </div>

  <div class="office-detail-view">
    <div class="office-detail-top">
      <div class="office-detail-tabs">
        <span class="office-detail-tab is-active">字体</span>
        <span class="office-detail-tab">字符间距</span>
      </div>
      <label class="office-back" aria-label="返回">
        <input type="radio" name="office-font-view" class="office-view-radio office-main-radio" checked />
        <span>←</span>
      </label>
    </div>

    <p class="office-note">
      这一版先做排版：中文字体、字号可以生效，其余选项要等编辑模式接入。
    </p>

    <div class="office-detail-section">
      <div class="office-detail-grid">
        <label class="office-field">
          <span>中文字体</span>
          <select data-key="font" aria-label="中文字体">${optionList(FONT_OPTIONS)}</select>
        </label>
        <label class="office-field">
          <span>字形</span>
          <select disabled aria-label="字形">${optionList(SHAPE_OPTIONS)}</select>
        </label>
        <label class="office-field">
          <span>字号</span>
          <select data-key="size" aria-label="字号">${optionList(SIZE_OPTIONS)}</select>
        </label>
      </div>
    </div>

    <div class="office-detail-section">
      <label class="office-field">
        <span>西文字体</span>
        <select disabled aria-label="西文字体">
          ${optionList([
            ["inherit", "使用中文字体"],
            ["Times New Roman", "Times New Roman"],
            ["Arial", "Arial"],
            ["Calibri", "Calibri"],
          ])}
        </select>
      </label>
    </div>

    <div class="office-detail-section">
      <h5>复杂文种</h5>
      <div class="office-detail-grid">
        <label class="office-field">
          <span>字体</span>
          <select disabled aria-label="复杂文种字体">${optionList([["Times New Roman", "Times New Roman"]])}</select>
        </label>
        <label class="office-field">
          <span>字形</span>
          <select disabled aria-label="复杂文种字形">${optionList([["regular", "常规"]])}</select>
        </label>
        <label class="office-field">
          <span>字号</span>
          <select disabled aria-label="复杂文种字号">${optionList([["22", "二号"]])}</select>
        </label>
      </div>
    </div>

    <div class="office-detail-section">
      <h5>所有文字</h5>
      <div class="office-detail-grid">
        <label class="office-field">
          <span>字体颜色</span>
          <select disabled aria-label="字体颜色">${optionList([["auto", "自动"]])}</select>
        </label>
        <label class="office-field">
          <span>下划线线型</span>
          <select disabled aria-label="下划线线型">${optionList([["none", "（无）"]])}</select>
        </label>
        <label class="office-field">
          <span>下划线颜色</span>
          <select disabled aria-label="下划线颜色">${optionList([["auto", "自动"]])}</select>
        </label>
        <label class="office-field">
          <span>着重号</span>
          <select disabled aria-label="着重号">${optionList([["none", "（无）"]])}</select>
        </label>
      </div>
    </div>

    <div class="office-detail-section">
      <h5>效果</h5>
      <div class="office-effects">
        <label><input type="checkbox" disabled />删除线</label>
        <label><input type="checkbox" disabled />小型大写字母</label>
        <label><input type="checkbox" disabled />双删除线</label>
        <label><input type="checkbox" disabled />全部大写字母</label>
        <label><input type="checkbox" disabled />上标</label>
        <label><input type="checkbox" disabled />隐藏文字</label>
        <label><input type="checkbox" disabled />下标</label>
      </div>
    </div>

    <div class="office-detail-section">
      <h5>预览</h5>
      <div class="office-preview"><strong>第二</strong></div>
    </div>

    <div class="office-detail-actions">
      ${button("reset", "恢复文档原样", "is-action")}
    </div>
  </div>

  <div class="office-para-detail">
    <div class="office-detail-top">
      <div class="office-detail-tabs">
        <span class="office-detail-tab is-active">缩进和间距</span>
        <span class="office-detail-tab">换行和分页</span>
      </div>
      <label class="office-back" aria-label="返回">
        <input type="radio" name="office-para-view" class="office-view-radio office-para-main-radio" checked />
        <span>←</span>
      </label>
    </div>

    <div class="office-detail-section">
      <h5>常规</h5>
      <label class="office-field">
        <span>对齐方式</span>
        <select data-key="align" aria-label="对齐方式">${optionList(ALIGN_OPTIONS)}</select>
      </label>
    </div>

    <div class="office-detail-section">
      <h5>缩进</h5>
      <div class="office-detail-grid">
        <label class="office-field">
          <span>左侧</span>
          <select disabled aria-label="左侧缩进">${optionList([["0", "0 字符"]])}</select>
        </label>
        <label class="office-field">
          <span>右侧</span>
          <select disabled aria-label="右侧缩进">${optionList([["0", "0 字符"]])}</select>
        </label>
        <label class="office-field">
          <span>特殊格式</span>
          <select disabled aria-label="特殊格式">${optionList([["none", "（无）"]])}</select>
        </label>
      </div>
    </div>

    <div class="office-detail-section">
      <h5>间距</h5>
      <div class="office-detail-grid">
        <label class="office-field">
          <span>段前</span>
          <select data-key="before" aria-label="段前">${optionList(SPACING_OPTIONS)}</select>
        </label>
        <label class="office-field">
          <span>段后</span>
          <select data-key="after" aria-label="段后">${optionList(SPACING_OPTIONS)}</select>
        </label>
        <label class="office-field">
          <span>行距</span>
          <select data-key="line" aria-label="行距">${optionList(LINE_OPTIONS)}</select>
        </label>
      </div>
    </div>

    <p class="office-note">
      这一版是整篇预览：改的是你看到的排版，不动原文件。按段落生效要等编辑模式（M5）。
    </p>

    <div class="office-detail-actions">
      ${button("reset", "恢复文档原样", "is-action")}
    </div>
  </div>
</div>
`;

/**
 * `data-value` → 发给视图的 JSON 载荷。
 *
 * 视图只认这一种形状；面板不直接碰排版，也不猜视图的状态。
 */
const INSERT_HTML = `
<div class="office-panel office-insert-panel">
  <p class="office-note">插入内容到光标所在段落之后。</p>

  <section class="office-group-box">
    <h4>表格</h4>
    <p class="office-note">点选行列数，立即插入一张等宽表格。</p>
    <div class="office-table-grid">${TABLE_GRID_HTML}</div>
  </section>

  <section class="office-group-box">
    <h4>其他插入</h4>
    <div class="office-insert-row">
      ${disabledIcon("图片", "插入图片")}
      ${disabledIcon("形状", "插入形状")}
      ${disabledIcon("文本框", "插入文本框")}
      ${disabledIcon("符号", "插入符号")}
      ${disabledIcon("公式", "插入公式")}
    </div>
    <p class="office-note">这些类型暂时只做占位，后续接入。</p>
  </section>
</div>
`;

function actionToPayload(action) {
  if (!action) return null;
  if (action === "marks" || action === "numbers" || action === "reset") {
    return { type: action };
  }

  const separator = action.indexOf(":");
  if (separator < 0) return null;
  const kind = action.slice(0, separator);
  const raw = action.slice(separator + 1);
  const value = raw === "follow" ? null : raw;

  if (kind === "insert-table") {
    const [rows, cols] = raw.split(":").map(Number);
    return { type: "insert-table", rows, cols };
  }
  if (kind === "run") {
    if (raw === "sup") return { type: "run-format", key: "vertAlign", value: "superscript" };
    if (raw === "sub") return { type: "run-format", key: "vertAlign", value: "subscript" };
    return { type: "run-format", key: raw };
  }
  if (kind === "font") return { type: "font", value: raw };
  if (kind === "size") {
    return { type: "size", value: value === null ? null : Number(value) };
  }
  if (kind === "line") {
    return { type: "line", value: value === null ? null : Number(value) };
  }
  if (kind === "before" || kind === "after") {
    return { type: "spacing", [kind]: value === null ? null : Number(value) };
  }
  if (kind === "align") {
    return { type: "align", value };
  }
  return null;
}

/** 让 `onUnload` 能清掉轮询与面板。 */
let stopSync = null;

floral.register({
  onLoad(api) {
    api.files.registerType({
      id: DOCX_TYPE_ID,
      extensions: ["docx"],
      label: "Word 文档",
      badge: "DOC",
      // Word 的惯用蓝，卡片左侧那条竖标一眼能认出来。
      color: "#2b579a",
      kind: "view",
      // 新建 .docx 时先落一份空文档骨架，而不是 0 字节。
      newFile: BLANK_DOCX_BASE64,
      view: {
        html: "view/index.html",
        css: ["view/viewer.css"],
        js: ["view/viewer.js"],
        // 顶上那排控件**由宿主渲染**：视图是沙箱里的一块孤岛，自己画工具栏跟窗口的排版
        // 对不齐。这里只留翻页 / 缩放这类「对画面做的事」；字体、段落进右侧的「开始」面板。
        toolbar: [
          { kind: "button", id: "zoom-out", title: "缩小", icon: "icons/zoom-out.svg" },
          { kind: "readout", id: "zoom", title: "缩放比例" },
          { kind: "button", id: "zoom-in", title: "放大", icon: "icons/zoom-in.svg" },
          {
            kind: "button",
            id: "fit-width",
            label: "适应宽度",
            title: "按窗口宽度铺满",
            toggle: true,
            icon: "icons/fit-width.svg",
          },
          { kind: "separator" },
          { kind: "button", id: "page-prev", title: "上一页", icon: "icons/page-prev.svg" },
          { kind: "readout", id: "page", title: "当前页 / 总页数" },
          { kind: "button", id: "page-next", title: "下一页", icon: "icons/page-next.svg" },
          { kind: "input", id: "goto", title: "跳转到页（回车）", placeholder: "页码", width: 46 },
          { kind: "separator" },
          {
            kind: "button",
            id: "spread",
            label: "连续",
            title: "单页 / 连续",
            toggle: true,
            icon: "icons/spread.svg",
          },
          { kind: "separator" },
          {
            kind: "button",
            id: "save-as",
            label: "另存为",
            title: "另存为新的 .docx（原文件不动）",
          },
        ],
      },
    });

    api.ui.registerStyle({ id: "office-home", css: PANEL_CSS });

    const sendFormat = (payload) => {
      void api.ui.sendToView({
        id: "office-format",
        value: JSON.stringify(payload),
      });
    };

    const typeId = `${api.plugin.id}:${DOCX_TYPE_ID}`;
    const PANEL_SPECS = [
      { id: "home", title: "开始", width: 320, html: PANEL_HTML },
      { id: "insert", title: "插入", width: 300, html: INSERT_HTML },
    ];
    const panelRegistrations = new Map();
    const panelPending = new Map();
    let wantPanel = false;
    let lastTypeId = null;

    function onPanelClick(ref) {
      const target = ref.closestClass("office-btn") || ref.closestClass("office-icon-btn");
      if (!target) return;
      const action = target.attrs["data-value"];
      if (!action) return;

      if (action === "size-plus") {
        sendFormat({ type: "size-adjust", delta: 1 });
        return;
      }
      if (action === "size-minus") {
        sendFormat({ type: "size-adjust", delta: -1 });
        return;
      }
      const payload = actionToPayload(action);
      if (payload) sendFormat(payload);
    }

    function onPanelChange(ref) {
      // 只认这些带 data-key 的原生下拉框；其余下拉框是 disabled 的排版占位。
      const key = ref.attrs["data-key"];
      if (!key) return;
      const value = ref.attrs["value"] ?? "";
      if (key === "font") {
        sendFormat({ type: "font", value });
      } else if (key === "size") {
        sendFormat({ type: "size", value: value === "follow" ? null : Number(value) });
      } else if (key === "line") {
        sendFormat({ type: "line", value: value === "follow" ? null : Number(value) });
      } else if (key === "before" || key === "after") {
        sendFormat({ type: "spacing", [key]: value === "follow" ? null : Number(value) });
      } else if (key === "align") {
        sendFormat({ type: "align", value: value === "follow" ? null : value });
      }
    }

    function registerOne(spec) {
      const pending = api.ui
        .registerPanel({
          id: spec.id,
          title: spec.title,
          standalone: true,
          width: spec.width,
          render() {
            return spec.html;
          },
          onClick: onPanelClick,
          onChange: onPanelChange,
        })
        .then((id) => {
          panelPending.delete(spec.id);
          if (!wantPanel) {
            void api.ui.dispose(id);
            return;
          }
          panelRegistrations.set(spec.id, id);
        })
        .catch((error) => {
          panelPending.delete(spec.id);
          api.log.debug(`注册「${spec.title}」面板失败：${error?.message ?? error}`);
        });
      panelPending.set(spec.id, pending);
    }

    /**
     * 当前文件是 docx 就注册「开始」「插入」两个面板，换成别的就 dispose。
     * `getFileSync()` 是同步镜像；文件切换后最多 500ms 才被轮询看到。
     */
    function syncPanel() {
      if (typeof api.editor.getFileSync !== "function") return;
      const file = api.editor.getFileSync();
      const current = file?.typeId ?? null;
      if (current === lastTypeId) return;
      lastTypeId = current;
      wantPanel = current === typeId;

      if (wantPanel) {
        for (const spec of PANEL_SPECS) {
          if (panelRegistrations.has(spec.id) || panelPending.has(spec.id)) continue;
          registerOne(spec);
        }
        return;
      }

      for (const id of panelRegistrations.values()) void api.ui.dispose(id);
      panelRegistrations.clear();
    }

    syncPanel();
    const timer = setInterval(syncPanel, 500);

    stopSync = () => {
      clearInterval(timer);
      wantPanel = false;
      for (const id of panelRegistrations.values()) void api.ui.dispose(id);
      panelRegistrations.clear();
    };
  },

  onUnload() {
    stopSync?.();
    stopSync = null;
  },
});
