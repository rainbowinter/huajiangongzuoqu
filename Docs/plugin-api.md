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
  "permissions": ["ui:toast"]
}
```

`index.js`

```js
floral.register({
  onLoad(api) {
    api.ui.showToast("你好，花笺！", "info");
  },
});
```

放进目录后，在插件面板点「刷新」即可加载。

> 目录名就是插件的唯一标识。`plugin.json` 里的 `name` 只用于展示；两者不一致时
> 插件仍能加载，但面板上会提示。读取代码、定位数据一律以目录名为准。

---

## 2. 两代插件 API

| | `apiVersion: 1` | `apiVersion: 2` |
|---|---|---|
| 运行位置 | 主线程，`new Function` 执行 | 独立 Web Worker 沙箱 |
| 隔离 | **无**。能直接访问 `window`、Tauri IPC | 有。没有 `window`/`document`/宿主对象 |
| 权限 | 不适用（与宿主同权限） | 清单声明 + 默认拒绝 + 权限门 |
| 卡死风险 | 死循环会冻住整个界面 | 超时后宿主 `terminate()` 掉 Worker |
| API 形态 | 扁平 13 个方法 | 命名空间化，全部返回 Promise |
| 状态 | 兼容保留，**建议迁移** | 推荐 |

`apiVersion` 缺省为 `1`。宿主能运行的最高版本写在 `manifest` 里，声明更高的版本会被
判为「清单无效」并在面板上显示原因，而不是静默忽略。

**新插件请一律写 v2。**

---

## 3. 权限

v2 插件**默认没有任何权限**。清单里没声明的权限一律不生效，调用会被拒绝，
插件侧收到 `code === "permissionDenied"` 的错误。

| 权限 | 覆盖的能力 |
|---|---|
| `workspace:read` | `workspace.listNotes` / `getNote` / `getActiveNote` |
| `workspace:write` | 新建 / 更新 / 删除 / 移动分类 / `openNote`（蕴含 `workspace:read`） |
| `categories:read` / `categories:write` | 分类的列举与创建 |
| `editor:read` | 读正文、选区、光标；注册选区转换器 |
| `editor:write` | 插入、包裹、按范围替换、设选区、聚焦（蕴含 `editor:read`） |
| `ui:toast` | `ui.showToast` |
| `ui:panel` | `ui.registerPanel` |
| `ui:command` | `ui.registerCommand` |
| `ui:statusbar` | `ui.registerStatusBarItem` |
| `ui:menus` | 编辑器 / 笔记列表右键菜单项 |
| `ui:toolbar` | 工具栏按钮 |
| `ui:open-panel` | `ui.openPanel` |
| `events` | `events.on` |
| `storage` | `storage.*` |
| `settings` | `settings.get()` |
| `system:clipboard:read` | 读剪贴板 |
| `system:clipboard:write` | 写剪贴板（**不**蕴含读） |
| `system:open-external` | 用系统浏览器打开链接（仅 `http`/`https`/`mailto`） |
| `system:dialog` | 原生消息框 / 确认框，以及 prompt 模态 |

权限可以在插件面板里逐项撤销。撤销后插件不会立刻卸载，而是下一次调用该能力时失败；
重新加载后生效。

---

## 4. API 参考

所有方法都返回 `Promise`。`api` 对象可用命名空间：

### `api.plugin`

当前插件的静态信息（不需要权限）：`id`、`name`、`version`、`apiVersion`、
`permissions`、`grantedPermissions`、`locale`。

### `api.workspace` — 笔记

```js
await api.workspace.listNotes()                  // NoteMetadata[]
await api.workspace.getNote(id)                  // Note
await api.workspace.createNote({ title, content, category })
await api.workspace.updateNote(id, { title, content, category })
await api.workspace.deleteNote(id)
await api.workspace.moveNoteCategory(id, category)
await api.workspace.listCategories()
await api.workspace.createCategory(name)
await api.workspace.openNote(id)                 // 在主窗口打开
await api.workspace.getActiveNote()              // 本窗口当前笔记，可能为 null
```

### `api.editor` — 当前窗口的编辑器

```js
await api.editor.getContent()          // 全文
api.editor.getContentSync()            // 同上，但读镜像，同步、无往返
await api.editor.getSelection()        // { text, start, end } | null
api.editor.getSelectionSync()
await api.editor.getCursor()           // { line, column, offset }

await api.editor.setContent(text)
await api.editor.insertText(text)              // 光标处插入
await api.editor.insertText(text, "docEnd")    // 文末追加
await api.editor.wrapSelection("**", "**")     // 包裹选区；第二个参数省略时与第一个相同
await api.editor.replaceSelection(text)
await api.editor.replaceRange(start, end, text)
await api.editor.setSelection(start, end)
await api.editor.focus()

api.editor.scrollTo(offset)
api.editor.scrollPreviewTo(offset)
```

`getContentSync()` / `getSelectionSync()` 读的是宿主**节流推送的镜像**，因此：

- 它是同步的，适合在 `render()` 这类必须立即返回的地方用；
- 它可能有最多约 150ms 的延迟，写操作请用 `await` 的版本；
- 未获得 `editor:read` 时，镜像里不含正文。

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

api.ui.dispose(registrationId);     // 上面的方法都返回注册 id，可单独撤销
```

**键位优先级**：宿主内置的 Markdown 快捷键（Ctrl+B / Ctrl+I / Ctrl+\ 等）先处理，
插件键位只在其未处理时才介入。不要指望用插件覆盖内置键位。

### `api.events` — 事件

```js
const disposable = api.events.on("note:opened", (payload) => {
  console.log(payload.id);
});
disposable.dispose();
```

| 事件 | 载荷 |
|---|---|
| `workspace:ready` | — |
| `note:opened` | `{ id }` |
| `note:changed` | `{ id? }`（保存/新建/删除后由后端广播） |
| `editor:contentChanged` | `{ content }`（节流 ≥150ms） |
| `editor:selectionChanged` | `Selection \| null` |
| `config:changed` / `theme:changed` | `{ theme?, accentColor?, locale? }` |
| `window:focus` / `window:blur` | — |

### `api.storage` — 插件级持久化

```js
await api.storage.set("token", { a: 1 });
await api.storage.get("token", null);
await api.storage.delete("token");
await api.storage.keys();
await api.storage.clear();     // 只清 kv，不动用户在设置里配的值
```

数据落在 `<笔记数据目录>/plugin-data/<插件名>/kv.json`，与插件代码分开存放，
因此替换或升级插件目录不会丢数据。

### `api.settings` — 只读设置快照

```js
const values = await api.settings.get();   // { countMode: "chars", ... }
```

取值来自用户在设置面板里改的内容，默认值取自清单的 `contributes.settings`。
详见第 6 节。

### `api.system`

```js
await api.system.clipboard.read()
await api.system.clipboard.write("文本")
await api.system.openExternal("https://example.com")
await api.system.dialog.message("提示", { title: "标题" })
await api.system.dialog.confirm("确定吗？")
await api.system.dialog.prompt("输入点什么", { defaultValue: "默认值" })
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
    const button = ref.closestClass("item");     // 或 ref.closest(".item")
    if (!button) return;
    const index = Number(ref.data("index"));      // 等价于 dataset.index
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

⚠️ `closest()` **不是完整的 CSS 选择器引擎**，只支持：`tag`、`.class`、`#id`、
`[data-x]`、`[data-x="v"]`，以及 `tag.class` / `tag[data-x]` 这类两段组合。
不支持后代、子代、逗号分组。

**面板 HTML 会被宿主消毒**后再注入：`<script>`、`<iframe>`、`on*` 事件属性、
`javascript:` 协议等一律剔除。所以内联 `onclick="..."` 是无效的，请用 `onClick` 回调。

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

| 能力 | 行为 |
|---|---|
| 插件内存状态 | **不共享**。开 3 个小窗就是 3 份实例 |
| `api.editor` | 只作用于**本窗口**的编辑器 |
| `api.ui.*` 注册项 | 在**每个窗口**各注册一份（命令、工具栏、菜单、面板、状态栏都如此） |
| `api.events` | 窗口内事件；`editor:*` 只反映本窗口的活动笔记 |
| `api.storage` | 多窗口共享同一份文件，同一刻并发写是 **后写覆盖** |
| `api.workspace` 写操作 | 全局生效 |

实践建议：把需要跨窗口一致的量放在 `api.storage` 里，并且只在明确的时点写
（例如 `onUnload` 或用户显式操作），避免在 `editor:contentChanged` 里高频写。

---

## 8. 从 v1 迁移到 v2

破坏性变更只有两条，但会影响几乎所有插件：

### (1) 所有 API 变成异步

v1 写 `api.getActiveNoteContent()`，v2 写 `await api.editor.getContent()`
或同步的 `api.editor.getContentSync()`。

方法名也变了，对照表：

| v1 | v2 |
|---|---|
| `addCommand({title, run})` | `ui.registerCommand({id, title, run, keybinding?})` |
| `getActiveNoteContent()` | `editor.getContent()` / `editor.getContentSync()` |
| `setActiveNoteContent(t)` | `editor.setContent(t)` |
| `getActiveNoteSelection()` | `editor.getSelection()` / `editor.getSelectionSync()` |
| `replaceActiveNoteSelection(t)` | `editor.replaceSelection(t)` |
| `registerSelectionTransformer(fn)` | `editor.registerSelectionTransformer({id, transform})` |
| `registerStatusBarItem(fn)` | `ui.registerStatusBarItem({id, render})` |
| `registerPanel(def)` | `ui.registerPanel(def)` |
| `scrollEditorTo(o)` | `editor.scrollTo(o)` |
| `scrollPreviewTo(o)` | `editor.scrollPreviewTo(o)` |
| `showToast(m, t)` | `ui.showToast(m, t)` |
| `listNotes()` / `getNote(id)` | `workspace.listNotes()` / `workspace.getNote(id)` |

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
