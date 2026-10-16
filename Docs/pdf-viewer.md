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

### ❗`buildPages()` 必须防重入（踩过一次，症状很怪）

它是**一长串 `await`**（每页一次 `getPage`），而调用它的 `zoomBy` 是**不排队**的 ——
Ctrl+滚轮每一格、工具栏每点一下都是 `void zoomBy(...)`。前一次还没跑完，后一次就进来了。

两轮交错时，各自都会**从头到尾建一整套** `.page` 元素，于是同一个 `data-index`
出现好几份。接下来两件事合起来，就是用户报的那个现象：

- `paint(index)` 用 `scroller.querySelector('.page[data-index=…]')` 取**第一个**匹配 ——
  多出来的那些永远轮不到被画，它们的「…」占位符一直挂着 ⇒ **「第二页是空白的」**；
- `notifyPages()` 是 `querySelectorAll('.page')`，会把**每一份**都报给扩展插件 ——
  批注插件于是也给空白那份建了层、填上同一页的标注 ⇒
  **「第二页多了一份第一页的标注」**。

判据用现成的 `state.generation`（`paint` 一直在用它挡陈旧绘制）：这一轮开始时领一个号，
**每次 `await` 醒来都对一次**，对不上立刻返回。领号是同步的、检查也在同步段里，
所以陈旧那一轮不可能在新一轮清空 DOM **之后**再塞东西进去。

实测（原型 `proto.html` 的「数页面（连打 6 次放大）」按钮，14 页文档）：

| | `.page` 元素 | 重复的 index | 永远画不到的页 |
| --- | --- | --- | --- |
| 修复前 | **84** | 每个页码各 6 份 | 83 |
| 修复后 | **14** | 无 | 0 |

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

## 文字层：为什么画布上还要再叠一层

画布上的字是**画出来的图形** —— 选不中、复制不了，也答不出「这一点落在第几行第几个字」。
所以每一页在画完 canvas 之后还会叠一层 pdf.js 的 **`TextLayer`**：按页面里真实的文字位置
摆出一堆 span，文字本身是透明的（看到的仍然是 canvas），于是**选中、复制、按文字选区做
高亮**都有了着力点。

三个坑（`viewer.js` 的 `attachTextLayer` 里都有注释）：

* **`--scale-factor` 必须在构造之前设好**。构造函数就要读它算容器尺寸，而每个 span 的字号是
  `calc(var(--scale-factor) * …px)`；忘了设的话整层字号全是默认值，选中的位置偏得离谱。
* 传给它的 **viewport 不要乘 `devicePixelRatio`**：canvas 为了高清才乘，而 `TextLayer`
  内部自己会乘（它要按真实设备像素量字宽），乘两遍就错。
* `render()` **直接返回 Promise**（不是 `{ promise }`）。失败只记一条日志 —— 最坏是这页
  选不中字，画出来的内容该照旧。

**JS 不用另外取**：`TextLayer` 类本来就在主包（`pdf.global.mjs`）的导出里。
**但样式一条都没有** —— 核心构建不带 `pdf_viewer.css`，所以 `npm run pdfjs` 会从那份
100KB 的官方样式里**只挑 `.textLayer` 开头的顶层规则**（约 2.3KB）生成
`vendor/text-layer.css`。整份取回来没意义：里面还有 `url(images/*.svg)` 这类引用，
而沙箱帧取不到任何外部资源。

## 配色跟着应用主题走

视图是独立文档，拿不到宿主的 CSS 变量，所以宿主把调色板**解析后的值**递进来：
`init` 里带一份，之后每次换主题再发一条 `{ t: "theme", … }`（**不能**复用 `init` ——
那个在插件这边意味着「重开文档」）。查看器把 `--color-paper-warm` 接到自己的 `--bg`、
`--color-ink` 接到 `--ink`，以此类推。

`viewer.css` 里那两套 `:root` 值是**回退**：万一没拿到 token，颜色不会掉回浏览器默认
（深色主题里突然一块白底格外刺眼）。用户在样式目录里改过时也照旧生效 ——
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

## 工具栏图标

那一排按钮的图标是**插件自带**的（`icons/*.svg`），宿主读成文本、消毒后内联进按钮里 ——
所以它们跟着主题色走（SVG 里写的是 `currentColor`），深浅色不用各画一套。实测过：
外壳 SVG 里塞 `<script>` / `onload` / `foreignObject` / `<style>` / 外链 `href`，
消毒之后一个都留不下，而形状与 `currentColor` 原样保留（见 `sanitizeSvg.ts`）。

## 现在还没做的

* **马克笔与悬浮批注**：**做成另一个插件了**（`pdf-annotations`，见
  [`Docs/pdf-annotations.md`](./pdf-annotations.md)）—— 它用 `files.extendView` 并进这个
  视图，数据存在 PDF 旁边的 `__floral-notepaper__/` 里（不是本文档原先设想的应用数据目录：
  那样批注会锁在这台机器上）。这个插件只负责把坐标换算的口子
  （`globalThis.floralPdfView`）交出去。
* **cMaps 与标准字体**：pdf.js 遇到日韩编码或非内置字体时会去取
  `cMapUrl` / `standardFontDataUrl` 指向的文件，而视图取不到外部资源 —— 那些字会缺。
  要支持的话得把这几份数据也内联进来（它们是几百 KB 到几 MB），等真遇到问题再说。
* **搜索**：文字层（见下）已经把「页面上哪一块是哪个字」这件事交出来了，但还没做查找框。
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
