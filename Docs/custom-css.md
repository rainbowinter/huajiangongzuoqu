# 改界面样式：全局样式表

## 改哪个文件

**改数据目录下的那一份，不是源码里的：**

```text
<数据目录>/styles/
  custom.css              ← 就改它。永远生效
  深色微调.css             ← 你自己加的，默认**不生效**，要去面板里开
```

`<数据目录>` 就是设置里那一行（出厂 `C:\Users\Administrator\Documents\花笺`）。
**改完保存，约两秒后自动生效**，不用重新构建、也不用回应用里点任何东西 ——
宿主每两秒看一眼那个目录，变了就重新套用。

> 源码里的 `src/styles/custom.css` 是**模板**，而且**出厂是空文件**：首次运行时被
> 复制过去一次，之后**再也不会覆盖你改过的内容**（版本升级也一样）。
> 说明书在 **「关于 → 说明文档 → 自定义样式」**（`Docs/user/custom-css.md`），
> 那里也以标签页打开；模板里不再塞注释。

## 哪几份生效（<kbd>custom.css</kbd> 常开，别的要手动开）

| | |
|---|---|
| `custom.css` | **永远生效**，没有开关。它是「这是我的界面」那份主样式表 |
| 同目录的其它 `.css` | **默认不生效** —— 只是「放在那儿」而已 |

另外两种让它们生效的方式，都在右侧栏的**「样式」面板**里：

1. **开成全局** —— 每份一个开关，打开就套用到每一个窗口；
2. **挂到某一个文件** —— 面板下半节是「当前文件」，在那儿打开的只作用于**当前打开的
   那个文件**：换一个文件就是另一套。想只给某篇笔记、某个 `.md` 换个观感，用这个。

> 为什么不做成「放进去就生效」：那样没法**试**。想知道一份样式好不好看，放进目录的
> 那一刻它就已经改掉整个界面了，只能先移走。默认关闭、想用再开，才有试的余地。

多份之间按**文件名字典序**依次套用，所以想控制先后就用 `10-`、`20-` 这样的前缀。

入口有两个：**右侧栏的「样式」面板**（完整：路径、开关、当前文件绑定、打开文件夹、
重新加载），以及**设置 → 外观 → 界面样式**（只读：文件放哪儿、现在生效哪几份）。
**「样式」面板顶上的「打开文件夹」**会在系统资源管理器里打开 `<数据目录>/styles`。

## 里面有什么（说明文档）

`custom.css` 出厂是空的；两份可直接照抄的清单都在
**「关于 → 说明文档 → 自定义样式」**（`Docs/user/custom-css.md`）里：

1. **变量速查表**（22 个可改变量：名字 / 出厂值 / 管什么）—— 改**颜色 / 字体 / 圆角**；
2. **语义钩子清单**（一百多个稳定类名，覆盖标题栏、侧栏、笔记卡片、工具栏、编辑区、
   预览区、状态栏、各面板、菜单与弹层）—— 改**尺寸 / 间距 / 显隐 / 选中态**。

两者不是竞品：**只是想换配色就改变量，想动某个部件的形态才用钩子。**

说明文档在应用里打开时是一张**只读标签页**，可以和笔记、工作区文件并排切换。

## 它是怎么接进去的

宿主把目录里**生效的那几份** `.css` 读出来，一份一个 `<style data-floral-style="文件名">`
追加到 `<head>` **末尾**（`src/features/styles/globalStyles.ts`）。于是它们稳定排在
`App.css` 之后，同优先级的规则由它们胜出 —— `App.css` 里那批 `.md-*` 预览规则用的
也是同一招。

- **一份一个 `<style>`** 而不是拼成一大份：某一份写坏了语法只是那一份失效，
  不会把后面的全带走；DevTools 里也能一眼看出哪条规则来自哪个文件。
- **读不出来就保持现状**，绝不把已经套用的样式清空 —— 「界面突然全白」比
  「还是旧的」糟糕得多。
- 数据目录是可以迁移的，`styles/` 会跟着一起搬（`DATA_DIR_ITEMS` 里有它）。

## 覆盖范围看选择器，不看「写在哪个文件」

这是最容易踩的一点。Tailwind 的 `@theme` 变量被编译进 `@layer theme`，而
分主题的覆盖块是**没有进任何 layer** 的：

| 想改的范围              | 选择器                                                        |
| ----------------------- | ------------------------------------------------------------- |
| 浅色 · 松绿（默认那套） | `:root`                                                       |
| 深色                    | `:root[data-theme="dark"]`                                    |
| 黛紫 / 樱粉（浅色）     | `:root[data-accent="purple"]` / `[data-accent="pink"]`        |
| 深色 + 某个主题色       | 两者组合，如 `:root[data-theme="dark"][data-accent="purple"]` |
| **上面全部**            | `custom.css` 第 2 节末尾那个组合选择器                        |

为什么 `:root` 盖不住深色/紫/粉：它们的 `:root[属性]` 选择器**权重高一档**
（`:root` 是 0-1-0，` :root[data-theme=…]` 是 0-2-0），权重高的先赢，跟谁写在后面无关。
组合选择器里每一段的权重都够，且本文件在后，所以能通吃。

字体与圆角（`--font-*`、`--app-*-radius`）**没有**分主题定义，写 `:root` 就是全主题生效。

## 语义钩子：界面每一块都有稳定的类名

**界面里绝大多数间距 / 字号确实是直接写在 JSX 上的 Tailwind 工具类**（`px-4`、
`text-[11px]`…）。但这不是说界面无从下手 —— 全界面一百多个**区块与状态**都带一个
**稳定的语义类名**，就是 `Docs/user/custom-css.md` 第 3 节那张清单
（应用里从「关于 → 说明文档 → 自定义样式」打开）：

```
窗口外壳    .main-window / .main-surface / .main-body
标题栏      .titlebar / .titlebar-brand / .titlebar-title / .titlebar-actions / .titlebar-button
活动栏      .activity-bar / .activity-bar-item
侧栏        .sidebar / .sidebar-header / .sidebar-title / .sidebar-resizer
列表        .note-list / .note-group / .note-group-header / .explorer-item / .explorer-item-title
文档工具栏  .doc-toolbar / .doc-toolbar-group / .doc-toolbar-button / .doc-tab
内容区      .content-area / .editor-pane / .editor-toolbar / .editor-tool / .preview-pane
状态栏      .status-bar / .status-text / .status-action
侧栏面板    .side-panel / .side-panel-view / .side-panel-header / .side-panel-body
浮层        .context-menu / .context-menu-item / .modal / .toast-entry / .command-palette
各面板      .settings-panel / .settings-section / .market-panel / .plugin-panel / .about-panel
```

**清单以 `Docs/user/custom-css.md` 第 3 节为准**（那里每个名字都写明了管哪块），这里不重复。
`src/styles/semanticHooks.test.ts` 会读那份 Markdown，逐个到源码里核对 —— 文档里写了、
界面上没有的名字会让测试变红。

### 它们和「工具类」的区别

| | 语义钩子 | Tailwind 工具类 |
| --- | --- | --- |
| 是什么 | 「这里是什么」的记号，**本身不带样式** | 实现细节（`px-2.5 h-8 rounded-lg`） |
| 改版会不会变 | 不会，是**接口** | 会 |
| 状态（选中 / 禁用 / 拖拽） | 有（`.is-selected` / `.is-hovered` / `.is-dragging`…） | **没有** —— 状态只活在 JS 里，DOM 上一点痕迹都没有 |

最后一行才是关键：以前想给「选中的那条笔记」加个左边框，外部 CSS **无论怎么写都做不到** ——
因为 DOM 上根本没有东西能指认它。现在 `.explorer-item.is-selected` 就是那个指认。

### 权重：钩子够用，工具类才需要提权重

钩子和 Tailwind 工具类**同权重**（都只是一个类），而 `custom.css` 排在 `App.css` 之后，
所以直接写就能赢：

```css
.explorer-item { padding: 8px 10px; }      /* 盖过 px-3 py-2.5 */
.doc-toolbar-button { border-radius: 999px; }
```

赢不了的只有两种，分别有对应写法：

- **伪类**（`hover:bg-paper-warm`、`group-hover:opacity-100`）—— 要写成 `.explorer-item:hover`；
- **`!important`** —— 只能也上 `!important`，或者加一层祖先提权重
  （`.app-window-shell .px-4 { … }`）。

另外，**不能用类名表达的 UI 状态用伪类本来就有**：`.doc-toolbar-button:disabled`、
`.editor-input::placeholder`。

### 什么时候还是该改变量

只是想换**颜色 / 字体 / 圆角**的话，第 1 节的主题变量更省事，也不必跟权重较劲。
钩子管的是**尺寸、间距、显隐，以及 Tailwind 表达不了的状态**。

## 另一条路：做成插件

要在**装好的人**机器上分发一套皮肤，写成插件更合适 —— `api.ui.registerStyle({ id, css })`
能把一段 CSS 注入当前窗口（需要 `ui:style` 权限）。样式是窗口粒度的，主窗口 / 小窗 /
磁贴各注入一份。参考 `Docs/plugin-api.md` 的 `api.ui` 一节。

与全局样式目录的分工：

| | 谁管 | 什么时候用 |
| --- | --- | --- |
| **`<数据目录>/styles/`** | 宿主 | 你自己调界面。`custom.css` 常开，其余在「样式」面板里开 |
| **插件的 `registerStyle`** | 插件 | 打包一整套皮肤给别人装；插件停用就跟着撤掉 |

两者不冲突，都会注入到 `<head>` 末尾。加载先后取决于时机（插件是异步装的），
所以**别指望靠它们互相覆盖**——要覆盖就提权重。

> 早先 `css-modifier` 插件也做过「把 `styles/` 全部当全局样式注入」这半截，还带一个
> **总开关**。那半截已删除、并入宿主的全局样式目录：两套「往文件夹里丢 CSS」的机制并存
> 时，用户永远分不清该丢哪个。现在边界是 **全局归宿主、单篇笔记归那个插件**。
