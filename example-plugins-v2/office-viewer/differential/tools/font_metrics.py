#!/usr/bin/env python3
"""
字体度量诊断：Word/WPS 的单倍行高到底用的是哪套数字？

背景：office-viewer 用 Canvas 的 fontBoundingBoxAscent/Descent 当行高，
但 WPS 导出的 PDF 显示 10.5pt 宋体的单倍行距是 25.68pt，而 Chrome 报的是
24.66pt —— 差 4%，30 行就会累积出一行。这个脚本把三方数字摆在一起：

  * Chrome / WebView2（Canvas measureText）
  * 字体文件（OS/2 typo、hhea、unitsPerEm）
  * WPS PDF 实测（从指纹里取相邻 baseline 差）

用法：
    python font_metrics.py            # 只打印字体文件 + Chrome
    python font_metrics.py --pdfs     # 额外从 out/*.wps.json 里抽实测行距
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

FONT_FILES = {
    "SimSun": Path(r"C:\Windows\Fonts\simsun.ttc"),
    "Microsoft YaHei": Path(r"C:\Windows\Fonts\msyh.ttc"),
    "SimHei": Path(r"C:\Windows\Fonts\simhei.ttf"),
    "FangSong": Path(r"C:\Windows\Fonts\simfang.ttf"),
    "KaiTi": Path(r"C:\Windows\Fonts\simkai.ttf"),
    "Arial": Path(r"C:\Windows\Fonts\arial.ttf"),
    "Times New Roman": Path(r"C:\Windows\Fonts\times.ttf"),
}

TARGET_FAMILIES = [
    "SimSun",
    "宋体",
    "Microsoft YaHei",
    "微软雅黑",
    "SimHei",
    "黑体",
    "FangSong",
    "仿宋",
    "KaiTi",
    "楷体",
]


def load_font(path: Path) -> TTFont:
    if path.suffix.lower() == ".ttc":
        collection = TTCollection(str(path))
        # 取第一个 face；宋体/雅黑的 TTC 里通常就是常规体。
        return collection.fonts[0]
    return TTFont(str(path))


def family_names(font: TTFont) -> set[str]:
    names = set()
    for record in font["name"].names:
        if record.nameID in (1, 4, 16):
            try:
                names.add(record.toUnicode())
            except Exception:  # noqa: BLE001
                continue
    return names


def font_metrics(name: str, path: Path) -> dict | None:
    if not path.exists():
        return None
    font = load_font(path)
    if "OS/2" not in font or "hhea" not in font or "head" not in font:
        return None
    os2 = font["OS/2"]
    hhea = font["hhea"]
    head = font["head"]
    upem = head.unitsPerEm
    typo = (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap)
    win = (os2.usWinAscent, os2.usWinDescent, 0)
    hhea_m = (hhea.ascent, hhea.descent, hhea.lineGap)
    return {
        "name": name,
        "path": str(path),
        "families": sorted(family_names(font)),
        "unitsPerEm": upem,
        "typo": {
            "ascender": typo[0],
            "descender": typo[1],
            "lineGap": typo[2],
            "lineHeight_em": round((typo[0] - typo[1] + typo[2]) / upem, 4),
        },
        "hhea": {
            "ascent": hhea_m[0],
            "descent": hhea_m[1],
            "lineGap": hhea_m[2],
            "lineHeight_em": round((hhea_m[0] - hhea_m[1] + hhea_m[2]) / upem, 4),
        },
        "win": {
            "ascent": win[0],
            "descent": win[1],
            "lineHeight_em": round((win[0] + win[1]) / upem, 4),
        },
        "fsSelection_useTypo": bool(os2.fsSelection & (1 << 7)),
    }


def chrome_metrics() -> list[dict]:
    """用 headless Edge 跑 tools/font-metrics.html。"""

    sys.path.insert(0, str(ROOT / "tools"))
    from run_layout import EDGE_CANDIDATES, first_existing, serve  # noqa: PLC0415

    edge = first_existing(EDGE_CANDIDATES)
    import functools
    import http.server
    import threading

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    handler = functools.partial(Quiet, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    try:
        with tempfile.TemporaryDirectory(prefix="edge-font-") as profile:
            proc = subprocess.run(
                [
                    edge,
                    "--headless=new",
                    "--disable-gpu",
                    "--no-first-run",
                    "--virtual-time-budget=15000",
                    f"--user-data-dir={profile}",
                    "--dump-dom",
                    f"http://127.0.0.1:{port}/tools/font-metrics.html",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=90,
            )
    finally:
        server.shutdown()

    import base64
    import re

    match = re.search(r'<pre id="result">([A-Za-z0-9+/=]+)</pre>', proc.stdout or "")
    if not match:
        raise SystemExit("font-metrics.html produced no result")
    return json.loads(base64.b64decode(match.group(1)).decode("utf-8"))


def measured_from_pdfs() -> dict[str, list[float]]:
    result = {}
    for path in sorted(OUT.glob("*.wps.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        gaps = []
        for page in data["pages"]:
            lines = page["lines"]
            for index in range(1, len(lines)):
                gaps.append(round(lines[index]["y"] - lines[index - 1]["y"], 3))
        if gaps:
            result[path.stem] = gaps[:6]
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdfs", action="store_true", help="附带 WPS PDF 实测行距")
    args = parser.parse_args()

    print("== 字体文件度量（em 为单位的单倍行高） ==")
    table = {}
    for label, path in FONT_FILES.items():
        metrics = font_metrics(label, path)
        table[label] = metrics
        if not metrics:
            print(f"{label:18} MISSING {path}")
            continue
        print(
            f"{label:18} upem={metrics['unitsPerEm']:5}  "
            f"typo={metrics['typo']['lineHeight_em']:.4f}em  "
            f"hhea={metrics['hhea']['lineHeight_em']:.4f}em  "
            f"win={metrics['win']['lineHeight_em']:.4f}em  "
            f"useTypo={metrics['fsSelection_useTypo']}"
        )

    print("\n== Chrome / WebView2 (Canvas fontBoundingBox，10.5pt / 400) ==")
    try:
        chrome = chrome_metrics()
    except SystemExit as exc:
        print(f"  skipped: {exc}")
        chrome = []
    for row in chrome:
        if row["size"] != 10.5 or row["weight"] != "400":
            continue
        print(
            f"{row['font']:18} ascent={row['fontAscent']:6.2f}px "
            f"descent={row['fontDescent']:5.2f}px "
            f"lineHeight={row['lineHeight']:6.2f}px "
            f"({row['lineHeight'] * 0.75:6.2f}pt, {row['ratio']:.4f}em) "
            f"width(国)={row['widthCJK']:.2f}px"
        )

    if args.pdfs:
        print("\n== WPS PDF 实测相邻 baseline 差（pt） ==")
        for case, gaps in measured_from_pdfs().items():
            print(f"{case:6} {gaps}")

    target = OUT / "font-metrics.json"
    OUT.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps({"fonts": table, "chrome": chrome}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"\n-> {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
