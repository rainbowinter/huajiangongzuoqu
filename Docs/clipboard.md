# 文件剪贴板与拖出

## 为什么不能只用 clipboard-manager

Tauri 的 clipboard-manager 插件只有文本 / HTML / 图片，没有「文件列表」。Windows 上
「复制一个文件」的本质是 `CF_HDROP` —— 资源管理器、Word、微信都认它。没有这层，从
花笺复制图片，粘到资源管理器只会得到一串路径。

## 写入什么

`src-tauri/src/clipboard.rs` 的 `clipboard_copy_files(paths)`：

1. `filter_authorized_paths`：每个路径 `canonicalize()` 后必须落在**已添加的工作文件夹**
   或**数据目录**内；文件夹也允许。
2. Windows 用 `clipboard-win`：
   - `formats::Unicode.write_clipboard(&text)` —— 会先 `EmptyClipboard()`；
   - `formats::FileList.write_clipboard(&paths)` —— 刻意**不清空**。
   - 顺序不能反，否则先写的文件列表会被后写的文本清掉。
3. 文本是每行一个绝对路径。粘回编辑器时，`useImagePaste` 先读文本：整段都是本地图片
   路径就插 `![](路径)`（并尽量还原成 `images/<noteId>/…` 相对路径）；不是才走老的
   「图片文件存进笔记」逻辑。

`clipboard-win 5.4.1` 本来就是 arboard 的传递依赖（在 `Cargo.lock` 里），加直接依赖
不会新增编译产物。

## 读回来：粘贴进工作区

`clipboard_read_files()` 用 `formats::FileList.read_clipboard(&mut Vec<PathBuf>)` 读
`CF_HDROP`；没有文件列表时退回读文本、按行拆成路径（有些程序只给文本）。

返回的绝对路径**来源可以在工作区之外** —— 从资源管理器复制任何文件都合法。真正的
写盘由 `workspace_copy_entries` 把关：**目标**必须在工作区根内，来源不限。

工作区树的 `Ctrl+V` 会先弹确认框（目标 = 焦点目录），确认后才复制。

## 拖出

用 `tauri-plugin-drag`（CrabNebula）在 Windows 上调 `DoDragDrop`：

```ts
await startDrag({ item: [absolutePath], icon: pngDataUrl });
```

- 必须在 `dragstart` 里先 `preventDefault()`，否则 WebView2 自己的 HTML5 拖拽会抢鼠标。
- 预览图用 `data:image/png;base64,…`；插件支持这个形式（`Image::Base64`），不必把
  二进制资源塞进仓库。
- capability 需要 `"drag:default"`；插件在 `lib.rs` 注册。

## 授权边界

复制与拖出都只接受工作区 / 数据目录内的路径。笔记图片在数据目录下，工作区文件在工作
文件夹下，两类都覆盖。外部任意路径的图片（不在 asset scope 里）本身也显示不出来。
