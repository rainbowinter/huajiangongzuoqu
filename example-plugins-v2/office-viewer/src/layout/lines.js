/**
 * 段落 → 行。
 *
 * 这一层负责 Word 排版里最核心的几件事：
 *
 * * 逐原子装行（断点服从禁则）
 * * 行高（`w:spacing` 的 auto / exact / atLeast + 文档网格）
 * * 首行缩进 / 悬挂缩进 / 左右缩进
 * * 两端对齐（最后一行不对齐）
 * * 手动换行、分页符
 *
 * 行对象是渲染与分页之间唯一的契约，字段都尽量是笨数据。
 */

import { ptToPx, twipsToPx } from "../units.js";
import {
  atomEndCaret,
  atomStartCaret,
  atomize,
  canBreakBefore,
  countCharacters,
  splitTextAtom,
} from "./atoms.js";
import { effectiveSizePx, fontMetrics } from "./measure.js";

/**
 * Word 的缩进常常**同时**写 `w:firstLine="640"` 与 `w:firstLineChars="200"`：
 * 前者是 twips，后者是「百分之几个字符」。两者说的是同一件事，**不能相加**。
 * 有 twips 就以 twips 为准（它没有字体歧义）；只有字符单位时才按字号折算。
 */
function indentPx(valueTwips, valueChars, charWidth) {
  if (valueTwips !== undefined && valueTwips !== null) return twipsToPx(valueTwips);
  if (valueChars !== undefined && valueChars !== null) {
    return (valueChars / 100) * charWidth;
  }
  return 0;
}

function computeIndent(paragraph, options) {
  const ind = paragraph.props.ind ?? {};
  // 首行 / 悬挂缩进的字符单位按这一段第一个字的字号折算；左右缩进按 WPS
  // 的实测口径用的是**段落默认字号**（B08：10.5pt 正文、默认 11pt，2 字符
  // 左缩进 WPS 是 21.96pt 而不是 21pt）。
  const firstText = paragraph.items.find((item) => item.kind === "text");
  const runStyle = firstText?.style ?? paragraph.defaultStyle ?? { sizePx: 14 };
  const defaultStyle = paragraph.defaultStyle ?? runStyle;
  const charWidth = effectiveSizePx(runStyle, options);
  const defaultCharWidth = effectiveSizePx(defaultStyle, options);

  const left = indentPx(ind.left, ind.leftChars, defaultCharWidth);
  const right = indentPx(ind.right, ind.rightChars, defaultCharWidth);
  const first = indentPx(ind.firstLine, ind.firstLineChars, charWidth);
  const hanging = indentPx(ind.hanging, ind.hangingChars, charWidth);

  return {
    left,
    right,
    firstLeft: Math.max(0, left + first - hanging),
  };
}

function lineSpacing(paragraph, context) {
  const { options } = context;
  const spacing = paragraph.props.spacing ?? {};
  let rule = spacing.lineRule ?? "auto";
  let value = spacing.line ?? 240;

  if (options.lineSpacingMode === "auto" && options.lineSpacingValue != null) {
    rule = "auto";
    value = options.lineSpacingValue * 240;
  } else if (options.lineSpacingMode === "exact" && options.lineSpacingValue != null) {
    rule = "exact";
    value = options.lineSpacingValue;
  } else if (options.lineSpacingMode === "atLeast" && options.lineSpacingValue != null) {
    rule = "atLeast";
    value = options.lineSpacingValue;
  }

  return { rule, value };
}

function lineHeightFor(atoms, paragraph, context) {
  const { section, options } = context;
  const style = paragraph.defaultStyle ?? { sizePx: 14 };
  // 有文字 atom 时，行高取**这一行实际字体**的最大值；段落默认样式只用来兜底
  // 空行。否则 9pt 的段落会被 10.5pt 的默认行高顶住，字号阶梯整段变平。
  let base = 0;
  for (const atom of atoms) {
    if (atom.lineHeight && atom.lineHeight > base) base = atom.lineHeight;
  }
  if (base === 0) {
    const isCJK = Boolean(style.fontEastAsia);
    base = fontMetrics(style, isCJK, options).lineHeight;
  }

  const hasInlineImage = atoms.some((atom) => atom.kind === "image" && !atom.floating);
  const { rule, value } = lineSpacing(paragraph, context);

  let height;
  if (rule === "exact") {
    height = options.lineSpacingMode === "exact" && options.lineSpacingValue != null
      ? ptToPx(options.lineSpacingValue)
      : twipsToPx(value);
  } else if (rule === "atLeast") {
    const minimum = options.lineSpacingMode === "atLeast" && options.lineSpacingValue != null
      ? ptToPx(options.lineSpacingValue)
      : twipsToPx(value);
    height = Math.max(base, minimum);
  } else {
    height = base * (value / 240);
  }

  // 文档网格：中文 Word 的默认行距是靠它对齐的。exact 不吸附（固定值就是要精确）。
  if (
    rule !== "exact" &&
    section.docGrid.snapsLines &&
    paragraph.props.snapToGrid !== false &&
    section.docGrid.linePitch > 0
  ) {
    const pitch = section.docGrid.linePitch;
    if (rule === "auto") {
      // 网格只决定「一倍」的行高；多倍行距在这之上再乘倍数。
      // G02：linePitch 15.6pt、行距 1.15 → WPS 17.88pt（≈15.6×1.15）。
      height = pitch * Math.max(1, value / 240);
    } else {
      height = Math.max(pitch, Math.ceil((height - 0.01) / pitch) * pitch);
    }
  }

  // 行内图片不能比图片本身矮：网格吸附 / 多倍行距只能加高，不能压扁。
  if (hasInlineImage && rule !== "exact") height = Math.max(height, base);

  return height;
}

/**
 * 行盒内的基线位置（相对行顶）。
 *
 * Word 不是把文字贴着行顶放：
 *
 * * `exact`：基线固定在行高的 ~80% 处（S02：20pt 固定行距，WPS 基线在 16.01pt）。
 *   字号再大也不外溢，这正是「固定值」裁切文字的来源。
 * * `atLeast`：行高至少是给定值；多出来的空间全在文字上方，文字按底边的
 *   descent 对齐（S02 第二段 24pt 最小值，WPS 基线 20.97pt ≈ 24 − descent）。
 * * `auto`：就是字体的 ascent；网格吸附只加高行盒，基线不动。
 */
function baselineFor(atoms, paragraph, context, height) {
  const style = paragraph.defaultStyle ?? { sizePx: 14 };
  let ascent = 0;
  let descent = 0;
  for (const atom of atoms) {
    // 空白原子按段落样式撑高度，但不参与基线定位（否则上标行会被空格
    // 的未缩放 ascent 拉回正常基线，C05）。
    if (atom.isSpace) continue;
    if (atom.ascent && atom.ascent > ascent) ascent = atom.ascent;
    if (atom.descent && atom.descent > descent) descent = atom.descent;
  }
  if (ascent === 0) {
    const metrics = fontMetrics(style, Boolean(style.fontEastAsia), context.options);
    ascent = metrics.ascent;
    descent = metrics.descent;
  }

  const { section } = context;
  const { rule } = lineSpacing(paragraph, context);
  // 固定值不受字体 ascent 限制：字号大于行高时文字会溢出（Word 正是这样裁切）。
  if (rule === "exact") return height * 0.8;
  if (rule === "atLeast" && height > ascent + descent) {
    // 底边对齐：基线之上留出全部多余空间。
    return Math.max(ascent, height - descent);
  }
  // 网格行比一倍网格高时（多倍行距），多出来的空间加在文字上方，
  // 否则基线与上一行的距离还是旧行高，G02 的 17.88pt 会量成 15.73pt。
  if (
    rule === "auto" &&
    section.docGrid.snapsLines &&
    paragraph.props.snapToGrid !== false &&
    section.docGrid.linePitch > 0 &&
    height > section.docGrid.linePitch
  ) {
    return ascent + (height - section.docGrid.linePitch);
  }
  return ascent;
}

function computeSpacing(paragraph, context, baseLineHeight) {
  const { options } = context;
  const spacing = paragraph.props.spacing ?? {};

  let before;
  if (options.spaceBeforePt != null) {
    before = ptToPx(options.spaceBeforePt);
  } else if (spacing.before !== undefined) {
    before = twipsToPx(spacing.before);
  } else if (spacing.beforeLines !== undefined) {
    before = (spacing.beforeLines / 100) * baseLineHeight;
  } else {
    before = 0;
  }

  let after;
  if (options.spaceAfterPt != null) {
    after = ptToPx(options.spaceAfterPt);
  } else if (spacing.after !== undefined) {
    after = twipsToPx(spacing.after);
  } else if (spacing.afterLines !== undefined) {
    after = (spacing.afterLines / 100) * baseLineHeight;
  } else {
    after = 0;
  }

  return { before: Math.max(0, before), after: Math.max(0, after) };
}

function computeTabWidth(currentWidth, paragraph, context) {
  const tabStop = context.settings.defaultTabStop || 28;
  const tabs = paragraph.props.tabs ?? [];
  let target = null;
  for (const tab of tabs) {
    const position = twipsToPx(tab.pos);
    if (position > currentWidth + 0.5) {
      target = position;
      break;
    }
  }
  if (target === null) {
    target = (Math.floor(currentWidth / tabStop) + 1) * tabStop;
  }
  const width = target - currentWidth;
  return width > 0.5 ? width : tabStop;
}

function makeLine(atoms, paragraph, context, lineIndex, fallbackCaret) {
  const indent = computeIndent(paragraph, context.options);
  const firstLine = lineIndex === 0;
  const left = firstLine ? indent.firstLeft : indent.left;
  const available = Math.max(1, context.section.contentWidth - left - indent.right);
  const naturalWidth = atoms.reduce((sum, atom) => sum + (atom.width ?? 0), 0);
  const alignment = context.options.alignOverride ?? paragraph.props.jc ?? "left";

  // 编号标签占视觉宽度，但光标只能落在它后面的第一个真实 item 上。
  let labelWidth = 0;
  for (const atom of atoms) {
    if (atom.itemIndex === -1) labelWidth += atom.width ?? 0;
    else break;
  }
  const firstReal = atoms.find((atom) => atom.itemIndex != null && atom.itemIndex >= 0);
  let lastReal = null;
  for (let index = atoms.length - 1; index >= 0; index -= 1) {
    const atom = atoms[index];
    if (atom.itemIndex != null && atom.itemIndex >= 0) {
      lastReal = atom;
      break;
    }
  }
  const startCaret = atomStartCaret(firstReal) ?? fallbackCaret;
  const endCaret = atomEndCaret(lastReal) ?? startCaret;
  const height = lineHeightFor(atoms, paragraph, context);

  return {
    kind: "line",
    atoms,
    paragraphIndex: paragraph.index,
    paraNumber: paragraph.index + 1,
    lineIndex,
    height,
    baseline: baselineFor(atoms, paragraph, context, height),
    naturalWidth,
    availableWidth: available,
    paddingLeft: left,
    paddingRight: indent.right,
    labelWidth,
    startCaret,
    endCaret,
    alignment,
    letterSpacing: 0,
    justified: false,
    charCount: countCharacters(atoms),
    spaceBefore: 0,
    spaceAfter: 0,
    isFirstInParagraph: false,
    isLastInParagraph: false,
    manualBreak: false,
    pageBreakAfter: false,
    paragraphEnd: false,
    segmentEnd: false,
  };
}

function finalizeSegment(lines, control, isFinalSegment) {
  if (lines.length === 0) return;
  const last = lines[lines.length - 1];
  last.segmentEnd = true;
  last.manualBreak = control === "lineBreak";
  last.pageBreakAfter = control === "pageBreak";
  last.paragraphEnd = isFinalSegment && control === null;

  for (const [index, line] of lines.entries()) {
    const isLast = index === lines.length - 1;
    const justify =
      line.alignment === "distribute" || (line.alignment === "both" && !isLast);
    if (!justify || line.charCount <= 1) continue;
    const extra = line.availableWidth - line.naturalWidth;
    if (extra > 0.01) {
      line.justified = true;
      line.letterSpacing = extra / (line.charCount - 1);
    }
  }
}

function layoutSegment(
  segmentAtoms,
  paragraph,
  context,
  startLineIndex,
  control,
  isFinalSegment,
  segmentStart,
) {
  const lines = [];
  const atoms = [...segmentAtoms];

  if (atoms.length === 0) {
    lines.push(makeLine([], paragraph, context, startLineIndex, segmentStart));
    finalizeSegment(lines, control, isFinalSegment);
    return lines;
  }

  let index = 0;
  while (index < atoms.length) {
    const lineIndex = startLineIndex + lines.length;
    const indent = computeIndent(paragraph, context.options);
    const left = lineIndex === 0 ? indent.firstLeft : indent.left;
    const available = Math.max(1, context.section.contentWidth - left - indent.right);

    let width = 0;
    let cursor = index;
    let lastBreak = index;

    while (cursor < atoms.length) {
      const atom = atoms[cursor];
      const atomWidth = atom.isTab
        ? computeTabWidth(width, paragraph, context)
        : (atom.width ?? 0);
      if (width + atomWidth <= available + 0.5) {
        if (atom.isTab) atom.width = atomWidth;
        width += atomWidth;
        cursor += 1;
        if (canBreakBefore(atoms, cursor, paragraph.props.kinsoku !== false)) {
          lastBreak = cursor;
        }
      } else {
        break;
      }
    }

    if (cursor === index) {
      // 这一行一个原子都放不下。长单词才拆字；单个字符 / 图片 / 制表符直接溢出。
      const atom = atoms[index];
      if (atom.kind === "text" && !atom.isSpace && Array.from(atom.text).length > 1) {
        atoms.splice(index, 1, ...splitTextAtom(atom, context.options));
        continue;
      }
      cursor = index + 1;
    }

    let takeEnd = cursor;
    if (cursor < atoms.length && lastBreak > index) takeEnd = lastBreak;

    // 行尾空格不占下一行的开头：本行留到最后一个非空格，后面的空格直接吃掉。
    if (takeEnd < atoms.length) {
      while (takeEnd > index && atoms[takeEnd - 1].isSpace) takeEnd -= 1;
      if (takeEnd === index) {
        // 整行只有空格：把空格放进来，别死循环。
        takeEnd = cursor;
      }
    }

    const lineAtoms = atoms.slice(index, takeEnd);
    lines.push(makeLine(lineAtoms, paragraph, context, lineIndex, segmentStart));
    index = takeEnd;
    // 跨过断行处的空格。
    while (index < atoms.length && atoms[index].isSpace && takeEnd < atoms.length) index += 1;
  }

  finalizeSegment(lines, control, isFinalSegment);
  return lines;
}

/**
 * 一个段落 → 行。
 *
 * 段落里的 `w:br` 会把原子序列切成多段；每一段单独装行，段尾标记手动换行 / 分页。
 */
export function layoutParagraph(paragraph, context) {
  const atoms = atomize(paragraph, context.options);
  const segments = [];
  let current = [];
  // 空段（连续两个手动换行）也要知道光标该落在哪个 item 边界上。
  let segmentStart = { itemIndex: 0, offset: 0 };

  for (const atom of atoms) {
    if (atom.kind === "control") {
      segments.push({ atoms: current, control: atom.type, start: segmentStart });
      segmentStart = atomEndCaret(atom) ?? segmentStart;
      current = [];
    } else {
      current.push(atom);
    }
  }
  segments.push({ atoms: current, control: null, start: segmentStart });

  const lines = [];
  paragraph.pageBreakAfter = false;
  let previousControl = null;
  let pendingPageBreak = false;

  for (const [index, segment] of segments.entries()) {
    const isFinalSegment = index === segments.length - 1;

    if (segment.atoms.length === 0) {
      // 分页符本身不占一行：把 break 挂到上一行末尾；段首的分页符挂到下一行开头。
      if (segment.control === "pageBreak") {
        if (lines.length > 0) lines[lines.length - 1].pageBreakAfter = true;
        else pendingPageBreak = true;
        previousControl = "pageBreak";
        continue;
      }
      // 分页符之后的段尾空 segment 不再生成幽灵空行。
      if (segment.control === null && previousControl === "pageBreak") continue;
    }

    const produced = layoutSegment(
      segment.atoms,
      paragraph,
      context,
      lines.length,
      segment.control,
      isFinalSegment,
      segment.start,
    );
    if (pendingPageBreak && produced.length > 0) {
      produced[0].pageBreakBefore = true;
      pendingPageBreak = false;
    }
    lines.push(...produced);
    previousControl = segment.control;
  }

  if (lines.length === 0) {
    if (pendingPageBreak) {
      // 整段只有分页符：不占行，分页交给分页器在 block 级别处理。
      paragraph.pageBreakAfter = true;
    } else {
      lines.push(makeLine([], paragraph, context, 0, { itemIndex: 0, offset: 0 }));
      finalizeSegment(lines, null, true);
    }
  }

  const defaultMetrics = fontMetrics(
    paragraph.defaultStyle ?? { sizePx: 14 },
    false,
    context.options,
  );
  const spacing = computeSpacing(paragraph, context, defaultMetrics.lineHeight);

  if (lines.length > 0) {
    lines[0].isFirstInParagraph = true;
    lines[0].spaceBefore = spacing.before;
    lines[lines.length - 1].isLastInParagraph = true;
    lines[lines.length - 1].spaceAfter = spacing.after;
  }

  return lines;
}
