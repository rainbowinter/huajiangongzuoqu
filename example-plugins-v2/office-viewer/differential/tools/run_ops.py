#!/usr/bin/env python3
"""
双端操作差分：同一份 ops/*.json，分别喂给 WPS（COM）和插件（replayEdit），
比较两边操作之后的文档行为。

    python tools/run_ops.py                 # 跑 ops/ 下全部
    python tools/run_ops.py O01 O02
    python tools/run_ops.py --keep-wps      # 复用 WPS 实例（调试用）

产物：
    out/<id>.wps-ops.json      WPS 投影（段落/run/表格）
    out/<id>.plugin-ops.json   插件投影（blocks/runs/documentXml）
    out/ops-results.json       比较结果
    out/ops-report.html        可读报告

注意：WPS 的 COM 调用是串行的，别并发跑两份。
"""

from __future__ import annotations

import argparse
import base64
import functools
import html
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
OPS = ROOT / "ops"
PWSH = Path(os.environ.get("SystemRoot", r"C:\Windows")) / (
    "System32/WindowsPowerShell/v1.0/powershell.exe"
)
NODE_CANDIDATES = [
    shutil.which("node") or "",
    r"C:\Program Files\nodejs\node.exe",
]
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


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        pass


def serve(directory: Path):
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def build_engine() -> None:
    node = first_existing(NODE_CANDIDATES)
    proc = subprocess.run(
        [node, str(ROOT / "tools" / "build_edit.mjs")],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(f"build failed (exit {proc.returncode})")
    print(proc.stdout.strip())


def run_wps(fixture: str, ops_path: Path, target: Path) -> dict:
    if target.exists():
        target.unlink()
    proc = subprocess.run(
        [
            str(PWSH), "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(ROOT / "tools" / "wps_ops.ps1"),
            "-Fixture", str(ROOT / "fixtures" / f"{fixture}.docx"),
            "-Ops", str(ops_path),
            "-Out", str(target),
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
    )
    if proc.returncode != 0 or not target.exists():
        raise RuntimeError(f"WPS ops failed: {proc.stdout[-800:]}{proc.stderr[-1200:]}")
    return json.loads(target.read_text(encoding="utf-8-sig"))


def run_plugin(browser: str, port: int, fixture: str, ops_rel: str) -> dict:
    profile = tempfile.mkdtemp(prefix="ops-prof-")
    try:
        proc = subprocess.run(
            [
                browser, "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", "--disable-extensions",
                "--virtual-time-budget=20000",
                f"--user-data-dir={profile}", "--dump-dom",
                f"http://127.0.0.1:{port}/ops-harness.html?fixture={fixture}&ops={ops_rel}",
            ],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    dom = proc.stdout or ""
    error = re.search(r'<pre id="error">(.*?)</pre>', dom, re.S)
    if error and "HARNESS-ERROR" in error.group(1):
        raise RuntimeError(error.group(1).strip()[:3000])
    match = re.search(r'<pre id="result">([A-Za-z0-9+/=]+)</pre>', dom)
    if not match:
        raise RuntimeError(f"no result (exit {proc.returncode}, {len(dom)} bytes)")
    return json.loads(base64.b64decode(match.group(1)).decode("utf-8"))


def normalize(wps: dict, plugin: dict) -> tuple[list[dict], list[dict]]:
    """两边投影成同一形状：{text, runs:[{text,bold,italic}], numbering}。"""

    w_paras = []
    for para in wps.get("paragraphs", []):
        # WPS 的 run 是逐词切开的；合并相邻同样式 run，避免粒度噪声。
        runs = []
        for run in para.get("runs", []):
            text = (run.get("text") or "").replace("\r", "")
            if not text.strip():
                continue
            key = (bool(run.get("bold")), bool(run.get("italic")))
            if runs and (runs[-1]["bold"], runs[-1]["italic"]) == key:
                runs[-1]["text"] += text
            else:
                runs.append({"text": text, "bold": key[0], "italic": key[1]})
        w_paras.append(
            {
                # 软换行在 WPS 里是 \v，插件里是 \n；统一成 \n 再比。
                "text": (para.get("text") or "").replace("\r", "").replace("\v", "\n"),
                "runs": runs,
                "numbering": para.get("numbering"),
            }
        )

    p_paras = []
    for block in plugin.get("blocks", []):
        runs = []
        for run in block.get("runs", []):
            text = run.get("text", "")
            if not text.strip():
                continue
            key = (bool(run.get("bold")), bool(run.get("italic")))
            if runs and (runs[-1]["bold"], runs[-1]["italic"]) == key:
                runs[-1]["text"] += text
            else:
                runs.append({"text": text, "bold": key[0], "italic": key[1]})
        p_paras.append(
            {
                "text": block.get("text", ""),
                "runs": runs,
                "numbering": block.get("numPr"),
            }
        )
    return w_paras, p_paras


def compare(case_id: str, wps: dict, plugin: dict) -> dict:
    w_paras, p_paras = normalize(wps, plugin)

    w_text = "\n".join(p["text"] for p in w_paras)
    p_text = "\n".join(p["text"] for p in p_paras)

    has_tables = bool(wps.get("tables") or plugin.get("tables"))
    checks = {}
    if not has_tables:
        checks = {
            "text_equal": w_text == p_text,
            "paragraph_count_equal": len(w_paras) == len(p_paras),
            # 只比"有没有编号"。WPS 的 numId 是运行时哈希、ilvl 也不稳定（实测
            # 单级列表报成 1），跨实现没有语义，不能拿 ID 比。
            "numbering_equal": [bool(p["numbering"]) for p in w_paras]
            == [bool(p["numbering"]) for p in p_paras],
        }
    # 表格：比较每个单元格的段落文本（WPS 用 \r 分段，插件用 paragraphs 数组）。
    w_tables = []
    for table in wps.get("tables", []):
        rows = []
        for row in table.get("cells", []) or []:
            cells = []
            for cell in row:
                text = (cell or "").replace("\r", "\n").rstrip("\n")
                cells.append([part for part in text.split("\n")])
            rows.append(cells)
        w_tables.append(rows)

    p_tables = []
    for table in plugin.get("tables", []):
        rows = []
        for row in table.get("rows", []):
            cells = []
            for cell in row.get("cells", []):
                if cell.get("hidden"):
                    cells.append([])
                else:
                    cells.append([
                        paragraph.get("text", "") if isinstance(paragraph, dict) else str(paragraph)
                        for paragraph in cell.get("paragraphs", [])
                    ])
            rows.append(cells)
        p_tables.append(rows)

    if has_tables:
        # 合并单元格在两端展开成网格的方式不同（WPS 的 Cell(r,c) 会把合并格
        # 重复/跳过），这里先比“整张表按阅读顺序的纯文本”。
        def table_flat_text(tables, source):
            parts = []
            for table in tables:
                if source == "wps":
                    parts.append("".join(
                        ch for ch in (table.get("text") or "") if ch.isprintable() and not ch.isspace()
                    ))
                else:
                    for row in table.get("rows", []):
                        for cell in row.get("cells", []):
                            if cell.get("hidden"):
                                continue
                            for paragraph in cell.get("paragraphs", []):
                                text = paragraph.get("text", "") if isinstance(paragraph, dict) else str(paragraph)
                                parts.append("".join(
                                    ch for ch in text if ch.isprintable() and not ch.isspace()
                                ))
            return "".join(parts)

        checks["tables_equal"] = table_flat_text(wps.get("tables", []), "wps") == table_flat_text(
            plugin.get("tables", []), "plugin"
        )

    # 粗体：按字符展开，而不是按 run。WPS 的 Words 会把软换行、标点单独切
    # 成 run，按 run 比会把切分粒度当成格式差异。
    def bold_per_char(paras):
        out = []
        for para in paras:
            flags = []
            for run in para["runs"]:
                flags.extend([bool(run.get("bold"))] * len(run["text"]))
            out.append(flags)
        return out

    if not has_tables:
        w_style = bold_per_char(w_paras)
        p_style = bold_per_char(p_paras)
        checks["bold_sequence_equal"] = all(
            a[: min(len(a), len(b))] == b[: min(len(a), len(b))]
            for a, b in zip(w_style, p_style)
        ) and len(w_style) == len(p_style)

    # 光标：WPS 投影是 {block, offset}，插件是 {blockIndex, offset}。
    w_caret = wps.get("caret")
    p_caret = plugin.get("caret")
    if w_caret is not None and p_caret is not None:
        if has_tables:
            # 表格里的段落编号在两端不在同一个序列里，只比单元格内偏移。
            checks["caret_equal"] = (
                int(w_caret.get("offset", -1)) == int(p_caret.get("offset", -2))
            )
        else:
            checks["caret_equal"] = (
                int(w_caret.get("block", -1)) == int(p_caret.get("blockIndex", -2))
                and int(w_caret.get("offset", -1)) == int(p_caret.get("offset", -2))
            )
    elif w_caret is None and p_caret is None:
        # 两端都没有光标信息：这一项不参与判定，避免"缺数据 = 失败"。
        checks["caret_equal"] = True

    failed = [name for name, ok in checks.items() if not ok]

    # 找第一个不同的段落，给报告用
    first_diff = None
    for index in range(max(len(w_paras), len(p_paras))):
        w = w_paras[index]["text"] if index < len(w_paras) else "<缺段>"
        p = p_paras[index]["text"] if index < len(p_paras) else "<缺段>"
        if w != p:
            first_diff = {"paragraph": index, "wps": w, "plugin": p}
            break

    return {
        "id": case_id,
        "pass": not failed,
        "failed": failed,
        "checks": checks,
        "stats": {
            "wps_paragraphs": len(w_paras),
            "plugin_paragraphs": len(p_paras),
            "wps_chars": len(w_text),
            "plugin_chars": len(p_text),
            "wps_tables": len(w_tables),
            "plugin_tables": len(p_tables),
            "wps_caret": w_caret,
            "plugin_caret": p_caret,
        },
        "first_diff": first_diff,
        "wps_text": w_text,
        "plugin_text": p_text,
        "wps_tables": len(wps.get("tables", [])),
        "plugin_has_table": "<w:tbl" in plugin.get("documentXml", ""),
    }


def render_html(results: list[dict]) -> str:
    rows = []
    sections = []
    for result in results:
        color = "#1a7f37" if result["pass"] else "#b42318"
        rows.append(
            f"<tr><td>{html.escape(result['id'])}</td>"
            f"<td style='color:{color};font-weight:600'>{'PASS' if result['pass'] else 'FAIL'}</td>"
            f"<td>{result['stats'].get('wps_paragraphs', 0)} / {result['stats'].get('plugin_paragraphs', 0)}</td>"
            f"<td>{result['stats'].get('wps_chars', 0)} / {result['stats'].get('plugin_chars', 0)}</td>"
            f"<td>{html.escape(', '.join(result['failed'])) or '—'}</td></tr>"
        )
        if result["pass"]:
            continue
        diff = result.get("first_diff")
        detail = (
            f"<p><b>第一个不同段落：</b>#{diff['paragraph']}<br>"
            f"WPS：<code>{html.escape(diff['wps'])}</code><br>"
            f"插件：<code>{html.escape(diff['plugin'])}</code></p>"
            if diff
            else ""
        )
        sections.append(
            f"<h2>{html.escape(result['id'])}</h2>{detail}"
            f"<h3>完整文本</h3>"
            f"<pre>WPS : {html.escape(result['wps_text'])}</pre>"
            f"<pre>插件: {html.escape(result['plugin_text'])}</pre>"
        )
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>双端操作差分</title><style>
body{{font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:28px;color:#1f2328}}
table{{border-collapse:collapse;margin:10px 0 22px}}
th,td{{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}}
th{{background:#f6f8fa}} code{{background:#f6f8fa;padding:1px 4px}}
pre{{background:#f6f8fa;padding:10px;white-space:pre-wrap}}
</style></head><body>
<h1>双端操作差分</h1>
<p>同一份 <code>ops/*.json</code>：WPS 走 COM，插件走 <code>replayEdit</code>。
比较文本、段落数、编号、粗体序列。</p>
<table><tr><th>用例</th><th>结果</th><th>段落 WPS/插件</th><th>字符 WPS/插件</th><th>失败项</th></tr>
{''.join(rows)}</table>{''.join(sections)}
</body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("cases", nargs="*")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--keep-wps", action="store_true", help="兼容旧参数，目前无作用")
    args = parser.parse_args()

    if not args.no_build:
        build_engine()

    op_files = sorted(OPS.glob("*.json"))
    if args.cases:
        wanted = set(args.cases)
        op_files = [p for p in op_files if p.stem in wanted]
    if not op_files:
        raise SystemExit("no ops/*.json")

    OUT.mkdir(parents=True, exist_ok=True)
    browser = first_existing(BROWSER_CANDIDATES)
    server, port = serve(ROOT)
    results = []
    try:
        for ops_path in op_files:
            case_id = ops_path.stem
            fixture = case_id
            if not (ROOT / "fixtures" / f"{fixture}.docx").exists():
                print(f"skip {case_id}: no fixtures/{fixture}.docx", file=sys.stderr)
                continue
            try:
                wps = run_wps(fixture, ops_path, OUT / f"{case_id}.wps-ops.json")
                plugin = run_plugin(browser, port, fixture, f"ops/{case_id}.json")
                (OUT / f"{case_id}.plugin-ops.json").write_text(
                    json.dumps(plugin, ensure_ascii=False, indent=1), encoding="utf-8"
                )
                result = compare(case_id, wps, plugin)
                results.append(result)
                mark = "PASS" if result["pass"] else "FAIL"
                print(
                    f"{mark} {case_id}  paras {result['stats']['wps_paragraphs']}/"
                    f"{result['stats']['plugin_paragraphs']}  chars "
                    f"{result['stats']['wps_chars']}/{result['stats']['plugin_chars']}"
                    + (f"  <- {', '.join(result['failed'])}" if result["failed"] else "")
                )
            except Exception as exc:  # noqa: BLE001
                print(f"FAIL {case_id}  {exc}", file=sys.stderr)
                results.append(
                    {"id": case_id, "pass": False, "failed": [str(exc)[:200]],
                     "checks": {}, "stats": {}, "first_diff": None,
                     "wps_text": "", "plugin_text": "", "wps_tables": 0,
                     "plugin_has_table": False}
                )
    finally:
        server.shutdown()

    (OUT / "ops-results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (OUT / "ops-report.html").write_text(render_html(results), encoding="utf-8")
    passed = sum(1 for r in results if r["pass"])
    print(f"\n{passed}/{len(results)} pass -> {OUT / 'ops-report.html'}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
