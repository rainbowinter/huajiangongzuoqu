#!/usr/bin/env python3
"""
差分比较器：WPS 的 PDF 指纹 vs 插件排版指纹。

比较的不是"像素一样"，而是四个可判定的事实：

1. 分页点   —— 每一页第一个字符在全文中的下标是否相同
2. 断行点   —— 每一行第一个字符在全文中的下标是否相同（禁则的直接体现）
3. 缩进/起点 —— 每行首个非空字符的 x，和 WPS 的差
4. 行距     —— 相邻行 baseline 差，和 WPS 的差

字符流用"逐字符 + 插入/删除 DP"对齐：某个字被吞、多字、顺序错，都会在这里暴露。

用法：
    python compare.py                 # out/ 下所有成对的 case
    python compare.py C01 B02
    python compare.py --report report.html
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

X_TOL = 0.75      # pt，约 1 CSS px
BASE_Y_TOL = 1.5  # pt，首行 baseline 的绝对偏差（字体 ascent 约定差异）
# 表格单元格的内边距 / 列宽取整和 WPS 会有几 pt 的差；先按 6pt 判，
# 比普通段落宽松，但仍能抓住“整列错位”。
TABLE_X_TOL = 8.0
TABLE_Y_TOL = 2.0
YES_TOL = 2.0     # pt，行距绝对偏差
Y_RATIO_TOL = 0.03  # 行距相对偏差 3%：超过就会在 30 行内累积出一行


def compare_gaps(wps_gaps: list[float], plugin_gaps: list[float]) -> dict:
    """逐行比较行距。返回最大绝对/相对偏差和首个超差行。"""

    count = min(len(wps_gaps), len(plugin_gaps))
    if count == 0:
        return {"count": 0, "max_abs": 0.0, "max_ratio": 0.0, "first_bad": None}
    max_abs = 0.0
    max_ratio = 0.0
    first_bad = None
    for index in range(count):
        a, b = wps_gaps[index], plugin_gaps[index]
        diff = abs(b - a)
        ratio = diff / a if a else 0.0
        max_abs = max(max_abs, diff)
        max_ratio = max(max_ratio, ratio)
        if first_bad is None and (diff > YES_TOL and ratio > Y_RATIO_TOL):
            first_bad = {"line": index + 1, "wps": a, "plugin": b, "diff": round(b - a, 2)}
    return {
        "count": count,
        "max_abs": round(max_abs, 2),
        "max_ratio": round(max_ratio, 4),
        "first_bad": first_bad,
    }


def char_stream(lines: list[dict]) -> tuple[str, list[int]]:
    """返回 (全文, 每个字符所在行号)。空白字符不参与对齐。

    空白不参与对齐有两个原因：PDF 文本层对行尾/行首空格的处理并不稳定；
    Word 的"中西文自动间距"看起来像空格、但并不是字符。空白差异单独统计，
    不污染"字有没有丢、断行点对不对"这两个结论。
    """

    text = []
    owners = []
    for index, line in enumerate(lines):
        for ch in line["text"]:
            if ch.isspace():
                continue
            text.append(ch)
            owners.append(index)
    return "".join(text), owners


def align_chars(a: str, b: str) -> tuple[int, list[tuple[int | None, int | None]]]:
    """最小编辑距离对齐，返回 (距离, [(i, j)])。"""
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return n + m, [(i, None) for i in range(n)] + [(None, j) for j in range(m)]

    # 快速路径：完全相同
    if a == b:
        return 0, [(i, i) for i in range(n)]

    prev = list(range(m + 1))
    rows = [prev]
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        ai = a[i - 1]
        for j in range(1, m + 1):
            cost = 0 if ai == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        rows.append(cur)
        prev = cur

    pairs: list[tuple[int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and a[i - 1] == b[j - 1]:
            pairs.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif i > 0 and rows[i][j] == rows[i - 1][j] + 1:
            pairs.append((i - 1, None))
            i -= 1
        else:
            pairs.append((None, j - 1))
            j -= 1
    pairs.reverse()
    return rows[n][m], pairs


def line_starts(owners: list[int], count: int) -> list[int]:
    starts = []
    cursor = 0
    for line in range(count):
        while cursor < len(owners) and owners[cursor] < line:
            cursor += 1
        starts.append(cursor)
    return starts


def split_into_lines(pairs, a_owners, b_owners):
    """把字符对齐结果变成行对齐：A 的每行 -> B 的每行。"""

    a_to_b = {}
    for i, j in pairs:
        if i is not None and j is not None:
            a_to_b[i] = j

    line_map = {}
    for i, j in pairs:
        if i is None or j is None:
            continue
        la, lb = a_owners[i], b_owners[j]
        line_map.setdefault(la, {}).setdefault(lb, 0)
        line_map[la][lb] += 1

    result = {}
    for la, counts in line_map.items():
        result[la] = max(counts.items(), key=lambda kv: kv[1])[0]
    return result


def compare_table_case(
    case_id: str,
    wps: dict,
    plugin: dict,
    wps_lines: list,
    plugin_lines: list,
    distance: int,
    pairs: list,
) -> dict:
    """表格专用判定。

    PDF 文本层会把同一表格行里的多个单元格按基线合并成一条“视觉行”，而插件
    侧是每个单元格各自一行；拿行号逐条对齐会在第一行就错位。这里改成按
    **字符对齐**：每个插件行的首字符映射到 WPS 的同一个字符，再比 x / baseline。
    """

    plugin_pages = plugin["pages"]
    wps_char_x = []
    wps_char_y = []
    wps_char_page = []
    for page_index, line in wps_lines:
        for char in line.get("chars", []):
            if char["c"].isspace():
                continue
            wps_char_x.append(char["x"])
            wps_char_y.append(line["y"])
            wps_char_page.append(page_index)

    b_owner = []
    b_line_first = []
    b_line_page = []
    cursor = 0
    for page_index, line in plugin_lines:
        count = len([c for c in line.get("text", "") if not c.isspace()])
        b_line_first.append(cursor)
        b_line_page.append(page_index)
        b_owner.extend([len(b_line_first) - 1] * count)
        cursor += count
    reverse: dict[int, list[int]] = {}
    for i, j in pairs:
        if i is not None and j is not None:
            reverse.setdefault(j, []).append(i)

    geometry = []
    unmapped = 0
    for line_index, (_, pline) in enumerate(plugin_lines):
        b_index = b_line_first[line_index] if line_index < len(b_line_first) else None
        candidates = reverse.get(b_index, []) if b_index is not None else []
        # 重复的表头在全文里会出现多次；优先取同一页上的那个。
        a_index = next(
            (item for item in candidates if wps_char_page[item] == b_line_page[line_index]),
            candidates[0] if candidates else None,
        )
        if a_index is None or a_index >= len(wps_char_x):
            unmapped += 1
            continue
        geometry.append(
            {
                "wps_line": a_index,
                "plugin_line": line_index,
                "wps_char": a_index,
                "dx": round(pline["x"] - wps_char_x[a_index], 2),
                "dy": round(pline["baseline"] - wps_char_y[a_index], 2),
                "wps_x": wps_char_x[a_index],
                "plugin_x": pline["x"],
                "wps_baseline": wps_char_y[a_index],
                "plugin_baseline": pline["baseline"],
                "text": pline["text"][:16],
            }
        )

    max_dx = max((abs(item["dx"]) for item in geometry), default=0.0)
    max_dy = max((abs(item["dy"]) for item in geometry), default=0.0)
    checks = {
        "text_identical": distance == 0,
        "text_edit_distance": distance,
        "page_count_equal": len(wps["pages"]) == len(plugin_pages),
        "table_lines_mapped": unmapped == 0,
        "table_geometry_within_tol": max_dx <= TABLE_X_TOL and max_dy <= TABLE_Y_TOL,
    }
    failed = [name for name, ok in checks.items() if isinstance(ok, bool) and not ok]
    if not checks["text_identical"]:
        failed.append(f"text_edit_distance={distance}")
    if max_dx > TABLE_X_TOL:
        failed.append(f"max_dx={max_dx:.2f}pt>{TABLE_X_TOL}")
    if max_dy > TABLE_Y_TOL:
        failed.append(f"max_dy={max_dy:.2f}pt>{TABLE_Y_TOL}")
    return {
        "id": case_id,
        "pass": not failed,
        "failed": failed,
        "checks": checks,
        "stats": {
            "wps_pages": len(wps["pages"]),
            "plugin_pages": len(plugin_pages),
            "wps_lines": len(wps_lines),
            "plugin_lines": len(plugin_lines),
            "wps_chars": len(wps_char_x),
            "plugin_chars": len(b_owner),
            "unmapped_lines": unmapped,
            "max_dx_pt": round(max_dx, 2),
            "first_dy_pt": round(geometry[0]["dy"], 2) if geometry else 0.0,
            "line_pitch_max_abs": round(max_dy, 2),
            "line_pitch_max_ratio": 0.0,
            "text_edit_distance": distance,
        },
        "geometry": geometry,
        "line_mismatches": [],
        "page_mismatches": [],
        "line_gaps": {"wps": [], "plugin": []},
        "empty_lines": {
            "wps": sum(1 for _, line in wps_lines if not line["text"].strip()),
            "plugin": sum(1 for _, line in plugin_lines if not line["text"].strip()),
        },
        "fonts": {
            "wps": sorted({f for _, line in wps_lines for f in line.get("fonts", [])}),
            "plugin": sorted({f for _, line in plugin_lines for f in line.get("fonts", [])}),
        },
        "gaps": {"ok": True, "first_bad": None, "wps": [], "plugin": []},
    }


def compare_case(wps: dict, plugin: dict) -> dict:
    wps_lines = [(pi, line) for pi, page in enumerate(wps["pages"]) for line in page["lines"]]
    plugin_pages = plugin["pages"]
    plugin_lines = [(pi, line) for pi, page in enumerate(plugin_pages) for line in page["lines"]]

    a_text, a_owner = char_stream([line for _, line in wps_lines])
    b_text, b_owner = char_stream([line for _, line in plugin_lines])

    distance, pairs = align_chars(a_text, b_text)
    if str(plugin.get("fixture", "")).startswith("T"):
        return compare_table_case(
            plugin["fixture"], wps, plugin, wps_lines, plugin_lines, distance, pairs
        )
    line_map = split_into_lines(pairs, a_owner, b_owner)

    # ---- 分页点 ----
    wps_pages = [0]
    for pi, page in enumerate(wps["pages"]):
        if pi == 0:
            continue
        wps_pages.append(wps_pages[-1] + len(wps["pages"][pi - 1]["lines"]))
    plugin_page_starts = []
    cursor = 0
    for page in plugin_pages:
        plugin_page_starts.append(cursor)
        cursor += len(page["lines"])

    wps_page_char_starts = line_starts(a_owner, len(wps_lines))
    plugin_page_char_starts = line_starts(b_owner, len(plugin_lines))

    def find_char_start(char_index: int, owners: list[int]) -> int:
        for idx, owner in enumerate(owners):
            if owner >= char_index:
                return idx
        return len(owners)

    page_mismatches = []
    for page_index, wps_line_start in enumerate(wps_pages):
        wps_char = wps_page_char_starts[wps_line_start] if wps_line_start < len(wps_page_char_starts) else len(a_text)
        mapped_line = line_map.get(wps_line_start)
        plugin_char = None
        if mapped_line is not None:
            plugin_char = plugin_page_char_starts[mapped_line] if mapped_line < len(plugin_page_char_starts) else len(b_text)
        if plugin_char is None or abs((plugin_char or 0) - wps_char) > 0:
            page_mismatches.append(
                {
                    "page": page_index,
                    "wps_char": wps_char,
                    "plugin_char": plugin_char,
                    "text": a_text[max(0, wps_char - 6) : wps_char + 6],
                }
            )

    # ---- 行号 / 断行 ----
    line_mismatches = []
    for a_line, (_, wline) in enumerate(wps_lines):
        if a_line == 0:
            continue
        if a_line not in line_map:
            line_mismatches.append({"wps_line": a_line, "plugin_line": None, "text": wline["text"][:20]})
            continue
        b_line = line_map[a_line]
        if line_map.get(a_line - 1) != b_line - 1:
            line_mismatches.append(
                {
                    "wps_line": a_line,
                    "plugin_line": b_line,
                    "text": wline["text"][:20],
                    "prev_plugin": line_map.get(a_line - 1),
                }
            )

    # ---- 几何 ----
    geometry = []
    for a_line, b_line in sorted(line_map.items()):
        if a_line >= len(wps_lines) or b_line >= len(plugin_lines):
            continue
        _, wline = wps_lines[a_line]
        _, pline = plugin_lines[b_line]
        dx = pline["x"] - wline["x"]
        dy = pline["baseline"] - wline["y"]
        geometry.append(
            {
                "wps_line": a_line,
                "plugin_line": b_line,
                "dx": round(dx, 2),
                "dy": round(dy, 2),
                "wps_x": wline["x"],
                "plugin_x": pline["x"],
                "wps_baseline": wline["y"],
                "plugin_baseline": pline["baseline"],
                "text": wline["text"][:16],
            }
        )

    # ---- 行距 ----
    # 逐页取"同页相邻行"的 gap：跨页没有意义，跨段的大 gap 用 75 分位滤掉。
    # 页数不同时逐页比，避免把两页的行拼成一条假序列。
    def page_gaps(pages: list[dict]) -> list[list[float]]:
        out = []
        for page in pages:
            lines = page["lines"]
            # WPS 指纹的 `y` 就是 baseline；插件指纹同时有 top `y` 和 `baseline`。
            # 两边必须都按 baseline 相减，否则比的是「行顶 vs 基线」。
            def baseline(line: dict) -> float:
                return line.get("baseline", line["y"])

            out.append(
                [
                    round(baseline(lines[i]) - baseline(lines[i - 1]), 2)
                    for i in range(1, len(lines))
                ]
            )
        return out

    def within_paragraph(values: list[float]) -> list[float]:
        if not values:
            return []
        ordered = sorted(values)
        cutoff = ordered[min(len(ordered) - 1, int(len(ordered) * 0.75))]
        return [value for value in values if value <= cutoff * 1.15]

    wps_page_gaps = page_gaps(wps["pages"])
    plugin_page_gaps = page_gaps(plugin_pages)
    wps_gaps = [value for page in wps_page_gaps for value in within_paragraph(page)]
    plugin_gaps = [value for page in plugin_page_gaps for value in within_paragraph(page)]
    gap_check = compare_gaps(wps_gaps, plugin_gaps)

    max_dx = max((abs(g["dx"]) for g in geometry), default=0.0)
    first_dy = geometry[0]["dy"] if geometry else 0.0
    # 文本完全对不上时 geometry 可能为空（表格被拍平等），给默认值，
    # 让报告能跑完并指出"根本没对齐"，而不是在格式化字符串时崩掉。
    if not geometry:
        max_dx = 999.0
        first_dy = 999.0

    checks = {
        "text_identical": distance == 0,
        "text_edit_distance": distance,
        "page_count_equal": len(wps["pages"]) == len(plugin_pages),
        "page_breaks_equal": not page_mismatches,
        "line_breaks_equal": not line_mismatches,
        "indent_within_tol": max_dx <= X_TOL,
        "first_baseline_within_tol": abs(first_dy) <= BASE_Y_TOL,
        "line_pitch_within_tol": gap_check["first_bad"] is None,
    }
    failed = [name for name, ok in checks.items() if isinstance(ok, bool) and not ok]
    if not checks["text_identical"]:
        failed.append(f"text_edit_distance={distance}")
    if not checks["indent_within_tol"]:
        failed.append(f"max_dx={max_dx:.2f}pt>{X_TOL}")
    if not checks["first_baseline_within_tol"]:
        failed.append(f"first_dy={first_dy:+.2f}pt")
    if not checks["line_pitch_within_tol"] and gap_check["first_bad"]:
        bad = gap_check["first_bad"]
        failed.append(
            f"line_pitch {bad['wps']}->{bad['plugin']}pt ({bad['diff']:+.2f}) at line {bad['line']}"
        )

    return {
        "id": plugin.get("fixture"),
        "pass": not failed,
        "failed": failed,
        "checks": checks,
        "stats": {
            "wps_pages": len(wps["pages"]),
            "plugin_pages": len(plugin_pages),
            "wps_lines": len(wps_lines),
            "plugin_lines": len(plugin_lines),
            "max_dx_pt": round(max_dx, 2),
            "first_dy_pt": round(first_dy, 2),
            "line_pitch_max_abs": gap_check["max_abs"],
            "line_pitch_max_ratio": gap_check["max_ratio"],
            "text_edit_distance": distance,
        },
        "page_mismatches": page_mismatches[:12],
        "line_mismatches": line_mismatches[:30],
        "geometry": geometry,
        "line_gaps": {"wps": wps_gaps[:40], "plugin": plugin_gaps[:40]},
        "empty_lines": {
            "wps": sum(1 for _, line in wps_lines if not line["text"].strip()),
            "plugin": sum(1 for _, line in plugin_lines if not line["text"].strip()),
        },
        "fonts": {
            "wps": sorted({f for _, line in wps_lines for f in line.get("fonts", [])}),
            "plugin": sorted({f for _, line in plugin_lines for f in line.get("fonts", [])}),
        },
    }


def render_html(results: list[dict]) -> str:
    rows = []
    for result in results:
        status = "PASS" if result["pass"] else "FAIL"
        color = "#1a7f37" if result["pass"] else "#b42318"
        detail = "<br>".join(html.escape(item) for item in result["failed"]) or "—"
        stats = result.get("stats", {})
        rows.append(
            f"<tr><td>{html.escape(result['id'] or '')}</td>"
            f"<td style='color:{color};font-weight:600'>{status}</td>"
            f"<td>{stats.get('wps_pages', 0)} / {stats.get('plugin_pages', 0)}</td>"
            f"<td>{stats.get('wps_lines', 0)} / {stats.get('plugin_lines', 0)}</td>"
            f"<td>{stats.get('max_dx_pt', 0):.2f}</td>"
            f"<td>{stats.get('first_dy_pt', 0):+.2f}</td>"
            f"<td>{stats.get('line_pitch_max_abs', 0):.2f} ({stats.get('line_pitch_max_ratio', 0):.1%})</td>"
            f"<td>{stats.get('text_edit_distance', 0)}</td>"
            f"<td>{detail}</td></tr>"
        )

    # 把失败归成"根因"，比一串用例名更有用。
    groups = [
        (
            "行高 / 字体度量",
            "pitch",
            "WPS 按行内实际字体算单倍行高；当前引擎用段落默认样式 + Canvas 西文度量。",
            ["C02", "C03", "B07", "G01", "G02", "S02"],
        ),
        (
            "字符缩进 / 字宽",
            "indent",
            "firstLineChars 折算成 px 时与 Word 的取整不同（0.96pt）。",
            ["B08"],
        ),
        (
            "上下标",
            "vertAlign",
            "上下标按 65% 缩排，但基线偏移与行高贡献和 WPS 不同。",
            ["C05"],
        ),
        (
            "空行 / 分页边界",
            "empty",
            "分页符产生的空段被当成一行，导致幽灵空行。",
            ["P06"],
        ),
    ]
    group_html = []
    for title, _tag, explanation, ids in groups:
        hit = [r for r in results if r["id"] in ids and not r["pass"]]
        if not hit:
            continue
        group_html.append(
            f"<li><b>{html.escape(title)}</b>（{', '.join(html.escape(r['id']) for r in hit)}）"
            f"<br><span class='muted'>{html.escape(explanation)}</span></li>"
        )

    sections = []
    for result in results:
        if result["pass"]:
            continue
        geom = "".join(
            f"<tr><td>{g['wps_line']}</td><td>{g['plugin_line']}</td>"
            f"<td>{g['wps_x']:.2f}</td><td>{g['plugin_x']:.2f}</td>"
            f"<td style='color:{'#b42318' if abs(g['dx']) > X_TOL else '#666'}'>{g['dx']:+.2f}</td>"
            f"<td>{g['wps_baseline']:.2f}</td><td>{g['plugin_baseline']:.2f}</td>"
            f"<td style='color:{'#b42318' if abs(g['dy']) > BASE_Y_TOL else '#666'}'>{g['dy']:+.2f}</td>"
            f"<td>{html.escape(g['text'])}</td></tr>"
            for g in result["geometry"][:40]
        )
        lines = "".join(
            f"<li>WPS 行 {m['wps_line']} → 插件行 {m.get('plugin_line')}："
            f"<code>{html.escape(m.get('text') or '')}</code></li>"
            for m in result["line_mismatches"]
        ) or "<li>无</li>"
        pages = "".join(
            f"<li>第 {m['page']} 页：WPS 字符 {m['wps_char']} / 插件 {m['plugin_char']} "
            f"<code>{html.escape(m.get('text') or '')}</code></li>"
            for m in result["page_mismatches"]
        ) or "<li>无</li>"
        sections.append(
            f"<h2>{html.escape(result['id'] or '')}</h2>"
            f"<p><b>失败项：</b>{html.escape(', '.join(result['failed']))}</p>"
            f"<h3>断行差异（前 30）</h3><ul>{lines}</ul>"
            f"<h3>分页差异</h3><ul>{pages}</ul>"
            f"<h3>几何（x / baseline，单位 pt）</h3>"
            f"<table><tr><th>WPS行</th><th>插件行</th><th>WPS x</th><th>插件 x</th><th>dx</th>"
            f"<th>WPS baseline</th><th>插件 baseline</th><th>dy</th><th>文本</th></tr>{geom}</table>"
        )

    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>排版差分报告</title>
<style>
body{{font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:28px;color:#1f2328}}
table{{border-collapse:collapse;margin:10px 0 22px}}
th,td{{border:1px solid #d0d7de;padding:5px 9px;text-align:left;vertical-align:top}}
th{{background:#f6f8fa}}
code{{background:#f6f8fa;padding:1px 4px;border-radius:3px}}
h3{{margin-top:22px}}
.muted{{color:#656d76}}
.finding{{background:#fff8c5;border:1px solid #d4a72c;padding:10px 14px;border-radius:6px}}
</style></head><body>
<h1>排版差分报告</h1>
<p>基准：WPS Office 12.1 导出的 PDF。被测：office-viewer 排版内核（headless Edge）。
X 容差 {X_TOL}pt，首行 baseline 容差 {BASE_Y_TOL}pt，行距容差 {YES_TOL}pt 且 {Y_RATIO_TOL:.0%}；
断行/分页点要求完全一致。</p>
<div class="finding"><b>失败根因聚类</b><ul>{''.join(group_html) or '<li>无</li>'}</ul></div>
<table><tr><th>用例</th><th>结果</th><th>页数 WPS/插件</th><th>行数 WPS/插件</th>
<th>max dx</th><th>首行 dy</th><th>行距最大差</th><th>文本编辑距离</th><th>失败项</th></tr>{''.join(rows)}</table>
{''.join(sections)}
</body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("cases", nargs="*")
    parser.add_argument("--report", default="report.html")
    args = parser.parse_args()

    manifest = json.loads((ROOT / "cases" / "manifest.json").read_text(encoding="utf-8"))
    ids = [case["id"] for case in manifest if case["kind"] == "render"]
    targets = args.cases or ids

    results = []
    for case_id in targets:
        wps_path = OUT / f"{case_id}.wps.json"
        plugin_path = OUT / f"{case_id}.plugin.json"
        if not wps_path.exists() or not plugin_path.exists():
            print(f"skip {case_id}: missing fingerprint", file=sys.stderr)
            continue
        wps = json.loads(wps_path.read_text(encoding="utf-8"))
        plugin = json.loads(plugin_path.read_text(encoding="utf-8"))
        plugin["fixture"] = case_id
        result = compare_case(wps, plugin)
        results.append(result)
        mark = "PASS" if result["pass"] else "FAIL"
        print(
            f"{mark} {case_id:4}  pages {result['stats']['wps_pages']}/{result['stats']['plugin_pages']}"
            f"  lines {result['stats']['wps_lines']}/{result['stats']['plugin_lines']}"
            f"  dx={result['stats']['max_dx_pt']:.2f} dy={result['stats']['first_dy_pt']:+.2f}"
            f"  pitch={result['stats']['line_pitch_max_abs']:.2f}"
            f"  edit={result['stats']['text_edit_distance']}"
            + (f"  <- {', '.join(result['failed'])}" if result["failed"] else "")
        )

    previous_by_id = {}
    results_path = OUT / "results.json"
    if args.cases and results_path.exists():
        try:
            previous = json.loads(results_path.read_text(encoding="utf-8"))
            previous_by_id = {item["id"]: item for item in previous if item.get("id")}
        except (json.JSONDecodeError, OSError):
            previous_by_id = {}

    results_path.write_text(
        json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    # 只跑子集时不要把整份报告缩成子集：把上一次的全量结果合并进来。
    merged = results
    if args.cases and previous_by_id:
        previous_by_id.update({item["id"]: item for item in results})
        merged = [previous_by_id[key] for key in sorted(previous_by_id)]
    report = OUT / args.report
    report.write_text(render_html(merged), encoding="utf-8")

    passed = sum(1 for item in merged if item["pass"])
    print(f"\n{passed}/{len(merged)} pass -> {report}")
    return 0 if all(item["pass"] for item in results) else 1


if __name__ == "__main__":
    sys.exit(main())
