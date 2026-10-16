# 花笺插件开发指南

花笺的插件是一个放在插件目录里的文件夹，包含一份 `plugin.json` 清单和一个 JavaScript 入口。

插件目录的位置：打开应用 → 标题栏的插件图标 → 面板底部「打开插件文件夹」。
默认落在**笔记数据目录**下（可在设置里改），即 `<笔记数据目录>/plugins/<插件名>/`。

---

## 1. 最小插件

```
plugins/hello/
  plugin.json
  index.js
```

`plugin.json`

```json
{
  "name": "hello",
  "version": "1.0.0",
  "apiVersion": 2,
  "main": "index.js",
  "description": "打个招呼",
  "author": "你",
  "homepage": "https://example.com/hello",
  "icon": "icon.svg",
  "permissions": ["ui:toast"],
  "requires": []
}
```

`icon` 是可选的（`svg` / `png` / `jpg`，**不超过 32KB**）：插件列表与插件市场会显示它，
没写就用宿主的默认图标。路径是插件目录下的相对路径，**别写绝对路径**。

> 图标里请**自己带上颜色**：它是以 `<img>` 渲染的独立 SVG，拿不到界面的
> `currentColor`，也不跟着明暗主题变。用中间调（明暗背景下都能看清），
> 例如示例插件里那几个 `#3a7a52` / `#2f6b8a` / `#c2692e`。

`index.js`

```js
floral.register({
  onLoad(api) {
    api.ui.showToast("你好，花笺！", "info");
  },
});
```

放进目录后，在插件面板点「刷新」即可加载。

### 依赖别的插件：`requires`

一个插件可能非要用上另一个（批注插件要 PDF 阅读器、扩展视图的那个要**被扩展**的那个）。
写上依赖，宿主就会按顺序加载，并在缺件时明确说出来：

```json
{ "name": "pdf-annotations", "requires": ["pdf-viewer"] }
```

- 只认**目录名**（这一版不做版本约束）。支持多级依赖，宿主按拓扑序加载。
- 依赖**没装或没启用**时，这个插件**不会被加载**，面板上那一行写明缺谁。比让它跑起来
  再莫名其妙地失败好得多。
- 依赖成环时相关的几个都跳过，并说明原因。
- 它**不是权限**，也不是安装：市场里装 A 不会顺手把 B 装上，用户得自己装。

> 目录名就是插件的唯一标识。`plugin.json` 里的 `name` 只用于展示；两者不一致时
> 插件仍能加载，但面板上会提示。读取代码、定位数据一律以目录名为准。

---

## 2. 两代插件 API

|          | `apiVersion: 1`                        | `apiVersion: 2`                       |
| -------- | -------------------------------------- | ------------------------------------- |
| 运行位置 | 主线程，`new Function` 执行            | 独立 Web Worker 沙箱                  |
| 隔离     | **无**。能直接访问 `window`、Tauri IPC | 有。没有 `window`/`document`/宿主对象 |
| 权限     | 不适用（与宿主同权限）                 | 清单声明 + 默认拒绝 + 权限门          |
| 卡死风险 | 死循环会冻住整个界面                   | 超时后宿主 `terminate()` 掉 Worker    |
| API 形态 | 扁平 13 个方法                         | 命名空间化，全部返回 Promise          |
| 状态     | 兼容保留，**建议迁移**                 | 推荐                                  |

`apiVersion` 缺省为 `1`。宿主能运行的最高版本写在 `manifest` 里，声明更高的版本会被
判为「清单无效」并在面板上显示原因，而不是静默忽略。

**新插件请一律写 v2。**

---

## 3. 权限

v2 插件**默认没有任何权限**。清单里没声明的权限一律不生效，调用会被拒绝，
插件侧收到 `code === "permissionDenied"` 的错误。

| 权限                                   | 覆盖的能力                                                          |
| -------------------------------------- | ------------------------------------------------------------------- |
| `workspace:read`                       | `workspace.listNotes` / `getNote` / `getActiveNote`                 |
| `workspace:write`                      | 新建 / 更新 / 删除 / 移动分类 / `openNote`（蕴含 `workspace:read`） |
| `workspace:cache`                      | 在**文件旁边**的 `__floral-notepaper__/` 里读写这个插件自己的数据   |
| `categories:read` / `categories:write` | 分类的列举与创建                                                    |
| `editor:read`                          | 读正文、选区、光标；注册选区转换器                                  |
| `editor:write`                         | 插入、包裹、按范围替换、设选区、聚焦（蕴含 `editor:read`）          |
| `ui:toast`                             | `ui.showToast`                                                      |
| `ui:panel`                             | `ui.registerPanel`                                                  |
| `ui:command`                           | `ui.registerCommand`                                                |
| `ui:statusbar`                         | `ui.registerStatusBarItem`                                          |
| `ui:menus`                             | 编辑器 / 笔记列表右键菜单项                                         |
| `ui:toolbar`                           | 工具栏按钮                                                          |
| `ui:popover`                           | 工具栏浮层：按钮 + 下拉面板（`ui.registerPopover`）                 |
| `ui:gutter`                            | 编辑器左侧的行旁注（`ui.registerGutter`）                           |
| `ui:decorations`                       | 行内装饰：贴着正文某个字符叠的小控件（`ui.registerDecorations`）    |
| `ui:open-panel`                        | `ui.openPanel`                                                      |
| `ui:style`                             | 往当前窗口注入 CSS（`ui.registerStyle`）                            |
| `files:register`                       | 声明工作文件夹里可识别的文件类型（`files.registerType`）            |
| `events`                               | `events.on`                                                         |
| `storage`                              | `storage.*`                                                         |
| `settings`                             | `settings.get()`                                                    |
| `system:clipboard:read`                | 读剪贴板                                                            |
| `system:clipboard:write`               | 写剪贴板（**不**蕴含读）                                            |
| `system:open-external`                 | 用系统浏览器打开链接（仅 `http`/`https`/`mailto`）                  |
| `system:dialog`                        | 原生消息框 / 确认框，以及 prompt 模态                               |

不需要权限的接口只有五个：`plugin.info` / `plugin.readAsset` / `plugin.listAssets` /
`fonts.register` / `ui.dispose`。它们要么只是自省，要么只能读插件**自己目录**下、本来
就是从那里加载的东西。`fonts.register` 尤其如此：列目录、生成 URL、拼 `@font-face`
全由宿主做，插件拿不到路径、也塞不进任意 CSS。

权限可以在插件面板里逐项撤销。撤销后插件不会立刻卸载，而是下一次调用该能力时失败；
重新加载后生效。

---

## 4. API 参考

所有方法都返回 `Promise`。`api` 对象可用命名空间：

### `api.plugin`

当前插件的静态信息（不需要权限）：`id`、`name`、`version`、`apiVersion`、
`permissions`、`grantedPermissions`、`locale`。

同一个命名空间下还有两个读**自己目录**资源的方法，同样不需要权限 —— 插件代码本来就是
从那个目录加载的，读自己的样式表不构成新增能力；跨目录由后端的路径校验拒绝，且只允许
文本类型（`.css` / `.js` / `.mjs` / `.json` / `.svg` / `.html` / `.txt` / `.md`）。

```js
await api.plugin.listAssets("styles"); // 该子目录下可读的文件名（不递归、已排序）
await api.plugin.readAsset("styles/dark.css"); // 文件内容
```

`listAssets("")` 列的是插件根目录。两者都不递归，子目录不会出现在结果里。

> **注意**：`api.plugin` 既承载静态信息，也承载这两个方法。静态字段优先，插件不能靠
> 同名方法顶掉 `id` / `version`。

### `api.workspace` — 笔记

```js
await api.workspace.listNotes(); // NoteMetadata[]
await api.workspace.getNote(id); // Note
await api.workspace.createNote({ title, content, category });
await api.workspace.updateNote(id, { title, content, category });
await api.workspace.deleteNote(id);
await api.workspace.moveNoteCategory(id, category);
await api.workspace.listCategories();
await api.workspace.createCategory(name);
await api.workspace.openNote(id); // 在主窗口打开
await api.workspace.getActiveNote(); // 本窗口当前笔记，可能为 null
```

跟着**文件**走的缓存（要 `workspace:cache` 权限，见
[`Docs/workspace-cache.md`](./workspace-cache.md)）：

```js
await api.workspace.cacheGet("E:\\笔记\\论文.pdf"); // 上次存的东西，没有则 null
await api.workspace.cacheSet("E:\\笔记\\论文.pdf", { marks: [] });
await api.workspace.cacheDelete("E:\\笔记\\论文.pdf"); // 删掉了返回 true
```

路径是**那个文件**的路径（工作区里的、或从「打开方式」进来的都行），键是**调用它的
插件名** —— 插件之间互相看不见对方的缓存。

### `api.editor` — 当前窗口的编辑器

```js
await api.editor.getContent(); // 全文
api.editor.getContentSync(); // 同上，但读镜像，同步、无往返
await api.editor.getSelection(); // { text, start, end } | null
api.editor.getSelectionSync();
await api.editor.getCursor(); // { line, column, offset }
api.editor.getFileSync(); // 当前文件身份，见下

await api.editor.setContent(text);
await api.editor.insertText(text); // 光标处插入
await api.editor.insertText(text, "docEnd"); // 文末追加
await api.editor.wrapSelection("**", "**"); // 包裹选区；第二个参数省略时与第一个相同
await api.editor.replaceSelection(text);
await api.editor.replaceRange(start, end, text);
await api.editor.setSelection(start, end);
await api.editor.focus();

api.editor.scrollTo(offset);
api.editor.scrollPreviewTo(offset);
```

`getContentSync()` / `getSelectionSync()` / `getFileSync()` 读的是宿主**节流推送的
镜像**，因此：

- 它们是同步的，适合在 `render()` 这类必须立即返回的地方用；
- 它们可能有最多约 150ms 的延迟，写操作请用 `await` 的版本；
- **未获得 `editor:read` 时，镜像里既不含正文，也不含文件路径。**

#### `getFileSync()` —— 当前打开的是什么文件

```ts
{
  (path, typeId, kind, language);
} // 或 null
```

| 字段       | 说明                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| `path`     | 绝对路径。**笔记没有磁盘路径，整项为 `null`。**                                |
| `typeId`   | 命中文件类型注册表时的 id（如 `"python"`）；没被任何插件认领时为 `null`        |
| `kind`     | `code` / `text` / `markdown` / `table` / `image` / `media` / `none` / `custom` |
| `language` | highlight.js 语言名，只有 `code` 类文件才有                                    |

有了它，「按文件类型做不同的事」才成立 —— 否则插件只能嗅探正文猜自己面对的是什么。
典型用法：

```js
const file = api.editor.getFileSync();
if (!file) {
  /* 笔记，没有磁盘文件 */
}
if (file.language === "python") {
  /* … */
}
if (file.kind === "code") {
  /* 任意代码格式 */
}
```

⚠️ 路径与正文同属 `editor:read` 这一档能力，`editor:write` 蕴含 `editor:read`，所以
能改正文的插件也能读到路径。

### `api.ui` — 界面贡献

```js
api.ui.showToast("消息", "info")   // "info" | "warning" | "error"

api.ui.registerCommand({
  id: "demo.run",
  title: "做点什么",
  keybinding: "Ctrl+Shift+D",       // 可选
  run() { /* ... */ },
});

api.ui.registerPanel({
  id: "demo",
  title: "面板标题",
  standalone: true,                 // true 时出现在标题栏，可单独打开
  width: 360,
  render() { return "<p>HTML 字符串</p>"; },
  onClick(ref) { /* 见下 */ },
});

api.ui.registerStatusBarItem({
  id: "demo.status",
  render(selection) { return selection ? `选中 ${selection.text.length} 字` : null; },
});

api.ui.registerEditorMenuItem({ id, title, run });
api.ui.registerNoteMenuItem({ id, title, run(noteId) });   // 带笔记 id
api.ui.registerToolbarButton({ id, title, icon, run });

api.ui.registerStyle({             // 注入 CSS，需要 ui:style 权限
  id: "demo.theme",
  css: ":root { --app-window-radius: 4px; }",
});

api.ui.dispose(registrationId);     // 上面的方法都返回注册 id，可单独撤销
```

**面板的 `render()` 请返回一个稳定的字符串。** 宿主在正文变化时会重新拉取面板 HTML；
返回值与上次**逐字符相同**时，整条更新链路会被短路 —— React 不重渲染、DOM 不重建，
于是用户在面板里的**滚动位置不会被打字打断**。反过来说，面板里尽量别放「当前文件名」
这类每敲一个字就变的内容：一变就重排、滚回顶部。`example-plugins-v2/math-symbols/`
就是按这个约定写的（HTML 算一次后缓存成常量）。

**关于 `registerStyle`**：注入的样式**不做消毒**，这与面板 HTML 的处理不同 —— 面板走
`dangerouslySetInnerHTML`，一句 `onerror` 就能在主世界执行代码，所以必须清洗；而 CSS
不具备脚本执行能力，最多做视觉改动与网络请求。能力大小由清单里的 `ui:style` 权限
如实表达。示例见 `example-plugins-v2/css-modifier/`。

样式是**窗口**粒度的：主窗口、小窗、磁贴各自注入一份。`id` 只用于调试定位，重复注册
会叠加（与 CSS 的层叠语义一致）。可参考的稳定变量：`--color-paper*` / `--color-ink*` /
`--color-bamboo*`（主题三层背景、文字四级、强调色），`--md-text-color` /
`--md-table-color` / `--md-divider-color` / `--md-quote-color` / `--md-caption-color`
（预览配色），`--app-window-radius` / `--app-surface-radius`（圆角）。
预览区在渲染结果上还带 `.md-body` / `.md-table` / `.md-divider` / `.md-quote` /
`.md-caption` 这几个语义类，覆盖它们比覆盖 Tailwind 工具类更稳。

**键位优先级**：宿主内置的 Markdown 快捷键（Ctrl+B / Ctrl+I / Ctrl+\ 等）先处理，
插件键位只在其未处理时才介入。不要指望用插件覆盖内置键位。

#### `api.ui.registerGutter()` —— 编辑器左侧的行旁注

```js
api.ui.registerGutter({
  id: "line-numbers",
  title: "行号",
  width: 36, // 可选，默认 36（px）
  render() {
    return api.editor
      .getContentSync()
      .split("\n")
      .map((_, i) => String(i + 1));
  },
});
```

需要 `ui:gutter` 权限。

在编辑区左侧加一栏「每行一段文字」：行号、git blame、TODO / 断点标记都走这个口子。

**`render()` 返回一个字符串数组，第 i 项对应正文第 i 个逻辑行**；空字符串表示这一行没有
标注 —— 多数行没内容才是常态（行号是例外）。

**位置不归你管，这是有意划的界。** 插件跑在 worker 里，没有 DOM，量不到编辑器的字体、
可用宽度和换行 —— 而同一行折成三行时，行号只该出现一次。所以宿主会把每一行的原文按与
编辑器**完全相同**的宽度再排一遍（不可见），行高因此天然对得上。你只管出文字。

- 正文变化、切换文件时宿主会自动重新调用 `render()`，不需要自己监听。
- `render()` 抛错或返回值不是字符串数组时，那一栏直接不显示，只往插件日志里记一条 ——
  边栏装饰失败不该在界面上留下一句报错。
- 多个插件可以同时注册，按注册顺序从左到右排列。`width` 是这一栏占的宽度。
- **同一个 `id` 再次注册是替换，不是叠加。** 插件自己的参数变了（比如用户把行号栏调宽
  了）可以重新注册一遍，宿主会把旧的撤掉 —— 不会多占一栏。

#### `api.ui.registerDecorations()` —— 贴正文的行内小控件

```js
api.ui.registerDecorations({
  id: "colors",
  title: "颜色块",

  render() {
    // 正文 / 文件每次变化时调用一次。返回**数据**，不是 HTML。
    return [{ offset: 123, length: 7, color: "#fbf9f4" }];
  },

  pick(offset, length, color) {
    // 用户点了那个位置的小控件并选了新颜色（color 是 #rrggbb）
  },
});
```

需要 `ui:decorations` 权限。

在正文里**贴着某个字符区间**叠一个小控件。与行旁注（`registerGutter`）的分工很明确：

|        | `registerGutter`               | `registerDecorations`            |
| ------ | ------------------------------ | -------------------------------- |
| 位置   | 编辑区**左侧固定栏**，一行一格 | 跟着**列位置**走，贴在指定区间旁 |
| 内容   | 每行一段**文字**               | 宿主渲染的小控件（目前是颜色块） |
| 可点击 | 否                             | 是（`pick` 回调）                |

三条约定：

- **`render()` 返回数据，不是 HTML**，所以这条链路不经过消毒器 —— 也就没有 `data-*` 白名单
  那一堆限制。每条是 `{ offset, length, color }`，`offset` / `length` 是**正文字符偏移**。
- **`color` 必须是 `#rrggbb`**。控件本体是 `<input type="color">`，按规范只认这个格式；
  三位缩写、`rgb()`、`hsl()` 都要你在插件里折算好。宿主拿到不合规的条目**直接丢弃那一条**，
  不会让整层失败。
- **改正文由你自己做**（`pick` 里用 `editor.replaceRange`）。宿主只回传「哪个区间、选了什么
  色」—— 只有你知道原文是 `#hex` 还是 `rgba(...)`，也因此能顺手保住透明度。

位置由宿主从编辑器布局里量，你只管给偏移。大文档放弃着色时这一层不显示（量不出位置），
属正常降级。

> ⚠️ 小控件是**叠**在正文上的，不会把文字推开 —— 正文是真实的 `<textarea>`，字符位置由
> 浏览器排版所有，往上层插图元不会让字跟着挪。所以控件会盖住它左边那一个字符位，放置时
> 尽量挑一个空格落上去。

完整样例见 `example-plugins-v2/color-swatches/`。

#### `api.ui.registerPopover()` —— 工具栏浮层（按钮 + 下拉）

```js
api.ui.registerPopover({
  id: "symbols",
  title: "符号",
  icon: "∑", // 按钮上显示的文字；不给就用 title
  width: 360, // 下拉宽度（px），默认 320
  markdownOnly: true, // 只在笔记 / Markdown 文件下出现
  closeOnClick: false, // 点一次就收起？默认 false

  render() {
    // 每次**点开**时调一次，返回下拉里的 HTML
    return `<button class="sym" data-value="\\alpha">α</button>`;
  },
  onClick(ref) {
    const cell = ref.closestClass("sym");
    if (!cell) return;
    insert(cell.attrs["data-value"]);
    // 返回一个字符串 = 用这段 HTML 换掉当前内容（分类切换、翻页靠它）
    // return renderPage(2);
  },
});
```

需要 `ui:popover` 权限。

工具栏上的一个按钮，点开一个**贴着它**的下拉面板。与 `registerPanel` 的分工：面板是常驻
侧栏，浮层是随手开合的临时界面 —— 符号表、表情选择、颜色盘、模板插入这类「看一眼、点一下、
关掉」的东西用它更合适。

- **内容懒加载**：注册时**不**渲染，用户点开时才调一次 `render()`。所以 `render()` 里可以
  放心做重活，也不会为没人打开的浮层白白渲染。
- 下拉内容与面板走**同一条消毒路径**（`data-*` 白名单、`on*` 剔除、`<svg>` 剥掉），
  `onClick(ref)` 拿到的是同一套描述符 —— 第 5 节那两条约束原样适用。
- `onClick` **返回字符串**时，宿主把它当作新内容换上。分类切换、翻页这类交互因此不必重新
  注册，插件在自己的沙箱里记住状态就行。
- 位置由宿主算：贴着按钮，快越出窗口时会翻到另一侧。宽度可以指定，高度由内容决定（超出滚动）。
- `render()` 抛错时下拉里显示一句错误说明而不是空白 —— 空面板只会让人以为按钮坏了。

完整可运行的样例见 `example-plugins-v2/popover-demo/`（两个分类的字符盘：点标签换页走
「返回新 HTML」，点格子插字符）。

### `api.files` — 文件类型

工作文件夹里**显示哪些文件、卡片长什么样、打开后怎么展示**，全部由这里声明。插件只是
登记规则，**不接触文件系统**：文件夹里有什么、内容是什么，都由宿主读好后交过来。

```js
await api.files.registerType({
  id: "python", // 插件内唯一即可，宿主会加上插件名前缀
  extensions: ["py", "pyw"], // 不带点，大小写不敏感
  label: "Python",
  badge: "PY", // 卡片标题前的短标签
  color: "#3572a5", // 卡片强调色（左侧竖条、标题、徽章）
  kind: "code", // 见下表
  language: "python", // kind === "code" 时交给宿主 highlight.js 的语言名

  // 可选：这个格式自己的编辑区观感
  font: "var(--font-mono)", // 任意 CSS font-family；不填按 kind 取默认
  highlightTheme: {
    // 代码配色；不填则跟随应用主题
    light: "atom-one-light",
    dark: "atom-one-dark",
  },
});
```

**字体**：`font` 不填时的默认是 —— `code` / `text` / `table` 用等宽字体（`--font-mono`），
`markdown` 用正文字体。想给某个格式单独换字体就填它，例如把 `.txt` 这类以阅读为主的内容
换成正文字体。

**配色**：`highlightTheme` 可写单个主题名（明暗都用它），也可写 `{ light, dark }` 按应用
主题各取一套。可选值：`github`、`github-dark`、`atom-one-light`、`atom-one-dark`、
`stackoverflow-light`、`stackoverflow-dark`、`a11y-light`、`a11y-dark`、`intellij-light`、
`color-brewer`、`xcode`、`monokai`、`agate`、`vs`、`vs2015`。名字写错会回落到默认，
不会让代码块变成没有样式。

| `kind`     | 编辑器         | 预览面板    | 说明                                             |
| ---------- | -------------- | ----------- | ------------------------------------------------ |
| `code`     | ✅             | ❌          | 用 highlight.js 着色，可编辑并写回磁盘           |
| `text`     | ✅             | ❌          | 纯文本，可编辑，不着色                           |
| `markdown` | ✅             | ✅ Markdown | 走完整的 Markdown 渲染管线                       |
| `table`    | ✅（原始文本） | ✅ 表格     | csv / tsv                                        |
| `image`    | ❌             | ✅ 图片     | 通过 asset 协议直接显示                          |
| `media`    | ❌             | ✅ 播放器   | 音频 / 视频                                      |
| `custom`   | ❌             | ✅ 插件渲染 | 调 `render(file)`，返回值经 `sanitizePluginHtml` |
| `view`     | ❌             | ✅ 沙箱视图 | 插件交出自己的 HTML/CSS/JS，跑在沙箱里           |
| `none`     | ❌             | ❌          | 只在侧栏出现，点开提示暂不支持                   |

**「有没有编辑器」和「有没有预览面板」是两件独立的事。** `.py`、`.log`、`.txt` 打开就
只是编辑器，不会挂一个空的预览窗格；`.csv` 则能在「编辑看原文」和「预览看表格」之间
切换。「编辑 / 分栏 / 预览」这组按钮只在**两者兼备**（即 `markdown` 与 `table`）时出现。

`kind: "custom"` 时多传一个 `render` 函数：

```js
await api.files.registerType({
  id: "my-format",
  extensions: ["xyz"],
  label: "自定义",
  badge: "XYZ",
  color: "#888888",
  kind: "custom",
  render(file) {
    // file: { name, path, content }
    // content 是宿主读好的文本；二进制文件或读取失败时为 null。
    // path 只可用于去重 / 缓存键，**不能**用来读盘 —— 插件没有这个能力。
    return `<pre>${escapeHtml(file.name)}</pre>`;
  },
});
```

**没装任何声明文件类型的插件时，工作文件夹里只看得见 `.md`** —— 宿主内置的
Markdown 规则是唯一一条。装上 `example-plugins-v2/file-reader/` 之后，30 多种常见格式
会一次性出现在侧栏里，宿主代码一行没改。这就是把「文件浏览」和「格式知识」拆开的收益：
原装保持轻量，能力靠插件扩展。

> `extensions` 为空数组会被判为参数错误。`kind` 拼错也会明确报错，而不是静默回落到
> 某个默认值 —— 那样插件作者会以为注册成功了，却一直看不到期望的渲染结果。

### `kind: "view"` — 插件自己的渲染界面

`custom` 只能返回一段 HTML 字符串（还要过消毒白名单，没有 `<canvas>` / `<script>`）。
想画 canvas、想跑自己的脚本、想用一个真正的库（pdf.js 那种），就得用 `view`：

```js
await api.files.registerType({
  id: "pdf",
  extensions: ["pdf"],
  label: "PDF",
  badge: "PDF",
  color: "#c0392b",
  kind: "view",
  view: {
    html: "view/index.html", // 骨架（进入 <body>）
    css: ["view/viewer.css"], // 按顺序内联进 <style>
    js: ["vendor/lib.js", "view/viewer.js"], // 按顺序拼进**同一个**内联 module
    worker: "vendor/lib.worker.js", // 可选：Web Worker 的源码，见下
  },
});
```

这个能力比「登记一条扩展名规则」强得多（插件交出来的代码会**真的跑起来**），所以除了
`files:register` 还要单独一道 **`files:view`** 权限 —— 用户撤掉它就能让视图失效，
不必停用整个插件。

**沙箱边界与那几条实测结论见 [`Docs/plugin-view-sandbox.md`](./plugin-view-sandbox.md)**，
写插件前值得先看一遍。三条最容易踩的：

1. **帧是 opaque origin，取不到任何外部资源。** 所以宿主把上面几样**全读成文本内联**进去；
   你的代码里不要写 `fetch("./x.json")`、也不要指望相对路径的资源 —— 要用什么就让宿主
   内联什么（多出来的文件写进 `js` / `css` 列表）。
2. **`new Worker(<地址>)` 会被 CORS 挡掉，`new Worker(blob:)` 可以。**
   所以 `worker` 指定的文件由宿主塞进
   `<script type="text/plain" id="floral-worker-src">`（**不执行**，只当文本），
   你自己读出来做成 blob：
   ```js
   const source = document.getElementById("floral-worker-src").textContent;
   globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
     new Blob([source], { type: "text/javascript" }),
   );
   ```
3. **`js` 列表里的文件全部共享一个模块作用域**（拼成一个 module）。第三方库的顶层名字
   可能和你撞车，所以自己的代码**包一层 IIFE**。

`html` / `css` / `js` / `worker` 的路径都相对插件目录，且都会被校验（不许绝对路径、不许
`..`、单个文件有大小上限）。

与宿主的往来只有一条通道：`window.floralView`（宿主注入的一段桥接，就这么几个方法）：

| 方法 | 干什么 |
|---|---|
| `ready()` | **必须调一次**：宿主收到它才发 `init` |
| `onMessage(handler)` | 收宿主来的消息（`init` / `document` / `documentError` / `theme`） |
| `requestDocument()` | 要文件内容（`document`，`message.bytes` 是 `ArrayBuffer`） |
| `requestDocumentCopy()` | **扩展插件**另要一份字节副本（`documentCopy`）—— 见下面那条 ⚠️ |
| `saveFile(name, bytes)` | 把一份字节存到**用户选的位置**（弹原生保存对话框） |
| `onCommand(handler)` | 收工具栏发来的命令（`{ id, value }`） |
| `setState(values, pressed)` | 报工具栏状态（基础插件用；扩展插件用下面那个） |
| `toast(message)` / `log(level, message)` | 提示 / 写宿主控制台（`error` 会被转发出来） |
| `extension("<插件名>")` | 扩展插件的私有数据通道：`{ write, onData, setState }` |

⚠️ **`document` 里的 `ArrayBuffer` 只用一次。** pdf.js 拿到手会把它**转移给 worker**，
转移过的 buffer 在原处就废了（再拿去构造任何东西都会报 `detached ArrayBuffer`）。一个视图里
两个插件（被扩展的 + 扩展它的）收到的是**同一个**对象，查看器先拿到先废 —— 所以扩展插件
要用文件内容的话，走 `requestDocumentCopy()` 另要一份（宿主会重新读一次文件）：

```js
floralView.onMessage((message) => {
  if (message.t === "documentCopy") useBytes(message.bytes);
});
floralView.requestDocumentCopy();
```

**要存东西出去**（导出、另存为）用 `saveFile` —— 宿主会弹出**原生的保存对话框**：路径由
用户挑、文件名由用户看着。插件拿不到路径，也写不了别的位置。所以要 `workspace:cache` 那种
权限，**这不是**「插件能写文件」：

```js
const bytes = await something.save(); // Uint8Array
floralView.saveFile("笔记-批注.pdf", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
```

文件内容是**主动要**的 —— 插件拿不到路径：

```js
floralView.onMessage((message) => {
  if (message.t === "init") floralView.requestDocument(); // { name, path, theme, tokens }
  if (message.t === "document") render(new Uint8Array(message.bytes)); // ArrayBuffer
  if (message.t === "documentError") showError(message.message);
});
floralView.ready(); // 别忘了：宿主收到它才会发 init
```

完整可运行的样例见 `example-plugins-v2/pdf-viewer/`（pdf.js 的 PDF 阅读器，含 worker 与
工具栏）；它是怎么拿到 pdf.js、为什么要把那份文件改一处，见
[`Docs/pdf-viewer.md`](./pdf-viewer.md)。

#### 顶上那排控件交给宿主画：`view.toolbar`

视图是沙箱里的一块**孤岛**：它跟应用窗口的排版对不齐，而且写再轻的工具栏也得等插件那坨 js
解析完才出得来。所以工具栏由**宿主**渲染，插件只声明：

```js
view: {
  html: "view/index.html",
  // …
  toolbar: [
    { kind: "button", id: "zoom-out", label: "−", title: "缩小" },
    { kind: "readout", id: "zoom", title: "缩放比例" },
    { kind: "button", id: "zoom-in", label: "+", title: "放大" },
    { kind: "button", id: "fit", label: "适应宽度", toggle: true },
    { kind: "separator" },
    { kind: "input", id: "goto", title: "跳转到页", placeholder: "页码", width: 46 },
  ],
}
```

五种控件：

| `kind` | 长什么样 | `id` 有什么用 |
|---|---|---|
| `button` | 一排小按钮 | 点了发 `command`；带 `toggle: true` 时会被 `pressed` 点亮 |
| `readout` | 只读小字（`3 / 14`） | 文本来自 `state.values[id]` |
| `input` | 输入框，**回车**提交 | 提交时发 `command`，值在 `message.value` |
| `menu` | 按钮 + 下拉菜单 | 选一项发 `command`，值在 `message.value`；按钮文字来自 `state.values[id]` |
| `separator` | 一条竖线 | 不需要 `id` |

#### 给按钮配个小图标：`icon`

一排全是字不好看，插件可以给每一项配一个图标 —— 但**排版仍然由宿主决定**，图标只是
装饰：尺寸、间距、明暗跟着这一排走。

```js
{ kind: "button", id: "zoom-in", label: "放大", icon: "icons/zoom-in.svg" }
```

- 值是**插件目录下的相对路径**（`.svg`）。宿主把它读成文本，**内联**进按钮里（不是
  `<img>`）—— 于是图标能跟着主题色走：写 `fill="currentColor"` / `stroke="currentColor"`
  就行，深浅色、主题色都不用你操心。
- **`button`、`menu` 与 `menu` 的每个选项**都能带。菜单的触发按钮显示的是**当前选中那一项**
  的图标，所以不必给菜单本身再配一个。
- 读不到、不是 SVG、或者内容里有脚本一类的东西 —— 都只是「这一项没有图标」，照旧显示文字，
  不会让整排控件出不来。单份图标超过 32KB 会被跳过（图标那么大一定是画歪了）。
- 路径合不合法由后端把关（与 `css` / `js` 同一条原则：前端不重复写一遍规则）。
- 走的是与 `view.css` / `view.js` 同一条资源通道，所以**图标文件要跟着插件一起分发**。

`menu` 是给「一个控件里选一样东西」用的（选工具、选颜色），选项带 `color` 时画成色块：

```js
{
  kind: "menu", id: "tool", label: "指针", title: "标注方式",
  options: [
    { value: "pointer", label: "指针" },
    { value: "rect", label: "矩形" },
    { value: "ink", label: "自由笔" },
    // 颜色选择器不必是另一种控件：带上 color 就行（一个色块 + 名字）
    { value: "#ffd400", label: "黄", color: "#ffd400" },
  ],
}
```

选项个数上限 24，`value` 会原样出现在 `message.value` 里；当前选中的那一项由
`state.values[id]` 决定（把它的 `value` 推回来即可）。

宿主不猜、也不记账：它只负责「把点击翻译成命令」与「照 `state` 显示」，**当前页码、缩放比例
这些事实一律以视图报上来的为准**（否则两边一旦分歧，就是越点越离谱）。

```js
floralView.onCommand(({ id, value }) => {
  if (id === "zoom-in") void zoomBy(1.2);
  if (id === "goto") void goToPage(Number(value));
});

// 任何时刻都能报（打开文档、翻页、缩放、旋转之后），宿主按 id 对上号
floralView.setState({ zoom: "120%", page: "3 / 14" }, ["fit"]);
//                       ↑ values：覆盖那一项显示的文字            ↑ pressed：点亮的开关
```

`values` 也能覆盖**按钮**的文字，所以「单页 / 连续」这种一个按钮两种状态不必拆成两个
（推一个 `values: { spread: "单页" }` 过去就行）。声明里的 `id` 要独一无二（它同时是命令名
与状态名）；形状不对的项会被**单独丢掉** —— 少一个按钮，好过整份声明作废。

当前页码、缩放比例这些状态**宿主不替你存**：插件被重新加载、文件被换掉，视图会重建，
再报一遍即可。

这排控件是**两个插件共用**的（别家扩展了你的视图时），两边各报各的状态：

```js
// 基础插件（注册视图的那个）：不带归属，报自己那一排
floralView.setState({ zoom: "103%" }, ["fit-width"]);

// 扩展插件：带插件名，只报自己那几项
floralView.extension("pdf-annotations").setState({ tool: "rect", color: "#ffd400" }, []);
```

不带名字的 `setState` 会被当成**基础插件**报的。宿主按插件各存一份再摊平，所以两边
不会互相盖掉（「缩放比例」这类小字忽然空掉，就是没按插件分开的典型症状）。

#### 主题：`theme` / `init.tokens`

视图是独立文档，**拿不到宿主的 CSS 变量** —— 用户换了深浅色、换了主题色，它一点都不知道。
所以宿主把调色板**解析后的值**递进来（`init` 里带一份，之后每次变化再发一条
`{ t: "theme", theme, tokens }`）：

```js
floralView.onMessage((message) => {
  if (message.t !== "init" && message.t !== "theme") return;
  document.documentElement.dataset.theme = message.theme; // "light" | "dark"
  root.style.setProperty("--bg", message.tokens["--color-paper-warm"]);
  root.style.setProperty("--ink", message.tokens["--color-ink"]);
});
```

给的是一小组固定名字（`VIEW_THEME_TOKENS`，见 `src/features/plugins/themeTokens.ts`）：
`--color-paper` / `--color-paper-warm` / `--color-paper-deep` / `--color-cloud` /
`--color-ink` / `--color-ink-soft` / `--color-ink-ghost` / `--color-bamboo` /
`--color-bamboo-mist` / `--color-shadow-deep`。

⚠️ **`--color-ink-faint` 不在里面，也别自己去找它**：这一版里它是荧光笔的黄（选区标记用的），
不是「次级正文灰」。小字灰是 `--color-ink-ghost`。

宿主没给某个 token（用户自定义样式把它删了）时那个键**不存在**，别把 `undefined` 塞进
`style.setProperty` —— 那会让 `var(--bg)` 变成无效值，整条声明连同后面几组一起失效。
`theme` 与 `init` 是**两条独立的消息**：`init` 在插件这边意味着「从头来一遍」，
换主题时可不能重开文档。

#### 扩展别人的视图：`api.files.extendView()`

有些能力**不该自己造一遍**：想给 PDF 加批注，不必重新实现一遍 PDF 渲染 —— 把代码并进
**已经有那个视图的插件**里就行。

```js
await api.files.extendView({
  typeId: "pdf-viewer:pdf", // 目标视图（**带插件名前缀**，见 ownerOfFileType）
  css: ["view/annotate.css"], // 并进同一个 <style> 序列
  js: ["view/annotate.js"], // 拼进**同一个**内联 module，排在基础插件的 js 之后
  toolbar: [/* 与 view.toolbar 同一种结构，接在基础插件那一排后面 */],
  data: true, // 要一条私有数据通道（落在文件旁边的 __floral-notepaper__ 里）
});
```

- **同一帧、同一模块**：两边的代码真的跑在一起，所以基础插件的顶层名字你够得着
  （pdf-viewer 就把坐标换算显式挂在 `globalThis.floralPdfView` 上给扩展用）。你自己的
  代码请**包一层 IIFE**，重名会让整个模块报错、视图全白。
- **工具栏是共用的**：id 撞了**基础插件赢**，扩展那一项被丢掉并在控制台警告一次。
  状态也按插件分开报（见上面 `view.toolbar` 一节），各报各的。
- **目标插件没装**：扩展先存着，等那个视图建出来时再合并 —— 加载顺序不该决定谁能扩展谁。
  反过来，你想扩展的插件自己也有 `requires` 约束的话（见下节），把依赖写上更稳。
- **`data: true`** 是唯一要额外权限的部分：它给一条属于**你这个插件**的数据通道
  （写的是用户文件夹里的 `__floral-notepaper__/`），所以要 `workspace:cache`。
  通道本身在视图里用：

  ```js
  const store = floralView.extension("pdf-annotations"); // 名字自己报，用插件名
  store.onData((data) => { state.marks = data?.marks ?? []; render(); }); // 宿主推回上次存的
  store.write({ version: 1, marks: state.marks }); // 存（宿主原子落盘）
  store.setState({ tool: "rect" }, []); // 只想报工具栏状态也走它
  ```

  数据落点是 `<文件所在工作区根>/__floral-notepaper__/<插件名>/…`，**跟着文件走**
  （见 [`Docs/workspace-cache.md`](./workspace-cache.md)）。同一个帧里的两个插件共享一切，
  所以「谁是哪个插件」由名字自己说了算 —— 这不算漏洞：扩展方与被扩展方本来就同属一个
  信任域。

### `api.fonts` — 自带字体

插件可以自带字体，用户把它们丢进文件夹就能用 —— **不需要装进系统**，不需要管理员权限，
卸载插件即全部消失。

```js
floral.register({
  async onLoad(api) {
    const { families, count } = await api.fonts.register({ dir: "fonts" });
    // families: ["JetBrains Mono", "Fira Code"]；count 是**文件**数（一个族可能占多个字重）
  },
});
```

把 `.ttf` / `.otf` / `.ttc` / `.woff` / `.woff2` 放进插件的 `fonts/` 目录（`dir` 可改，
默认就是 `fonts`；**只扫描一层**）。登记之后这些字体立刻可用于代码编辑器、Markdown
代码块与行内代码，并出现在「设置 → 代码字体 → 插件字体」里。

**插件全程拿不到路径。** 它只声明「我的字体在哪个文件夹」，剩下的全由宿主完成：列目录、
把文件变成 WebView 能加载的 URL、拼 `@font-face`、注入样式、登记族名。回给插件的只有
字体**名字**。所以这个接口**不需要任何权限** —— 它比 `ui.registerStyle`（要 `ui:style`）
还弱：插件塞不进任意 CSS，规则是宿主按校验过的文件名生成的。

族名、字重、字形从字体**文件内部**的 `name` 与 `OS/2` 表读出来，文件名只是读不出来时的
兜底（`JetBrainsMono-Regular.ttf` 按驼峰拆会得到 "Jet Brains Mono"，而真名是
"JetBrains Mono"）。读不出内部名称的格式（例如 WOFF）才按文件名猜，猜得不对可以用
`overrides` 兜：

```js
await api.fonts.register({
  dir: "fonts",
  overrides: {
    // 键是文件名，不是路径
    "weird-1.ttf": { family: "正经族名", weight: 400, style: "normal" },
  },
});
```

> 单个文件上限 16 MB，超限的**跳过而不是报错** —— 一个坏文件不该让整个字体目录失效。
> 目录不存在时返回空列表，所以用户还没往里丢字体时插件也能正常加载。

完整示例见 `example-plugins-v2/font-pack/`。

### `api.events` — 事件

```js
const disposable = api.events.on("note:opened", (payload) => {
  console.log(payload.id);
});
disposable.dispose();
```

| 事件                               | 载荷                                    |
| ---------------------------------- | --------------------------------------- |
| `workspace:ready`                  | —                                       |
| `note:opened`                      | `{ id }`                                |
| `note:changed`                     | `{ id? }`（保存/新建/删除后由后端广播） |
| `note:saved` / `note:deleted`      | `{ id }`                                |
| `editor:contentChanged`            | `{ content }`（节流 ≥150ms）            |
| `editor:selectionChanged`          | `Selection \| null`                     |
| `config:changed` / `theme:changed` | `{ theme?, accentColor?, locale? }`     |
| `window:focus` / `window:blur`     | —                                       |
| `settings.changed`                 | 你**自己**的完整设置（改设置时推给你）  |
| `plugin:assetsChanged`             | `{ plugin, path }`，见下                |

**`plugin:assetsChanged`** —— 你在花笺里保存了某个**插件自己目录**里的文件时发出，
载荷是插件名与那个文件的绝对路径。广播给所有订阅者，所以按名字过滤一下：

```js
let myName = null;
void api.plugin.info().then((info) => {
  myName = info.name;
});

api.events.on("plugin:assetsChanged", (payload) => {
  if (payload.plugin !== myName) return;
  if (payload.path.endsWith(".css")) void reloadStyles();
});
```

典型用途就是「改完插件自己的样式表，保存即生效」，不必再回插件面板点重新加载。
⚠️ 只有**在花笺里保存**会触发；用外部编辑器改文件不会（那需要一个文件监视器）。

### `api.storage` — 插件级持久化

```js
await api.storage.set("token", { a: 1 });
await api.storage.get("token", null);
await api.storage.delete("token");
await api.storage.keys();
await api.storage.clear(); // 只清 kv，不动用户在设置里配的值
```

数据落在 `<笔记数据目录>/plugin-data/<插件名>/kv.json`，与插件代码分开存放，
因此替换或升级插件目录不会丢数据。

### `api.settings` — 只读设置快照

```js
const values = await api.settings.get(); // { countMode: "chars", ... }
```

取值来自用户在设置面板里改的内容，默认值取自清单的 `contributes.settings`。
详见第 6 节。

### `api.system`

```js
await api.system.clipboard.read();
await api.system.clipboard.write("文本");
await api.system.openExternal("https://example.com");
await api.system.dialog.message("提示", { title: "标题" });
await api.system.dialog.confirm("确定吗？");
await api.system.dialog.prompt("输入点什么", { defaultValue: "默认值" });
```

### `api.log`

`api.log.debug / info / warn / error`，输出会进插件面板的「日志」标签页。
`error` 级别还会弹 Toast，但**每个插件 10 秒最多一次**，所以不用担心在渲染循环里
刷屏。

---

## 5. 面板的点击事件：`onClick(ref)`

沙箱里没有 DOM，所以点击事件传给你的是**可序列化的描述符**，不是 DOM 节点。

```js
api.ui.registerPanel({
  id: "demo",
  title: "示例",
  render() {
    return `<button class="item" data-index="2">第三章</button>`;
  },
  onClick(ref) {
    const button = ref.closestClass("item"); // 或 ref.closest(".item")
    if (!button) return;
    const index = Number(ref.data("index")); // 等价于 dataset.index
    console.log(index, ref.text);
  },
});
```

`ref` 的形状：

```ts
{
  tag: "button", id: "", classes: ["item"],
  attrs: { "data-index": "2" },      // 只含 data-* 与少量白名单属性
  text: "第三章",
  path: [/* 自身与祖先，最多 8 层 */]
}
```

助手：`ref.data(key)`、`ref.attr(name)`、`ref.closest(selector)`、`ref.closestClass(name)`。

⚠️ **`ref` 描述的是点击的落点，不一定是你要的那个元素。** 格子里若还嵌了 `<span>`
（比如「字形 + 命令」两行的那种），点在文字上时 `ref` 就是那个 `span`，它身上没有
`data-value`，`ref.data("value")` 会返回 `null` —— 表现为「点在字上没反应，点在格子
边缘才有反应」。取值应当从**找到的那个祖先**上读，描述符的每一层都带自己的 `attrs`：

```js
onClick(ref) {
  const cell = ref.closestClass("sym-cell");
  if (!cell) return;
  const value = cell.attrs["data-value"];     // ← 按钮那一层的 data-*
  if (value) insert(value);
}
```

完整样例见 `example-plugins-v2/math-symbols/`（符号面板：静态 HTML + `data-value` 传参）。

⚠️ `closest()` **不是完整的 CSS 选择器引擎**，只支持：`tag`、`.class`、`#id`、
`[data-x]`、`[data-x="v"]`，以及 `tag.class` / `tag[data-x]` 这类两段组合。
不支持后代、子代、逗号分组。

**面板 HTML 会被宿主消毒**后再注入：`<script>`、`<iframe>`、`<svg>`、`on*` 事件属性、
`javascript:` 协议等一律剔除。所以内联 `onclick="..."` 是无效的，请用 `onClick` 回调。

两条容易踩的约束：

- **`data-*` 是严格白名单**，只有 `data-index` / `data-id` / `data-key` / `data-value`
  这四个键能活下来。`data-offset`、`data-line` 之类会被删掉。
- **内联 `style` 放行**（只挡 `expression(` 与 `url(javascript:…)` 之类），所以
  `padding-left` 做缩进、`var(--color-*)` 取主题色都没问题。想带元信息，塞进上面
  那四个键，或者干脆在 `onClick` 里按 `data-index` 重新算一遍。

---

## 6. 声明式设置项

在清单里声明，宿主会自动在设置面板里渲染成表单，插件不需要写界面代码：

```json
{
  "contributes": {
    "settings": [
      {
        "key": "countMode",
        "type": "select",
        "title": "统计方式",
        "description": "可选的说明文字",
        "options": [
          { "value": "chars", "label": "字符数" },
          { "value": "words", "label": "词数" }
        ],
        "default": "chars"
      }
    ]
  }
}
```

支持的 `type`：`boolean`、`number`（可带 `min` / `max` / `step`）、`string`、
`textarea`、`select`（需 `options`，元素可以是字符串或 `{value,label}`）。

插件侧通过 `await api.settings.get()` 读取。值存在
`plugin-data/<插件名>/settings.json`，与 `api.storage` 分开——用户在界面上配的东西
不会被 `storage.clear()` 抹掉。

---

## 7. 多窗口语义

花笺是多窗口应用（主窗口 + 若干小窗 / 磁贴窗），**每个窗口各自加载一份插件运行时**。

| 能力                   | 行为                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| 插件内存状态           | **不共享**。开 3 个小窗就是 3 份实例                               |
| `api.editor`           | 只作用于**本窗口**的编辑器                                         |
| `api.ui.*` 注册项      | 在**每个窗口**各注册一份（命令、工具栏、菜单、面板、状态栏都如此） |
| `api.events`           | 窗口内事件；`editor:*` 只反映本窗口的活动笔记                      |
| `api.storage`          | 多窗口共享同一份文件，同一刻并发写是 **后写覆盖**                  |
| `api.workspace` 写操作 | 全局生效                                                           |

实践建议：把需要跨窗口一致的量放在 `api.storage` 里，并且只在明确的时点写
（例如 `onUnload` 或用户显式操作），避免在 `editor:contentChanged` 里高频写。

---

## 8. 从 v1 迁移到 v2

破坏性变更只有两条，但会影响几乎所有插件：

### (1) 所有 API 变成异步

v1 写 `api.getActiveNoteContent()`，v2 写 `await api.editor.getContent()`
或同步的 `api.editor.getContentSync()`。

方法名也变了，对照表：

| v1                                 | v2                                                     |
| ---------------------------------- | ------------------------------------------------------ |
| `addCommand({title, run})`         | `ui.registerCommand({id, title, run, keybinding?})`    |
| `getActiveNoteContent()`           | `editor.getContent()` / `editor.getContentSync()`      |
| `setActiveNoteContent(t)`          | `editor.setContent(t)`                                 |
| `getActiveNoteSelection()`         | `editor.getSelection()` / `editor.getSelectionSync()`  |
| `replaceActiveNoteSelection(t)`    | `editor.replaceSelection(t)`                           |
| `registerSelectionTransformer(fn)` | `editor.registerSelectionTransformer({id, transform})` |
| `registerStatusBarItem(fn)`        | `ui.registerStatusBarItem({id, render})`               |
| `registerPanel(def)`               | `ui.registerPanel(def)`                                |
| `scrollEditorTo(o)`                | `editor.scrollTo(o)`                                   |
| `scrollPreviewTo(o)`               | `editor.scrollPreviewTo(o)`                            |
| `showToast(m, t)`                  | `ui.showToast(m, t)`                                   |
| `listNotes()` / `getNote(id)`      | `workspace.listNotes()` / `workspace.getNote(id)`      |

### (2) `onClick` 收到的是描述符，不是 DOM 节点

```js
// v1
onClick(target) {
  const btn = target.closest(".outline-item");
  const index = Number(btn.getAttribute("data-index"));
}

// v2
onClick(ref) {
  const btn = ref.closestClass("outline-item");
  const index = Number(ref.data("index"));
}
```

### 还需要注意

- `floral.register` 不再需要传 `name`（以宿主下发的 `api.plugin` 为准）。
- 清单要加 `"apiVersion": 2` 与 `"permissions": [...]`。
- 返回 `Disposable` 不再是必须——宿主会在卸载时自动释放本插件的全部注册项；
  但你仍可用 `api.ui.dispose(id)` 提前撤销某一项。
- 可以（也应该）实现 `onUnload()` 做收尾；宿主会给它最多 5 秒。

完整的 v1 / v2 对照实现见仓库的 `example-plugins/`（v1）与 `example-plugins-v2/`（v2）。

---

## 9. 调试与排错

- **插件面板 → 日志**：Worker 里的 `console.*`、未捕获异常、以及宿主侧的加载错误
  都会汇总到这里。
- **状态徽标**：
  - `运行中` —— 正常；带 `沙箱` 标签表示是 v2。
  - `运行中（未沙箱）` —— v1 插件，跑在主线程。
  - `清单无效` —— `plugin.json` 解析失败、`apiVersion` 不受支持、入口不是 `.js`/`.mjs`。
    面板上会显示具体原因。注意**坏插件也会列出来**，不会被静默忽略。
  - `加载失败` —— `onLoad` 抛错或初始化超时。
- **权限被拒**：日志里会有 `拒绝越权调用 xxx：缺少权限 yyy`，同时插件侧会收到
  `code === "permissionDenied"` 的错误，`details.permission` 是缺的那个权限。
- **改了插件代码不生效**：在插件面板点「刷新」。刷新会整体重载，因此所有插件的
  内存状态都会重置。
- **超时**：读类调用 5 秒、磁盘类 15 秒、插件回调 10 秒。超时会让宿主终止该插件的
  Worker 并标记为失败。

### 沙箱的边界

Worker 隔离的是**宿主能力**：插件拿不到 `window`、`document`、Tauri 的
`__TAURI_INTERNALS__`，也无法直接读写文件系统。但请注意：

- Worker 里 `fetch` / `XMLHttpRequest` / `indexedDB` 仍然可用。沙箱限制的是插件
  对**花笺**的访问，不是对网络的访问。装插件前请自行审阅它的代码。
- v1 插件没有这些保障，它与宿主同权限。

---

## 10. 发布到插件市场

写好插件之后可以让用户从应用内的**插件市场**安装（右侧栏 → 插件 → 市场）。要点：

- **只收 `apiVersion >= 2`**：v1 跑在主线程、没有沙箱，来自网络的代码不能是 v1。
  清单层会筛一遍，安装时**再读一遍 zip 里的 `plugin.json` 复核**。
- **`plugin.json` 里的 `permissions` 会逐条列给用户看**，用户点了确认才装。之后插件想多要
  权限（更新一版多声明一个），应用会**重新列一遍**要求确认 —— 没确认过的权限不会生效。
  权限名请照 `src/features/plugins/permissions.ts` 里的词汇表写，拼错了只会被忽略。
- **zip 结构必须是「恰好一层顶层目录，名字等于插件名」**（`pdf-viewer/plugin.json`）。
- **版本号只从 `plugin.json` 读**，发布脚本不接受另外指定 —— 两处写版本号迟早会不一致，
  而不一致的后果是「装上去的版本和清单里写的不是一个」。
- `icon` 会被**内联进清单**（转成 data URL），所以用户还没装就能在市场上看到图标。
- **写一份 `README.md` 放在插件根目录**（`pdf-viewer/README.md` 那种）。用户在
  **插件列表**与**市场**里点「详细信息」打开的就是它 —— 那是你写给用户看的东西，比我们从
  清单里拼出来的准得多、也全得多。建议写清三件事：**怎么用**、**要了哪些权限干什么**、
  **还没做的**（免得用户以为是坏了）。
  发布时它会被**内联进清单**（上限 64KB，超了整条丢掉并在控制台提示），所以**还没装**的
  用户也看得到 —— 装之前总得让人知道这是个什么插件。不写也不会报错：插件列表那边会退回
  一份自动生成的（列出这个插件当下注册了哪些面板、命令、设置项），但那份说不出「为什么」。
- 发布用 `npm run plugin -- --dir <插件目录> --repo <插件仓库>`。

完整流程、清单格式与安全约定见 [`Docs/plugin-market.md`](./plugin-market.md)。
