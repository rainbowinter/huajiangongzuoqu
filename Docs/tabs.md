# 文档标签页

本期只做**标签条**，不做左右分屏。分屏需要把 `MainWindow` 的单文档引擎拆成两套，
单独排期。

## 唯一真源是 `selectedId`

活动文档仍然由 `selectedId` 表示（笔记 id 或外部文件绝对路径）。**没有第二个
`activeTabKey`** —— 保存路由、撤销栈、插件镜像、侧栏选中都读 `selectedId`，再存一份
活动标签只会在十几个入口之间不同步。

活动标签的键由它推导：

```ts
activeDocumentKey = docView
  ? openDocumentKey("doc", docView.key)
  : selectedId
    ? openDocumentKey(selectedExternalFile ? "file" : "note", selectedId)
    : null
```

只读说明文档显示时 `selectedId` 已经被清空（见下面的激活顺序），所以 `docView` 必须优先。

标签列表只存 `{ key, kind, id, fromWorkspace? }`（`features/tabs/openDocuments.ts`），
`kind` 有 `note` / `file` / `doc` 三种。标题在渲染时从 `notes` / 文件名 / `docTabsRef`
派生，不缓存。只读文档的正文单独放在 `docTabsRef`（`Map<文档键, {title, content}>`），
标签本身只存键。

## 打开与切换

所有入口都走 `openDocumentInTab(document, mode)`：

- `mode: "replace"`（默认）—— 顶掉当前活动标签；侧栏普通点击。
- `mode: "append"` —— 另开一格；Ctrl/⌘+点击、中键、右键「在新标签页中打开」。
- 已经在列表里：不再添加，直接 `activateDocument`。

`activateDocument` 把整段切换**串行**排进 `activationQueueRef`。这是必须的：
`saveCurrentNote` 是排队执行的，真正跑 `performSave` 时才读 `selectedIdRef`；两次快速
切换交错会让 A 的内容写进 B 的 id 下。

切换顺序（`performActivation`）：

1. 同标签：笔记 / 文件恢复滚动/光标；只读文档若正文被重新读取过就刷新 `docView`。
2. 把当前 buffer 记进 `tabBuffersRef`（内容、标题、保存状态、scrollTop、光标）——
   **只读文档跳过**，它的正文在 `docTabsRef` 里。
3. `saveCurrentNote()` —— **不要 force**！图片 / PDF 的 `content` 是空串，强制保存会
   把原文件写成空的。非 force 只在 dirty 时写。
4. 保存失败就**中止切换**，当前文档原样留着。
5. 目标是 `doc`：`clearCurrentNote()` 后从 `docTabsRef` 取出正文设进 `docView`，结束；
   目标是笔记 / 文件：`loadNote` / `loadExternalFile`，再恢复目标标签的滚动与光标。

## 关闭

- 关活动标签：先保存（同样非 force），失败就不关；然后激活右邻，没有就左邻。
- 关只读文档标签：同时从 `docTabsRef` 删掉正文（下次打开会重新读）。
- 关最后一个：`clearCurrentNote()`，回到空状态。
- 外部文件从侧栏「移除」：如果它是活动的，先清空再激活邻居 —— 否则切换时还会去保存
  一个已经摘掉的路径。
- 笔记被删除（本窗口或外部）：`notes-changed` 会把对应标签摘掉；活动笔记被删时先
  `clearCurrentNote()`，避免保存把它重新建出来。

## 单例桥接

`activeContent`、`pluginFileInfo`、`documentContextOf`、`styleFileKey`、`panelFileKey`
都继续只指向活动文档。标签切换结束前 `selectedIdRef` 已经更新，插件看到的就是新文档。

`tabBuffersRef` 只用于滚动/光标与保存失败的草稿；活动文档的真身仍是
`content/title/saveState` 与它们的 ref。

## 已知取舍

- 标签不持久化：重启回到第一篇笔记。
- 不限制标签数量；标签条横向滚动。
