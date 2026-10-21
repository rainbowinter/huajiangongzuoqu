# 双端操作差分：设计（OPERATION-DIFFERENTIAL）

目标：**同一套操作脚本，分别喂给 WPS 和 office-viewer，比较两边每一步之后的文档行为。**
最终体验差异来自人的真实输入，所以这是比"同一份 docx 各排一遍"更贴近用户的验收层。

---

## 1. 现在有什么、缺什么

| 层 | 现状 | 是否双端 |
|---|---|---|
| 排版差分（C/B/S/A/P/G/L 类） | 同一份 `.docx`，WPS PDF vs 插件排版指纹 | ✅ 是 |
| 编辑回放（E01–E10） | 直接调 `operations.js`，只跑插件一侧 | ❌ 单端 |
| **操作差分（本设计）** | 同一份 transcript，WPS COM vs 插件真实事件 | ⬜ 待建 |

已有编辑回放的价值是"模型层对不对"，但它**绕过了输入路径**：textarea 的
`beforeinput`、IME 的 `compositionstart/update/end`、键盘映射、撤销栈、
光标移动都没被覆盖。而这些恰恰是"用起来像不像 Word"的主要来源。

---

## 2. 一个必须说清楚的取舍：物理按键 vs 语义操作

真正"模拟人按键"意味着往 WPS 窗口发 OS 级 keybd_event。这条路不可靠：

* WPS 窗口必须可见、聚焦，会抢用户焦点；
* 不同输入法、不同键盘布局会让同一个键产生不同结果；
* 失败时无法区分"插件错了"还是"按键没送进去"。

所以自动化版本采用**语义操作**做两端共同语言：

> "在第 2 段第 3 个字后插入『测试』"——WPS 用 COM 的
> `Selection.TypeText`，插件用 `beforeinput`/`insertText`。

这与物理按键在**文档行为**上等价（同一个插入点、同样触发分段/合并/编号重排），
只是不覆盖"哪个键映射到哪个命令"。键位映射单独用一张**键位表**做单端断言
（见 §6），不需要 WPS 参与。

---

## 3. Transcript 格式

一个用例 = 起始文档 + 操作序列 + 每步/最终的期望。

```jsonc
{
  "id": "O01",
  "title": "在编号列表中间回车，再输入文字",
  "start": "fixtures/O01.docx",
  "ops": [
    { "op": "place",  "block": 1, "offset": 2 },
    { "op": "type",   "text": "新增" },
    { "op": "key",    "key": "Enter" },
    { "op": "type",   "text": "续行" },
    { "op": "key",    "key": "Backspace" },
    { "op": "key",    "key": "Backspace" }
  ],
  "compare": ["text", "paras", "numbering", "runs", "xml"]
}
```

支持的操作（两端都要能表达）：

| op | WPS COM | 插件 |
|---|---|---|
| `place {block, offset}` | `Selection.SetRange` + `Move` | `beforeinput` 前的 caret 定位 |
| `select {from, to}` | `Selection.SetRange` | `pointerdown` + `pointermove`（或内部 selection） |
| `type {text}` | `Selection.TypeText` | `beforeinput` / `compositionend` |
| `ime {text}` | `Selection.TypeText`（WPS 不区分 IME） | `compositionstart/update/end` |
| `key {Enter/Backspace/Delete/Tab/Shift+Enter/Arrow…}` | `TypeParagraph` / `Delete` / `TypeText("\t")` | `keydown` + `beforeinput` |
| `paste {text}` | `Selection.Paste`（或 `TypeText` 多行） | `paste` 事件 |
| `table {rows, cols}` | `Range.ConvertToTable` | 表格命令（M7 后） |
| `format {bold/italic/…}` | `Selection.Font.Bold = true` | 格式命令（M5 后） |
| `undo/redo` | `Document.Undo/Redo` | `Ctrl+Z/Y` 事件 |

---

## 4. 两端怎么读结果

不比原始 `document.xml`：WPS 保存时会重写 rsid、拆 run、重排属性，直接 diff
全是噪声。比**语义投影**（两端都能产出）：

```jsonc
{
  "paragraphs": [
    {
      "text": "甲乙丙丁",
      "style": "Normal",
      "numbering": { "numId": 1, "ilvl": 0 } | null,
      "runs": [
        { "text": "甲乙", "bold": true, "italic": false, "font": "宋体", "sizePt": 10.5 }
      ]
    }
  ],
  "tables": [
    { "rows": 3, "cols": 3, "spans": [[1,2],[3,1]], "vmerge": [[0,0],[1,0]] }
  ]
}
```

* WPS 侧：COM 遍历 `Paragraphs` / `Range.Words` / `Tables` 读出；
* 插件侧：从 `document.xml` 用 `parse.js` 的 IR 投影，或直接读 DOM/IR。

比较顺序：**文本 → 段落数 → 编号 → run 格式 → 表格结构 → 光标位置**。
先比文本，文本不对就不必看格式（否则报告会被噪声淹没）。

---

## 5. 用例库怎么组织（这是“案例尽量多”的落点）

按**真实使用流程**组合，而不是按功能点罗列。每条 5–15 个操作：

| 组 | 场景 | 覆盖 |
|---|---|---|
| O-输入 | 段中插字、行首插字、行尾插字、连续输入 50 字 | 插入点、run 拆分、`xml:space` |
| O-分段 | 段中回车、段首回车、段尾回车、连续回车、Shift+Enter | 分段、格式继承、`sectPr` 不复制 |
| O-删除 | 段首退格、段尾 Delete、跨 run 删、跨段删、全选删 | 合并、run 清理、空段 |
| O-列表 | 列表中间回车、空项回车、项首退格降级、多级缩进 | `numPr`、续号、重排 |
| O-表格 | 文本转表格、表格内 Tab、表格内回车、表格前回车 | 表格创建/编辑（M7） |
| O-格式 | 选中加粗、取消加粗、改字号、改字体 | 按选区写格式（M5） |
| O-撤销 | 输入后退、分段后退、删除后退、重做 | 撤销粒度、合并规则 |
| O-组合 | 输入→回车→输入→退格→选中→加粗→撤销 | 真实编辑流的组合 |
| O-IME | 组合中取消、组合中移动、连续组合 | 组合预览不落 XML |

先做 O-输入 / O-分段 / O-删除 / O-撤销（当前 M5 已支持），
表格和格式等 M5/M7 补齐后再加。

---

## 6. 键位表（单端，不需要 WPS）

物理按键的映射单独测：给 textarea 发 `keydown`，断言"产生了哪个操作"。

| 键 | 期望 |
|---|---|
| `Enter` | `splitParagraph` |
| `Shift+Enter` | `insertSoftBreak` |
| `Backspace`（段首） | `mergeWithPrevious` |
| `Delete`（段尾） | `mergeWithNext` |
| `ArrowLeft/Right` | caret 移动一个码点（CJK 按字） |
| `Home/End` | 行首/行尾 |
| `Ctrl+Z/Y` | undo/redo |
| `Tab` | `insertTab`（列表内改级别） |

这张表用合成 `KeyboardEvent` 就能测，不需要 WPS。

---

## 7. 落地顺序

1. **WPS COM 操作执行器**（`tools/wps_ops.ps1`）：读 transcript，执行，导出语义投影。
2. **插件真实事件执行器**（`tools/edit-entry.js` 扩展）：把同一 transcript 翻译成
   `beforeinput` / `composition` / `keydown`，走 `createEditor` 的真实路径。
3. **投影比较器**（`tools/compare_ops.py`）：文本 → 段落 → 编号 → run → 表格。
4. **用例库**：先 20 条（O-输入/分段/删除/撤销），再按功能补齐扩到 60+。

第 1 步是风险最高的（WPS 的 COM 行为要现场验证），所以先做一个最小 spike：
`Selection.TypeText` + `TypeParagraph` + `Backspace` + `ConvertToTable`，
确认能稳定读回段落/run/表格。跑通再铺用例。
