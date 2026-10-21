# office-viewer 统一验收协议（v1）

两个会话（插件实现 / 参考迁移与验收）共用这一份协议。**先看这里，再改
`differential/` 或 `src/`。**

## 1. 三层测试

| 层 | 回答的问题 | 入口 | 判定 |
|---|---|---|---|
| 排版差分 | 同一份 `.docx`，WPS 与插件排出来一样吗 | `python tools/run_protocol.py` | 文本编辑距离 0、断行/分页点一致、x ≤ 0.75pt、首行 baseline ≤ 1.5pt、行距 ≤ 2pt 或 3% |
| 单端编辑 | 模型层操作写回 XML 对不对 | 同上（内部 `replay_edit.py`） | 文本、段落数、`numPr`、run 格式、软换行、粘贴分段 |
| 双端操作 | 同一套语义操作，WPS 与插件行为一样吗 | 同上（内部 `run_ops.py`） | 文本、段落数、编号、粗体序列、光标位置 |
| 表格编辑 | 单元格内输入 / 分段 / 合并 / 选区格式 | 同上（内部 `test_table_editing.py`） | 单元格段落文本与粗体 |

**一条命令**：

```bash
python tools/run_protocol.py            # 会重新打 engine bundle
python tools/run_protocol.py --no-build # 复用已有 bundle
```

结果：`out/protocol-results.json`、`out/protocol-report.html`。

协议**不生成夹具、不导出 PDF**。`fixtures/`、`ref/` 必须先就位；需要刷新
oracle 时单独走 WPS 导出，不混进日常回归。

## 2. 稳定用例

| 组 | ID | 状态 |
|---|---|---|
| 排版核心 | `C01–C06 / B01–B08 / S01–S03 / A01–A02 / P01–P06 / G01–G02 / L01` | 必须全绿 |
| 表格 | `TB1`（合并单元格）、`TB2`（不等列宽）、`TB3`（跨页表头重复） | 必须全绿 |
| 编辑 | `E01–E10` | 必须全绿 |
| 双端操作 | `O01–O26` | 必须全绿；支持 `place / select / type / ime / paste / key / format` |
| 表格编辑 | `insert / split / merge / cross-paragraph-delete / bold-in-cell / insert-table` | 必须全绿 |
| 试验夹具 | `T01–T04` | **不进入协议**；留给参考迁移会话整理 |

新增用例必须同时改这里和 `run_protocol.py` 的稳定列表，否则不算进入验收。

## 3. 文件所有权（避免互相覆盖）

| 路径 | 主写方 | 说明 |
|---|---|---|
| `example-plugins-v2/office-viewer/src/**`、`view/**`、`test/**` | 插件实现会话 | 排版 / 编辑 / 渲染实现 |
| `differential/ops/**`、`OPS-FINDINGS.md`、`parity-fixtures/**`、`reference/**` | 验收会话 | 双端 transcript、参考实现、金标准 |
| `differential/cases/**`、`fixtures/**`、`ref/**` | 验收会话 | 生成物；实现会话只读 |
| `differential/tools/**` | 共用 | 改动前先说明；不要两个会话同时写同一个脚本 |
| `differential/out/**` | 生成物 | 每次跑协议会覆盖；不要手工编辑 |

**并发操作规则**：

1. 同一时间只允许一个会话跑会写 `fixtures/` / `ref/` / `cases/` 的脚本。
2. 跑之前先看 `git status` 和文件 mtime；发现对方刚改过，先停。
3. 日常回归只用 `run_protocol.py`；它只写 `out/`。

## 4. 已知风险 / 隔离

* **`tools/build_fixtures.py` 已损坏**（错误编码），重新运行会把
  `E02/E06/E08/E09` 的 `ppr/runs/numPr` 写丢，也会把 `T01–T04` 生成成非法表格。
  在它被修复前**不要作为默认步骤调用**。
* 编辑夹具坏了用 `python tools/patch_edit_fixtures.py` 修（只改这四份）。
* 表格夹具用 `python tools/build_table_fixtures.py` 生成 `TB1–TB3`，
  不依赖坏生成器。
* `out/` 里的 `*.wps.json` 有两种来源：`make_reference.ps1` 写的统计文件
  （带 BOM）和 `pdf_fingerprint.py` 写的排版指纹。跑比较前必须确认是后者。

## 5. 判定与状态

* `PASS`：所有 check 为真。
* `FAIL`：任一 check 为假；必须定位到“驱动 / 夹具 / 实现”三者之一。
* `XFAIL`：已知差异，协议不计入失败；修好后变 `XPASS`，届时从 xfail 列表移除。
* `pending`：功能尚未实现（例如 `table` 操作），不进入 transcript 结果。

**首轮红线先查驱动语义**：O01 的“退格删错”实际是 WPS 驱动把
`Selection.Delete(1,1)` 当成了 Backspace；插件侧 `caretAfter` 是正常的。
驱动、夹具、实现三层都排除后，才改插件。

## 6. 结果结构

`out/protocol-results.json`：

```json
{
  "protocol": "office-viewer-test-protocol/1",
  "render": { "pass": 0, "fail": 0, "cases": [{ "id": "C01", "status": "PASS" }] },
  "edit":   { "pass": 0, "fail": 0, "cases": [] },
  "ops":    { "pass": 0, "fail": 0, "cases": [] },
  "tableEdit": { "pass": 0, "fail": 0, "cases": [] },
  "xfail":  [],
  "overall_pass": true
}
```

新增字段只能追加；不要改已有字段含义。
