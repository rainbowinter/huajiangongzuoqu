# 双端操作差分：首轮发现（O01）

## 结论：第一次跑抓到的差异，根因在 WPS 驱动，不在插件

同一份 `ops/O01.json`：

```jsonc
[
  { "op": "place", "block": 0, "offset": 2 },
  { "op": "type",  "text": "测试" },
  { "op": "key",   "key": "Enter" },
  { "op": "type",  "text": "续行" },
  { "op": "key",   "key": "Backspace" }
]
```

首轮结果：

| 端 | 操作后文本 |
|---|---|
| WPS（COM） | `甲乙测试` / `续行丁` |
| office-viewer（replayEdit） | `甲乙测试` / `续丙丁` |

看起来像“插件退格删错了位置”，但插件最终投影里的光标是
`{ blockIndex: 1, offset: 1 }`：它先输入了 `续行`（光标在 `行` 后），再退格删掉了
`行`，得到 `续丙丁`——这正是 Backspace 应有的行为。

WPS 那边是把 `Selection.Delete(1, 1)` 当成了 Backspace。Word/WPS 的
`Selection.Delete(Unit, Count)` 里 **负 Count 往左删，正 Count 往右删**，
所以 `Delete(1, 1)` 实际删的是光标后的 `丙`，才得到 `续行丁`。

修法在 `tools/wps_ops.ps1`：

```powershell
'Backspace' { $app.Selection.Delete(1, -1) }
'Delete'    { $app.Selection.Delete(1, 1) }
```

修正后 **O01 通过**（`python tools/run_ops.py O01`）。

> 这条仍然说明了双端差分有价值：它抓到的不是插件 bug，而是**驱动层语义错**。
> 如果只信首轮红线，就会去改一个本来正确的 `caretAfter` 路径。

## O01–O26 全绿（2026-10）

修完下面几类问题后，26 条双端用例全部通过：

| 问题 | 根因 | 修在哪 |
|---|---|---|
| O11/O13/O14 粗体序列不一致 | WPS 的 run 逐词切，插件按 run 合并；比较粒度不同 | `run_ops.py` 改成按字符展开粗体序列，并统一软换行 `\v` → `\n` |
| O16/O17 选区删除无效 | 重放器只认 `select.to`，忽略了 `from` | `edit-entry.js` 用 `from` 建 anchor |
| O16 跨段删除 | 插件不支持跨段选区删除 | `replaceSelection` 新增跨段删除 + 合并（删起点段尾 / 中间段 / 终点段首） |
| O19–O22 撤销重做 | WPS 的 `Application.Undo` 不存在 | 改用 `Document.Undo()` / `Document.Redo()` |
| O24/O25 列表退格 | WPS COM 的 `Delete(-1)` 不会像 UI 一样先取消编号 | WPS 驱动在列表项开头改调 `ListFormat.RemoveNumbers()` |

当前结果：

```text
28/28 dual-end operation cases passed
```

表格用例 O27/O28 用 `placeCell`（表 / 行 / 单元格 / 段落 / 偏移）在两端定位，
比较整张表的阅读顺序纯文本；合并单元格在 WPS 与插件里的网格展开方式不同，
不按 row/col 矩阵逐格比。

---

## 已跑通的链路

```
ops/O01.json
   ├─> tools/wps_ops.ps1   （WPS COM：Selection.TypeText / TypeParagraph / Delete）
   └─> ops-harness.html    （插件：replayEdit → operations.js）
          └─> tools/run_ops.py 比较文本/段落/编号/粗体 → out/ops-report.html
```

WPS 侧读回的是**语义投影**：每段的文本、run 的粗体/斜体/字体/字号、列表编号、
表格行列。插件侧读回 blocks/runs/numPr/documentXml。

---

## 用例库规划（“案例尽量多”的落点）

按真实编辑流程组合，每条 4–12 个操作。**先做 O01–O30，跑通后再扩。**

| 组 | ID | 场景 | 覆盖点 |
|---|---|---|---|
| 输入 | O01–O06 | 段中/段首/段尾插字；连续输入；中英混输；输入后立即退格 | 插入点、caret 前移、run 拆分 |
| 分段 | O07–O12 | 段中/段首/段尾回车；连续回车；Shift+Enter；空段回车 | 分段、格式继承、sectPr、软换行 |
| 删除 | O13–O18 | 段首退格、段尾 Delete、跨 run 删、跨段删、全选删、删到空 | 合并、run 清理、空段保留 |
| 撤销 | O19–O22 | 输入后退、分段后退、删除后退、重做、连续输入合并为一步 | 撤销粒度、快照边界 |
| 列表 | O23–O26 | 列表中间回车、空项回车、项首退格降级、两级列表 | numPr、续号、重排 |
| 表格 | O27–O28 | 文本转表格、表格内 Tab/回车 | M7 后启用 |
| 格式 | O29–O30 | 选中加粗、取消加粗、改字号 | M5 后启用 |

### 每条用例的判定

1. **文本完全相同**（逐段）
2. **段落数相同**
3. **编号状态相同**（有/无 numPr）
4. **粗体/斜体序列相同**
5. 表格类：行列数、合并跨度相同
6. 光标最终位置相同（下一步补进投影）

---

## 和现有两层测试的关系

| 层 | 回答的问题 | 覆盖 |
|---|---|---|
| 排版差分 | 同一份 docx 排出来一样吗 | 28/28（另有表格 TB1/TB2） |
| 单端编辑 | 模型层操作对不对 | 10/10 |
| **双端操作** | **同一套输入，行为一样吗** | O01 已通过；O02 的 `table` 操作待表格编辑接入 |

三层缺一不可：排版差分管"打开就错"，单端编辑管"模型写错"，
双端操作管"用起来不一样"。
