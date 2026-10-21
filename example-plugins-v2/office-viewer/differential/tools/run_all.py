#!/usr/bin/env python3
"""
一键跑完整条差分流水线（Windows / 本机有 WPS）。

    python run_all.py                # 打包 -> 夹具 -> WPS 基准 -> 插件指纹 -> 比较 -> 报告
    python run_all.py --skip-build   # 只重跑对照
    python run_all.py --only C01 B02

为什么用 subprocess + 显式路径：这台机器的 PowerShell 执行策略禁止直接跑
.ps1，且 python 直接调用没有输出；统一走 Start-Process 风格的重定向。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYTHON = Path(sys.executable)
PWSH = Path(os.environ.get("SystemRoot", r"C:\Windows")) / (
    "System32/WindowsPowerShell/v1.0/powershell.exe"
)


def run(label: str, args: list[str], cwd: Path = ROOT) -> int:
    print(f"\n=== {label} ===")
    proc = subprocess.run(
        args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.stdout.strip():
        print(proc.stdout.rstrip())
    if proc.returncode != 0 and proc.stderr.strip():
        print(proc.stderr.rstrip(), file=sys.stderr)
    print(f"--- {label}: exit {proc.returncode}")
    return proc.returncode


def main() -> int:
    # 控制台是 GBK 时，子进程输出里的中文/替换字符会直接抛 UnicodeEncodeError。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--only", nargs="*", default=[])
    args = parser.parse_args()

    manifest = json.loads((ROOT / "cases" / "manifest.json").read_text(encoding="utf-8"))
    render_ids = [case["id"] for case in manifest if case.get("kind") == "render"]
    edit_ids = [case["id"] for case in manifest if case.get("kind") == "edit"]
    unknown = [item for item in args.only if item not in render_ids + edit_ids]
    if unknown:
        print(f"unknown cases: {unknown}", file=sys.stderr)
        return 2
    render_only = [item for item in args.only if item in render_ids] if args.only else render_ids
    edit_only = [item for item in args.only if item in edit_ids] if args.only else edit_ids

    if not args.skip_build:
        code = run("build fixtures", [str(PYTHON), str(ROOT / "tools/build_fixtures.py")])
        if code != 0:
            return code
        node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
        if render_only:
            code = run("build layout engine", [node, str(ROOT / "tools/build_layout.mjs")])
            if code != 0:
                return code
        if edit_only:
            code = run("build edit engine", [node, str(ROOT / "tools/build_edit.mjs")])
            if code != 0:
                return code

    failures = 0

    if render_only:
        code = run(
            "WPS reference (PDF)",
            [
                str(PWSH),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(ROOT / "tools/make_reference.ps1"),
            ],
        )
        if code != 0:
            return code

        code = run(
            "PDF fingerprint",
            [
                str(PYTHON),
                str(ROOT / "tools/pdf_fingerprint.py"),
                str(ROOT / "ref"),
                "--out-dir",
                str(ROOT / "out"),
            ],
        )
        if code != 0:
            return code

        code = run(
            "plugin layout",
            [str(PYTHON), str(ROOT / "tools/run_layout.py"), "--no-build", *render_only],
        )
        if code != 0:
            failures += 1

        # 即使比较有失败，也把校准表算出来——失败报告里要引用它。
        run("calibration", [str(PYTHON), str(ROOT / "tools/calibrate.py")])

        code = run(
            "compare",
            [str(PYTHON), str(ROOT / "tools/compare.py"), *render_only],
        )
        if code != 0:
            failures += 1

    if edit_only:
        # 编辑用例（E01–E10）：不依赖 WPS PDF，直接重放 operations.js。
        code = run(
            "edit replay",
            [str(PYTHON), str(ROOT / "tools/replay_edit.py"), "--no-build", *edit_only],
        )
        if code != 0:
            failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
