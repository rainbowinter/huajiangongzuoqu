#!/usr/bin/env python3
"""
表格夹具（T01 / T02）。

`build_fixtures.py` 的表格分支在一次并发编辑中被错误编码写坏了；而且本机没有
python-docx。这里用标准库直接写一份最小但合法的 DOCX（OOXML + ZIP），只产出
表格用例，不动其它已经稳定的夹具。

用法：
    python tools/build_table_fixtures.py
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def run(text: str, *, bold: bool = False, italic: bool = False) -> str:
    props = [
        '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" '
        'w:eastAsia="宋体" w:cs="Times New Roman"/>',
        '<w:sz w:val="21"/><w:szCs w:val="21"/>',
    ]
    if bold:
        props.append("<w:b/><w:bCs/>")
    if italic:
        props.append("<w:i/><w:iCs/>")
    return f'<w:r><w:rPr>{"".join(props)}</w:rPr><w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def paragraph(
    text: str = "",
    *,
    bold: bool = False,
    italic: bool = False,
    align: str | None = None,
    after: int = 0,
    line: int = 240,
    rule: str = "auto",
) -> str:
    props = [f'<w:spacing w:before="0" w:after="{after}" w:line="{line}" w:lineRule="{rule}"/>']
    if align:
        props.insert(0, f'<w:jc w:val="{align}"/>')
    body = run(text, bold=bold, italic=italic) if text else ""
    return f'<w:p><w:pPr>{"".join(props)}</w:pPr>{body}</w:p>'


def cell(
    content: str,
    *,
    width: int | None = None,
    span: int | None = None,
    vmerge: str | None = None,
    fill: str | None = None,
    valign: str | None = None,
) -> str:
    props = []
    if width:
        props.append(f'<w:tcW w:w="{width}" w:type="dxa"/>')
    if span:
        props.append(f'<w:gridSpan w:val="{span}"/>')
    if vmerge:
        props.append(f'<w:vMerge w:val="{vmerge}"/>')
    if fill:
        props.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>')
    if valign:
        props.append(f'<w:vAlign w:val="{valign}"/>')
    return f'<w:tc><w:tcPr>{"".join(props)}</w:tcPr>{content}</w:tc>'


def table_row(cells: list[str], *, header: bool = False, height: int | None = None) -> str:
    props = []
    if header:
        props.extend(["<w:cantSplit/>", "<w:tblHeader/>"])
    else:
        props.append("<w:cantSplit/>")
    if height:
        props.append(f'<w:trHeight w:val="{height}" w:hRule="atLeast"/>')
    return f'<w:tr><w:trPr>{"".join(props)}</w:trPr>{"".join(cells)}</w:tr>'


TABLE_PROPS = f'''<w:tblPr>
  <w:tblStyle w:val="TableGrid"/>
  <w:tblW w:w="{{width}}" w:type="{{width_type}}"/>
  <w:jc w:val="{{align}}"/>
  <w:tblBorders>
    <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
    <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
    <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
    <w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>
    <w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>
  </w:tblBorders>
  <w:tblCellMar>
    <w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>
    <w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>
  </w:tblCellMar>
</w:tblPr>'''


def table(widths: list[int], rows: list[str], *, width: int = 5000, width_type: str = "pct", align: str = "center") -> str:
    grid = "".join(f'<w:gridCol w:w="{value}"/>' for value in widths)
    props = TABLE_PROPS.format(width=width, width_type=width_type, align=align)
    return f'<w:tbl>{props}<w:tblGrid>{grid}</w:tblGrid>{"".join(rows)}</w:tbl>'


def document(body: str) -> str:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{W}" xmlns:r="{R}">
  <w:body>{body}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"
               w:header="850" w:footer="992" w:gutter="0"/>
      <w:cols w:space="720"/>
    </w:sectPr>
  </w:body>
</w:document>'''


STYLES = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>
      <w:sz w:val="21"/><w:szCs w:val="21"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr>
      <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
    </w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
  </w:style>
</w:styles>'''

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>'''

ROOT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

DOC_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''


def write_docx(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", ROOT_RELS)
        archive.writestr("word/document.xml", document(body))
        archive.writestr("word/styles.xml", STYLES)
        archive.writestr("word/_rels/document.xml.rels", DOC_RELS)


def build_t01() -> Path:
    rows = [
        table_row(
            [
                cell(paragraph("项目", bold=True, align="center"), width=4800, span=2, fill="D9E2F3", valign="center"),
                cell(paragraph("备注", align="center"), width=2400, vmerge="restart", valign="center"),
            ],
            header=True,
            height=480,
        ),
        table_row(
            [
                cell(paragraph("甲项"), width=2400),
                cell(paragraph("乙项"), width=2400),
                cell(paragraph(""), width=2400, vmerge="continue"),
            ]
        ),
        table_row(
            [
                cell(
                    paragraph("跨三列说明：行内文本随列宽换行。", italic=True),
                    width=7200,
                    span=3,
                )
            ]
        ),
    ]
    body = paragraph("表 1 合并单元格与行属性", bold=True, after=120) + table([2400, 2400, 2400], rows)
    path = FIXTURES / "T01.docx"
    write_docx(path, body)
    # 并行会话会重写 T0x；留一份自己专用的，验收时用 TB1。
    write_docx(FIXTURES / "TB1.docx", body)
    return path


def build_t02() -> Path:
    rows = [
        table_row(
            [
                cell(paragraph("序号", bold=True, align="center"), width=1600),
                cell(paragraph("名称", bold=True, align="center"), width=3600),
                cell(paragraph("数量", bold=True, align="right"), width=2000),
            ]
        ),
        table_row(
            [
                cell(paragraph("1", align="center"), width=1600),
                cell(paragraph("甲"), width=3600),
                cell(paragraph("120", align="right"), width=2000),
            ]
        ),
        table_row(
            [
                cell(paragraph("2", align="center"), width=1600),
                cell(paragraph("乙"), width=3600),
                cell(paragraph("3,450", align="right"), width=2000),
            ]
        ),
    ]
    body = paragraph("表 2 三列列表与列宽", bold=True, after=120) + table(
        [1600, 3600, 2000], rows, width=5000, width_type="pct", align="left"
    )
    path = FIXTURES / "T02.docx"
    write_docx(path, body)
    write_docx(FIXTURES / "TB2.docx", body)
    return path


def build_tb3() -> Path:
    """跨页表格：表头重复 + 行不拆分。"""
    filler = "春江潮水连海平海上明月共潮生滟滟随波千万里何处春江无月明"
    body = "".join(paragraph(filler, line=200, rule="exact") for _ in range(32))
    body += paragraph("表 3 跨页表格（表头重复）", bold=True, after=120)
    rows = [
        table_row(
            [
                cell(paragraph("编号", bold=True, align="center"), width=1200),
                cell(paragraph("内容", bold=True, align="center"), width=5000),
                cell(paragraph("备注", bold=True, align="center"), width=1200),
            ],
            header=True,
            height=480,
        )
    ]
    for index in range(25):
        rows.append(
            table_row(
                [
                    cell(paragraph(f"{index + 1:02d}", align="center"), width=1200),
                    cell(paragraph(f"第 {index + 1} 行内容，用于观察跨页时表头是否重复。"), width=5000),
                    cell(paragraph("甲", align="center"), width=1200),
                ]
            )
        )
    body += table([1200, 5000, 1200], rows, width=4500, width_type="pct")
    path = FIXTURES / "TB3.docx"
    write_docx(path, body)
    return path


def update_manifest() -> None:
    path = ROOT / "cases" / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    existing = {case["id"] for case in manifest}
    additions = [
        {
            "id": "T01",
            "cat": "table",
            "title": "合并单元格 + 行属性（对齐 docen 夹具）",
            "why": "横跨 2 列、纵跨 2 行、末行跨 3 列，带底纹/边框/居中，对应 parity-fixtures/table-merged-cells。",
            "milestone": "M7",
            "kind": "render",
            "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
            "file": "fixtures/T01.docx",
            "checks": ["table", "linebreak", "page"],
        },
        {
            "id": "T02",
            "cat": "table",
            "title": "基础三列列表 + 右对齐数字",
            "why": "最常见的表格：列宽不等、表头加粗、数字右对齐。",
            "milestone": "M7",
            "kind": "render",
            "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
            "file": "fixtures/T02.docx",
            "checks": ["table", "linebreak"],
        },
    ]
    replaced = []
    for case in manifest:
        replacement = next((item for item in additions if item["id"] == case["id"]), None)
        replaced.append(replacement or case)
    for item in additions:
        if item["id"] not in existing:
            replaced.append(item)
    path.write_text(json.dumps(replaced, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    for build in (build_t01, build_t02, build_tb3):
        path = build()
        print(f"ok {path.name} {path.stat().st_size} B")
    update_manifest()
    print("manifest updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
