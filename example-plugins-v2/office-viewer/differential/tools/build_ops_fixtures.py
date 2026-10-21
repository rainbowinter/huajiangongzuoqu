#!/usr/bin/env python3
"""
生成双端操作差分用的轻量夹具（O 系列）。

不依赖 build_fixtures.py（那个已标记损坏）。只生成 ops 用例需要的简单文档：
普通段落、多段、混合格式、列表。每份都保证没有多余空段，方便 transcript
用 block index 定位。

用法：
    python tools/build_ops_fixtures.py
"""

from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.oxml import parse_xml
from docx.shared import Pt

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def qn(tag: str) -> str:
    return f"{{{W}}}{tag}"


def run_props(*, bold: bool = False, size: float = 10.5, east: str = "宋体") -> str:
    parts = [
        f'<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" '
        f'w:eastAsia="{east}" w:cs="Times New Roman"/>',
        f'<w:sz w:val="{int(round(size * 2))}"/>',
        f'<w:szCs w:val="{int(round(size * 2))}"/>',
    ]
    if bold:
        parts.append("<w:b/><w:bCs/>")
    return f'<w:rPr xmlns:w="{W}">' + "".join(parts) + "</w:rPr>"


def para_props(
    *,
    line: float | None = 1.0,
    first_line_chars: float | None = None,
    num_id: int | None = None,
    ilvl: int = 0,
    after_pt: float = 0,
) -> str:
    parts = []
    if num_id is not None:
        parts.append(
            f'<w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="{num_id}"/></w:numPr>'
        )
    spacing = [f'w:line="{int(round(line * 240))}" w:lineRule="auto"']
    spacing.append(f'w:after="{int(round(after_pt * 20))}"')
    parts.append("<w:spacing " + " ".join(spacing) + "/>")
    if first_line_chars:
        parts.append(f'<w:ind w:firstLineChars="{int(round(first_line_chars * 100))}"/>')
    return f'<w:pPr xmlns:w="{W}">' + "".join(parts) + "</w:pPr>"


def add_para(doc: Document, text: str, *, ppr: str, runs: list[tuple[str, str]] | None = None) -> None:
    p = doc.add_paragraph()
    p._p.insert(0, parse_xml(ppr))
    for piece, rpr in runs if runs is not None else [(text, run_props())]:
        run = p.add_run(piece)
        run._r.insert(0, parse_xml(rpr))


def new_doc() -> Document:
    doc = Document()
    body = doc.element.body
    for p in list(body.findall(qn("p"))):
        body.remove(p)
    return doc


def add_numbering(doc: Document) -> None:
    """挂一份最小 numbering.xml（decimal 单级列表）。"""

    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.parts.numbering import NumberingPart

    element = parse_xml(f'<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="0"/><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>')
    root = element
    abstract = root.find(qn("abstractNum"))
    level = parse_xml(
        f'<w:lvl xmlns:w="{W}" w:ilvl="0">'
        f'<w:start w:val="1"/><w:numFmt w:val="decimal"/>'
        f'<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>'
        f'<w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr>'
        f"</w:lvl>"
    )
    abstract.append(level)

    part = NumberingPart(
        NumberingPart.partname, NumberingPart.content_type, element, doc.part.package
    )
    doc.part.relate_to(part, RT.NUMBERING)


def build() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)

    # O01：单段纯文本（与 E01 一致，保留已有文件也行）
    # O02/O03/O04：单段，用于段首/段尾/连续输入
    for name, text in [
        ("O02", "甲乙丙丁"),
        ("O03", "甲乙丙丁"),
        ("O04", "甲乙丙丁"),
        ("O05", "中文English混排"),
        ("O06", "甲乙丙丁"),
        ("O07", "甲乙丙丁"),
        ("O08", "甲乙丙丁"),
        ("O09", "甲乙丙丁"),
        ("O10", "甲乙丙丁"),
        ("O11", "甲乙丙丁"),
    ]:
        doc = new_doc()
        add_para(doc, text, ppr=para_props())
        doc.save(FIXTURES / f"{name}.docx")

    # O12：带首行缩进 + 1.5 倍行距，用于分段后格式继承
    doc = new_doc()
    add_para(doc, "甲乙丙丁", ppr=para_props(first_line_chars=2, line=1.5))
    doc.save(FIXTURES / "O12.docx")

    # O13–O16：两段
    for name in ("O13", "O14", "O15", "O16"):
        doc = new_doc()
        add_para(doc, "甲乙", ppr=para_props())
        add_para(doc, "丙丁", ppr=para_props())
        doc.save(FIXTURES / f"{name}.docx")

    # O17：跨 run（粗体 + 普通）
    doc = new_doc()
    add_para(
        doc,
        "",
        ppr=para_props(),
        runs=[("甲乙", run_props(bold=True)), ("丙丁", run_props())],
    )
    doc.save(FIXTURES / "O17.docx")

    # O18：单段，用于删到空
    doc = new_doc()
    add_para(doc, "甲乙", ppr=para_props())
    doc.save(FIXTURES / "O18.docx")

    # O19–O22：撤销/重做，单段
    for name in ("O19", "O20", "O21", "O22"):
        doc = new_doc()
        add_para(doc, "甲乙丙丁", ppr=para_props())
        doc.save(FIXTURES / f"{name}.docx")

    # O23–O26：列表。python-docx 没有公开的 numbering part API，直接复用
    # E08 里已有的 decimal 列表（numId=5），清空正文后重写两段。
    list_source = FIXTURES / "E08.docx"
    if list_source.exists():
        for name in ("O23", "O24", "O25", "O26"):
            doc = Document(str(list_source))
            body = doc.element.body
            for p in list(body.findall(qn("p"))):
                body.remove(p)
            add_para(doc, "第一项", ppr=para_props(num_id=5))
            add_para(doc, "第二项", ppr=para_props(num_id=5))
            doc.save(FIXTURES / f"{name}.docx")
    else:
        print("skip O23–O26: fixtures/E08.docx not found")

    print("generated O02–O26 fixtures")


if __name__ == "__main__":
    build()
