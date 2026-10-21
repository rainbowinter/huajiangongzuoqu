#!/usr/bin/env python3
"""
重放编辑用例 E01–E10，并与 manifest 的期望比对。

和渲染差分不同：这里不经过 UI / WPS，而是直接调用插件的
`src/edit/operations.js`，验证「同一串操作之后，模型里的文字、段落数、
numPr / run 格式」是否符合规格。

用法：
    python tools/replay_edit.py
    python tools/replay_edit.py E08 E09
    python tools/replay_edit.py --no-build
"""

from __future__ import annotations

import argparse
import base64
import functools
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
NODE_CANDIDATES = [
    shutil.which("node") or "",
    r"C:\Program Files\nodejs\node.exe",
    r"C:\Program Files (x86)\nodejs\node.exe",
]
# 优先 Chrome：这台机器的 Edge headless 偶尔会静默返回 0 字节 DOM。
BROWSER_CANDIDATES = [
    str(Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        / "Google" / "Chrome" / "Application" / "chrome.exe"),
    str(Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
    str(Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
]


def first_existing(paths: list[str]) -> str:
    for path in paths:
        if path and Path(path).exists():
            return path
    raise SystemExit(f"not found: {paths}")


def build_engine() -> None:
    node = first_existing(NODE_CANDIDATES)
    proc = subprocess.run(
        [node, str(ROOT / "tools" / "build_edit.mjs")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(f"build failed (exit {proc.returncode})")
    print(proc.stdout.strip())


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        pass


def serve(directory: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def run_one(browser: str, port: int, case_id: str) -> dict:
    profile = tempfile.mkdtemp(prefix="edit-prof-")
    try:
        proc = subprocess.run(
            [
                browser,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--virtual-time-budget=20000",
                f"--user-data-dir={profile}",
                "--dump-dom",
                f"http://127.0.0.1:{port}/edit-harness.html?id={case_id}",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
        )
    finally:
        # 浏览器可能还握着 lockfile；清理失败不影响结果。
        shutil.rmtree(profile, ignore_errors=True)
    dom = proc.stdout or ""
    error = re.search(r'<pre id="error">(.*?)</pre>', dom, re.S)
    if error and "HARNESS-ERROR" in error.group(1):
        raise RuntimeError(error.group(1).strip()[:4000])
    match = re.search(r'<pre id="result">([A-Za-z0-9+/=]+)</pre>', dom)
    if not match:
        raise RuntimeError(f"no result in DOM (exit {proc.returncode}, {len(dom)} bytes)\n{dom[-1500:]}")
    return json.loads(base64.b64decode(match.group(1)).decode("utf-8"))


def xml_checks(case: dict, result: dict) -> dict[str, bool]:
    """把 manifest 里的人类可读 xml 期望落成可判定的布尔值。"""
    cid = case["id"]
    blocks = result.get("blocks", [])
    xml = result.get("documentXml", "")
    checks: dict[str, bool] = {}

    if cid == "E01":
        checks["run_rPr_preserved"] = 'w:eastAsia="宋体"' in xml or "w:eastAsia=" in xml
        checks["xml_space_preserve"] = 'xml:space="preserve"' in xml
    elif cid == "E02":
        for index, block in enumerate(blocks[:2]):
            checks[f"p{index}_keeps_firstLineChars"] = "firstLineChars" in block.get("pPr", "")
            checks[f"p{index}_keeps_line"] = "w:line=" in block.get("pPr", "")
        checks["second_no_sectPr"] = bool(blocks[1:]) and "sectPr" not in blocks[1].get("pPr", "")
    elif cid == "E05":
        checks["same_paragraph"] = result.get("paras") == 1
        checks["has_w_br"] = "<w:br" in xml
    elif cid == "E06":
        runs = blocks[0].get("runs", []) if blocks else []
        checks["first_run_still_bold"] = bool(runs) and runs[0]["text"].startswith("甲") and runs[0]["bold"]
        checks["last_run_still_plain"] = bool(runs) and runs[-1]["text"].endswith("丁") and not runs[-1]["bold"]
        checks["no_empty_runs"] = all(run["text"] for run in runs)
    elif cid == "E08":
        checks["first_numPr_removed"] = bool(blocks) and blocks[0].get("numPr") is None
        checks["second_still_numbered"] = len(blocks) > 1 and blocks[1].get("numPr") is not None
        labels = blocks[1].get("labels", []) if len(blocks) > 1 else []
        checks["second_renumbered_1"] = bool(labels) and labels[0] == "1."
    elif cid == "E09":
        checks["empty_item_keeps_numPr"] = len(blocks) > 1 and blocks[1].get("numPr") is not None
        checks["new_item_same_numId"] = (
            len(blocks) > 2
            and blocks[1].get("numPr") is not None
            and blocks[2].get("numPr") is not None
            and blocks[1]["numPr"].get("numId") == blocks[2]["numPr"].get("numId")
        )
    elif cid == "E10":
        checks["paste_created_two_paras"] = result.get("paras") == 2
        checks["newline_became_w_p"] = xml.count("<w:p ") + xml.count("<w:p>") >= 2
    else:
        checks["xml_has_content"] = bool(xml)

    return checks


def evaluate(case: dict, result: dict) -> tuple[bool, list[str], dict[str, bool]]:
    expect = case.get("expect", {})
    failed: list[str] = []
    checks: dict[str, bool] = {}

    if "text" in expect:
        checks["text"] = result.get("text") == expect["text"]
    if "paras" in expect:
        checks["paras"] = result.get("paras") == expect["paras"]
    checks.update(xml_checks(case, result))

    for name, ok in checks.items():
        if not ok:
            failed.append(name)
    return not failed, failed, checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("ids", nargs="*")
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    if not args.no_build:
        build_engine()
    engine = OUT / "edit-engine.js"
    if not engine.exists():
        raise SystemExit(f"missing {engine}; run without --no-build first")

    manifest = json.loads((ROOT / "cases" / "manifest.json").read_text(encoding="utf-8"))
    edit_cases = [case for case in manifest if case.get("kind") == "edit"]
    by_id = {case["id"]: case for case in edit_cases}
    targets = args.ids or [case["id"] for case in edit_cases]
    unknown = [item for item in targets if item not in by_id]
    if unknown:
        raise SystemExit(f"unknown edit cases: {unknown}")

    browser = first_existing(BROWSER_CANDIDATES)
    server, port = serve(ROOT)
    summary = []
    try:
        for case_id in targets:
            case = by_id[case_id]
            try:
                result = run_one(browser, port, case_id)
                ok, failed, checks = evaluate(case, result)
                OUT.mkdir(parents=True, exist_ok=True)
                (OUT / f"{case_id}.edit.json").write_text(
                    json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
                )
                summary.append({"id": case_id, "pass": ok, "failed": failed, "checks": checks})
                mark = "ok  " if ok else "FAIL"
                detail = "" if ok else "  " + ", ".join(failed)
                print(f"{mark} {case_id}  {case['title']}{detail}")
            except Exception as exc:  # noqa: BLE001
                summary.append({"id": case_id, "pass": False, "failed": ["exception"], "error": str(exc)})
                print(f"FAIL {case_id}  {exc}", file=sys.stderr)
    finally:
        server.shutdown()

    (OUT / "edit-results.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    passed = sum(1 for item in summary if item["pass"])
    print(f"\n{passed}/{len(summary)} edit cases passed -> out/edit-results.json")
    return 0 if passed == len(summary) else 1


if __name__ == "__main__":
    sys.exit(main())
