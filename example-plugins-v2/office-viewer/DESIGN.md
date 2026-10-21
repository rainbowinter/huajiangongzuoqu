# office-viewer 设计说明

> 状态：**M0 / M1 已完成，M2 / M3 / M4 的第一版也已落地**。真实 `.docx` 能打开并按页
> 渲染；编辑与另存 `.docx` 还在 M5 / M6。下面「里程碑」一节写的是实际完成度。

这个插件要在花笺里打开 Word 文档（先 `.docx`，之后同一插件里加 `.pptx` / `.xlsx`）。
目标不是「把文字倒出来」，而是**按 Word 的规则分页与排版**，并且能编辑、另存为新的 `.docx`。

---

## 1. 为什么是 `kind: "view"`

宿主给插件的渲染口子有三档：

| 方式 | 能力 | 够不够 |
|---|---|---|
| `kind: "custom"` | 返回一段经过消毒的 HTML 字符串 | 不能执行脚本、没有 canvas、拿不到二进制 |
| `kind: "view"` | 沙箱 iframe 里跑插件自己的 HTML/CSS/JS，宿主把文件字节递进来 | **够** |
| 改宿主 | 把 Word 做进应用本体 | 不选 |

Word 文档要先解压、再按 OOXML 解析、最后自己做行排版与分页，三样都需要真实的脚本环境，
所以只有 `view` 合适。现有的 `pdf-viewer` 是同一条路，可以直接对照。

### 沙箱带来的硬约束

- 帧是 **opaque origin**：`fetch` 取不到外部资源，相对路径、`asset://` 都不行；
  视图的 HTML/CSS/JS 由宿主读成文本、拼成 `srcdoc`。
- **没有 localStorage / IndexedDB**，插件不能把阅读设置偷偷存在浏览器里。
- 文件字节只能主动向宿主要（`floralView.requestDocument()`），拿到的是一条 `ArrayBuffer`。
- 只有 `floralView.saveFile(name, bytes)` 能让插件往磁盘写东西，而且**弹原生保存对话框**、
  路径由用户选。**没有「原地保存」** —— 所以「保存」这个词在插件里只能是「另存为」。
- 宿主注册的插件字体**进不了视图**；视图只能用 WebView2 能访问到的系统字体。

---

## 2. Word 的排版模型（调研摘要）

### 2.1 三层结构

```
section → paragraph → run
```

- **section**：页面尺寸、页边距、分栏、页眉页脚、文档网格；`w:sectPr` 可以出现在正文里表示分节。
- **paragraph**：对齐、缩进、段前段后、行距、分页控制；对应 `w:p` / `w:pPr`。
- **run**：一段同样式文字；字体、字号（**半磅**）、粗斜体、颜色、上下标、字符间距；对应 `w:r` / `w:rPr`。

### 2.2 样式级联

```
docDefaults（styles.xml）
  → 段落样式（basedOn 链）
  → 字符样式
  → 直接格式（run / paragraph 自己身上的属性）
```

主题字体从 `word/theme/theme1.xml` 的 major/minor 字体方案里取；`w:rFonts` 的
`ascii` / `hAnsi` 管拉丁字符，`eastAsia` 管汉字，`cs` 管复杂文种。**同一行里中英文
可能用两套字体**，测量与断行要按字符分流。

### 2.3 行高

`w:spacing` 的 `lineRule` 有三种：

| `lineRule` | 含义 | 算法 |
|---|---|---|
| `auto`（默认） | 倍数 | `w:line / 240 × 单倍行高`；1.15 倍是 `w:line="276"` |
| `exact` | 固定值 | 直接按 twips 固定，内容可能被裁 |
| `atLeast` | 最小值 | `max(单倍行高, w:line)` |

「单倍行高」来自字体自身的 ascent + descent + lineGap，不是字号本身。浏览器
`line-height: normal` 的算法与 Word 不完全一样，所以引擎要自己量字体度量，不能直接
拿 CSS 的 `normal` 当答案。

中文文档还常带**文档网格**（`w:docGrid w:linePitch`、`w:snapToGrid`）；行高要吸附到
网格上。不实现这一条，中文 Word 的分页会和原文档差很多。

### 2.4 断行

- 西文：UAX #14，在空格、连字符、标点处断；Word 默认不做自动断词（hyphenation）。
- 中文：UAX #14 的东亚规则 + **禁则处理**：
  - 行首禁则：`，。、；：？！）］｝〉》」』】”’` 等不能出现在行首；
  - 行尾禁则：`（［｛〈《「『【“‘` 等不能出现在行尾；
  - 不能拆开的组合（数字 + 单位、连续标点、省略号等）。
- Word 另有：
  - `w:overflowPunct`：允许标点悬挂到右边距外；
  - `w:topLinePunct`：行首标点压缩；
  - `w:autoSpaceDE/DN`：中英文、中文与数字之间自动加间隙；
  - `w:kinsoku`：禁则开关（默认开）。

首版先做「禁则 + 推字」，悬挂、压缩、自动间距放在 M2 的后半段。

### 2.5 对齐

`w:jc` 的值：`left` / `start`、`center`、`right` / `end`、`both`（两端对齐）、
`distribute`（分散对齐）。

两端对齐要把剩余宽度分配到字/词之间，**最后一行不对齐**；段落以手动换行（`w:br`）分成
几段时，每个小段的最后一行都不对齐。这件事必须在我们自己决定断行之后做，不能交给
CSS 的 `text-align: justify` —— 那会重新断行，行数就变了。

### 2.6 分页

Word 的分页是一组约束，不是单纯的「排不下就换页」：

- `w:pageBreakBefore`：段前强制分页；
- `w:keepLines`：整段不拆页；
- `w:keepNext`：与下一段同页（标题最常用）；
- `w:widowControl`：孤行控制，段首/段尾不能只剩一行（默认开）；
- 段前段后间距；
- `w:br w:type="page"`：手动分页符；
- `w:sectPr`：分节符（下一页 / 连续 / 偶数页 / 奇数页）；
- 分栏、页眉页脚、脚注。

这些约束会互相影响，所以分页要「先把段落排成行，再按约束装箱」，不能边排边决定。

### 2.7 单位

- twips：1/20 pt，`w:spacing`、`w:ind`、`w:pgSz`、`w:pgMar` 都用它；
- 半磅：`w:sz`；
- 字符单位：`w:ind w:firstLineChars="200"` 表示 2 个字符；
- EMU：图片、DrawingML（1 EMU = 1/914400 inch）。

引擎内部统一用 **CSS px（96dpi）** 做布局：`1pt = 4/3 px`，`1twip = 1/15 px`。

---

## 3. 架构

### 3.1 管线

```
docx bytes
  → 解压（DecompressionStream("deflate-raw")）
  → OOXML 解析（document / styles / numbering / theme / settings / rels）
  → 规范化 IR（Section / Paragraph / Run，保留原 XML 节点指针）
  → 样式级联 + 字体解析
  → 文本原子化（中文按字、西文按词、禁则）
  → 行级排版（测量 / 断行 / 行高 / 缩进 / 对齐）
  → 分页装箱（keepLines / keepNext / widow / pageBreak）
  → DOM 渲染（按页虚拟化）
```

### 3.2 目录

```
office-viewer/
  plugin.json              # 先注册 .docx
  index.js                 # 只做文件类型登记
  icon.svg / icons/
  build.mjs                # src/ → view/viewer.js
  view/
    index.html
    viewer.css
    viewer.js              # 构建产物；宿主只读这一个 bundle
  src/
    main.js                # 宿主桥接、工具栏、排版面板、缩放 / 翻页
    units.js               # twips / pt / px / EMU
    xml.js                 # 命名空间无关的 OOXML 读取助手
    zip.js                 # 只读 ZIP（浏览器自带 DecompressionStream）
    docx/
      parse.js             # document.xml → blocks / items
      props.js             # pPr / rPr
      styles.js            # 样式级联
      theme.js             # 主题字体
      numbering.js         # 自动编号
      section.js           # 页面设置 / 文档网格 / settings
    layout/
      measure.js           # Canvas 测量 + 缓存
      atoms.js             # 文本原子 + 禁则
      lines.js             # 段落 → 行
      paginate.js          # 行 → 页
      index.js             # 排版入口
    render/
      pages.js             # 页 / 行 / 原子 DOM，懒加载
      theme.js             # 宿主主题 token
  test/
    linebreak.test.js
    paginate.test.js
  README.md
```

源码用 ES module 写，构建时用仓库已有的 `rolldown` 打成一个 `viewer.js`：

```bash
node example-plugins-v2/office-viewer/build.mjs
```

宿主会把 `view.js` 里列的文件全部拼进同一个内联 module，所以最终交一个 bundle 最干净。
**没有第三方解压依赖**：WebView2 与 Node 都支持 `DecompressionStream("deflate-raw")`，
DOCX 的条目只有存储与 deflate 两种压缩方式，够用。

### 3.3 渲染（已实现）

- 每一页是一个 `<section class="page">`，里面是绝对定位的内容区；
- 每一行是一个**绝对定位**的 `.line`：`top` / `left` / `width` / `height` 都由引擎算好。
  这样段落间距不会碰上 CSS 的 margin 折叠，分页高度与 DOM 完全对得上；
- 行内按文本原子切 `<span>`；两端对齐用 `letter-spacing` 把剩余宽度分到字与字之间；
- 段落标记（¶ / ↵ / → / ·）是**零宽**的覆盖标记，打开不会改变排版；
- 段落序号画在页面左侧空白处，是花笺自己的阅读辅助；
- 「开始」是**宿主右侧栏里的 standalone 面板**，与「目录」同一级。面板只在当前文件是
  `.docx` 时注册，切走就 dispose —— `standalone` 页签本身不按文件类型过滤，所以插件
  轮询 `api.editor.getFileSync()` 自己判断；
- 面板跑在 Worker，视图跑在沙箱 iframe；格式命令走 `api.ui.sendToView()`（宿主按插件名
  过滤，只能发给自己的视图），视图里收到的仍是与 `view.toolbar` 一样的
  `{ t: "command", id, value }`；
- 页面用 CSS `zoom` 缩放（影响布局，滚动条长度跟着变）；
- 只渲染视口附近的页：先用固定高度的空页撑出滚动条，`IntersectionObserver` 到了再画。
  长文档不能一次把几万行塞进 DOM。

### 3.4 可编辑模型与「另存为」

**源真相是原始 XML**，不是重新生成的一份 OOXML：

```
zip 条目（原样保留）
  └─ word/document.xml  → XMLDocument（编辑时直接改它）
        └─ IR 缓存（每个段落带一个指向原 w:p 的指针）
```

这样做的好处是：**不认识的元素（表格、图片、域、批注）只要没被编辑，就原样留在文件里**，
不会在保存时丢掉。如果从 IR 重新生成整份 document.xml，任何没实现的特性都会蒸发。

编辑操作（`src/edit/`）：

- **源映射**：段落有稳定的 `key`；每个 item 带 `node` / `runNode` / `nested` /
  `editable`；排版原子带 `itemIndex` + 码点 `charStart/charEnd`。光标写成
  `{ blockKey, itemIndex, offset }`，所以分段、合并、重解析后还能找回同一个字。
  编号标签放在 `block.labelItems`，不混进可编辑的 `items`。
- **改文字**：更新 run 的 `w:t`（带 `xml:space="preserve"`）；需要动在 `w:t` 中间时
  先拆文本、再拆 run。清空后只删除「除 `w:rPr` 外没有内容」的 run，域代码、书签、
  批注范围都留住。
- **分段 / 合并**：创建 / 删除 `w:p`，克隆 `w:pPr` 但**不复制 `w:sectPr`**；表格行、
  分节符、嵌套容器（超链接 / 修订 / sdt）里的结构操作直接拒绝并提示。
- **重解析**：只重解析受影响的 `w:p`，再统一刷新编号与 block index。
- **撤销 / 重做**：第一版用**整份 `document.xml` 快照**（连续输入 800ms 内合并、
  200 条 / 16 MiB 上限）。比段落级快照简单、天然保住未知内容；段落级是后续优化。
- 表格编辑、字符颜色/高亮等剩余格式还没做；M4 侧栏里的字体 / 字号 / 行距仍是整篇预览。

保存：

1. `XMLSerializer` 序列化改过的 `document.xml`（保留原 XML 声明，去掉序列化器可能重复
   带出的 prolog）；
2. 用 `CompressionStream("deflate-raw")` 压缩这一个条目；其它条目（含 `word/` 这类目录
   项）**按原压缩字节、原顺序**搬回，自己写最小 ZIP writer（CRC32 + local/central/EOCD，
   不引第三方库）；
3. 重新打开写出的 ZIP 做自检（`document.xml` 合法、段落数与文字一致），再
   `floralView.saveFile("原名-已编辑.docx", bytes)` 弹原生保存对话框。

**没有编辑时不要重新序列化**：直接把原始字节返回，避免 XMLSerializer 的空白/属性顺序
变化带来无意义的 diff。`doc.dirty` 负责这件事。

编辑交互：

- 用**隐藏 textarea** 承接键盘与输入法（IME），它每次跟着光标移动，候选框才会出现在
  正确位置；
- 光标、选区、组合预览都画在每页的 `.edit-overlay` 层里，不用浏览器原生 selection
  （原生 selection 没法跨我们手工分的页）；
- 命中测试用布局几何（不读 DOM 行），所以懒渲染的页也能点；
- `compositionstart/update/end` 期间只做预览，提交时一次事务写入 XML；
- 重排只重算脏段的行；分页仍全量跑，页面 DOM 每次编辑重建（增量渲染是后续优化）。

---

## 4. 里程碑

| 阶段 | 状态 | 内容 / 还差什么 |
|---|---|---|
| **M0 骨架** | ✅ | 注册 `.docx`、文件通道、ZIP 目录识别、主题、工具栏、排版面板、状态条 |
| **M1 解析** | ✅ | ZIP 解压、document/styles/theme/numbering/settings/rels、IR、段落 + run + 字符格式、图片、表格网格（合并单元格 / 行属性） |
| **M2 行排版** | 🟡 第一版 | 已有：测量、断行、禁则、行高（auto/exact/atLeast + 文档网格）、缩进、对齐、两端对齐。还差：标点悬挂 / 压缩、中英文自动间距、更细的禁则 |
| **M3 分页** | 🟡 第一版 | 已有：页尺寸/边距、keepLines / keepNext / 孤行 / pageBreakBefore / 手动分页、按页虚拟化。还差：分节、分栏、页眉页脚、页码 |
| **M4 开始面板** | 🟡 第一版 | 已有：与「目录」同级的全局右侧栏「开始」面板（只在 docx 时出现）；Word 式两行字体组（分块线 + 右下角箭头 + 详细字体页 + 返回）；Word 式两行段落组（项目符号 / 编号 / 缩进 / 排序 / ¶、对齐 / 行距 / 底纹 / 边框，以及「缩进和间距」详细页）；字体 / 字号、对齐 / 行距 / 段前段后（整篇预览）、恢复原样、段落标记、段落序号；面板通过 `api.ui.sendToView()` 控制视图，下拉框通过面板 `onChange` 回传。还差：加粗 / 颜色 / 下划线 / 缩进 / 列表等按选区或段落生效（依赖 M5）、跨会话持久化、字体缺失提示 |
| **M5 编辑核心** | 🟡 第一版 | 已有：源映射（block key / item / 码点偏移）、自绘光标与选区、点击 / 拖选 / 双击选词、键盘导航、输入法组合预览与提交、文字增删写回 `document.xml`、回车分段、Shift+Enter 段内换行、退格 / Delete 合并、列表项开头退格先取消编号（多级先降级）、空列表项回车继续编号、复制剪切粘贴（多行分段、tab 变 `w:tab`）、整份 XML 快照的撤销 / 重做（连续输入合并、200 条 / 16 MiB 上限）、未保存标记。还差：字符颜色/高亮等剩余格式、表格结构编辑（增删行列 / 合并）、增量渲染（现在每次编辑重建页面 DOM）、撤销栈的持久化 |
| **M6 另存 docx** | 🟡 第一版 | 已有：保留原 ZIP 元数据、CRC32、`CompressionStream` deflate（不可用退回 store）、local/central/EOCD 写入、未改条目原样搬运（含目录项、保持顺序）、只重新序列化 `document.xml`、保存后自检、`saveFile` 另存为。还差：保存结果回执（宿主 API 限制）、另存后继续编辑时的增量 ZIP 复用（现在仍从原 ZIP 重建） |
| **M7 富内容** | 🟡 部分 | 图片、基础列表、表格真实排版、单元格文字编辑与插入新表格已做；增删行列/合并单元格、嵌套表格、超链接、页眉页脚、脚注还没做 |
| **M8 其它格式** | ⬜ | `.pptx` / `.xlsx`（同一插件的不同视图包） |

M5 / M6 的第一条端到端链路已经打通（打开 → 改字 → 另存）。下一步按顺序补：表格结构编辑 → 富内容（公式、超链接、页眉页脚）→ `.pptx` / `.xlsx`。

---

## 5. 测试

- **纯函数单测**：断行、禁则、分页约束、源映射偏移、命中测试、CRC / ZIP 往返；
  `npx vitest run example-plugins-v2/office-viewer/test` 目前 **43 条全过**。
- **浏览器原型台**：`%TEMP%\office-viewer-harness`，一个本地 HTML 直接 fetch 一份 docx、
  跑真实引擎、量真实宽度。已经用三类真实文档验过：
  - 中文通知（21 段、1 张图、首行缩进 / 固定行距 / 文档网格）；
  - 带表格与自动编号的测试说明（表格按行拍平）；
  - 4,521 字符、没有任何空格的长串（触发超长西文词的应急拆字）。
- **真实应用**：插件已拷到 `.devdata/notes/plugins/office-viewer`，在
  `npm run dev:isolated` 的隔离实例里加载；**安装版实例没有动**。
  ⚠️ 手工拷插件会漏权限；这次只需要 `files:register` / `files:view`，没有新权限。
- **round-trip**：M6 再做。打开 → 不改 → 保存，所有 zip 条目应逐字节一致；改一段文字 →
  保存 → Word 能打开，且其它部件（图片、样式、rels）不变。
- **分页对照**：继续收集样本文档，和 Word 导出的 PDF 对照页数与断点。

---

## 6. 已知限制与需要宿主配合的地方

1. **字体**：视图拿不到宿主注册的字体，只能用系统字体。文档里的「仿宋_GB2312」这类
   没装的字体要回退（目前会回退到宋体 / Arial，**还没做缺失提示**）。要做到高保真，
   需要宿主新增「把字体递进插件视图」的通道。
2. **阅读设置持久化**：基础视图没有数据通道（`floralView.extension()` 的 `data` 是给
   `extendView` 的扩展插件的）。所以 M4 的字体/行距覆盖只能在本会话内有效。
   要跨会话记住，需要宿主给基础视图开放 `workspace:cache`（这是个小改动，值得做）。
3. **表格**：已有真实网格、合并单元格与边框；单元格内容只读，嵌套表格暂时拍平。
4. **图片**：内联与锚定图片都按内联处理；WMF / EMF / TIFF 显示占位框。锚定图片的
   环绕方式、相对定位还没做。
5. **页面结构**：只取最后一个 `sectPr`；分节、分栏、页眉页脚、页码、脚注/尾注还没做。
6. **没有原地保存**：只能另存为；原文件一个字节都不会动。
7. **旧格式**：`.doc`（OLE 二进制）不做；加密的 `.docx` 也打不开。两者都会给出明确提示。
8. **像素级 1:1 不现实**：目标是「分页位置和阅读观感接近 Word」，不是逐像素复刻。
   Word 自己的排版还受打印机驱动、字体版本影响。

---

## 7. 与花笺现有约定的关系

- 视图主题：`init.tokens` 与 `theme` 消息，映射到 `--bg` / `--panel` / `--ink*` / `--accent`，
  见 `view/viewer.css` 顶部。**文档纸是固定浅色**（`--page-*`），不跟深色主题变深，
  否则 DOCX 里的黑色文字会看不见。
- 工具栏：`view.toolbar` 由宿主渲染，视图只收 `command`、用 `setState` 回报。
  **按钮给了 `icon` 就不要再给单字符 `label`**（会画两遍）。
- 面板 → 视图：`api.ui.sendToView({ id, value })`（需要 `files:view`）。它复用宿主
  「当前视图命令」那条通道，并且只允许发给**自己插件的**视图；没有活视图时返回 `false`。
- 面板里的下拉框 / 复选框用 `onChange(ref)`；`ref.attrs.value` 是选中值。宿主只对
  `change` 事件调用它，不会把同一次操作再当成 `click` 送一遍。
- 主视图 / 详细字体页的切换用 `<input type="radio">` + `:has()`，不重新注册面板 ——
  重新注册会让宿主重建 DOM，把滚动位置归零。
- 编码约定：JS 里别在模板字符串的注释里写反引号；编辑 `src/locales` 用 Node 读写。
- 新增文件类型只动插件目录，不需要改宿主代码。
