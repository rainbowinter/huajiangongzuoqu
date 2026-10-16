# PDF 批注插件（`example-plugins-v2/pdf-annotations/`）

给 PDF 圈画、划重点、钉批注。**它不注册文件类型** —— 它用
[`api.files.extendView`](./plugin-api.md#扩展别人的视图apifilesextendview) 把自己并进
[`pdf-viewer`](./pdf-viewer.md) 那个视图里，顺带证明了一件本来只是设想的事：
**两个插件的代码可以共用一个沙箱帧**（各包一层 IIFE，靠 `globalThis.floralPdfView` 说话）。

```json
{ "requires": ["pdf-viewer"], "permissions": ["files:view", "workspace:cache"] }
```

## 这一层是怎么叠上去的

pdf-viewer 的视图里，一页是这样一个盒子：

```text
<.page>
  <canvas>        画出来的 PDF
  <.textLayer>    透明的文字（可选中、可搜索，z-index 1）
  <.anno-layer>   ← 批注层（z-index 2）
```

`z-index` 是**必须**的，不能靠 DOM 顺序：文字层是异步画的，有可能在批注层之后才追加。
批注层自己 `pointer-events: none` —— 那样文字才选得中、拖拽也才落得到页面上；
**只有「指针」模式下标注自己接管点击**（去点那个 × 删掉它）。

## 坐标一律存 PDF 的用户空间

这是整个插件里唯一真正要小心的地方。

屏幕坐标（页内像素）**会随缩放与旋转变化**：同一块高亮，100% 时在一处、200% 时在另一处，
转 90° 之后完全对不上。所以落盘的每一处几何都过一遍
`PageViewport.convertToPdfPoint`，显示时再用 `convertToViewportPoint` 换回来 ——
两个方向都由 pdf-viewer 通过 `globalThis.floralPdfView` 交出来：

```js
pdf.toPdf(页号, x, y); // 页内像素 → PDF 用户空间（存这个）
pdf.toPage(页号, x, y); // 反过来（画的时候用）
pdf.onPages((pages) => { ... }); // 页面（重新）建好了 —— 缩放、旋转、翻页都会来一次
```

实测过的往返：在 103% 下画一个 (80,120) 240×70 的框 → 转 90°（此时是 80%）变成
(486,62) 54×185（宽高换了个个儿，尺寸乘 0.8/1.03）→ 转回来仍在 (80,120) 240×70。

⚠️ 顺带一个坑：**自由笔的线宽也得这么算**。`toPage(72, 0)` 量的是「72 个 PDF 点在这个
缩放下有多长」，除以 72 才是「1 个点 = 几像素」。而且必须取**两点距离**（`Math.hypot`），
不能只看横坐标之差 —— 页面转 90° 时那个位移整个落到 y 上，只看 `[0]` 会得到 0，
线细成一根头发。

## 五种标注

| 工具 | 交互 | 存的是什么 |
|---|---|---|
| 指针 | 悬停已有标注冒出一个 ×，点它删掉 | —— |
| 矩形 / 圆形 | 按住拖一个框 | 一对角点的 PDF 坐标 |
| 自由笔 | 按住随便画 | 折线点列（取点间隔 2.5px，太密数据会白胖几十倍） |
| 文字选区 | 像在网页上那样划过去选中文字 | **每一行盒**一对角点，所以高亮贴着字走、不会圈住整块空白 |
| 图钉批注 | 点一下，弹框写字，回车保存 | 一个点 + 文字；鼠标移上去就能看到内容 |

颜色是四个色块（黄 / 绿 / 蓝 / 粉），高亮带透明度 —— 盖死了就没法读了。

文字选区靠的是 pdf-viewer 的**文字层**（`Docs/pdf-viewer.md` 里那层透明的 span）：
`selection.getRangeAt(i).getClientRects()` 一行一条矩形，逐行换算成 PDF 坐标。
所以这一版**必须**先有文字层，文字层做完「选中 / 搜索」也就顺带能做了。

## 存到哪

`floralView.extension("pdf-annotations")` 给的私有数据通道，落点是
**PDF 旁边**的 `__floral-notepaper__/pdf-annotations/<相对路径>.json`：

```text
E:\笔记\
├── 论文.pdf
└── __floral-notepaper__\pdf-annotations\论文.pdf.json
```

把 PDF 拷到别处、发给别人，标注跟着走；删掉那个文件夹就等于清空批注。机制本身见
[`Docs/workspace-cache.md`](./workspace-cache.md)。

存盘是**防抖**的（停手 400ms 才写）—— 拖拽时每一帧写一次盘太浪费。读回来的数据形状
未必还靠谱（用户手改过、别的版本写的），所以每条标注都要过一遍 `isSaneMark`，
坏的直接不要 —— 一条坏数据不该让整份批注都画不出来。

## 还没做

- **撤销 / 重做**：画错了只能删掉重画。
- **移动已有的标注**：现在只能删。
- **批注列表**：钉了十几个图钉之后，没有一栏把它们列出来。
- **导出**：不能把批注导出成图片或打印。
- **跨页选择**：`commitSelection` 其实按页分了组（跨页选中会分别落在各自的页上），
  但没测过滚动中跨页拖选的边界情况。

## 怎么验它

不用起应用 —— 原型在 `%TEMP%\pdfproto\`：`sync.mjs` 从仓库拷插件真文件（连写死的
`VIEW_PRELUDE` 都从 `viewBridge.ts` 里抽），`proto.html` 自己扮演宿主（读声明、拼 srcdoc、
画工具栏、转发消息）。里面带一个**帧内探针**：沙箱帧是 opaque origin，父页够不着它的 DOM，
所以「在页面上拖一下」「划一段字」这类动作只能由帧里的代码自己合成指针事件来完成。

```bash
cd "$TEMP/pdfproto" && node sync.mjs && node serve.mjs   # http://127.0.0.1:8099/proto.html
```

> 探针会把 `setPointerCapture` 换成空实现 —— 合成事件没有真的 pointer，原生实现会抛
> `NotFoundError` 把处理函数打断。**只有原型里有这一步**，真应用里用户是真的指针。
