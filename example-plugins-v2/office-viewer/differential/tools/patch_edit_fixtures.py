#!/usr/bin/env python3
"""
修补被并发重写坏的编辑夹具（E02 / E06 / E08 / E09）。

`build_fixtures.py` 目前在编码损坏后不会把 `ppr` / `runs` / `{"list": ...}`
写进 XML；这个脚本只改这四份 fixture 的 `word/document.xml`，其它条目原样复制。
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"


def rewrite_docx(path: Path, document_xml: str) -> None:
    temporary = path.with_suffix(".tmp.docx")
    with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(
        temporary, "w", zipfile.ZIP_DEFLATED
    ) as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "word/document.xml":
                data = document_xml.encode("utf-8")
            target.writestr(item, data)
    temporary.replace(path)


def read_document(path: Path) -> str:
    with zipfile.ZipFile(path, "r") as archive:
        return archive.read("word/document.xml").decode("utf-8")


def patch_e02() -> None:
    path = FIXTURES / "E02.docx"
    xml = read_document(path)
    xml = xml.replace(
        "<w:pPr/>",
        '<w:pPr><w:ind w:firstLineChars="200"/>'
        '<w:spacing w:line="360" w:lineRule="auto"/></w:pPr>',
        1,
    )
    rewrite_docx(path, xml)


def patch_e06() -> None:
    path = FIXTURES / "E06.docx"
    xml = read_document(path)
    paragraphs = list(re.finditer(r"<w:p\b[^>]*>.*?</w:p>", xml, re.S))
    if len(paragraphs) != 2:
        raise SystemExit(f"E06: expected 2 paragraphs, got {len(paragraphs)}")
    first, second = paragraphs
    p1 = first.group(0)
    p2 = second.group(0)
    ppr = re.search(r"<w:pPr>.*?</w:pPr>", p1, re.S)
    runs1 = re.findall(r"<w:r\b.*?</w:r>", p1, re.S)
    runs2 = re.findall(r"<w:r\b.*?</w:r>", p2, re.S)
    merged = "<w:p>" + (ppr.group(0) if ppr else "<w:pPr/>") + "".join(runs1 + runs2) + "</w:p>"
    xml = xml[: first.start()] + merged + xml[first.end() : second.start()] + xml[second.end() :]
    rewrite_docx(path, xml)


def patch_list_fixture(name: str) -> None:
    path = FIXTURES / f"{name}.docx"
    xml = read_document(path)
    number = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>'
    xml = xml.replace("<w:pPr/>", f"<w:pPr>{number}</w:pPr>")
    rewrite_docx(path, xml)


def update_manifest() -> None:
    path = ROOT / "cases" / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    for case in manifest:
        if case.get("kind") != "edit":
            continue
        fixture = FIXTURES / f"{case['id']}.docx"
        if fixture.exists():
            case["bytes"] = fixture.stat().st_size
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    patch_e02()
    patch_e06()
    patch_list_fixture("E08")
    patch_list_fixture("E09")
    update_manifest()
    print("patched E02 / E06 / E08 / E09")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
