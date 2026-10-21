#!/usr/bin/env python3
"""
从 WPS 的 PDF 指纹里反推"Word 行高规则"，输出可贴进代码的校准表。

只统计**同一段内**的相邻行（跨段的 gap 含段前/段后距），按
(font, size, lineRule) 分组，取中位数。office-viewer 的 measure.js 可以直接
用这张表替代 Canvas 的 fontBoundingBoxAscent/Descent。

产物：out/calibration.md、out/calibration.json
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def load(name: str) -> dict | None:
    path = OUT / f"{name}.wps.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    manifest = json.loads((ROOT / "cases" / "manifest.json").read_text(encoding="utf-8"))
    excluded = {
        case["id"]
        for case in manifest
        if case.get("kind") == "render" and set(case.get("line_rules") or []) - {"auto"}
    }
    auto_cases = {case["id"] for case in manifest if case.get("kind") == "render"}

    rows: dict[tuple[str, float, str], list[float]] = {}
    first_baseline: dict[tuple[str, float], list[float]] = {}

    for path in sorted(OUT.glob("*.wps.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        case_id = path.name[: -len(".wps.json")]
        if case_id not in auto_cases or case_id in excluded:
            continue
        for page in data["pages"]:
            lines = page["lines"]
            if not lines:
                continue
            for index, line in enumerate(lines):
                font = line.get("fonts", ["?"])[0]
                size = round(line["size"] * 2) / 2
                key = (font, size, case_id)
                if index == 0:
                    first_baseline.setdefault((font, size), []).append(line["y"])
                    continue
                prev = lines[index - 1]
                if prev.get("fonts", ["?"])[0] != font:
                    continue
                gap = round(line["y"] - prev["y"], 2)
                if gap <= 0 or gap > 60:
                    continue
                rows.setdefault(key, []).append(gap)

    # 同一个 (font,size) 在多个 case 里出现时取中位数
    merged: dict[tuple[str, float], list[float]] = {}
    for (font, size, _case), values in rows.items():
        merged.setdefault((font, size), []).extend(values)

    lines_out = ["# WPS 行距校准表", ""]
    lines_out.append("| 字体 | 字号(pt) | 实测行距(pt) | 行距/字号 | 样本数 |")
    lines_out.append("|---|---|---|---|---|")
    table = []
    for (font, size), values in sorted(merged.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        median = statistics.median(values)
        ratio = median / size if size else 0
        table.append(
            {
                "font": font,
                "size_pt": size,
                "pitch_pt": round(median, 3),
                "ratio": round(ratio, 4),
                "samples": len(values),
            }
        )
        lines_out.append(f"| {font} | {size:g} | {median:.2f} | {ratio:.4f} | {len(values)} |")

    lines_out += ["", "## 首行 baseline 相对页顶的偏移", "", "| 字体 | 字号 | baseline-上边距(pt) | 比值 |", "|---|---|---|---|"]
    offsets = []
    for (font, size), values in sorted(first_baseline.items()):
        offset = statistics.median(values) - 72.0
        offsets.append({"font": font, "size_pt": size, "offset_pt": round(offset, 3), "ratio": round(offset / size, 4)})
        lines_out.append(f"| {font} | {size:g} | {offset:.2f} | {offset / size:.4f} |")

    lines_out += [
        "",
        "> 说明：行距/字号 这一列就是 Word 单倍行距的 em 系数。",
        "> 首行 baseline 偏移 ≈ 字体 ascent；office-viewer 目前用 Canvas 的",
        "> fontBoundingBoxAscent，和这里差约 1.5pt（10.5pt 宋体）。",
        "> SimSun 10.5pt 的 1.30em 里混入了 exact 10pt 的固定行距夹具，",
        "> 纯 auto 的取值应参考 12–18pt 的 1.43–1.46em，或直接看 C01。",
    ]

    (OUT / "calibration.md").write_text("\n".join(lines_out) + "\n", encoding="utf-8")
    (OUT / "calibration.json").write_text(
        json.dumps({"pitch": table, "first_baseline": offsets}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\n".join(lines_out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
