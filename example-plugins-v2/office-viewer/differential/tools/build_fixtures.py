#!/usr/bin/env python3
"""
生成差分测试用的 .docx 夹具，并写出 cases/manifest.json。

夹具是确定性生成的：同样的 spec 永远得到同样的 document.xml（不含时间戳，
避免 WPS 另存时产生无意义差异）。所有段落/字符属性都写到 run / paragraph
上，不依赖 python-docx 的默认样式，避免"Word 版本不同、默认值不同"。

用法：
    python build_fixtures.py            # 生成全部
    python build_fixtures.py --only P01 # 只生成某个用例
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from docx import Document
from docx.oxml import parse_xml
from docx.shared import Pt, Twips

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
CASES = ROOT / "cases"

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

# ---------------------------------------------------------------------------
# 基础构件
# ---------------------------------------------------------------------------


def qn(tag: str) -> str:
    return f"{{{W}}}{tag}"


def run_props(
    *,
    size_pt: float = 10.5,
    east_asia: str = "宋体",
    latin: str = "Times New Roman",
    bold: bool = False,
    italic: bool = False,
    underline: bool = False,
    strike: bool = False,
    color: str | None = None,
    vert_align: str | None = None,
    spacing_pt: float | None = None,
) -> str:
    """生成 <w:rPr> 的 XML 字符串。"""

    parts = [
        f'<w:rFonts w:ascii="{latin}" w:hAnsi="{latin}" '
        f'w:eastAsia="{east_asia}" w:cs="{latin}"/>',
        f'<w:sz w:val="{int(round(size_pt * 2))}"/>',
        f'<w:szCs w:val="{int(round(size_pt * 2))}"/>',
    ]
    if bold:
        parts.append("<w:b/><w:bCs/>")
    if italic:
        parts.append("<w:i/><w:iCs/>")
    if underline:
        parts.append('<w:u w:val="single"/>')
    if strike:
        parts.append("<w:strike/>")
    if color:
        parts.append(f'<w:color w:val="{color}"/>')
    if vert_align:
        parts.append(f'<w:vertAlign w:val="{vert_align}"/>')
    if spacing_pt is not None:
        parts.append(f'<w:spacing w:val="{int(round(spacing_pt * 20))}"/>')
    return f'<w:rPr xmlns:w="{W}">' + "".join(parts) + "</w:rPr>"


def para_props(
    *,
    align: str | None = None,
    line: float | None = None,
    line_rule: str = "auto",
    before_pt: float | None = None,
    after_pt: float | None = None,
    first_line_chars: float | None = None,
    left_chars: float | None = None,
    right_chars: float | None = None,
    keep_next: bool = False,
    keep_lines: bool = False,
    page_break_before: bool = False,
    widow: bool | None = None,
    snap_to_grid: bool | None = None,
    tabs: list[int] | None = None,
) -> str:
    """生成 <w:pPr> 的 XML 字符串（不含 sectPr）。"""

    parts: list[str] = []
    if keep_next:
        parts.append("<w:keepNext/>")
    if keep_lines:
        parts.append("<w:keepLines/>")
    if page_break_before:
        parts.append("<w:pageBreakBefore/>")
    if widow is not None:
        parts.append(f'<w:widowControl w:val="{1 if widow else 0}"/>')
    if snap_to_grid is not None:
        parts.append(f'<w:snapToGrid w:val="{1 if snap_to_grid else 0}"/>')
    if tabs:
        stop_xml = "".join(
            f'<w:tab w:val="left" w:pos="{int(round(p * 20))}"/>' for p in tabs
        )
        parts.append(f"<w:tabs>{stop_xml}</w:tabs>")
    spacing = []
    if before_pt is not None:
        spacing.append(f'w:before="{int(round(before_pt * 20))}"')
    if after_pt is not None:
        spacing.append(f'w:after="{int(round(after_pt * 20))}"')
    if line is not None:
        if line_rule == "auto":
            spacing.append(f'w:line="{int(round(line * 240))}" w:lineRule="auto"')
        else:
            spacing.append(f'w:line="{int(round(line * 20))}" w:lineRule="{line_rule}"')
    if spacing:
        parts.append("<w:spacing " + " ".join(spacing) + "/>")
    ind = []
    if left_chars is not None:
        ind.append(f'w:leftChars="{int(round(left_chars * 100))}"')
    if right_chars is not None:
        ind.append(f'w:rightChars="{int(round(right_chars * 100))}"')
    if first_line_chars is not None:
        ind.append(f'w:firstLineChars="{int(round(first_line_chars * 100))}"')
    if ind:
        parts.append("<w:ind " + " ".join(ind) + "/>")
    if align:
        parts.append(f'<w:jc w:val="{align}"/>')
    return f'<w:pPr xmlns:w="{W}">' + "".join(parts) + "</w:pPr>"


def add_para(
    doc: Document,
    text: str,
    *,
    ppr: str | None = None,
    rpr: str | None = None,
) -> None:
    p = doc.add_paragraph()
    if ppr:
        p._p.insert(0, parse_xml(ppr))
    run = p.add_run(text)
    if rpr:
        run._r.insert(0, parse_xml(rpr))


def add_page_break_para(doc: Document) -> None:
    p = doc.add_paragraph()
    run = p.add_run()
    run._r.append(parse_xml(f'<w:br xmlns:w="{W}" w:type="page"/>'))


def add_soft_break_para(doc: Document, parts: list[str], *, ppr: str, rpr: str) -> None:
    """段内软换行：多个片段之间插 <w:br/>。"""

    p = doc.add_paragraph()
    p._p.insert(0, parse_xml(ppr))
    for index, part in enumerate(parts):
        run = p.add_run(part)
        run._r.insert(0, parse_xml(rpr))
        if index < len(parts) - 1:
            br = parse_xml(f'<w:br xmlns:w="{W}"/>')
            run._r.append(br)


def setup_section(
    doc: Document,
    *,
    page: str = "A4",
    margin_pt: tuple[float, float, float, float] = (72.0, 90.0, 72.0, 90.0),
    doc_grid: str | None = None,
) -> None:
    """页面尺寸 / 页边距 / 文档网格。margin 顺序：上右下左（pt）。"""

    sec = doc.sections[0]
    if page == "A5":
        sec.page_width, sec.page_height = Pt(420), Pt(595.3)
    else:
        sec.page_width, sec.page_height = Pt(595.3), Pt(841.9)
    top, right, bottom, left = margin_pt
    sec.top_margin, sec.right_margin = Pt(top), Pt(right)
    sec.bottom_margin, sec.left_margin = Pt(bottom), Pt(left)
    sec.header_distance, sec.footer_distance = Pt(42.5), Pt(49.6)

    sect_pr = sec._sectPr
    for old in sect_pr.findall(qn("docGrid")):
        sect_pr.remove(old)
    if doc_grid:
        sect_pr.append(parse_xml(f'<w:docGrid xmlns:w="{W}" {doc_grid}/>'))


def new_doc() -> Document:
    doc = Document()
    body = doc.element.body
    for p in list(body.findall(qn("p"))):
        body.remove(p)
    return doc


# ---------------------------------------------------------------------------
# 表格构件（M7 验收用）
# ---------------------------------------------------------------------------

BORDER_SIZE = 4


def _borders_xml(*, inside: bool = True, size: int = BORDER_SIZE) -> str:
    sides = ["top", "left", "bottom", "right"]
    if inside:
        sides += ["insideH", "insideV"]
    return "".join(
        f'<w:{side} w:val="single" w:sz="{size}" w:space="0" w:color="000000"/>'
        for side in sides
    )


def table_props(
    *,
    width_pct: float = 90,
    alignment: str = "center",
    cell_margin_twips: int = 108,
) -> str:
    return (
        f'<w:tblPr xmlns:w="{W}">'
        f'<w:tblW w:w="{int(width_pct * 50)}" w:type="pct"/>'
        f'<w:jc w:val="{alignment}"/>'
        f'<w:tblBorders>{_borders_xml()}</w:tblBorders>'
        f'<w:tblCellMar>'
        f'<w:top w:w="0" w:type="dxa"/>'
        f'<w:left w:w="{cell_margin_twips}" w:type="dxa"/>'
        f'<w:bottom w:w="0" w:type="dxa"/>'
        f'<w:right w:w="{cell_margin_twips}" w:type="dxa"/>'
        f"</w:tblCellMar>"
        f"</w:tblPr>"
    )


def set_cell(
    cell,
    *,
    span: int | None = None,
    vmerge: str | None = None,
    shade: str | None = None,
    valign: str | None = None,
) -> None:
    """设置单元格属性。vmerge: restart / continue。"""

    tc_pr = cell._tc.get_or_add_tcPr()
    if span and span > 1:
        tc_pr.append(parse_xml(f'<w:gridSpan xmlns:w="{W}" w:val="{span}"/>'))
    if vmerge:
        # OOXML: 只有 restart 需要显式值；continue 等价于空 w:vMerge。
        if vmerge == "restart":
            tc_pr.append(parse_xml(f'<w:vMerge xmlns:w="{W}" w:val="restart"/>'))
        else:
            tc_pr.append(parse_xml(f'<w:vMerge xmlns:w="{W}"/>'))
    if shade:
        tc_pr.append(parse_xml(f'<w:shd xmlns:w="{W}" w:val="clear" w:fill="{shade}"/>'))
    if valign:
        tc_pr.append(parse_xml(f'<w:vAlign xmlns:w="{W}" w:val="{valign}"/>'))


def set_cell_text(cell, text: str, *, rpr: str | None = None, ppr: str | None = None) -> None:
    # 不要用 cell.text = ""：那会先塞一个空 run，再 add_run 就多一个 <w:r/>。
    para = cell.paragraphs[0]
    if ppr:
        para._p.insert(0, parse_xml(ppr))
    run = para.add_run(text)
    if rpr:
        run._r.insert(0, parse_xml(rpr))


def apply_row_props(
    row,
    *,
    header: bool = False,
    cant_split: bool = False,
    height_twips: int | None = None,
    height_rule: str = "atLeast",
) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    if cant_split:
        tr_pr.append(parse_xml(f'<w:cantSplit xmlns:w="{W}"/>'))
    if header:
        tr_pr.append(parse_xml(f'<w:tblHeader xmlns:w="{W}"/>'))
    if height_twips:
        tr_pr.append(
            parse_xml(
                f'<w:trHeight xmlns:w="{W}" w:val="{height_twips}" w:hRule="{height_rule}"/>'
            )
        )


def add_table(
    doc: Document,
    rows: list[list[dict]],
    *,
    widths: list[int],
    width_pct: float = 90,
    alignment: str = "center",
    header_rows: int = 0,
) -> None:
    """按声明式 rows 建表（不支持跨列单元格之后的落位，当前夹具够用）。"""

    column_count = len(widths)
    table = doc.add_table(rows=len(rows), cols=column_count)
    # python-docx 已经建了一个空的 tblPr；必须整个换掉，不能只清子元素，
    # 否则会出现两个 <w:tblPr>，Word 直接判文档损坏。
    old_pr = table._tbl.tblPr
    if old_pr is not None:
        table._tbl.remove(old_pr)
    table._tbl.insert(0, parse_xml(table_props(width_pct=width_pct, alignment=alignment)))
    for index, width in enumerate(widths):
        table.columns[index].width = Twips(width)
    grid = table._tbl.find(qn("tblGrid"))
    if grid is not None:
        for grid_col, width in zip(grid.findall(qn("gridCol")), widths):
            grid_col.set(qn("w"), str(width))

    for row_index, cells in enumerate(rows):
        row = table.rows[row_index]
        apply_row_props(
            row,
            header=row_index < header_rows,
            cant_split=True,
            height_twips=480 if row_index == 0 else None,
        )
        for spec in cells:
            cell = row.cells[spec.get("col", 0)]
            set_cell(
                cell,
                span=spec.get("span"),
                vmerge=spec.get("vmerge"),
                shade=spec.get("shade"),
                valign=spec.get("valign"),
            )
            set_cell_text(
                cell,
                spec.get("text", ""),
                rpr=run_props(
                    bold=spec.get("bold", False),
                    italic=spec.get("italic", False),
                ),
                ppr=para_props(
                    align=spec.get("align"),
                    line=1.0,
                    after_pt=0,
                ),
            )


def build_table_custom(doc: Document, kind: str) -> None:
    body_rpr = run_props(size_pt=10.5, east_asia="宋体")
    if kind == "table_merged":
        add_para(doc, "表 1 合并单元格与行属性", ppr=para_props(after_pt=6), rpr=body_rpr)
        add_table(
            doc,
            [
                [
                    {
                        "text": "项目",
                        "col": 0,
                        "span": 2,
                        "shade": "D9E2F3",
                        "valign": "center",
                        "bold": True,
                        "align": "center",
                    },
                    {
                        "text": "备注",
                        "col": 2,
                        "vmerge": "restart",
                        "valign": "center",
                        "align": "center",
                    },
                ],
                [
                    {"text": "甲项", "col": 0},
                    {"text": "乙项", "col": 1},
                    {"text": "", "col": 2, "vmerge": "continue"},
                ],
                [
                    {
                        "text": "跨三列说明：行内文本随列宽换行。",
                        "col": 0,
                        "span": 3,
                        "italic": True,
                    },
                ],
            ],
            widths=[2400, 2400, 2400],
            header_rows=1,
        )
    elif kind == "table_basic":
        add_para(doc, "表 2 三列表格与列宽", ppr=para_props(after_pt=6), rpr=body_rpr)
        add_table(
            doc,
            [
                [
                    {"text": "序号", "col": 0, "bold": True, "align": "center"},
                    {"text": "名称", "col": 1, "bold": True, "align": "center"},
                    {"text": "数量", "col": 2, "bold": True, "align": "right"},
                ],
                [
                    {"text": "1", "col": 0, "align": "center"},
                    {"text": "甲", "col": 1},
                    {"text": "120", "col": 2, "align": "right"},
                ],
                [
                    {"text": "2", "col": 0, "align": "center"},
                    {"text": "乙", "col": 1},
                    {"text": "3,450", "col": 2, "align": "right"},
                ],
            ],
            widths=[1600, 3600, 2000],
        )
    elif kind == "table_repeat_header":
        add_para(doc, "表 3 跨页表格（表头重复）", ppr=para_props(after_pt=6), rpr=body_rpr)
        for _ in range(32):
            add_para(doc, CJK40, ppr=para_props(line=10, line_rule="exact"), rpr=body_rpr)
        rows = [
            [
                {"text": "编号", "col": 0, "bold": True, "align": "center"},
                {"text": "内容", "col": 1, "bold": True, "align": "center"},
                {"text": "备注", "col": 2, "bold": True, "align": "center"},
            ]
        ]
        for index in range(1, 26):
            rows.append(
                [
                    {"text": f"{index:02d}", "col": 0, "align": "center"},
                    {"text": f"第 {index} 行内容，用于观察跨页时的表头重复。", "col": 1},
                    {"text": "—", "col": 2, "align": "center"},
                ]
            )
        add_table(doc, rows, widths=[1200, 5000, 1200], header_rows=1)
    elif kind == "table_nested":
        add_para(doc, "表 4 嵌套表格", ppr=para_props(after_pt=6), rpr=body_rpr)
        add_table(
            doc,
            [[{"text": "外层左", "col": 0}, {"text": "外层右", "col": 1}]],
            widths=[3000, 3000],
        )
        outer = doc.tables[-1]
        inner = outer.cell(0, 0).add_table(rows=2, cols=2)
        for r in range(2):
            for c in range(2):
                set_cell_text(
                    inner.cell(r, c),
                    f"内{r + 1}{c + 1}",
                    rpr=body_rpr,
                    ppr=para_props(line=1.0, after_pt=0),
                )
    else:
        raise SystemExit(f"unknown table kind: {kind}")


# ---------------------------------------------------------------------------
# 用例定义
# ---------------------------------------------------------------------------

CJK20 = "春江潮水连海平海上明月共潮生滟滟随波千万里何处春江无月明"
CJK40 = CJK20 + "江流宛转绕芳甸月照花林皆似霰空里流霜不觉飞汀上白沙看不见"
CJK80 = CJK40 + CJK40


def p(
    text: str,
    *,
    size: float = 10.5,
    east: str = "宋体",
    latin: str = "Times New Roman",
    align: str | None = None,
    line: float | None = None,
    line_rule: str = "auto",
    before: float | None = None,
    after: float | None = None,
    first_line: float | None = None,
    left: float | None = None,
    right: float | None = None,
    keep_next: bool = False,
    keep_lines: bool = False,
    page_break_before: bool = False,
    widow: bool | None = None,
    snap: bool | None = None,
    bold: bool = False,
    italic: bool = False,
    underline: bool = False,
    color: str | None = None,
    spacing: float | None = None,
    vert: str | None = None,
) -> dict:
    return {
        "text": text,
        "size": size,
        "east": east,
        "latin": latin,
        "align": align,
        "line": line,
        "line_rule": line_rule,
        "before": 0 if before is None else before,
        "after": 0 if after is None else after,
        "first_line": first_line,
        "left": left,
        "right": right,
        "keep_next": keep_next,
        "keep_lines": keep_lines,
        "page_break_before": page_break_before,
        "widow": widow,
        "snap": snap,
        "bold": bold,
        "italic": italic,
        "underline": underline,
        "color": color,
        "spacing": spacing,
        "vert": vert,
    }


SPECS: list[dict] = [
    # ---------------- 字符与字体 ----------------
    {
        "id": "C01",
        "cat": "char",
        "title": "宋体 10.5pt 基准",
        "why": "一切测量的基准：单倍行距、默认页边距下的行高与字宽。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p(CJK20, line=1.0), p(CJK20, line=1.0)],
        "checks": ["linebreak", "lineheight", "x", "page"],
    },
    {
        "id": "C02",
        "cat": "char",
        "title": "字号阶梯",
        "why": "字号 -> 字宽 / 行高是否线性；半磅值是否被正确四舍五入。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK20, size=9),
            p(CJK20, size=10.5),
            p(CJK20, size=12),
            p(CJK20, size=14),
            p(CJK20, size=16),
            p(CJK20, size=18),
        ],
        "checks": ["lineheight", "linebreak"],
    },
    {
        "id": "C03",
        "cat": "char",
        "title": "中文字体差异",
        "why": "宋体/雅黑/黑体/仿宋/楷体在同样字号下的字宽不同，行尾位置必须一致。",
        "milestone": "M2 / 字体",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK40, east="宋体"),
            p(CJK40, east="微软雅黑"),
            p(CJK40, east="黑体"),
            p(CJK40, east="仿宋"),
            p(CJK40, east="楷体"),
        ],
        "checks": ["linebreak", "x"],
    },
    {
        "id": "C04",
        "cat": "char",
        "title": "粗体 / 斜体 / 下划线 / 颜色",
        "why": "粗体会改变字宽（尤其西文），中文通常不变；斜体会影响西文占位。",
        "milestone": "M2 / M4",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK20, bold=True),
            p(CJK20, italic=True),
            p(CJK20, underline=True),
            p(CJK20, color="C00000"),
            p("Bold English 12345 and 中文混排", bold=True),
            p("Italic English 12345 and 中文混排", italic=True),
        ],
        "checks": ["linebreak", "x", "pdf_style"],
    },
    {
        "id": "C05",
        "cat": "char",
        "title": "上下标",
        "why": "上下标按 65% 缩排并改变基线，行高是否被撑大。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p("E=mc2 与 H2O 的上标下标", vert="superscript"),
            p("E=mc2 与 H2O 的上标下标", vert="subscript"),
        ],
        "checks": ["lineheight"],
    },
    {
        "id": "C06",
        "cat": "char",
        "title": "字符间距",
        "why": "w:spacing 加宽 0.5pt / 1pt 时每行能放下的字数与总宽。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p(CJK20, spacing=0.5), p(CJK20, spacing=1.0), p(CJK20, spacing=-0.3)],
        "checks": ["linebreak", "x"],
    },
    # ---------------- 断行 ----------------
    {
        "id": "B01",
        "cat": "break",
        "title": "超长中文段落",
        "why": "固定栏宽下每行 N 字，跨 6 行以上，能稳定测出断行位置。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p(CJK80), p(CJK80)],
        "checks": ["linebreak", "lineheight", "page"],
    },
    {
        "id": "B02",
        "cat": "break",
        "title": "行首禁则 —— 逗号/句号",
        "why": "逗号、句号落在行首时，Word 会把前一个字一起推到下一行。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p("甲乙丙丁戊己庚辛壬癸，子丑寅卯辰巳午未申酉。") for _ in range(4)],
        "checks": ["linebreak", "kinsoku"],
    },
    {
        "id": "B03",
        "cat": "break",
        "title": "行尾禁则 —— 左括号/引号",
        "why": "（「 不能留在行尾，必须和后面的字一起换行。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p("甲乙丙丁戊己庚辛壬癸（子丑寅卯辰巳午未申酉）") for _ in range(4)],
        "checks": ["linebreak", "kinsoku"],
    },
    {
        "id": "B04",
        "cat": "break",
        "title": "中英混排 + 数字单位",
        "why": "Word 不在汉字与英文之间断词，但会在汉字与英文词边界断行；2026年/9月 不可拆。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p("本文使用 WordprocessingML 2026年9月 的规范，共3个部分 与 Microsoft Office 对照。"),
            p("中文English混排中文English混排中文English混排中文English混排中文English混排"),
        ],
        "checks": ["linebreak"],
    },
    {
        "id": "B05",
        "cat": "break",
        "title": "超长西文词拆字",
        "why": "列宽放不下一个单词时，Word 会按字符硬拆；拆点与剩余宽度要对。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p("Supercalifragilisticexpialidocious" * 3), p("1234567890" * 12)],
        "checks": ["linebreak"],
    },
    {
        "id": "B06",
        "cat": "break",
        "title": "Tab 与段内软换行",
        "why": "w:tab 的跳位（默认 420 twip）、w:br 的段内换行；软换行后的对齐要按段内最后一行处理。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [],
        "custom": "tabs_and_breaks",
        "checks": ["linebreak", "x"],
    },
    {
        "id": "B07",
        "cat": "break",
        "title": "首行缩进 2 字符",
        "why": "firstLineChars=200 时首行缩进 = 2 × 字号；后续行不缩进。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p(CJK80, first_line=2), p(CJK40, first_line=2, size=14)],
        "checks": ["indent", "linebreak"],
    },
    {
        "id": "B08",
        "cat": "break",
        "title": "左右缩进 + 悬挂缩进",
        "why": "leftChars/rightChars 同时存在时，栏宽变窄，断行位置随之改变。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK80, left=2, right=2),
            p(CJK80, left=2, right=0),
        ],
        "checks": ["indent", "linebreak"],
    },
    # ---------------- 行距与段距 ----------------
    {
        "id": "S01",
        "cat": "spacing",
        "title": "单倍 / 1.5 倍 / 双倍行距",
        "why": "行距倍数直接决定每页行数；中文单倍行高不等于字号。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK20, line=1.0),
            p(CJK20, line=1.5),
            p(CJK20, line=2.0),
        ],
        "checks": ["lineheight", "page"],
    },
    {
        "id": "S02",
        "cat": "spacing",
        "title": "固定值 / 最小值行距",
        "why": "exact 会裁字，atLeast 取 max(单倍行高, 值)；两者基线位置不同。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK20, line=20, line_rule="exact"),
            p(CJK20, line=24, line_rule="atLeast"),
        ],
        "checks": ["lineheight"],
    },
    {
        "id": "S03",
        "cat": "spacing",
        "title": "段前 / 段后间距",
        "why": "段间距是否被折叠、是否影响分页；beforeLines/afterLines 与 pt 混用。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK20, before=12, after=6),
            p(CJK20, before=0, after=18),
            p(CJK20, before=6, after=0),
        ],
        "checks": ["lineheight", "y", "page"],
    },
    # ---------------- 对齐 ----------------
    {
        "id": "A01",
        "cat": "align",
        "title": "左 / 居中 / 右 / 两端 / 分散",
        "why": "两端对齐的最后一行不对齐；分散对齐每行都铺满；居中/右对齐的起点 x。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK20, align="left"),
            p(CJK20, align="center"),
            p(CJK20, align="right"),
            p(CJK20, align="both"),
            p(CJK80, align="both"),
            p(CJK20, align="distribute"),
        ],
        "checks": ["x", "justify", "linebreak"],
    },
    {
        "id": "A02",
        "cat": "align",
        "title": "两端对齐的段内软换行",
        "why": "软换行把段落切成多段，每个小段的最后一行都不应拉伸。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [],
        "custom": "justify_soft_break",
        "checks": ["justify", "x"],
    },
    # ---------------- 分页 ----------------
    {
        "id": "P01",
        "cat": "page",
        "title": "多页自然分页",
        "why": "40 段固定行高文字，页边界落在第几段第几行。",
        "milestone": "M3",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p(CJK40, line=1.0) for _ in range(40)],
        "checks": ["page", "pagination"],
    },
    {
        "id": "P02",
        "cat": "page",
        "title": "孤行控制",
        "why": "段首/段尾只剩一行时整段挪页；widowControl=0 时允许孤行。",
        "milestone": "M3",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p(CJK20, line=10, line_rule="exact") for _ in range(38)]
        + [p(CJK80, line=10, line_rule="exact"), p(CJK80, line=10, line_rule="exact")],
        "checks": ["page", "pagination"],
    },
    {
        "id": "P03",
        "cat": "page",
        "title": "keepLines 整段不拆页",
        "why": "整段放不下时整体挪到下一页，而不是从中间断开。",
        "milestone": "M3",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p(CJK20, line=10, line_rule="exact") for _ in range(34)]
        + [p(CJK80, line=10, line_rule="exact", keep_lines=True)],
        "checks": ["page", "pagination"],
    },
    {
        "id": "P04",
        "cat": "page",
        "title": "keepNext 标题与正文同页",
        "why": "标题不能单独留在页底；标题+下一段首行要一起挪页。",
        "milestone": "M3",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [p(CJK20, line=10, line_rule="exact") for _ in range(36)]
        + [p("标题：春江花月夜", line=10, line_rule="exact", keep_next=True, bold=True)]
        + [p(CJK80, line=10, line_rule="exact")],
        "checks": ["page", "pagination"],
    },
    {
        "id": "P05",
        "cat": "page",
        "title": "段前分页 pageBreakBefore",
        "why": "强制另起一页，页数与上一段无关。",
        "milestone": "M3",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [
            p(CJK20),
            p("第二部分", page_break_before=True, bold=True),
            p(CJK80),
        ],
        "checks": ["page", "pagination"],
    },
    {
        "id": "P06",
        "cat": "page",
        "title": "手动分页符",
        "why": "w:br type=page 之后的内容必须从新页开始，且分页符本身不占行高。",
        "milestone": "M3",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [],
        "custom": "manual_page_break",
        "checks": ["page", "pagination"],
    },
    # ---------------- 中文文档网格 ----------------
    {
        "id": "G01",
        "cat": "grid",
        "title": "文档网格 lines（每页 44 行）",
        "why": "中文 Word 默认网格：行高吸附到 linePitch，每页行数与 Word 对齐。",
        "milestone": "M2 / M3",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90], "doc_grid": 'type="lines" linePitch="312"'},
        "paras": [p(CJK80, line=1.0) for _ in range(6)],
        "checks": ["lineheight", "pagination"],
    },
    {
        "id": "G02",
        "cat": "grid",
        "title": "文档网格关闭 snapToGrid",
        "why": "snapToGrid=0 的段落不受网格约束，行距按字体自身。",
        "milestone": "M2",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90], "doc_grid": 'type="lines" linePitch="312"'},
        "paras": [
            p(CJK80, snap=False),
            p(CJK80, snap=True),
        ],
        "checks": ["lineheight"],
    },
    # ---------------- 页面设置 ----------------
    {
        "id": "L01",
        "cat": "layout",
        "title": "窄页边距 + 小页面",
        "why": "栏宽变化后断行位置全线改变，测的是 computeIndent / contentWidth。",
        "milestone": "M2",
        "page": {"page": "A5", "margin_pt": [36, 36, 36, 36]},
        "paras": [p(CJK80), p(CJK80)],
        "checks": ["linebreak", "page"],
    },
    # ---------------- 表格（M7，当前引擎按行拍平） ----------------
    {
        "id": "T01",
        "cat": "table",
        "title": "合并单元格 + 行属性（对齐 docen 夹具）",
        "why": "横跨 2 列、纵跨 2 行、末行跨 3 列，带底纹/边框/居中；"
        "对应 parity-fixtures/table-merged-cells 的场景。",
        "milestone": "M7",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [],
        "custom": "table_merged",
        "checks": ["table", "linebreak", "page"],
    },
    {
        "id": "T02",
        "cat": "table",
        "title": "基础三列表格 + 右对齐数字",
        "why": "最普通的表格：列宽不等、表头加粗、数字右对齐。",
        "milestone": "M7",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [],
        "custom": "table_basic",
        "checks": ["table", "linebreak"],
    },
    {
        "id": "T03",
        "cat": "table",
        "title": "跨页表格 + 表头重复",
        "why": "25 行表格跨页时，w:tblHeader 的表头行要在第二页重复；"
        "行不能被从中间切断（cantSplit）。",
        "milestone": "M7",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [],
        "custom": "table_repeat_header",
        "checks": ["table", "page"],
    },
    {
        "id": "T04",
        "cat": "table",
        "title": "嵌套表格",
        "why": "单元格里再放一张表；外层列宽决定内层可用宽度。",
        "milestone": "M7",
        "page": {"page": "A4", "margin_pt": [72, 90, 72, 90]},
        "paras": [],
        "custom": "table_nested",
        "checks": ["table"],
    },
]

# 交互类用例：不做 WPS 渲染对照，只做"操作 -> 文档模型/XML"的确定性断言。
EDIT_SPECS: list[dict] = [
    {
        "id": "E01",
        "cat": "edit",
        "title": "在段中插入中文（输入法提交）",
        "start": "甲乙丙丁",
        "ops": [{"op": "place", "block": 0, "offset": 2}, {"op": "ime", "text": "测试"}],
        "expect": {"text": "甲乙测试丙丁", "paras": 1, "xml": ["w:rPr 保留", "w:t 带 xml:space=preserve"]},
    },
    {
        "id": "E02",
        "cat": "edit",
        "title": "回车分段保留段落格式",
        "start": "甲乙丙丁",
        "ppr": {"first_line": 2, "line": 1.5},
        "ops": [{"op": "place", "block": 0, "offset": 2}, {"op": "key", "key": "Enter"}],
        "expect": {"text": "甲乙\n丙丁", "paras": 2, "ppr": "两段均保留 firstLineChars/line", "sectPr": "新段不得复制 sectPr"},
    },
    {
        "id": "E03",
        "cat": "edit",
        "title": "段首退格合并",
        "start": ["甲乙", "丙丁"],
        "ops": [{"op": "place", "block": 1, "offset": 0}, {"op": "key", "key": "Backspace"}],
        "expect": {"text": "甲乙丙丁", "paras": 1},
    },
    {
        "id": "E04",
        "cat": "edit",
        "title": "段尾 Delete 合并",
        "start": ["甲乙", "丙丁"],
        "ops": [{"op": "place", "block": 0, "offset": 2}, {"op": "key", "key": "Delete"}],
        "expect": {"text": "甲乙丙丁", "paras": 1},
    },
    {
        "id": "E05",
        "cat": "edit",
        "title": "Shift+Enter 段内软换行",
        "start": "甲乙丙丁",
        "ops": [{"op": "place", "block": 0, "offset": 2}, {"op": "key", "key": "Shift+Enter"}],
        "expect": {"text": "甲乙\n丙丁", "paras": 1, "xml": ["<w:br/> 而不是新 w:p"]},
    },
    {
        "id": "E06",
        "cat": "edit",
        "title": "跨 run 删除",
        "start": [("甲乙", {"bold": True}), ("丙丁", {})],
        "ops": [{"op": "place", "block": 0, "offset": 1}, {"op": "select", "to": {"block": 0, "offset": 3}}, {"op": "key", "key": "Backspace"}],
        "expect": {"text": "甲丁", "xml": ["两个 run 的 rPr 不被混合", "空 run 被清理"]},
    },
    {
        "id": "E07",
        "cat": "edit",
        "title": "撤销 / 重做",
        "start": "甲乙丙丁",
        "ops": [
            {"op": "place", "block": 0, "offset": 4},
            {"op": "ime", "text": "戊"},
            {"op": "key", "key": "Ctrl+Z"},
            {"op": "key", "key": "Ctrl+Y"},
        ],
        "expect": {"text": "甲乙丙丁戊", "paras": 1},
    },
    {
        "id": "E08",
        "cat": "edit",
        "title": "列表项开头退格：先取消编号",
        "start": [("第一项", {"list": "decimal"}), ("第二项", {"list": "decimal"})],
        "ops": [{"op": "place", "block": 0, "offset": 0}, {"op": "key", "key": "Backspace"}],
        "expect": {"text": "第一项\n第二项", "xml": ["第一段丢失 numPr", "第二段编号重排为 1"]},
    },
    {
        "id": "E09",
        "cat": "edit",
        "title": "空列表项回车：保留编号并续号",
        "start": [("第一项", {"list": "decimal"}), ("", {"list": "decimal"})],
        "ops": [{"op": "place", "block": 1, "offset": 0}, {"op": "key", "key": "Enter"}],
        "expect": {"text": "第一项\n\n", "xml": ["空项保留 numPr", "新项 numId 相同"]},
    },
    {
        "id": "E10",
        "cat": "edit",
        "title": "粘贴多行文本",
        "start": "甲乙",
        "ops": [{"op": "place", "block": 0, "offset": 2}, {"op": "paste", "text": "丙丁\n戊己"}],
        "expect": {"text": "甲乙丙丁\n戊己", "paras": 2, "xml": ["换行转 w:p", "tab 转 w:tab"]},
    },
]


# ---------------------------------------------------------------------------
# 生成
# ---------------------------------------------------------------------------


def build_para_spec(doc: Document, item: dict) -> None:
    rpr = run_props(
        size_pt=item["size"],
        east_asia=item["east"],
        latin=item["latin"],
        bold=item["bold"],
        italic=item["italic"],
        underline=item["underline"],
        color=item["color"],
        spacing_pt=item["spacing"],
        vert_align=item["vert"],
    )
    ppr = para_props(
        align=item["align"],
        line=item["line"],
        line_rule=item["line_rule"],
        before_pt=item["before"],
        after_pt=item["after"],
        first_line_chars=item["first_line"],
        left_chars=item["left"],
        right_chars=item["right"],
        keep_next=item["keep_next"],
        keep_lines=item["keep_lines"],
        page_break_before=item["page_break_before"],
        widow=item["widow"],
        snap_to_grid=item["snap"],
    )
    add_para(doc, item["text"], ppr=ppr, rpr=rpr)


def build_custom(doc: Document, kind: str) -> None:
    base_rpr = run_props()
    if kind == "tabs_and_breaks":
        add_para(doc, "姓名\t年龄\t城市", ppr=para_props(), rpr=base_rpr)
        add_para(doc, "张三\t28\t北京", ppr=para_props(), rpr=base_rpr)
        add_soft_break_para(
            doc,
            ["第一行内容", "第二行内容", "第三行内容"],
            ppr=para_props(line=1.0),
            rpr=base_rpr,
        )
    elif kind == "justify_soft_break":
        add_soft_break_para(
            doc,
            [CJK40, CJK40, "短行"],
            ppr=para_props(align="both"),
            rpr=base_rpr,
        )
        add_para(doc, CJK80, ppr=para_props(align="both"), rpr=base_rpr)
    elif kind == "manual_page_break":
        add_para(doc, CJK20, ppr=para_props(), rpr=base_rpr)
        add_page_break_para(doc)
        add_para(doc, CJK20, ppr=para_props(), rpr=base_rpr)
    elif kind.startswith("table_"):
        build_table_custom(doc, kind)
    else:
        raise SystemExit(f"unknown custom kind: {kind}")


def build_one(spec: dict) -> Path:
    doc = new_doc()
    setup_section(doc, **(spec.get("page") or {}))
    if spec.get("custom"):
        build_custom(doc, spec["custom"])
    else:
        for item in spec["paras"]:
            build_para_spec(doc, item)
    out = FIXTURES / f"{spec['id']}.docx"
    doc.save(out)
    return out


def main() -> int:
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]

    FIXTURES.mkdir(parents=True, exist_ok=True)
    manifest = []
    for spec in SPECS:
        if only and spec["id"] != only:
            continue
        path = build_one(spec)
        manifest.append(
            {
                "id": spec["id"],
                "kind": "render",
                "cat": spec["cat"],
                "title": spec["title"],
                "why": spec["why"],
                "milestone": spec["milestone"],
                "file": f"fixtures/{path.name}",
                "checks": spec["checks"],
                "line_rules": sorted({item["line_rule"] for item in spec.get("paras", [])}),
                "bytes": path.stat().st_size,
            }
        )
        print(f"  {spec['id']}  {path.stat().st_size:>7} B  {spec['title']}")

    for spec in EDIT_SPECS:
        if only and spec["id"] != only:
            continue
        start = spec["start"]
        doc = new_doc()
        setup_section(doc)
        if isinstance(start, str):
            add_para(doc, start, ppr=para_props(), rpr=run_props())
        elif isinstance(start, list):
            for entry in start:
                if isinstance(entry, tuple):
                    text, fmt = entry
                else:
                    text, fmt = entry, {}
                add_para(
                    doc,
                    text,
                    ppr=para_props(),
                    rpr=run_props(bold=fmt.get("bold", False)),
                )
        path = FIXTURES / f"{spec['id']}.docx"
        doc.save(path)
        manifest.append(
            {
                "id": spec["id"],
                "kind": "edit",
                "cat": "edit",
                "title": spec["title"],
                "milestone": "M5",
                "file": f"fixtures/{path.name}",
                "ops": spec["ops"],
                "expect": spec["expect"],
                "bytes": path.stat().st_size,
            }
        )
        print(f"  {spec['id']}  {path.stat().st_size:>7} B  {spec['title']} (edit)")

    (CASES / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n{len(manifest)} cases -> {CASES / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
