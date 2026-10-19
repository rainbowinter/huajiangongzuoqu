# 工作区目录树

`src/components/WorkspaceTree.tsx` + `ExplorerItem.tsx`，偏好存在
`src/features/workspace/treePrefs.ts`。

## 状态放在哪

`WorkspaceTree` 在 `MainWindow` 里被 `key={activeExplorer}` 整个重挂，组件自己的 state
活不过切换。因此两类偏好放在 **localStorage**（本机浏览状态，不进 `AppConfig`）：

- `floral.workspace.expanded`：`Record<根路径, string[]>`，展开的绝对路径；
- `floral.workspace.displayMode`：`Record<根路径, "list" | "cards" | "icons">`。
  旧版本的两档 `"compact"` / `"details"` 读回来自动映射成 `"list"` / `"cards"`，
  见 `normalizeDisplayMode`。

恢复时用 `expandAncestors()` 补齐所有父目录 —— 只记 `a/b/c` 的话，`a` 没展开就永远
渲染不到 `c`。目录在两次运行之间被删掉时，`load()` 返回 `false`，该路径会从集合里
摘掉，不留下一条错误。

笔记分类的折叠状态在 `features/notes/categoryPrefs.ts`，存的是
`{ collapsed, known }`：`known` 用来让**新出现的分类默认折叠**。

## 三种显示方式

搜索框右边是「查看方式」下拉（`.workspace-view-button` / `.workspace-view-menu`），
每个工作区各记各的：

- `list`（列表）：`ExplorerItem` 的 `compact` 变体，一行「类型图标 + 标题」。
  图标用 `FileKindIcon`，颜色取自文件类型注册表，不再是 `PY` / `CSV` 文字徽章。
- `cards`（卡片，默认）：`ExplorerItem` 原样（日期 / 大小 / 正文预览）。
- `icons`（图标）：`renderIconLevel` **文件夹置顶、文件进网格**。每一层的文件夹仍然
  是一行一个（`ExplorerFolderRow` + `+` + 计数），只有文件画成
  `.explorer-icon-tile`；**图片类型直接用缩略图**（`convertFileSrc`，`loading="lazy"`），
  其余类型画 `FileKindIcon`。展开文件夹后，子层（同样是「文件夹行 + 文件网格」）排在
  那一行下方（`.workspace-icon-children`）。

⚠️ 查看方式下拉的「点别处收起」挂在 **mousedown** 上，不是 click：打开它的那一下
click 可能赶上 passive effect 同步冲刷，监听器会接住**同一个事件**，菜单刚出现就被收起
（用户看到的是「点不开」）。浮层是 portal 的，所以 `viewMenuRef.contains(target)` 也要
放过，否则点菜单项时 mousedown 先把菜单收掉、click 根本发不出来。

`FileKindIcon` 与标签页共用：标签条里笔记用 `note`，文件用
`matchFileType(extensionOf(path))?.kind`。

## 多选、框选与批量操作

- **Ctrl / Cmd + 点击**切换单项；**Shift + 点击**按当前可见顺序选一段
  （`flattenedVisible` 是按渲染顺序做的 DFS）。
- **空白处按住左键拖拽**开始框选（`.workspace-marquee`）。拖拽矩形与每个
  `[data-workspace-path]` 的行盒求交，命中的全选中。从滚动条上按下不算
  （右侧 18px 让给滑轨）。
- 目录树常常被条目铺满，找不到空白按下去，所以还有两条辅助路径：
  - **活动栏（左侧图标那条）与侧栏里目录树之外的空白**也能起手 —— document 级的
    mousedown 监听，命中 `.sidebar, .activity-bar` 且不是按钮/输入框/条目就开框选；
    在辅助区域「点一下不拖」**不会**清空已有选中。
  - 列表末尾留了 `pb-16` 的空白：滚到底就能从那里起手。
  - 两类起手共用 `beginMarquee`，只是 `clearOnClick` 不同（目录树空白 = 点击清空）。
- 右键：如果右键点的是已选中的一项，保留整组选中；否则把选中改成这一项。
  菜单里出现「已选 N 项」与批量动作。
- 批量动作都会先去掉「祖先已选中」的后代（`collapseSelectedPaths`）——
  一个文件夹已经包含整棵子树，再单独处理里面的文件会变成删两次 / 目标已存在。
- **删除**：`workspace_delete_entries`，确认框写清「文件夹会连同里面所有文件一起删」。
  后端拒绝删除工作区根。
- **复制**：`copyFilePaths` 写系统剪贴板（`CF_HDROP` + 路径文本）。
- **复制文件路径**：`writeText` 把每条路径换行拼接。
- **移动到…**：`WorkspaceFolderPicker` —— 一棵**逐级展开**的目录树，而不是平铺一长串
  相对路径。正在移动的目录及其子树会被禁用（不能移进自己）。成功后
  `onPathsMoved` 把打开中的标签 / 外部文件条目按前缀改写（移动文件夹时子树一起改），
  活动文档的 `selectedId` 也跟着换 —— 否则下一次保存会把文件写回旧位置。
- **删除**成功后 `onPathsRemoved` 关掉受影响的标签；活动标签**不走 `closeTab` 的保存**
  （那会把刚删掉的文件写回来），而是直接清空再激活邻居。
- 快捷键：`Delete` / `Backspace` 删除、`Ctrl+C` 复制文件、`Ctrl+V` 粘贴到焦点目录。
  输入框、编辑区与 `[role="dialog"]` 里的按键一律放过。
- 右键还有 **打开方式…**（`ShellExecuteW("openas")`）与 **属性**
  （`ShellExecuteExW` + `SEE_MASK_INVOKEIDLIST` + `"properties"`），见
  `src-tauri/src/system.rs`。

## 拖入与粘贴

- 系统拖入由 `MainWindow` 的 `onDragDropEvent` 统一接收。落点用
  `document.elementFromPoint(position / devicePixelRatio)` 判断：命中
  `.workspace-tree` 就交给 `dropOntoWorkspace(paths, targetDir)`（`dropBridge.ts`），
  不再走「当外部文件打开」那条路。
- 目录树注册一个 `setWorkspaceDropHandler`；`targetDir` 来自落点最近的
  `[data-workspace-drop]`（文件卡片给的是它的父目录），空白处为 `null`，由树回落到
  `focusedDir`。
- **拖入和粘贴都不会直接写盘**：先弹确认框「确定复制…到「目标」下吗」，确认后调
  `workspace_copy_entries`。文件夹会连同整棵子树复制。
- `Ctrl+V` 从系统剪贴板读文件列表（`clipboard_read_files`），目标同样是焦点目录。

## 新建 / 重命名

- `focusedDir`：新建的默认落点。选中文件时跟随它的父目录；点文件夹或 `+` 时改写。
- 每个文件夹行**悬停时**才显示 `+`（`.explorer-folder-add`，`opacity-0` +
  `group-hover:opacity-100`；键盘聚焦时也显示）。目录树很窄，每行常驻一颗「+」会把
  文件名挤短。点击后展开该目录并显示
  `ExplorerDraftRow`（`.explorer-draft-row`）。
- 新建：字符校验 → `matchFileType(extension)` 必须认领 → 同名检查 → 写空文件 → reload。
- 重命名：后端 `workspace_rename_entry`；只允许文件，不换目录；大小写改名经临时名中转。
  成功后如果这个文件正开着，`MainWindow.handlePathRenamed` 会同步 `externalFiles`、
  `selectedId`、标签键与缓存。
- **扩展名不被认领时报错，不创建也不改名**（用户明确选的规则）。所以没装 file-reader
  时，新建 `.txt` 也会被拒绝。

## 复制与拖出

- 右键「复制」→ `clipboard_copy_files`：Windows 写 `CF_HDROP` + 路径文本。详见
  `Docs/clipboard.md`。
- 拖出：`onDragStart` 里先 `preventDefault()`，再调 `@crabnebula/tauri-plugin-drag` 的
  `startDrag`。**不能靠 HTML5 拖拽** —— `dataTransfer` 到不了操作系统。
  拖动预览图是运行时画出来的 24×24 PNG data URL（`features/workspace/dragOut.ts`）。
- 文件夹行从「+」上按下时不要开始拖整个文件夹（`onDragStart` 里检查
  `closest(".explorer-folder-add")`）。

## 拖动侧栏宽度与图片缩略图

图片一多，拖侧栏边框会卡。现在**宽度和图片彻底解耦**：

1. **拖动过程不 setState**。`MainWindow` 的 resize effect 只把新宽度写进
   `.sidebar` / `.sidebar-inner` 的 `--sidebar-width`，并用 rAF 合并到每帧一次；
   React 完全不参与拖动时的重渲染。松手才 `setSidebarWidth(最终值)`，随后撤掉
   CSS 变量（先提交 state、再在下一帧移除，避免闪回旧宽度）。
2. **拖动时禁用 `transition-[width]`**。以前每帧都去追一个 300ms 的过渡，看起来
   像「跟不上鼠标」；收起/展开才需要那条过渡。
3. **拖动时图片缩略图换成类型图标**。`WorkspaceTree` 收到 `resizing` 后不挂
   `<img>`，只画 `FileKindIcon`；松手后再挂回去（走浏览器缓存）。于是拖动期间只
   排版缩略图占位，不再重采样几十上百张图片 —— 先跟手变宽，再渲染图片。

## 语义钩子

新增的钩子都在 `Docs/user/custom-css.md` 第 3 节：`.explorer-item.is-compact` /
`.is-multi-selected`、`.explorer-folder-toggle`、`.explorer-folder-add`、
`.explorer-draft*`、`.workspace-tree-toolbar` / `-scroll`、`.workspace-view-button` /
`-menu` / `-item`、`.explorer-icon-tile`、`.workspace-icon-grid` /
`-children`、`.workspace-marquee`、`.picker-row`。
改类名记得同时改那份清单 —— `semanticHooks.test.ts` 会逐条到源码里找。
