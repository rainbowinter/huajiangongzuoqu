#!/usr/bin/env python3
"""
在 headless Edge（与 WebView2 同引擎）里跑插件的排版内核，产出指纹。

流程：
  1. node tools/build_layout.mjs  -> out/layout-engine.js
  2. 起一个只读 HTTP 服务（file:// + fetch 会被 Chromium 拦）
  3. Edge --headless --dump-dom 打开 harness.html?f=<id>
  4. 从 DOM 里取出 base64(JSON)，写 out/<id>.plugin.json

用法：
    python run_layout.py                 # 全部渲染类用例
    python run_layout.py C01 B02         # 指定用例
    python run_layout.py --no-build      # 跳过打包
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
        [node, str(ROOT / "tools" / "build_layout.mjs")],
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
    def log_message(self, *_args) -> None:  # 静音
        pass


def serve(directory: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]


def run_one(browser: str, port: int, fixture: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="edge-prof-") as profile:
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
                f"http://127.0.0.1:{port}/harness.html?f={fixture}",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
        )
    dom = proc.stdout or ""
    error = re.search(r'<pre id="error">(.*?)</pre>', dom, re.S)
    if error and "HARNESS-ERROR" in error.group(1):
        raise RuntimeError(error.group(1).strip()[:4000])
    match = re.search(r'<pre id="result">([A-Za-z0-9+/=]+)</pre>', dom)
    if not match:
        raise RuntimeError(f"no result in DOM (exit {proc.returncode}, {len(dom)} bytes)\n{dom[-1500:]}")
    return json.loads(base64.b64decode(match.group(1)).decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixtures", nargs="*")
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()

    if not args.no_build:
        build_engine()
    engine = OUT / "layout-engine.js"
    if not engine.exists():
        raise SystemExit(f"missing {engine}; run without --no-build first")

    manifest = json.loads((ROOT / "cases" / "manifest.json").read_text(encoding="utf-8"))
    render_ids = [case["id"] for case in manifest if case["kind"] == "render"]
    targets = args.fixtures or render_ids
    unknown = [item for item in targets if item not in render_ids]
    if unknown:
        raise SystemExit(f"unknown render fixtures: {unknown}")

    browser = first_existing(BROWSER_CANDIDATES)
    server, port = serve(ROOT)
    failures = 0
    try:
        for fixture in targets:
            try:
                fingerprint = run_one(browser, port, fixture)
                OUT.mkdir(parents=True, exist_ok=True)
                target = OUT / f"{fixture}.plugin.json"
                target.write_text(
                    json.dumps(fingerprint, ensure_ascii=False, indent=1), encoding="utf-8"
                )
                stats = fingerprint["stats"]
                print(f"ok   {fixture}  {stats['pageCount']}P {stats['lineCount']}L -> {target.name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {fixture}  {exc}", file=sys.stderr)
    finally:
        server.shutdown()

    print(f"\n{len(targets) - failures}/{len(targets)} ok")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
