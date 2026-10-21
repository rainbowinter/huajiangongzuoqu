# 双会话协作规范（COORDINATION v1）

两个会话共用一份台账：**一个负责实现，一个负责验收**。目标是不靠人传话，
任一方跑完测试，另一方第一时间能看到结果并接手。

---

## 1. 角色

| 角色 | 会话 | 写什么 |
|---|---|---|
| **实现方** | 插件实现会话 | `src/**`、`view/**`、`test/**` |
| **验收方** | 参考迁移与验收会话 | `differential/ops/**`、`parity-fixtures/**`、`reference/**`、本台账的测试记录 |
| 共用 | 两边 | `differential/tools/**`（改前先在台账说明）、`out/**`（生成物） |

一轮里**只有一个角色在写代码**。另一方只能读、跑测试、写台账。

---

## 2. 共享台账

三份文件，都在 `differential/coordination/`：

| 文件 | 谁写 | 内容 |
|---|---|---|
| `STATE.json` | 双方，按轮次交接 | 当前轮次、谁在干活、谁在等、下一步 |
| `MESSAGES.jsonl` | 双方追加 | 交接消息（append-only，只追加不改） |
| `TESTS.jsonl` | 验收方为主 | 每次测试运行的结果摘要，append-only |

### `STATE.json`

```jsonc
{
  "round": 3,
  "phase": "first-batch",          // first-batch / tables / undo / ime
  "owner": "impl",                 // impl | verify
  "busy": true,                    // 当前持有者是否正在写
  "waiting_for": "verify",         // 另一方在等谁
  "status": "in_progress",         // in_progress | ready_for_test | passed | blocked
  "last_run": {
    "at": "2026-10-20T16:40:00+08:00",
    "render": "31/31",
    "edit": "10/10",
    "ops": "22/22",
    "overall": "pass"
  },
  "next": "验收方复核 O16/O17 的跨段删除，再决定是否进入表格",
  "updated_at": "2026-10-20T16:40:00+08:00",
  "updated_by": "verify"
}
```

### `MESSAGES.jsonl`

一行一条，追加写：

```jsonc
{"ts":"...","from":"impl","round":3,"kind":"handoff","text":"行高修复完成，bundle 已重建，请跑协议"}
{"ts":"...","from":"verify","round":3,"kind":"result","text":"render 31/31 edit 10/10 ops 22/22，全绿"}
{"ts":"...","from":"verify","round":4,"kind":"handoff","text":"O19–O22 需要驱动补 Undo/Redo，先 pending"}
```

`kind` 取值：`handoff`（交棒）、`result`（测试结果）、`blocked`（卡住）、`note`（备注）。

### `TESTS.jsonl`

```jsonc
{"ts":"...","round":3,"by":"verify","render":{"pass":31,"fail":0},
 "edit":{"pass":10,"fail":0},"ops":{"pass":22,"fail":0},
 "failed":[],"pending":["O19","O20","O21","O22"],"overall":"pass"}
```

---

## 3. 轮次协议

```
        ┌──────────────┐
        │  impl 写代码  │
        └──────┬───────┘
               │ 写 STATE: owner=verify, status=ready_for_test
               │ 追加 MESSAGES: kind=handoff
               ▼
        ┌──────────────┐
        │ verify 跑测试 │  ← 只写 out/ 和台账
        └──────┬───────┘
               │ 写 TESTS.jsonl
               │ 写 STATE: owner=impl, status=passed 或 blocked
               │ 追加 MESSAGES: kind=result
               ▼
        ┌──────────────┐
        │  impl 看结果  │
        └──────────────┘
```

规则：

1. **交棒必须改 `STATE.json` 并追加一条 `MESSAGES.jsonl`**，只发消息不算交棒。
2. 交棒前把 `busy` 置 `false`；接手方先把它置 `true` 再动手。
3. 同一时间只允许一个会话跑会写 `fixtures/` / `ref/` / `cases/` 的脚本。
   日常回归只跑 `run_protocol.py`（只写 `out/`）。
4. **不主动结束会话**：跑完一轮就等对方；等待用 `python tools/coordinate.py wait`
   （轮询 `STATE.json`，超时才返回）。
5. 测试失败时，`TESTS.jsonl` 必须写清 `failed` 列表；`STATE.next` 写“谁该改什么”。
6. 一轮只推进一个主题。第一批基础功能全绿之前，不进入表格/撤销/IME。

---

## 4. 第一批（first-batch）的定义

进入下一阶段的门槛：以下全部 `pass`。

| 层 | 范围 | 门槛 |
|---|---|---|
| 排版 | C01–C06 / B01–B08 / S01–S03 / A01–A02 / P01–P06 / G01–G02 / L01 | 28/28 |
| 表格渲染 | TB1–TB3 | 3/3 |
| 编辑 | E01–E10 | 10/10 |
| 双端操作 | O01–O18、O23–O26 | 22/22 |

`first-batch` 通过后，`STATE.phase` 改成 `tables`（表格编辑）或 `undo`，
再按同样节奏推进。

---

## 5. 工具

```bash
# 看当前状态
python tools/coordinate.py status

# 追加一条消息
python tools/coordinate.py say --from verify --kind result --text "全绿"

# 交棒 / 接手
python tools/coordinate.py handoff --to verify --status ready_for_test --next "跑协议"
python tools/coordinate.py claim  --as impl

# 记录一次测试
python tools/coordinate.py test --by verify --render 31/31 --edit 10/10 --ops 22/22 \
  --overall pass --pending O19,O20,O21,O22

# 等对方交棒（默认 30 分钟，超时返回非零）
python tools/coordinate.py wait --for verify --timeout 1800

# 看最近消息 / 测试
python tools/coordinate.py log --tail 10
```

`wait` 的语义：轮询 `STATE.json`，当 `owner` 变成指定角色且 `status` 为
`ready_for_test` / `passed` / `blocked` 时返回 0；超时返回 1。

---

## 6. 和已有协议的关系

* `TEST-PROTOCOL.md` 定义**测什么、怎么判定**；
* 本文件定义**谁在什么时候测、结果写哪、怎么交接**；
* 两者不冲突：测试入口仍然是 `python tools/run_protocol.py`。

---

## 7. 反例（不要这样做）

* 只发消息、不改 `STATE.json` —— 对方不知道轮次变了。
* 两边同时跑 `run_protocol.py` —— `out/` 会互相覆盖。
* 测试没过就进入下一阶段 —— 第一批的意义就是先锁住基本盘。
* 一方跑完直接结束会话 —— 另一方的“等待”会一直超时。
