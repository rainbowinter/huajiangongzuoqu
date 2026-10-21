#!/usr/bin/env python3
"""
统一验收协议：一次跑完排版 / 单端编辑 / 双端操作三层。

不重新生成夹具、不调用 WPS 导出 PDF；前提是 `fixtures/`、`ref/` 已经就位。
这样两个会话共用同一套稳定入口，不会互相覆盖 `build_fixtures.py` 的产物。

    python tools/run_protocol.py            # 三层全跑
    python tools/run_protocol.py --no-build # 复用已打好的 engine bundle

产物：
    out/protocol-results.json
    out/protocol-report.html
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
PYTHON = Path(sys.executable)

# 稳定基线。T01–T04 是另一个会话的试验夹具，暂不进入协议；
# 表格用本目录生成器产出的 TB1–TB3。
CORE_RENDER = [
    "C01", "C02", "C03", "C04", "C05", "C06",
    "B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08",
    "S01", "S02", "S03",
    "A01", "A02",
    "P01", "P02", "P03", "P04", "P05", "P06",
    "G01", "G02",
    "L01",
]
TABLE_RENDER = ["TB1", "TB2", "TB3"]
TABLE_XFAIL: list[str] = []

ALLOWED_OPS = {"place", "placeCell", "select", "type", "ime", "paste", "key", "format"}
ALLOWED_KEYS = {"Enter", "Shift+Enter", "Backspace", "Delete", "Tab", "Ctrl+Z", "Ctrl+Y"}
# WPS 驱动还没有 Undo/Redo（Selection 上没有对应命令）。这些用例先标 pending，
# 不进入 ops 结果；驱动补上后从 PENDING_OPS 移除即可。
PENDING_OPS: set[str] = set()


def run(args: list[str]) -> int:
    proc = subprocess.run(
        args,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.stdout.strip():
        print(proc.stdout.rstrip())
    if proc.returncode != 0 and proc.stderr.strip():
        print(proc.stderr.rstrip(), file=sys.stderr)
    return proc.returncode


def build_engines() -> None:
    node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    for script in ("build_layout.mjs", "build_edit.mjs"):
        code = run([node, str(ROOT / "tools" / script)])
        if code != 0:
            raise SystemExit(f"{script} failed")


def available_ops() -> list[str]:
    ids = []
    for path in sorted((ROOT / "ops").glob("*.json")):
        try:
            ops = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:  # noqa: BLE001
            continue
        if all(
            op.get("op") in ALLOWED_OPS
            and (op.get("op") != "key" or op.get("key") in ALLOWED_KEYS)
            for op in ops
        ) and path.stem not in PENDING_OPS:
            ids.append(path.stem)
    return ids


def render_layer(ids: list[str], browser: str | None = None) -> list[dict]:
    sys.path.insert(0, str(ROOT / "tools"))
    import run_layout as layout  # noqa: PLC0415

    if browser is None:
        browser = layout.first_existing(layout.BROWSER_CANDIDATES)
    server, port = layout.serve(ROOT)
    try:
        for case_id in ids:
            fixture = ROOT / "fixtures" / f"{case_id}.docx"
            if not fixture.exists():
                print(f"skip {case_id}: missing fixture", file=sys.stderr)
                continue
            try:
                fingerprint = layout.run_one(browser, port, case_id)
                (OUT / f"{case_id}.plugin.json").write_text(
                    json.dumps(fingerprint, ensure_ascii=False, indent=1),
                    encoding="utf-8",
                )
                print(f"ok   {case_id}")
            except Exception as exc:  # noqa: BLE001
                print(f"FAIL {case_id}: {exc}", file=sys.stderr)
    finally:
        server.shutdown()

    run([str(PYTHON), str(ROOT / "tools/compare.py"), *ids])
    path = OUT / "results.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def edit_layer() -> list[dict]:
    run([str(PYTHON), str(ROOT / "tools/replay_edit.py"), "--no-build"])
    path = OUT / "edit-results.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def ops_layer(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    run([str(PYTHON), str(ROOT / "tools/run_ops.py"), "--no-build", *ids])
    path = OUT / "ops-results.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def table_edit_layer() -> list[dict]:
    run([str(PYTHON), str(ROOT / "tools/test_table_editing.py"), "--no-build"])
    path = OUT / "table-edit-results.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def summarize(results: list[dict], xfail: set[str] | None = None) -> dict:
    xfail = xfail or set()
    cases = []
    passed = 0
    failed = 0
    for result in results:
        case_id = result.get("id")
        ok = bool(result.get("pass"))
        if case_id in xfail:
            status = "XFAIL" if not ok else "XPASS"
        else:
            status = "PASS" if ok else "FAIL"
            if ok:
                passed += 1
            else:
                failed += 1
        cases.append({"id": case_id, "status": status, "failed": result.get("failed", [])})
    return {"pass": passed, "fail": failed, "cases": cases}


def render_report(report: dict) -> str:
    rows = []
    for layer in ("render", "edit", "ops", "tableEdit"):
        for case in report[layer]["cases"]:
            color = {
                "PASS": "#1a7f37",
                "FAIL": "#b42318",
                "XFAIL": "#9a6700",
                "XPASS": "#0969da",
            }[case["status"]]
            rows.append(
                f"<tr><td>{layer}</td><td>{case['id']}</td>"
                f"<td style='color:{color};font-weight:600'>{case['status']}</td>"
                f"<td>{'; '.join(case['failed'])}</td></tr>"
            )
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>office-viewer 验收协议</title><style>
body{{font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:28px;color:#1f2328}}
table{{border-collapse:collapse}}th,td{{border:1px solid #d0d7de;padding:6px 10px;text-align:left}}
th{{background:#f6f8fa}} .ok{{color:#1a7f37}} .bad{{color:#b42318}}
</style></head><body>
<h1>office-viewer 验收协议</h1>
<p class="{'ok' if report['overall_pass'] else 'bad'}">
排版 {report['render']['pass']}/{report['render']['pass'] + report['render']['fail']}，
编辑 {report['edit']['pass']}/{report['edit']['pass'] + report['edit']['fail']}，
双端操作 {report['ops']['pass']}/{report['ops']['pass'] + report['ops']['fail']}，
表格编辑 {report['tableEdit']['pass']}/{report['tableEdit']['pass'] + report['tableEdit']['fail']}。
</p>
<table><tr><th>层</th><th>用例</th><th>结果</th><th>失败项</th></tr>
{''.join(rows)}
</table></body></html>"""


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()

    if not args.no_build:
        build_engines()

    render_ids = CORE_RENDER + TABLE_RENDER + TABLE_XFAIL
    render_results = render_layer(render_ids)
    render = summarize(render_results, set(TABLE_XFAIL))
    edit = summarize(edit_layer())
    ops = summarize(ops_layer(available_ops()))
    table_edit = summarize(table_edit_layer())

    report = {
        "protocol": "office-viewer-test-protocol/1",
        "render": render,
        "edit": edit,
        "ops": ops,
        "tableEdit": table_edit,
        "xfail": TABLE_XFAIL,
        "overall_pass": (
            render["fail"] == 0
            and edit["fail"] == 0
            and ops["fail"] == 0
            and table_edit["fail"] == 0
        ),
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "protocol-results.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (OUT / "protocol-report.html").write_text(render_report(report), encoding="utf-8")
    print(
        f"\nrender {render['pass']}/{render['pass'] + render['fail']}  "
        f"edit {edit['pass']}/{edit['pass'] + edit['fail']}  "
        f"ops {ops['pass']}/{ops['pass'] + ops['fail']}  "
        f"tableEdit {table_edit['pass']}/{table_edit['pass'] + table_edit['fail']}  "
        f"-> out/protocol-report.html"
    )
    return 0 if report["overall_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
