/**
 * color-swatches（v2）—— 代码文件里的颜色块
 *
 * 每个颜色字面量前面叠一个小色块，点它直接开系统取色器，选完把原来的颜色换掉。
 * 这是「行内装饰」（`api.ui.registerDecorations`）的第一个用户，那个贡献点的三条约定
 * 都能在这个文件里看到：
 *
 * 1. **`render()` 返回数据，不是 HTML。** 每条是 `{ offset, length, color }`，位置由宿主
 *    从高亮层量出来 —— 插件没有 DOM，量不了字符在屏幕上的位置。
 * 2. **`color` 必须是 `#rrggbb`。** 色块本体是 `<input type="color">`，它按规范只认这个
 *    格式，所以折算（三位缩写 / `rgb()` / `hsl()` → 六位）是**插件**的活。
 * 3. **替换正文由插件自己做。** 宿主只回传「哪个区间、选了什么色」；插件才知道原文是
 *    `rgba(...)` 还是 `#hex`，也因此能保住透明度。
 *
 * ---------------------------------------------------------------------------
 *
 * 只对**代码文件**生效（`kind === "code"`）。笔记与 Markdown 里出现 `#fff` 多半是正文内容
 * 而不是颜色声明，标上色块只会碍事。
 */

/** 一次扫描认这些写法。长的在前，免得 `#ffffff` 被 `#fff` 截胡。 */
const HEX_PATTERN = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const RGB_PATTERN = /\brgba?\(([^()]*)\)/gi;
const HSL_PATTERN = /\bhsla?\(([^()]*)\)/gi;

/** 颜色字面量本身长什么样 —— `pick` 时用它核对区间有没有被改过。 */
const COLOR_LITERAL = /^(#[0-9a-fA-F]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\))$/;

/* ------------------------------------------------------------------ 工具 */

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function clampChannel(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex) {
  const value = hex.slice(1);
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function hslToHex(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, saturation));
  const l = Math.max(0, Math.min(1, lightness));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const offset = l - chroma / 2;

  const table = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const [r, g, b] = table[Math.floor(h / 60) % 6];
  return rgbToHex(
    clampChannel((r + offset) * 255),
    clampChannel((g + offset) * 255),
    clampChannel((b + offset) * 255),
  );
}

/** 把一个颜色字面量折算成 `#rrggbb`；折算不了返回 null。 */
function toHexColor(literal) {
  const text = literal.trim();

  if (text.startsWith("#")) {
    const value = text.slice(1);
    if (value.length === 3 || value.length === 4) {
      // #rgb / #rgba → 每位数翻倍
      const expanded = value
        .slice(0, 3)
        .split("")
        .map((char) => char + char)
        .join("");
      return `#${expanded.toLowerCase()}`;
    }
    // #rrggbb / #rrggbbaa → 丢掉 alpha（取色器表达不了它）
    return `#${value.slice(0, 6).toLowerCase()}`;
  }

  const call = /^([a-z]+)\(([^()]*)\)$/i.exec(text);
  if (!call) return null;

  const name = call[1].toLowerCase();
  // 支持 `rgb(1, 2, 3)` 与 `rgb(1 2 3 / 50%)` 两种写法
  const parts = call[2].split(/[,\s/]+/).filter(Boolean);

  if (name.startsWith("rgb")) {
    if (parts.length < 3) return null;
    const channel = (raw) => {
      const trimmed = raw.trim();
      const value = parseFloat(trimmed);
      return trimmed.endsWith("%") ? (value / 100) * 255 : value;
    };
    return rgbToHex(
      clampChannel(channel(parts[0])),
      clampChannel(channel(parts[1])),
      clampChannel(channel(parts[2])),
    );
  }

  if (name.startsWith("hsl")) {
    if (parts.length < 3) return null;
    return hslToHex(parseFloat(parts[0]), parseFloat(parts[1]) / 100, parseFloat(parts[2]) / 100);
  }

  return null;
}

/**
 * 这个字面量带不带透明度？带的话返回原样的 alpha 记号（可能是 `0.5`，也可能是 `50%`）。
 *
 * 换色时要把 alpha 原样带回去 —— 取色器只能表达不透明色，直接写 `#rrggbb` 会把
 * `rgba(0,0,0,.25)` 变成实心黑，那是用户没要求的改动。
 */
function readAlphaToken(literal) {
  const call = /^(rgba|hsla)\(([^()]*)\)$/i.exec(literal.trim());
  if (!call) return null;
  const parts = call[2].split(/[,\s/]+/).filter(Boolean);
  return parts.length >= 4 ? parts[3] : null;
}

/**
 * 注释区间。颜色块不该出现在被注释掉的代码上 —— 扫一遍 `App.css` 就知道，那里满屏都是
 * 「曾经的」颜色，全标上色块既吵又容易点错。
 *
 * `//` 的判据带了 `前一个字符不是 :` 这一条：URL 里的 `https://` 不能被当成注释开头，
 * 否则那一行后面的真颜色全被吞掉。
 */
function commentRanges(text) {
  const ranges = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close < 0 ? text.length : close + 2;
      ranges.push([index, stop]);
      index = stop;
      continue;
    }
    if (text[index] === "/" && text[index + 1] === "/" && text[index - 1] !== ":") {
      const close = text.indexOf("\n", index + 2);
      const stop = close < 0 ? text.length : close;
      ranges.push([index, stop]);
      index = stop;
      continue;
    }
    index += 1;
  }

  return ranges;
}

function inRanges(ranges, offset) {
  return ranges.some(([start, stop]) => offset >= start && offset < stop);
}

/** 扫出正文里所有颜色字面量。纯函数，测试直接喂样例。 */
function scanColors(text) {
  const comments = commentRanges(text);
  const found = [];

  const collect = (pattern) => {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const literal = match[0];
      if (!inRanges(comments, match.index)) {
        const color = toHexColor(literal);
        if (color) {
          found.push({ offset: match.index, length: literal.length, color });
        }
      }
      match = pattern.exec(text);
    }
  };

  collect(HEX_PATTERN);
  collect(RGB_PATTERN);
  collect(HSL_PATTERN);

  // 三种写法各自扫一遍，同一位置不会重叠，但要按出现顺序排好 —— 宿主按顺序渲染。
  found.sort((left, right) => left.offset - right.offset);
  return found;
}

floral.register({
  onLoad(api) {
    api.ui.registerDecorations({
      id: "colors",
      title: "颜色块",

      render() {
        const file = api.editor.getFileSync();
        if (!file || file.kind !== "code") return [];
        return scanColors(api.editor.getContentSync());
      },

      pick(offset, length, color) {
        void (async () => {
          const content = await api.editor.getContent();
          const original = content.slice(offset, offset + length);

          // 渲染到点击之间正文可能已经被编辑过（既有约定，见 outline 的点击处理）。
          // 区间对不上就什么都不做 —— 总比把一段无关的文字替换掉好。
          if (!COLOR_LITERAL.test(original)) return;

          const alpha = readAlphaToken(original);
          const replacement = alpha === null ? color : toRgba(color, alpha);

          // 走宿主的可撤销写入路径，Ctrl+Z 照常。
          await api.editor.replaceRange(offset, offset + length, replacement);
        })();
      },
    });
  },
});

function toRgba(hex, alpha) {
  const [red, green, blue] = hexToRgb(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
