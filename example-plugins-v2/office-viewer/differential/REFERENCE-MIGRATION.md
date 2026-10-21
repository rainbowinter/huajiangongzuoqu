# 先本地保存，再逐功能参考迁移

这是可执行的路线，不是"把库塞进去"。核心是把"参考实现"和"花笺代码"隔离开，
每次只迁移一个功能，并且每个功能都有可验证的输入/输出。

## 0. 已经落地的准备

```
differential/reference/
  README.md                  # 许可证边界与使用规则
  docen/                     # MIT，可读可改
  eigenpal-docx-editor/      # Apache-2.0 核心（Pro 包除外）
  superdoc/                  # AGPL-3.0，只读，不复制代码
differential/parity-fixtures/
  paragraph-heading-runs/    # 样式级联 + 行距 + 缩进 + 对齐 + 上下标
  table-merged-cells/        # 横向合并 + 纵向合并 + 表头 + 行高
  footnote-page-field/       # 脚注 + PAGE/NUMPAGES 字段 + 页脚槽位
  README.md                  # 来源与用途（MIT，已注明）
```

`reference/` 已在 `.gitignore` 里，不进版本库；需要时按 `reference/README.md`
里的地址重新下载。`parity-fixtures/` 是摘出来的对照夹具，会进版本库。

## 1. 法律边界（先看这一节，避免返工）

| 来源 | 能做什么 | 不能做什么 |
|---|---|---|
| docen（MIT） | 读、改、摘算法、闭源分发；保留版权声明 | 去掉原版权声明后当成自己的 |
| EigenPal（Apache-2.0） | 读、改、分发；保留 LICENSE/NOTICE | 把 `packages/pro` 的代码当 Apache 用 |
| SuperDoc（AGPL-3.0） | **只读**：理解行为、理解 OOXML 组织方式 | 复制任何代码到闭源产品；链接其库分发 |

**判断标准**：迁移完成后，花笺仓库里不应出现与 AGPL 项目逐行同构的实现。
MIT/Apache 的代码如果摘用，文件头写清来源、版本、许可证。

## 2. 逐功能迁移的固定流程

每个功能都走同一套，避免"改着改着跑偏"：

```
① 选一个功能（只选一个）
② 在 reference 里找到对应实现，读懂它解决的是什么问题
③ 在 differential/ 里加一条能复现该功能的夹具（docx + 期望）
④ 先只用 WPS 跑出 oracle（PDF + 期望的断行/分页/行距）
⑤ 在花笺引擎里实现（自己的代码）
⑥ 跑 differential/，看这条夹具是否通过；同时跑全量，确认没回归
⑦ 记一条迁移日志（做了什么、和 WPS 还差多少、为什么）
```

第 ③ 步是关键：**没有夹具的功能不迁移**。否则改完无法证明"更接近 WPS"。

## 3. 建议的迁移顺序（按首轮实测缺口排）

| 顺序 | 功能 | 为什么先做 | 参考位置 |
|---|---|---|---|
| 1 | **字体度量 / 行高** | 当前 −6.8% 系统性偏差，40 行出一行错；所有分页问题的根 | `docen/packages/layout/src/font.ts`、`font-metrics-data.ts`、`text/measure.ts` |
| 2 | **exact / atLeast 行盒定位** | 首行 baseline 差 7pt，固定行距的中文公文很常见 | `docen/packages/layout/src/block/paragraph.ts` |
| 3 | **上下标基线** | 只缩字号不抬基线，行高被算错 | `docen/packages/layout/src/layout-doc/inline.ts` |
| 4 | **分页符空行** | 幽灵空行会让页内行号错位 | `docen/packages/layout/src/block/paragraph.ts`、`flow/flow.ts` |
| 5 | **firstLineChars 取整** | 0.96pt 的缩进差，中文首行缩进必现 | `docen/packages/layout/src/block/geometry.ts` |
| 6 | **表格** | 花笺现在按行拍平，是功能缺口不是精度问题 | `docen/packages/layout/src/block/table.ts` + `parity-fixtures/table-merged-cells/` |
| 7 | **页眉页脚 / 页码 / 脚注** | M7 未做；参考夹具已经给了期望结构 | `docen/packages/docx/src/extensions/` + `parity-fixtures/footnote-page-field/` |
| 8 | **字段（TOC / PAGE / NUMPAGES）** | 公文/论文场景必需 | `docen/packages/docx/src/extensions/toc-field.ts` |
| 9 | **修订 / 批注** | 协作场景；只读 SuperDoc 的思路 | `superdoc/`（只读） |

前 5 项是"精度修复"，第 6–8 项是"功能补齐"，第 9 项是"协作能力"。
**不要混在一起做**：精度修复可以用现有夹具快速验证，功能补齐需要新夹具。

## 4. 每个功能的验收标准

一条功能算"迁移完成"，必须同时满足：

- [ ] `differential/` 里有至少一条专门覆盖它的夹具
- [ ] 该夹具对 WPS 的判定：文本 0 差异、断行/分页点一致、行距在容差内
- [ ] 全量差分没有新增失败
- [ ] 保存出的 `.docx` 在 WPS 里能打开、无修复提示（`differential/` 的 P 类用例）
- [ ] 迁移日志里写清"参考了哪个实现、哪些是自己写的、还剩什么差异"

## 5. 两个不要

* **不要 fork 整个 docen 然后改**。它是 pre-1.0，API 会变；fork 会把你的节奏绑在
  别人的发版上。只摘算法/结构，落到花笺自己的模块里。
* **不要一次迁移多个功能**。排版引擎的改动高度耦合（行高会影响分页，分页会影响
  页眉），一次只动一个，跑完全量再动下一个。

## 6. 现在就可以做的第一步

行高修复不需要等任何选型决定：

1. 打开 `out/calibration.md`，拿到宋体 10.5/12/14/16/18pt 的实测行距；
2. 对照 `reference/docen/packages/layout/src/font.ts` 看它怎么从字体文件取
   `ascent/descent/lineGap`；
3. 改 `src/layout/measure.js` 的 `fontMetrics`，改 `src/layout/lines.js` 的
   `lineHeightFor`（取行内 max，而不是段落默认样式）；
4. `python tools/run_all.py --skip-build`，看 C01–C03、B07、G01–G02 是否转绿。

这一步做完，再决定要不要继续往表格/页眉页脚走。
