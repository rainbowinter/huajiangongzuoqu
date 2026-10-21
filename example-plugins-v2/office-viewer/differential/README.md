# office-viewer 差分验收包（WPS / Word 对照）

目标是回答一个问题：

> 同一个 `.docx`，WPS 排出来是什么样，office-viewer 排出来是不是**一样**？
> 同一套操作，WPS 存出来的文档是什么样，office-viewer 存出来是不是**一样**？

不是"看起来差不多"，而是可判定的四条：

| # | 判定项 | 口径 |
|---|---|---|
| 1 | 文本 | 去掉空白后逐字符对齐，**编辑距离必须为 0**（丢字/多字/乱序都会暴露） |
| 2 | 断行 | 每一行第一个字符在全文中的下标**必须完全相同**（禁则、词边界） |
| 3 | 分页 | 每一页第一个字符的下标**必须完全相同** |
| 4 | 几何 | 行首 x 偏差 ≤ 0.75pt；首行 baseline 偏差 ≤ 1.5pt；同段行距偏差 ≤ 2pt 且 ≤ 3% |

行距用"同段内相邻 baseline 差"衡量，跨段/跨页的 gap 不计入（那里含段前段后距）。

---

## 双会话协作

两个会话（实现 / 验收）通过一份共享台账协作，不需要人传话：

* **`COORDINATION.md`** —— 角色、轮次、交接、等待规则
* **`coordination/STATE.json`** —— 当前轮次、谁在干活、下一步
* **`coordination/MESSAGES.jsonl`** —— 交接消息（追加）
* **`coordination/TESTS.jsonl`** —— 每次测试结果（追加）

```bash
python tools/coordinate.py status                 # 看当前状态
python tools/coordinate.py claim  --as impl       # 接手
python tools/coordinate.py handoff --from impl --to verify \
  --status ready_for_test --next "跑协议"
python tools/coordinate.py wait --for verify      # 等对方交棒（默认 24h）
python tools/coordinate.py log --tail 10          # 看最近消息与结果
python tools/coordinate.py log --follow           # 持续跟
```

**第一批（first-batch）门槛**：排版 31/31、编辑 10/10、双端操作 22/22。
全绿之前不进入表格编辑 / 撤销 / IME。

---

## 三层验收（缺一不可）

| 层 | 回答的问题 | 入口 | 现状 |
|---|---|---|---|
| **排版差分** | 同一份 docx，WPS 和插件排出来一样吗 | `tools/run_all.py` → `out/report.html` | 28/32 |
| **单端编辑** | 模型层的操作对不对 | `tools/replay_edit.py` → `out/edit-results.json` | 6/10 |
| **双端操作差分** | 同一套输入，两边行为一样吗 | `tools/run_ops.py` → `out/ops-report.html` | 已跑通，O01 发现差异 |

双端操作差分的说明见 `OPERATION-DIFFERENTIAL.md`，首轮发现见 `OPS-FINDINGS.md`。

### 双端操作差分怎么跑

```bash
# 全部 ops/*.json（WPS 走 COM，插件走 replayEdit）
python tools/run_ops.py

# 单条
python tools/run_ops.py O01 --no-build
```

产物：`out/<id>.wps-ops.json`、`out/<id>.plugin-ops.json`、
`out/ops-results.json`、`out/ops-report.html`。

注意：WPS COM 是串行的，不要并发跑多份；脚本会自己起停 WPS 实例。

---

## 跑起来

> **两个会话共用 `TEST-PROTOCOL.md`。** 日常回归只用
> `python tools/run_protocol.py`（不生成夹具、不导出 PDF）；
> 刷新 WPS oracle 或改夹具时才走下面的完整流水线。

前提：本机装有 WPS（`KWPS.Application` 可创建）、Edge、Node、Python 3.11。

```bash
# 统一协议：排版 + 单端编辑 + 双端操作
python tools/run_protocol.py

# 一条龙：生成夹具 -> WPS 导出 PDF -> PDF 指纹 -> 插件排版指纹 -> 比较 -> 报告
python tools/run_all.py

# 只重跑对照（夹具没变）
python tools/run_all.py --skip-build

# 只跑某几个用例
python tools/run_all.py --skip-build --only C01 B02
```

产物都在 `out/`：

| 文件 | 内容 |
|---|---|
| `out/report.html` | **主报告**：通过率、失败根因聚类、逐用例几何明细 |
| `out/results.json` | 机器可读结果，可直接喂给 CI |
| `out/<id>.wps.json` | WPS 侧指纹（每行文字、x、baseline、字号、字体） |
| `out/<id>.plugin.json` | 插件侧指纹（每行文字、x、baseline、行高、原子宽度） |
| `out/calibration.md` | 从 WPS PDF 反推的行高校准表 |
| `out/font-metrics.json` | Canvas / 字体文件 / WPS 三方度量对照 |
| `out/edit-results.json` | **编辑用例**（E01–E10）逐条结果 |
| `out/<id>.edit.json` | 编辑重放后的模型数据（文本、numPr、run、document.xml） |
| `ref/<id>.pdf` | WPS 导出的基准 PDF（可直接肉眼比对） |

> Windows 上如果 `.ps1` 被执行策略拦住，`run_all.py` 已经用
> `powershell -ExecutionPolicy Bypass -File` 包了一层，直接跑 Python 即可。

---

## 目录

```
differential/
  tools/
    build_fixtures.py    # 夹具生成器（python-docx + 原始 OOXML）
    make_reference.ps1   # WPS 打开 -> 导出 PDF + 页数/段落数
    pdf_fingerprint.py   # PDF -> 字符坐标 -> 行指纹
    layout-entry.js      # 把 parse.js + layout/ 打成独立模块的入口
    build_layout.mjs     # rolldown 打包
    harness.html         # headless Edge 里的排版测试台
    run_layout.py        # 批量跑引擎，产出 plugin 指纹
    edit-entry.js        # 把编辑操作重放到 operations.js 的入口
    build_edit.mjs       # 打包编辑重放器
    replay_edit.py       # 跑 E01–E10，产出 edit 结果
    compare.py           # 对齐 + 判定 + HTML 报告
    calibrate.py         # 行高校准表
    font_metrics.py      # 字体度量诊断
    run_all.py           # 一条龙
  cases/manifest.json    # 用例清单（生成物，含每条用例的意图）
  fixtures/*.docx        # 夹具（生成物）
  ref/*.pdf              # WPS 基准（生成物）
```

**不改插件源码**：`layout-entry.js` 只 import `src/docx/parse.js` 与
`src/layout/*`，排版测试台跑在独立 bundle 里。

---

## 用例矩阵（28 条渲染 + 10 条交互）

| 组 | ID | 测什么 |
|---|---|---|
| 字符/字体 | C01–C06 | 基准行高、字号阶梯、宋体/雅黑/黑体/仿宋/楷体、粗斜体下划线颜色、上下标、字符间距 |
| 断行 | B01–B08 | 超长中文、行首禁则（，。）、行尾禁则（（「）、中英混排、超长西文拆字、Tab/软换行、首行缩进、左右缩进 |
| 行距 | S01–S03 | 单倍/1.5/双倍、固定值/最小值、段前段后 |
| 对齐 | A01–A02 | 左/中/右/两端/分散、两端对齐 + 段内软换行 |
| 分页 | P01–P06 | 自然分页、孤行、keepLines、keepNext、pageBreakBefore、手动分页符 |
| 文档网格 | G01–G02 | `docGrid type=lines` 吸附、`snapToGrid=0` |
| 页面 | L01 | A5 + 36pt 窄边距（栏宽变化） |
| 编辑 | E01–E10 | 输入法插入、回车分段、退格/Delete 合并、软换行、跨 run 删除、撤销重做、列表退格、空列表项回车、多行粘贴 |

每条用例的 `why` 与关联里程碑在 `cases/manifest.json` 里。

### 加一条用例

1. 在 `build_fixtures.py` 的 `SPECS` 里加一项（`id` / `cat` / `title` / `why` / `page` / `paras` / `checks`）。
2. `python tools/build_fixtures.py`
3. `python tools/run_all.py --skip-build`

`p()` 的默认值已经固定为 `line=1.0`、`before=0`、`after=0`，避免文档级默认值
污染行距测量；要测段距就显式传 `before` / `after`。

---

## 当前基线（2026-10，WPS 12.1.0.29161）

**28 / 28 渲染用例通过**（`out/results.json`）：

* **文本 28/28 编辑距离 = 0**（不丢字、不多字、不乱序）
* **断行点 28/28 完全一致**（含手动分页符 P06）
* **分页点 28/28 完全一致**
* **行首 x 28/28 ≤ 0.05pt**（B08 的字符缩进取整已对齐）
* **行距 28/28 在容差内**（最大 0.74pt，出现在上下标用例 C05）

首轮暴露的五个系统性偏差都已修掉，根因与修法见 `FINDINGS.md`：

| 编号 | 问题 | 修法 |
|---|---|---|
| F1 | 单倍行高整体偏小 6.8% | 中文字体按 WPS 校准表取行高/ascent（`measure.js`） |
| F2 | 固定值/最小值行距的基线位置 | 行盒显式带 `baseline`；exact 取 0.8×行高，atLeast 底边对齐 |
| F3 | 上下标压扁行距、基线不偏移 | 宽度按 65% 字号，纵向用原字号；上标 +33%、下标 −14% 移基线 |
| F4 | 分页符产生幽灵空行 | 控制符产生的空 segment 不再生成 line |
| F5 | `firstLineChars` 折算差 0.96pt | 字符单位缩进按段落默认字号折算 |

编辑用例 **10 / 10 通过**（`out/edit-results.json`）。重放不经过 UI，直接调用
`src/edit/operations.js`：文本、段落数、`numPr`、run 格式、软换行、粘贴分段
都按 manifest 的期望判定。`python tools/replay_edit.py` 可单独跑。

表格另有一套专用判定：PDF 会把同一行的多个单元格合并成一条“视觉行”，不能按
行号对齐；`compare.py` 改为把每个单元格行的首字符映射到 WPS 的同一个字符后再比
x / baseline。当前 `TB1`（合并单元格）、`TB2`（不等列宽）、`TB3`（跨页表头重复）都通过；
嵌套表格 `T04` 仍先按行拍平成文本。

> ⚠️ 并发提示：`T01`–`T04` 由另一个会话生成，`build_fixtures.py` 目前被错误编码
> 写坏，会重新覆盖这些 fixture；稳定验收请用 `TB1`–`TB3`
> （`python tools/build_table_fixtures.py` 生成）。

可直接替换的度量见 `out/calibration.md`。

---

## 已知边界

* **WPS 侧是 PDF 文本层**：上下标、行内公式会让字符包围盒重叠；行分组已按
  bbox 重叠处理，但极端排版（文字叠加、艺术字）仍可能误判。
* **字体必须两侧都装了**：`C:\Windows\Fonts` 里的宋体/雅黑/黑体/仿宋/楷体都在。
  文档里引用未安装字体时，WPS 与 WebView2 的回退策略不同，不能直接对比。
* **交互用例（E01–E10）已经是可执行的**：`tools/replay_edit.py` 把
  `place / ime / key / select / paste` 直接翻译成 `src/edit/operations.js`
  的操作，撤销/重做用整份 XML 快照模拟。当前 10/10 通过。
* **编辑夹具的格式补全**：生成器现在支持 `ppr`（E02 的首行缩进 / 行距）、
  `runs`（E06 同段多 run）和 `{"list": ...}`（E08/E09 的直接 `numPr`）。
  这三类此前只写进了 `start` 但被生成器忽略，导致夹具与规格不符。
* **只覆盖单节文档**：分节、分栏、页眉页脚、脚注尚未纳入（插件 M7 也没做）。
* 像素级 1:1 不是目标；判定的是断行/分页/几何，不是渲染截图。
