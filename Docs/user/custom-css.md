# 自定义界面样式

花笺的界面可以用一份 CSS 自己调。**改的是数据目录下的 `custom.css`**，不是安装目录：

```text
<数据目录>/styles/custom.css
例：C:\Users\Administrator\Documents\花笺\styles\custom.css
```

- **不需要装任何插件。** 全局样式表是花笺宿主自带的能力：模板、`custom.css` 常开、
  其余文件的开关、「样式」面板都在应用本体里。插件 `css-modifier` 只是额外提供一件事：
  按笔记开头 `css:` 那一行挂**单篇**样式；
- `custom.css` **永远生效**：保存约两秒后自动套用，不需要去开什么开关；
- 同一个目录里**其它** `.css` **默认不生效**。在右侧栏的「样式」面板里，可以把某一份
  **开成全局**（每个窗口都套用），也可以把它**挂到某一个打开的文件**上，只让那一个
  文件变样。想试一份新样式就新建一个文件，别直接改 `custom.css` —— 试坏了删掉就行；
- 套用顺序按文件名的字典序，想控制先后就用 `10-`、`20-` 这样的前缀。

`custom.css` 出厂是**空的**：不写任何东西，观感与出厂完全一致。下面所有内容都只是
可以抄进去的模板。

---

## 1. 主题变量速查

左边是变量名，中间是「浅色 · 松绿」的出厂值（其余主题的值见 `App.css`），右边是它管
什么。要改哪一项，把它抄进 `:root { }` 里、填上新值。

### 背景四层（由浅到深）

> 想整体变亮就把前三层一起往上抬；描边那层别抬太多，否则边界会糊掉。

| 变量 | 浅色 · 松绿 | 用途 |
| --- | --- | --- |
| `--color-paper` | `#fbf9f4` | 主背景：正文区、侧栏 |
| `--color-paper-warm` | `#f5f1e8` | 次层：输入框、卡片、悬停底 |
| `--color-paper-deep` | `#eae4d8` | 描边 / 分隔线 / 滚动条槽 |
| `--color-cloud` | `#ffffff` | 最亮层：窗口底、下拉与弹层 |

### 文字四级（由深到浅）

| 变量 | 浅色 · 松绿 | 用途 |
| --- | --- | --- |
| `--color-ink` | `#1a1a18` | 正文 |
| `--color-ink-soft` | `#3d3d38` | 次级正文 |
| `--color-ink-faint` | `#8a8a80` | 说明文字 |
| `--color-ink-ghost` | `#b8b8ae` | 占位符、禁用态 |

### 强调色（跟随「设置 → 主题色」选中的那一套）

| 变量 | 浅色 · 松绿 | 用途 |
| --- | --- | --- |
| `--color-bamboo` | `#2d5a3d` | 主强调：选中态、链接、主要按钮 |
| `--color-bamboo-light` | `#3a7a52` | 悬停态 |
| `--color-bamboo-mist` | `#e8f0eb` | 强调色的浅底（选中背景） |
| `--color-bamboo-glow` | `#d4e8da` | 再浅一档（按下 / 高亮） |
| `--color-stone` | `#6b6b62` | 中性强调（次要按钮） |
| `--color-danger-bg` | `#fef2f2` | 危险操作的浅底 |

### 阴影

| 变量 | 浅色 · 松绿 | 用途 |
| --- | --- | --- |
| `--color-shadow` | `rgba(26,26,24,.06)` | 常规投影 |
| `--color-shadow-deep` | `rgba(26,26,24,.12)` | 弹层投影 |

### 字体（写 `:root` 即全主题生效，不区分主题）

| 变量 | 用途 |
| --- | --- |
| `--font-display` | 标题字体栈 |
| `--font-body` | 正文字体栈 |
| `--font-serif` | 衬线（预览里的引用等） |
| `--font-mono` | 代码字体栈（「设置 → 代码字体」会覆盖它） |

### 圆角（同样不区分主题）

| 变量 | 出厂值 | 用途 |
| --- | --- | --- |
| `--app-window-radius` | `14px` | 窗口圆角 |
| `--app-surface-radius` | `14px` | 卡片 / 面板 / 弹层圆角 |

### 预览语义色（默认**不定义**，留空即跟随主题）

给预览区单独调色的口子，不定义就取各自的主题回退值。

> ⚠️ 它们也由「设置 → 渲染配色」写入；在这里写死会**盖过**用户设置。
> 除非你就是想要一个固定值，否则建议留着别动。

| 变量 | 回退 |
| --- | --- |
| `--md-text-color` | `--color-ink-soft` |
| `--md-table-color` | `--color-paper-deep` |
| `--md-divider-color` | `--color-paper-deep` |
| `--md-quote-color` | `--color-bamboo` |
| `--md-caption-color` | `--color-ink-ghost` |

### 空壳

把速查表里要改的那几行抄进来、填上值即可：

```css
:root {
  /* ⚠️ 只对「浅色 · 松绿」生效。深色 / 黛紫 / 樱粉在 App.css 里各有自己的
     `:root[属性]` 块，权重高一档，照样赢。要改它们请用第 2 节对应的块。 */
}
```

---

## 2. 按主题分别覆盖

当前主题由 `<html>` 上两个属性表达：

```text
data-theme  = "dark"（浅色时该属性不存在）
data-accent = "green" | "purple" | "pink"
```

所以「深色 + 黛紫」就是两者的组合选择器。

```css
/* 只想改深色主题写这里 */
:root[data-theme="dark"] {
  --color-paper: #2a2927;
  --color-paper-warm: #34322e;
}

/* 黛紫主题（浅色）专属覆盖 */
:root[data-accent="purple"] {
}

/* 樱粉主题（浅色）专属覆盖 */
:root[data-accent="pink"] {
}
```

### 一次改**所有**主题

每一段的选择器权重都**不低于** `App.css` 里对应的主题块，而 `custom.css` 排在它后面，
所以同权重下由这里胜出。把要覆盖的变量写进这个块里即可：

```css
:root,
:root[data-theme="dark"],
:root[data-accent="purple"],
:root[data-accent="pink"],
:root[data-theme="dark"][data-accent="purple"],
:root[data-theme="dark"][data-accent="pink"] {
  --app-window-radius: 6px;
}
```

---

## 3. 语义钩子

这些类名**本身不带任何样式** —— 它们只是「这里是什么」的记号（`App.css` 里没有对应
的规则，写了也不会自己变样）。加它们的唯一目的，是让你（或插件）有一条**可靠的路**
命中界面里的某一块：

```css
.explorer-item.is-selected { border-left: 3px solid var(--color-bamboo); }
.titlebar                  { height: 48px; }
.doc-toolbar-button        { padding-inline: 14px; }
```

为什么不能直接盖 Tailwind 工具类：那是**实现细节**（`px-2.5 h-8 rounded-lg`），改一次
版就可能变；更要命的是**状态根本不在 DOM 上** —— 「这条笔记选中了」是 JS 里选出来的
一个字符串，DOM 上一点痕迹都没有，外部 CSS 无论如何都命中不了。钩子是接口，工具类不是。

三条使用须知：

1. **先考虑主题变量（第 1 节）。** 只是想换颜色 / 字体 / 圆角的话，改变量更省事，也
   不必跟权重较劲。钩子管的是**尺寸、间距、显隐，以及 Tailwind 表达不了的状态**。
2. **权重。** 钩子通常和 Tailwind 工具类**同权重**（都只是一个类），而本文件排在后面，
   所以直接写就能赢过 `px-3 py-2.5`。赢不了的两种：对方带 `!important`，或要盖的是伪类
   （那要写成 `:hover`）。
3. **状态一律 `is-*`。** 同一个元素可能同时带多个（`.is-selected.is-hovered`）。

### 窗口外壳

- `.app-window-shell` —— 最外层（圆角 / 投影 / 噪声纹理都挂在它上面）
- `.main-window` —— 主窗口根
- `.main-surface` —— 主窗口那层带噪声纹理的底
- `.main-body` —— 标题栏下方那一行（活动栏 + 侧栏 + 内容区）

### 标题栏（那条 `h-11`，也是拖窗口的手柄！）

- `.titlebar` —— 标题栏整条
- `.titlebar-brand` —— 左侧「花笺 — 笔记名」
- `.titlebar-title` —— 那个笔记名
- `.titlebar-actions` —— 右侧按钮组
- `.titlebar-button` —— 里面每个图标按钮（+ `.is-active`）
- `.window-control` —— 右上角最小化 / 最大化 / 关闭，每一个（+ `.is-close`）
  - macOS 上这三个换成 `App.css` 里既有的 `.mac-window-controls` 那套

### 活动栏（最左侧那条图标栏）

- `.activity-bar`
- `.activity-bar-item` —— 里面每一格（+ `.is-active`）
- `.activity-bar-add` —— 底部那个「+」

### 侧栏

- `.sidebar` —— 宽度会动画的外壳（+ `.is-collapsed`）
- `.sidebar-inner` —— 里面定宽那一层
- `.sidebar-header` —— 标题行
- `.sidebar-title` —— 视图名（笔记 / 文件夹名）
- `.sidebar-subtitle` —— 文件夹的完整地址
- `.sidebar-resizer` —— 拖宽度的竖条（+ `.is-dragging`）

### 列表：笔记与工作区文件共用一套卡片

- `.note-search` —— 侧栏顶上那个搜索框
- `.note-list` —— 笔记列表的滚动容器
- `.note-group` —— 一个分类分组
- `.note-group-header` —— 分类表头（+ `.is-open`）
- `.note-empty` —— 「还没有笔记」那块
- `.workspace-tree` —— 工作区目录树的容器
- `.explorer-item` —— 一张卡片（笔记与工作区文件**都是它**）
  - 状态：`.is-selected` / `.is-hovered` / `.is-multi-selected`
- `.explorer-item-accent` —— 左边那条选中竖条
- `.explorer-item-title` —— 标题行
- `.explorer-item-badge` —— 标题前的小标签（`PY` / `CSV`）
- `.explorer-item-meta` —— 右上角的日期 / 大小
- `.explorer-item-subtitle` —— 第二行描述
- `.explorer-item-details` —— 第三行小字
- `.explorer-item.is-compact` —— 紧凑模式：只画「类型徽章 + 标题」一行
- `.explorer-folder` —— 目录树里的一层目录（+ `.is-open` / `.is-focused` / `.is-compact`）
- `.explorer-folder-toggle` —— 展开箭头 + 图标 + 名称那一颗按钮
- `.explorer-folder-count` —— 子项数量
- `.explorer-folder-add` —— 「在这里新建」，**悬停文件夹时出现**
- `.explorer-draft-row` —— 行内新建 / 重命名的外层
- `.explorer-draft` —— 那个文件名输入框
- `.explorer-draft-error` —— 输入框下方的错误提示
- `.workspace-tree-toolbar` —— 目录树顶部的搜索 + 查看方式那一行
- `.workspace-tree-scroll` —— 目录树的滚动容器（空白处拖拽框选也发生在这里）
- `.workspace-view-button` —— 右上角的「查看方式」按钮
- `.workspace-view-menu` —— 那个下拉（选项用 `.workspace-view-item`）
- `.workspace-view-item` —— 下拉里的一个选项（当前项 + `.is-active`）
- `.explorer-icon-tile` —— 图标视图里的一格（+ `.is-selected` / `.is-multi-selected`）
- `.workspace-icon-grid` —— 图标视图的网格
- `.workspace-icon-children` —— 图标视图里展开出来的子层
- `.workspace-marquee` —— 框选时那个半透明矩形
- `.picker-row` —— 「移动到…」里的一行目录（+ `.is-selected` / `.is-disabled`）

### 文档工具栏（笔记标题上方那一行，随文件类型成套换）

- `.doc-toolbar` —— 整行
- `.doc-toolbar-group` —— 左边那组动作
- `.doc-toolbar-right` —— 右边那组（视图切换）
- `.doc-toolbar-button` —— 其中一个按钮（+ `.is-active`；不可用时是 `:disabled`）
- `.doc-tab` —— 插件贡献的独立面板页签（+ `.is-active`）
- `.doc-tab-bar` —— 文档标签条
- `.doc-tab-item` —— 其中一个文档标签（+ `.is-active` / `.is-dirty`）
- `.doc-tab-label` —— 标签上的标题
- `.doc-tab-dirty` —— 未保存的小圆点
- `.doc-tab-close` —— 标签上的关闭按钮

### 文档标题 / 状态

- `.doc-header` —— 标题那一块
- `.doc-header-title` —— 标题输入框
- `.doc-header-meta` —— 「时间 · 字数 · 已保存」那一行
- `.doc-header-label` —— 只读文档那行小字（「说明文档 · 只读」）
- `.doc-header-close` —— 文档视图右上角那个「关闭」
- `.save-state` —— 保存状态那一段（+ `.is-saved` / `.is-dirty` / `.is-error`）

### 内容区

- `.content-area` —— 编辑区 + 预览区那一行
- `.empty-state` —— 「选择或新建一篇笔记」
- `.editor-pane` —— 编辑那一栏
- `.editor-toolbar` —— Markdown 格式化按钮那一排
- `.editor-tool` —— 其中一个按钮
- `.editor-scroll` —— 编辑器的滚动容器
- `.editor-input` —— 那个 textarea 本体
- `.image-copy-button` —— 图片右上角「复制原图」（平时隐藏，悬停才出现）
- `.preview-pane` —— 预览那一栏
- `.preview-scroll` —— 预览的滚动容器
- `.pane-resizer` —— 编辑 / 预览之间的拖拽条（+ `.is-dragging`）

### 状态栏（窗口最底下那条）

- `.status-bar` / `.status-bar-left` / `.status-bar-right`
- `.status-text` —— 一条只读信息
- `.status-action` —— 一条可点的（如「清理未使用图片」）

### 右侧栏

- `.side-panel` —— 外壳（+ `.is-open` / `.is-overlay`）
- `.side-panel-view` —— 里面每一个面板的容器（+ `.is-active`）
- `.side-panel-header` / `.side-panel-title` / `.side-panel-close` / `.side-panel-body`
- `.side-panel-scrim` —— 设置以浮层形式打开时压住内容区的那层

### 浮层

- `.modal-backdrop` / `.modal` / `.modal-title` / `.modal-actions`
- `.modal-button` —— 弹窗里的按钮（+ `.is-primary` / `.is-danger`）
- `.context-menu` —— 右键菜单与下拉
  - ⚠️ 比 `.popup-menu` 宽：`.popup-menu` 只管标题栏那几个菜单（在 `App.css` 里有
    真实规则），`.context-menu` 是所有菜单、下拉、插件浮层统一都有的那一个，用它更省心
- `.context-menu-item` —— 里面每一条（+ `.is-danger` / `.is-disabled`）
- `.toast-region` —— Toast 的容器
- `.toast-entry` —— 一条 Toast（+ `.is-error` / `.is-warning` / `.is-info`）
  - ⚠️ `App.css` 里**本来就有**这条规则，是既有语义类，不只是钩子
- `.command-palette` / `.command-palette-input` / `.command-palette-list`
- `.command-palette-item`（+ `.is-active`）
- `.prompt-dialog` —— 插件弹的那个输入框

### 小控件

- `.switch` —— 开关（+ `.is-on`）
- `.segmented` —— 分段选择器（编辑 / 分栏 / 预览）
- `.segmented-option` —— 其中一段（+ `.is-active`）

### 右侧栏里各个面板

- `.settings-panel` / `.settings-section` / `.settings-row`
- `.market-panel` / `.market-item`（+ `.is-installed`）
- `.plugin-panel` / `.plugin-card`（+ `.is-enabled` / `.is-broken`）
- `.about-panel`
- `.outline-panel` —— 目录插件的面板
  - `App.css` 里既有的 `.outline-item` 是它里面每一条 —— 那个类**本来就带样式**，不是钩子

### 插件视图（`kind: "view"` 那个沙箱 iframe）

- `.plugin-view` —— 宿主给插件视图的那层壳
- `.plugin-view-frame` —— iframe 本体
- `.view-toolbar` —— 视图自己的工具栏（渲染在 iframe 上方）
- `.view-toolbar-button` —— 其中一个（+ `.is-active`）

### 文件预览（工作区文件占掉内容区时）

- `.file-preview` —— 预览容器（图片、音视频、插件视图都用这一个）
- `.file-preview-media` —— 图片 / 音视频那一支
- `.file-preview-message` —— 「不支持 / 加载中 / 出错」那种提示支

### 小窗（笔记独立窗口 / 磁贴）

- `.notepad-window` —— 小窗根
- `.notepad-surface` —— 小窗那张纸
- `.app-surface-frame` —— 磁贴那种卡片外壳
  - ⚠️ 这个是 `App.css` 里**既有**的语义类，本来就带样式（圆角 / 投影），不是纯钩子

### Markdown 预览（原有的语义类）

- `.md-body` —— 正文根节点
- `.md-table` —— 表格
- `.md-divider` —— 分割线
- `.md-quote` —— 引用块
- `.md-caption` —— 图注
- `.md-align-left` / `.md-align-center` / `.md-align-right` —— 段落对齐
- `.markdown-alert` 及 `-note` `-tip` `-important` `-warning` `-caution`
- `.katex` / `.katex-display` —— 公式

### 其它既有类名

- `.scrollbar-hidden` —— 隐藏滚动条
- `.noise-bg` —— 噪声纹理底

### 例子：都取消注释就能用

```css
/* 把预览正文调大一点、行距放宽 */
.md-body { font-size: 15px; line-height: 1.85; }

/* 全局换成无衬线标题 */
:root { --font-display: var(--font-body); }

/* 把窗口圆角去掉（Windows 上更贴边） */
:root { --app-window-radius: 0px; --app-surface-radius: 8px; }

/* 侧栏里的笔记卡片更紧凑一点（原来 px-3 py-2.5 = 12px / 10px） */
.explorer-item { padding: 8px 10px; }

/* 侧栏整体窄一点、标题栏矮一点
   —— 宽度是内联样式算出来的，改它要动 JS；但高度是纯 CSS，钩子一写就生效 */
.titlebar { height: 36px; }

/* 选中的那篇笔记换一种高亮（覆盖 Tailwind 的 bg-bamboo-mist/70）
   注意要连「悬停」一起写，否则鼠标一移上去就被 `.is-hovered` 那支盖回去了。 */
.explorer-item.is-selected,
.explorer-item.is-selected.is-hovered { background: var(--color-bamboo-glow); }

/* 把顶部那排文档按钮改成描边胶囊 */
.doc-toolbar-button {
  border: 1px solid var(--color-paper-deep);
  border-radius: 999px;
}
```

---

## 4. 万一还是得盖 Tailwind 工具类

**多数情况下第 3 节的钩子就够了**（同权重 + 本文件在后 ⇒ 直接赢）。只有当你要盖的是
一个**伪类**（`hover:bg-paper-warm`、`group-hover:opacity-100`）时，才需要提权重：

- 加一层祖先（`.app-window-shell .px-4 { ... }`）—— 权重更高，最干净；
- 或者用 `!important` —— 最省事，但下次想收回来会麻烦。

而**优先级更高、也更稳**的做法始终是改主题变量（第 1 节）或语义钩子（第 3 节）——
那些是留给人调的接口，工具类不是。

---

## 5. 一个可以直接取消注释的完整例子

下面这份是「樱粉 · 浅色」这一档的生效示例。

注意选择器。写 `:root { … }` 只会影响「浅色 · 松绿」——深色 / 黛紫 / 樱粉各有自己的块、
权重更高，写 `:root` 一个像素都不会变。

想确认自己现在在哪一档：设置 → 外观 / 主题色。

```css
:root[data-accent="pink"] {
  --color-paper: #fefcfd;      /* 出厂 #fdf9fb，再亮一档 */
  --color-paper-warm: #fcf7f9; /* 出厂 #faf1f4 */
  --app-surface-radius: 8px;   /* 卡片 / 面板圆角：14 → 8。最直观的一项，先改它验证接通没有 */
}
```

---

## 最后：为什么写在这里就能生效

宿主把生效的那几份 `.css` 注入到 `<head>` **末尾**，于是最终样式表里排在 `App.css`
之后；同优先级下后写的胜出（`App.css` 里那批 `.md-*` 规则用的也是同一招）。而默认那套
主题变量写在 `:root` 上、没进任何 `@layer`，所以这里写 `:root` 能直接盖住它 —— 但
**分主题的那三块盖不住**，原因见第 2 节。

三个容易踩的坑：

1. **「没写」与「写成空值」不是一回事。** 留着不写就什么都不改；写了
   `--color-paper:` 却忘了填值，整条声明会失效，颜色掉回浏览器默认。
2. **颜色变量是分主题的，光写 `:root` 盖不住深色 / 黛紫 / 樱粉。** `App.css` 里这三个
   主题各自有一个 `:root[data-theme=…]` / `:root[data-accent=…]` 覆盖块，**权重比单个
   `:root` 高一档**，所以它们照样赢。要一次改所有主题，用第 2 节末尾那个组合选择器；
   只想改默认那套（浅色 · 松绿），写 `:root` 就行。（字体与圆角没有分主题定义，
   `--font-*` / `--app-*-radius` 写 `:root` 即可全主题生效。）
3. **想盖掉 Tailwind 工具类，光靠这个文件的位置可能不够。** 工具类通常权重更高，
   得提高选择器权重或加 `!important` —— 见第 4 节。

变量与语义类的**完整定义**在 `App.css`：浅色底在文件开头 `@theme` 里，深色 / 黛紫 /
樱粉各自的覆盖块紧随其后。
