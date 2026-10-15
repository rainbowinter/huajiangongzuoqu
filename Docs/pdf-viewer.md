# PDF 阅读器插件

`example-plugins-v2/pdf-viewer/` —— 让 `.pdf` 在花笺里打开。第一版只做**读**：翻页、缩放、
适应宽度、**跳页**、**单页 / 连续**、**旋转**、Ctrl+滚轮缩放。马克笔与悬浮批注还没做（见文末）。

## 它是怎么跑起来的

```text
侧栏认出 .pdf（插件登记的扩展名规则）
   → 宿主把 view/index.html + viewer.css + pdf.js + worker 源码**读成文本**，拼成 srcdoc
   → 塞进 sandbox="allow-scripts" 的 iframe（opaque origin）
   → 视图问宿主要字节：floralView.requestDocument()
   → 宿主从工作区（或外部文件）读出**二进制**递过去（ArrayBuffer）
   → 视图里 pdf.js 把每页画成 canvas
```

插件**不碰文件系统**：目录里有哪些文件、内容是什么，全由宿主读好递过来。

## 顶上那排控件为什么由宿主画

缩放、页码、跳转、单页/连续、旋转 —— 这些按钮**不在视图里**，是宿主按插件声明的
`view.toolbar` 渲染在预览区顶上的（跟 Markdown 那排格式化按钮同一个位置、同一套样式）。

* 视图是沙箱里的一块孤岛，自己在里面画工具栏，跟窗口的排版（分栏、标题栏、以后的改动）
  永远对不齐；
* 工具栏得**点得动**：塞在视图里的话，页面刚打开那几秒 pdf.js 还没解析完，按钮根本不存在。
  交给宿主画，进页面就能点，宿主还会把这几秒里的点击**排队**，等视图 ready 之后补发。

文件名**不在这排控件里** —— 标题栏已经写着它了，再画一遍就是重复。

交互只有两条消息（细节见 [`Docs/plugin-api.md`](./plugin-api.md) 的「顶上那排控件交给宿主画」）：
宿主点了发 `command` 进来，视图用 `setState` 把当前状态报回去。所以这个查看器里
**没有任何按钮、没有绑定任何 click**，只有一个 `handleCommand` 的 switch。

## 配色跟着应用主题走

视图是独立文档，拿不到宿主的 CSS 变量，所以宿主把调色板**解析后的值**递进来：
`init` 里带一份，之后每次换主题再发一条 `{ t: "theme", … }`（**不能**复用 `init` ——
那个在插件这边意味着「重开文档」）。查看器把 `--color-paper-warm` 接到自己的 `--bg`、
`--color-ink` 接到 `--ink`，以此类推。

`viewer.css` 里那两套 `:root` 值是**回退**：万一没拿到 token，颜色不会掉回浏览器默认
（深色主题里突然一块白底格外刺眼）。用户自定义过 `src/styles/custom.css` 时也照旧生效 ——
宿主读的就是**解析后**的值。

## 为什么 pdf.js 不在仓库里

那两个文件加起来 1.7MB，而**安装包里不该有它们**（用户定过：等插件市场通了从市场装）。
所以：

* 仓库里不放 —— `example-plugins-v2/pdf-viewer/vendor/` 已在 `.gitignore` 里；
* 用脚本按**钉死的版本 + sha256** 取：`npm run pdfjs`（见 `scripts/fetch-pdfjs.mjs`）；
* 发布这个插件时（`npm run plugin -- --dir example-plugins-v2/pdf-viewer …`）会连着
  `vendor/` 一起打进 zip —— 495KB，用户从市场装的时候一次性拿到。

版本或哈希对不上时脚本会**停下来报错**：要么版本号写错了，要么上游重发了同一个版本号，
两种都该先人看一眼。

## 为什么要动 pdf.js 的产物一处

插件的 js 是**全部拼进同一个内联 module** 的（这样它们共享一个模块作用域）。而 pdf.js 的
压缩包用的是 `export{Ut as getDocument,…}` —— 那些别名只对「导出名」成立，模块里的真实
绑定名是压缩过的，后面拼进来的代码拿不到 `getDocument` 这种名字。

好在压缩包完全自包含（实测 0 条 import），末尾只有一条 export，所以取文件的时候机械地
把它换成：

```js
globalThis.pdfjsLib = { getDocument: Ut, GlobalWorkerOptions: Jt, … };
```

插件的查看器代码因此只依赖 `globalThis.pdfjsLib`，不依赖任何模块作用域里的名字。
`fetch-pdfjs.mjs` 里配了三条断言（不许出现 import、export 恰好一条、export 之后没有别的东西），
不变量一旦不成立就直接停下来报错，不硬凑。

## 为什么 worker 要绕一圈

视图帧是 opaque origin（沙箱标志让它**永久**如此），`new Worker(<外部地址>)` 会被 CORS 挡掉；
**`new Worker(blob:)` 可以**（实测，见 `Docs/plugin-view-sandbox.md`）。所以：

1. 插件在 `view.worker` 里声明 worker 的**源码文件**；
2. 宿主把它塞进 `<script type="text/plain" id="floral-worker-src">`（不执行，只当文本）；
3. 查看器读 `textContent` 做成 blob，交给 pdf.js（它自己会带 `{ type: "module" }`）。

读不到 worker 源码时 pdf.js 会退回主线程渲染（大文件会卡界面），所以那种情况下记一条
warn 日志。

## 现在还没做的

* **马克笔与悬浮批注**：需要先给插件体系加「批注存储」这条通道
  （`PluginView` 里的 `loadAnnotations` / `saveAnnotations` 现在还是空实现）。
  批注会存**应用数据目录**，不写进 PDF 本身。
* **cMaps 与标准字体**：pdf.js 遇到日韩编码或非内置字体时会去取
  `cMapUrl` / `standardFontDataUrl` 指向的文件，而视图取不到外部资源 —— 那些字会缺。
  要支持的话得把这几份数据也内联进来（它们是几百 KB 到几 MB），等真遇到问题再说。
* **文本层**（选中、搜索）：pdf.js 的 `TextLayer` 要额外的 CSS 与 DOM 层，属于下一步。
* **加密文档**：能识别出来并显示"打不开"，但不会提示输密码。
* **`goto` 只认页码**，不认「第 3 节的图 2」这种文本定位。

## 试一下

```bash
npm run pdfjs                                     # 取 pdf.js（首次）
node scripts/market-sandbox.mjs                   # 让市场里有这个插件
npm run dev:isolated -- --config .devdata/market-override.json
```

然后 插件面板 → 市场 → 装 `pdf-viewer`，之后打开任意 PDF（侧栏的工作文件夹里点，
或者「打开文件」选一个）。

开发这个查看器时**不用每次都起应用**：`view/` 那三个文件是纯前端，可以在浏览器里直接调
（`docs/plugin-view-sandbox.md` 里那套办法：把几份文件按 `buildViewDocument` 的规则拼成一个
HTML，自己扮演宿主应答 `requestDocument`）。改动集中在那三个文件时这条路快得多。
