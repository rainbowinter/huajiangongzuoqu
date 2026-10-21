# 行高修复参考补丁（来自 docen + WPS 实测）

这是 `FINDINGS.md` 里 F1（单倍行高系统性 −6.8%）的落地参考。
公式思路来自 docen `packages/layout/src/font-metrics-data.ts`（MIT，已注明来源），
但**实测发现纯公式还差一截**，所以下面给的是"查表优先、公式兜底"的写法。

## 1. 先看结论

| 字号 | docen 公式 | WPS 实测 | 差 |
|---|---|---|---|
| 宋体 10.5pt | 13.62pt | 15.60pt | +1.98 |
| 宋体 12pt | 15.56pt | 17.16pt | +1.60 |
| 宋体 14pt | 18.16pt | 20.04pt | +1.88 |
| 宋体 16pt | 20.75pt | 23.34pt | +2.59 |
| 宋体 18pt | 23.34pt | 26.34pt | +3.00 |
| 微软雅黑 10.5pt | 17.43pt | 20.76pt | +3.33 |
| 黑体 10.5pt | 13.62pt | 15.72pt | +2.10 |
| 仿宋 10.5pt | 13.62pt | 15.60pt | +1.98 |
| 楷体 10.5pt | 13.62pt | 15.72pt | +2.10 |
| Times New Roman 10.5pt | 11.63pt | 13.92pt | +2.29 |

**规律**：WPS 比 `winAscent + winDescent (+ CJK 15%)` 的公式多出 1.6–3pt。
所以不能只换公式，必须"实测表 + 公式"两层。

## 2. 首行 baseline 的规律（这条很干净）

WPS 的首行 baseline = 上边距 + **1.0em**：

| 字体 | 字号 | baseline − 上边距 | 比值 |
|---|---|---|---|
| 宋体 | 9pt | 9.05pt | 1.006 |
| 宋体 | 10.5pt | 10.49pt | 0.999 |
| Times New Roman | 10.5pt | 9.77pt | 0.931 |

宋体/黑体/仿宋/楷体都符合 `ascent = 1.0 × fontSize`。当前引擎是 0.857em
（12px / 14px），所以固定差 −1.49pt。**这一条可以单独先修，风险最低。**

## 3. 建议的最小改动

### `src/layout/measure.js`

```js
// 来源：docen font-metrics-data.ts 的 winAscent/winDescent 表（MIT）
// 数值用 fontTools 从 C:\Windows\Fonts 读出的真实 OS/2 表项。
const WORD_FONT_METRICS = {
  simsun: { upem: 256, winAscent: 220, winDescent: 36, cjk: true },
  宋体:   { upem: 256, winAscent: 220, winDescent: 36, cjk: true },
  simhei: { upem: 256, winAscent: 220, winDescent: 36, cjk: true },
  黑体:   { upem: 256, winAscent: 220, winDescent: 36, cjk: true },
  simfang:{ upem: 256, winAscent: 220, winDescent: 36, cjk: true },
  仿宋:   { upem: 256, winAscent: 220, winDescent: 36, cjk: true },
  simkai: { upem: 256, winAscent: 220, winDescent: 36, cjk: true },
  楷体:   { upem: 256, winAscent: 220, winDescent: 36, cjk: true },
  "microsoft yahei": { upem: 2048, winAscent: 2167, winDescent: 536, cjk: true },
  微软雅黑:          { upem: 2048, winAscent: 2167, winDescent: 536, cjk: true },
  "times new roman": { upem: 2048, winAscent: 1825, winDescent: 443, cjk: false },
  arial:             { upem: 2048, winAscent: 1854, winDescent: 434, cjk: false },
};

function wordRatio(m) {
  const sum = m.winAscent + m.winDescent;
  const leading = m.cjk ? 2 * Math.round(0.15 * sum) : 0;
  return (sum + leading) / m.upem;
}
```

`fontMetrics()` 改成**按实际字体取 ratio**，不要再用 `fontBoundingBoxAscent`：

```js
export function fontMetrics(style, isCJK, options = {}) {
  const size = effectiveSizePx(style, options);
  const family = (isCJK ? style.fontEastAsia : style.fontLatin || "").trim().toLowerCase();
  const table = WORD_FONT_METRICS[family];
  // WPS 实测在公式上还有 1.6–3pt 的额外 leading；先按 1.0em 的 baseline 修，
  // 行高差额用下面的 measured 表兜底。
  const ratio = table ? wordRatio(table) + MEASURED_LEADING[size] : 1.2;
  const lineHeight = size * ratio;
  const ascent = isCJK ? size : size * ((table?.winAscent ?? 0.8 * (table?.upem ?? 1)) / (table?.upem ?? 1));
  return { ascent, descent: Math.max(0, lineHeight - ascent), lineHeight, size };
}
```

### 实测表（优先于公式）

```js
// 单位 pt；key = 字号。来自 differential/out/calibration.md
const MEASURED_LEADING = {
  9:    0.15,   // 宋体
  10.5: 0.19,   // 宋体 15.60 / 10.5 - 1.297
  12:   0.133,
  14:   0.134,
  16:   0.162,
  18:   0.167,
};
```

更稳的做法：把 `out/calibration.md` 里的 `(font, size) -> pitch` 直接做成
JSON 表，`fontMetrics()` 先查表，查不到再走公式。

### `src/layout/lines.js`

```js
// 现在：只取 paragraph.defaultStyle，且 isCJK 固定 false
const metrics = fontMetrics(style, false, options);
```

改成：

```js
// 1) 取行内所有 atom 的 lineHeight 最大值
// 2) 每个 atom 用自己的 isCJK / 字体算 metrics（atoms.js 里已经算过 ascent/descent）
let base = 0;
for (const atom of atoms) {
  base = Math.max(base, atom.lineHeight ?? 0);
}
```

`makeTextAtom` 里已经有 `fontMetrics(style, isCJK, options)`，所以只要
`fontMetrics` 改对，atom 的 `ascent/descent/lineHeight` 就对了；
`lineHeightFor` 再把 `max(atom.lineHeight)` 作为 `base` 即可。

## 4. 验收

改完跑：

```bash
python tools/run_all.py --skip-build
```

期望转绿：**C01、C02、C03、B07、G01、G02**（行高类）。
`C05`（上下标）、`B08`（缩进取整）、`P06`（分页空行）是另外三个问题，
别混在这次改动里。

## 5. 来源与许可

* 公式与字体表结构参考 **docen**（MIT，Copyright (c) 2025 Demo Macro），
  文件 `packages/layout/src/font-metrics-data.ts`。
* 字体表项由 `fontTools` 从本机 `C:\Windows\Fonts` 读取，不是抄来的常量。
* WPS 实测值来自 `differential/out/calibration.md`，可复现。
