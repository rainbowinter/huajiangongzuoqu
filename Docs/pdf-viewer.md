# PDF 阅读器插件

`example-plugins-v2/pdf-viewer/` —— 让 `.pdf` 在花笺里打开。第一版只做**读**：翻页、缩放、
适应宽度、Ctrl+滚轮缩放。马克笔与悬浮批注还没做（见文末）。

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
