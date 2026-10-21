#!/usr/bin/env python3
"""表格单元格编辑的单端验证（不经过 WPS）。"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import run_ops  # noqa: E402

CASES = [
    (
        "insert",
        [{"op": "place", "key": "t1r1c0p0", "offset": 0}, {"op": "type", "text": "新"}],
        ["新甲项"],
    ),
    (
        "split",
        [
            {"op": "place", "key": "t1r1c0p0", "offset": 1},
            {"op": "key", "key": "Enter"},
            {"op": "type", "text": "新"},
        ],
        ["甲", "新项"],
    ),
    (
        "merge",
        [
            {"op": "place", "key": "t1r1c0p0", "offset": 1},
            {"op": "key", "key": "Enter"},
            {"op": "place", "key": "p2", "offset": 0},
            {"op": "key", "key": "Backspace"},
        ],
        ["甲项"],
    ),
    (
        "cross-paragraph-delete",
        [
            {"op": "place", "key": "t1r1c0p0", "offset": 1},
            {"op": "key", "key": "Enter"},
            {
                "op": "select",
                "from": {"key": "t1r1c0p0", "offset": 1},
                "to": {"key": "p2", "offset": 1},
            },
            {"op": "key", "key": "Backspace"},
        ],
        ["甲"],
    ),
    (
        "bold-in-cell",
        [
            {
                "op": "select",
                "from": {"key": "t1r1c0p0", "offset": 0},
                "to": {"key": "t1r1c0p0", "offset": 2},
            },
            {"op": "format", "key": "bold", "value": True},
        ],
        ["甲项"],
    ),
]


def cell_paragraphs(projection: dict) -> list:
    return projection["tables"][0]["rows"][1]["cells"][0]["paragraphs"]


def write_ops(path: Path, ops: list) -> None:
    path.write_text(json.dumps(ops, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    subprocess.run([node, str(ROOT / "tools" / "build_edit.mjs")], cwd=ROOT, check=True)
    browser = run_ops.first_existing(run_ops.BROWSER_CANDIDATES)
    server, port = run_ops.serve(ROOT)
    failures = 0
    results = []
    try:
        for name, ops, expected in CASES:
            # ops-harness 通过仓库内的相对 URL 取 transcript，临时文件要落在 ops/ 下。
            ops_path = ROOT / "ops" / f".table-edit-{name}.json"
            write_ops(ops_path, ops)
            try:
                projection = run_ops.run_plugin(
                    browser, port, "TB1", f"ops/{ops_path.name}"
                )
            finally:
                ops_path.unlink(missing_ok=True)
            paragraphs = cell_paragraphs(projection)
            texts = [paragraph["text"] for paragraph in paragraphs]
            ok = texts == expected
            if name == "bold-in-cell":
                ok = ok and all(run["bold"] for run in paragraphs[0]["runs"])
            print(f"{'ok  ' if ok else 'FAIL'} {name}: {texts}")
            results.append({"id": name, "pass": ok, "texts": texts})
            if not ok:
                failures += 1

        # 插入新表格：在普通段落后面建一张 2×3 的表。
        ops_path = ROOT / "ops" / ".table-edit-insert-table.json"
        write_ops(ops_path, [{"op": "place", "block": 0, "offset": 0}, {"op": "insertTable", "rows": 2, "cols": 3}])
        try:
            projection = run_ops.run_plugin(browser, port, "O01", f"ops/{ops_path.name}")
        finally:
            ops_path.unlink(missing_ok=True)
        tables = projection.get("tables", [])
        ok = (
            len(tables) == 1
            and len(tables[0]["rows"]) == 2
            and all(len(row["cells"]) == 3 for row in tables[0]["rows"])
        )
        print(f"{'ok  ' if ok else 'FAIL'} insert-table: {len(tables)} table(s)")
        results.append({"id": "insert-table", "pass": ok})
        if not ok:
            failures += 1
    finally:
        server.shutdown()
    (ROOT / "out" / "table-edit-results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"\n{len(CASES) + 1 - failures}/{len(CASES) + 1} table editing cases passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
