# 排版差分发现（首轮，2026-10）

被测：`office-viewer` 的 `src/docx/parse.js` + `src/layout/*`（M2/M3 第一版）。
基准：WPS Office 12.1.0.29161 对同一份 `.docx` 导出的 PDF。
方法：去掉空白后逐字符对齐 → 比断行点/分页点/行首 x/同段行距。
全部数字可在 `out/results.json`、`out/calibration.md`、`out/report.html` 复现。

## 总览

首轮结果（修复前）：

| 维度 | 结果 |
|---|---|
| 文本（去空白） | **28/28 用例编辑距离 = 0** |
| 断行点 | **27/28 完全一致**（唯一失败 P06 为空行问题） |
| 分页点 | **28/28 完全一致**（P01/P05/P06 页数都对） |
| 行首 x（缩进/对齐） | 27/28 偏差 ≤ 0.05pt；B08 差 0.96pt |
| 行距 | **10/28 超出容差**；但所有用例都存在 +6.8% 的系统性偏差 |

> 结论：**"断行/禁则/分页"这套核心规则已经和 WPS 对齐**；剩下的差距几乎全部
> 集中在"行高从哪来"这一件事上。这是当前最值得投入的修复点。

## 修复后（2026-10）

F1–F5 全部落地，**渲染 28/28 通过**，最大行距余量 0.74pt（C05）：

| 编号 | 修法 | 验证 |
|---|---|---|
| F1 | 中文字体按 `out/calibration.md` 查表取行高/ascent；行高取该行实际字体的最大值 | C01–C06、B01–B08 |
| F2 | 行对象新增 `baseline`：exact 取 `0.8×height`，atLeast 底边对齐，auto 用 ascent；网格多倍行距把多余高度加在基线上方 | S01–S03、P02–P04 |
| F3 | 上下标宽度按 65% 字号，纵向按原字号；基线 +33% / −14%；空白原子不参与基线定位 | C05 |
| F4 | 控制符产生的空 segment 不生成 line；分页符只标在前后行上 | P06 |
| F5 | 左右缩进的字符单位按段落默认字号折算，首行/悬挂按首个 run 字号 | B07、B08 |
| 附加 | 相邻段落的段前/段后取较大者（不叠加）；页首保留段前距；`w:docGrid/@type` 无命名空间也能读到 | S03、G02 |

---

## F1（最严重）单倍行高系统性偏小 6.8%，40 行必出一行偏差

**现象**：C01，宋体 10.5pt，单倍行距：

| | WPS | 插件 | 差 |
|---|---|---|---|
| 相邻 baseline 差 | 13.56pt | 12.63pt | **−0.93pt（−6.8%）** |
| 首行 baseline（页顶+72pt 起） | 82.49pt | 81.00pt | −1.49pt |

单看一行只差 1pt，但它是**线性累积**的：40 行后差 37pt，超过一行高度，
分页点就会提前/延后一页。P01 目前 2 页对 2 页只是"恰好没跨过边界"。

**根因**（`src/layout/measure.js`）：

```js
const measured = ctx.measureText("国Ag");
const ascent  = measured.fontBoundingBoxAscent  || size * 0.82;
const descent = measured.fontBoundingBoxDescent || size * 0.22;
lineHeight = ascent + descent;
```

* Chrome/WebView2 对宋体报 `fontBoundingBox = 0.952em`（10.5pt → 10.0px），
  而字体文件 `simsun.ttc` 的 hhea/typo 是 **1.1406em**，WPS 实际用的是 1.43–1.49em。
* `fontMetrics(style, false, ...)` 固定传 `isCJK = false`，即用**西文字体栈**量中文行高。
* `lineHeightFor()` 只取 `paragraph.defaultStyle`，**不看行内实际 run 的字体/字号**；
  一行里最大字号是 18pt 时仍按段落默认的 10.5pt 算。

**实测校准表**（`out/calibration.md`，从 WPS PDF 反推）：

| 字体 | 字号 | WPS 单倍行距 | 行距/字号 |
|---|---|---|---|
| 宋体 | 10.5 | 15.60pt* | 1.486 |
| 宋体 | 12 | 17.16pt | 1.430 |
| 宋体 | 14 | 20.04pt | 1.431 |
| 宋体 | 16 | 23.34pt | 1.459 |
| 宋体 | 18 | 26.34pt | 1.463 |
| 微软雅黑 | 10.5 | 20.76pt | 1.977 |
| 黑体 | 10.5 | 15.72pt | 1.497 |
| 仿宋 | 10.5 | 15.60pt | 1.486 |
| 楷体 | 10.5 | 15.72pt | 1.497 |

\* 10.5pt 宋体在无网格文档里表现为 **15.6pt**（与 Word 中文默认网格 312 twip 一致），
12pt 以上才按 1.43em 线性增长。

**首行 baseline**：WPS 在 10.5pt 宋体下 = 页顶 + 上边距 + **1.0em**（10.49pt），
9pt 时也是 1.0em。插件当前是 0.857em（12px），所以固定差 −1.49pt。

**建议修法**（按优先级）：

1. `fontMetrics` 改为读字体文件真实度量（`OS/2.sTypoAscender/Descender/LineGap`
   或 `hhea`），并按 `unitsPerEm` 归一；不要用 Canvas 的 `fontBoundingBox*`。
2. `lineHeightFor()` 改为取**该行所有 atom 的 max(lineHeight)**，而不是段落默认样式。
3. 中文单倍行距对 10.5pt 有 15.6pt 下限（文档网格默认 pitch），可作为常量表兜底。
4. ascent 用「1.0em」还是「typoAscender」需要再用 9/12/18pt 三档验证；
   现有数据支持 1.0em。

---

## F2 固定值 / 最小值行距：行盒定位差 5pt

**现象**：S02，`w:line=20pt lineRule=exact`：

* WPS 首行 baseline 在 88.01pt（页顶 72 + 16.01）
* 插件 baseline 在 81.00pt（页顶 72 + 9.00）
* 差 **−7.01pt**；`atLeast 24pt` 时行距 24.96 vs 24.00。

**根因**：`lines.js` 把 `height` 设成固定值，但渲染/DOM 里 `line-height = height`、
文字按字体 ascent 贴顶；Word 是把**行盒的基线**放在固定值的某个比例上
（实测约 0.8×固定值），多出来的空间在上方。

**建议**：`exact` 时显式算 `baselineInLine = min(ascent, height - descent)`，
并把行盒 top 调整为 `lineTop + (height - ascent - descent)` 的网格对齐版本；
不要依赖 CSS `line-height` 的默认垂直居中。

---

## F3 上下标：基线偏移和行高贡献与 WPS 不同

**现象**：C05，同样的两段文字，WPS 行距 19.92pt，插件 14.66pt；首行 baseline
反而高 1.87pt。文本与 x 完全一致，纯粹是纵向度量。

**根因**：`atoms.js` 的 `scaledStyle` 只把字号乘 0.65，没有：
* 抬升/压低 baseline（Word 上标约 +33% 字号，下标约 −14%）；
* 让上下标所在行按"未缩放字号"计算行高（Word 仍按原字号撑行）。

**建议**：atom 增加 `baselineShift`；`lineHeightFor` 用 `atom.size`（原始字号）
而非缩放后的 `sizeFactor` 参与 max。

---

## F4 分页符产生幽灵空行

**现象**：P06，WPS 2 行 / 插件 4 行。插件在分页符前后各多出一个空 line
（`text === ""`），导致 `line_breaks_equal` 失败、页内行号错位。

**根因**：`layoutParagraph` 把 `w:br type="page"` 切段后，段尾的空 segment
仍生成 `makeLine([])`；文档以分页符结尾时尤其明显。

**建议**：段尾（最后一 segment）为空且由控制符产生时，不要 push 空 line；
保留 caret 所需的 fallback 即可。另加一条单测：`pageBreak` 在段首/段中/段尾
三种位置的 line 数。

---

## F5 firstLineChars 折算差 0.96pt

**现象**：B08，左右缩进 2 字符 + 10.5pt，行首 x 差 0.96pt（WPS 90.00 / 插件 90.96）。

**根因**：`indentPx()` 用 `(chars/100) * charWidth`，`charWidth = 字号 px`；
Word 对字符单位缩进按**文档网格的字符宽度**折算（或对 0.5pt 取整），不是简单乘字号。

**建议**：优先使用 `w:ind w:left` 的 twip 值；只有 `*Chars` 时才折算，
并按 0.5pt 取整对齐 Word 的 `twips` 粒度。

---

## 表格（T / TB）

PDF 文本层会把同一表格行里的多个单元格按包围盒重合成一条视觉行，而插件侧每个
单元格各是一行，所以表格不能沿用“行号逐条对齐”。`compare.py` 的表格分支改为：
每个插件行的首字符映射到 WPS 的同一个字符，再比该字符的 x / baseline；容差放宽到
x ≤ 8pt、y ≤ 2pt（列宽按 tblW 缩放、单元格内边距取整与 WPS 有几 pt 差）。

已对齐：

* `TB1` 合并单元格（`gridSpan` / `vMerge` / 行高 atLeast / 底纹 / 垂直居中）
* `TB2` 不等列宽 + 表头加粗 + 数字右对齐

已知未对齐：

* `TB3` 跨页表格：表头重复与分页点已经对齐（单元格行高补 0.48pt 的表格行距）。
* `T04` 嵌套表格：先按行拍平成文本，只保证不丢字，没有嵌套网格。

表格的单元格段落额外把**段落标记**的字体度量并进行高/基线（内容只有数字时，
Word 的基线仍按正文宋体落，不按 Times 的 ascent）。

## 编辑用例（E01–E10）

`tools/replay_edit.py` 直接调用插件的 `src/edit/operations.js` 重放 manifest
里的操作，不打 UI。当前 **10/10 通过**，覆盖：输入法插入、回车分段（保留
`firstLineChars` / `line`，不复制 `sectPr`）、段首/段尾合并、Shift+Enter、
跨 run 删除、撤销重做、列表项退格、空列表项回车、多行粘贴。

首轮跑的时候发现夹具生成器有三处“写了规格但没生成”的问题，已修：

* E02 的 `ppr`（首行缩进 / 行距）没写进段落；
* E06 的 `runs` 被当成两个段落，实际应是一段两个 run；
* E08/E09 的 `{"list": "decimal"}` 被忽略，夹具是普通段落。

修完后两处列表用例的结果与 `expect` 完全一致：E08 第一段丢 `numPr`、第二段
重排为 `1.`；E09 空项保留 `numPr`、新项同 `numId`。

---

## 已确认"对齐"的部分（可以作为回归基线）

| 用例 | 结论 |
|---|---|
| B01 超长中文断行 | 6 行，断点逐字一致 |
| B02/B03 行首/行尾禁则 | 4 行，禁则位置完全一致 |
| B04 中英混排 + 数字单位 | 文本、断行一致（空白差异已归一） |
| B05 超长西文拆字 | 4 行，拆字点一致 |
| B06 Tab + 段内软换行 | 5 行，tab 跳位与软换行一致 |
| B07 首行缩进 2 字符 | 缩进 0.04pt 内，仅行高受 F1 影响 |
| A01 五种对齐 | 居中/右对齐起点差 ≤ 0.05pt（修掉 line.x 漏加偏移后） |
| A02 两端对齐 + 软换行 | 拉伸与末行不对齐都一致 |
| P01–P05 分页 | 页数、页边界字符下标全部一致 |
| L01 A5 窄边距 | 8 行，断行点一致 |

---

## 复现

```bash
python tools/run_all.py
# 然后看 out/report.html、out/calibration.md、out/font-metrics.json
```

单条用例：

```bash
python tools/run_all.py --skip-build --only C01
```
