#!/usr/bin/env python3
"""
把 PDF 抽成"版面指纹"：每页的字符坐标、行分组、字体、行距。

为什么不用 get_text("text")：断行位置是差分的核心，必须拿到每个字符的
x/y。WPS 导出的 PDF 文本层是逐字符 span，坐标可直接用。

行分组策略：同一 baseline（容差 = 0.35 × 字号）且 y 不跳跃的字符归为一行。
中文没有空格，所以行的重建完全靠 baseline + 字号，不靠空格。

用法：
    python pdf_fingerprint.py ref/C01.pdf out/C01.wps.json
    python pdf_fingerprint.py ref/*.pdf --out-dir out
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import pymupdf as fitz  # PyMuPDF >= 2.0 的新入口
except ImportError:  # pragma: no cover
    import fitz  # 旧版本


def _round(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def extract_lines(page: "fitz.Page") -> list[dict]:
    """按包围盒纵向重叠把字符聚成行。

    不能用"baseline 相同"来分组：上标/下标会把 baseline 抬高或压低半行，
    一行就会被拆成两行、文字顺序也随之错乱。按 bbox 重叠分组更接近
    "视觉上是不是同一行"，同时仍然能把上下标留在父行里。
    """

    data = page.get_text("rawdict")
    chars: list[dict] = []
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                for ch in span.get("chars", []):
                    if ch["c"] in ("\n", "\r"):
                        continue
                    x0, y0, x1, y1 = ch["bbox"]
                    if x1 <= x0 or y1 <= y0:
                        continue
                    chars.append(
                        {
                            "c": ch["c"],
                            "x": ch["origin"][0],
                            "y": ch["origin"][1],
                            "w": x1 - x0,
                            "bbox": (x0, y0, x1, y1),
                            "size": span["size"],
                            "font": span["font"],
                            "flags": span["flags"],
                            "color": span["color"],
                        }
                    )

    if not chars:
        return []

    chars.sort(key=lambda c: (round(c["y"], 1), c["x"]))

    rows: list[list[dict]] = []
    for ch in chars:
        cy0, cy1 = ch["bbox"][1], ch["bbox"][3]
        height = max(0.1, cy1 - cy0)
        best = None
        for row in rows:
            ry0 = min(c["bbox"][1] for c in row)
            ry1 = max(c["bbox"][3] for c in row)
            overlap = min(cy1, ry1) - max(cy0, ry0)
            if overlap >= 0.5 * min(height, ry1 - ry0):
                best = row
                break
        if best is None:
            rows.append([ch])
        else:
            best.append(ch)

    lines: list[dict] = []
    for row in rows:
        row.sort(key=lambda c: c["x"])
        lines.append(_to_line(row))

    lines.sort(key=lambda line: (line["top"], line["x"]))
    for index, line in enumerate(lines):
        line["index"] = index
    return lines


def _to_line(chars: list[dict]) -> dict:
    text = "".join(ch["c"] for ch in chars)
    sizes = [ch["size"] for ch in chars]
    fonts: list[str] = []
    for ch in chars:
        if not fonts or fonts[-1] != ch["font"]:
            fonts.append(ch["font"])
    x0 = min(ch["x"] for ch in chars)
    x1 = max(ch["x"] + ch["w"] for ch in chars)
    # 行基线取中位数：上下标会让首个字符的 y 偏离整行基线。
    ys = sorted(ch["y"] for ch in chars)
    top = min(ch["bbox"][1] for ch in chars)
    return {
        "text": text,
        "x": _round(x0),
        "right": _round(x1),
        "top": _round(top),
        "y": _round(ys[len(ys) // 2]),
        "y_first": _round(chars[0]["y"]),
        "width": _round(x1 - x0),
        "size": _round(max(sizes)),
        "fonts": fonts,
        "chars": [
            {"c": ch["c"], "x": _round(ch["x"]), "w": _round(ch["w"]), "size": _round(ch["size"])}
            for ch in chars
        ],
    }


def fingerprint(pdf_path: Path) -> dict:
    doc = fitz.open(pdf_path)
    pages = []
    for index, page in enumerate(doc):
        rect = page.rect
        lines = extract_lines(page)
        pages.append(
            {
                "index": index,
                "width": _round(rect.width),
                "height": _round(rect.height),
                "lines": lines,
            }
        )
    meta = doc.metadata or {}
    result = {
        "source": pdf_path.name,
        "producer": meta.get("producer"),
        "creator": meta.get("creator"),
        "pdf_pages": len(pages),
        "page_size": [pages[0]["width"], pages[0]["height"]] if pages else None,
        "pages": pages,
    }
    doc.close()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--out-dir", default="")
    args = parser.parse_args()

    out_dir = Path(args.out_dir) if args.out_dir else None
    inputs: list[Path] = []
    for raw in args.inputs:
        path = Path(raw)
        if path.is_dir():
            inputs.extend(sorted(path.glob("*.pdf")))
        else:
            inputs.append(path)
    if not inputs:
        raise SystemExit("no PDF inputs")

    for path in inputs:
        fp = fingerprint(path)
        if out_dir:
            out_dir.mkdir(parents=True, exist_ok=True)
            target = out_dir / f"{path.stem}.wps.json"
        else:
            target = path.with_suffix(".wps.json")
        target.write_text(json.dumps(fp, ensure_ascii=False, indent=1), encoding="utf-8")
        total = sum(len(p["lines"]) for p in fp["pages"])
        print(f"{path.name}: {fp['pdf_pages']} pages, {total} lines -> {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
