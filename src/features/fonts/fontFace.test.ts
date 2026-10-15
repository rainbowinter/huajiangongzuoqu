import { describe, expect, it } from "vitest";
import {
  buildFontFaceCss,
  deriveFamily,
  deriveFontFaceSpecs,
  parseVariantToken,
  stackForPluginFamily,
  type FontSource,
} from "./fontFace";

function source(file: string, url = `asset:///${file}`): FontSource {
  return { file, url };
}

describe("parseVariantToken", () => {
  it("认字重词", () => {
    expect(parseVariantToken("Regular")).toEqual({ weight: 400, style: "normal" });
    expect(parseVariantToken("Light")).toEqual({ weight: 300, style: "normal" });
    expect(parseVariantToken("ExtraLight")).toEqual({ weight: 200, style: "normal" });
    expect(parseVariantToken("SemiBold")).toEqual({ weight: 600, style: "normal" });
    expect(parseVariantToken("Bold")).toEqual({ weight: 700, style: "normal" });
    expect(parseVariantToken("Black")).toEqual({ weight: 900, style: "normal" });
  });

  it("认字重 + 字形的组合", () => {
    expect(parseVariantToken("BoldItalic")).toEqual({ weight: 700, style: "italic" });
    expect(parseVariantToken("LightOblique")).toEqual({ weight: 300, style: "italic" });
  });

  it("纯样式词", () => {
    expect(parseVariantToken("Italic")).toEqual({ weight: 400, style: "italic" });
    expect(parseVariantToken("Oblique")).toEqual({ weight: 400, style: "italic" });
  });

  it("不认识的一律返回 null", () => {
    // 关键：`Retina` 不是变体词，否则 `FiraCode-Retina` 会被剥成 `Fira Code`，
    // 跟真正的 Fira Code 撞在一起。
    for (const token of ["Retina", "NF", "NL", "", "  ", "123"]) {
      expect(parseVariantToken(token)).toBeNull();
    }
  });
});

describe("deriveFamily", () => {
  it("剥掉变体后缀，族名与字重各归各位", () => {
    expect(deriveFamily("FiraCode-Regular.ttf")).toEqual({
      family: "Fira Code",
      weight: 400,
      style: "normal",
    });
    expect(deriveFamily("FiraCode-BoldItalic.ttf")).toEqual({
      family: "Fira Code",
      weight: 700,
      style: "italic",
    });
    expect(deriveFamily("MonaspaceNeon-Regular.otf")).toEqual({
      family: "Monaspace Neon",
      weight: 400,
      style: "normal",
    });
    expect(deriveFamily("VictorMono-Oblique.ttf")).toEqual({
      family: "Victor Mono",
      weight: 400,
      style: "italic",
    });
  });

  it("驼峰连写能拆开，全大写缩写不拆碎", () => {
    expect(deriveFamily("SourceCodePro-Regular.otf").family).toBe("Source Code Pro");
    expect(deriveFamily("IBMPlexMono-Regular.otf").family).toBe("IBM Plex Mono");
  });

  it("驼峰拆分只是猜，JetBrains 会被拆成两截", () => {
    // 这一条**故意**把文件名推导的局限写死：驼峰拆不出 `JetBrains` 是一个词。
    // 真实字体文件由 Rust 侧读 `name` 表给出真名（"JetBrains Mono"），文件名推导只负责
    // WOFF、损坏文件这类兜底场景 —— 见 deriveFontFaceSpecs 的取值优先级测试。
    expect(deriveFamily("JetBrainsMono-Regular.ttf").family).toBe("Jet Brains Mono");
    expect(deriveFamily("JetBrainsMonoNL-Regular.ttf").family).toBe("Jet Brains Mono NL");
  });

  it("全小写的词首字母大写，带大写的词原样保留", () => {
    expect(deriveFamily("iosevka-regular.ttf").family).toBe("Iosevka");
    expect(deriveFamily("hack-regular.ttf").family).toBe("Hack");
    expect(deriveFamily("IBMPlexMono-Regular.otf").family).toBe("IBM Plex Mono");
  });

  it("按空格/下划线分开的写法同样认得", () => {
    expect(deriveFamily("Fira Code Light.ttf")).toEqual({
      family: "Fira Code",
      weight: 300,
      style: "normal",
    });
    expect(deriveFamily("Fira_Code_Bold.ttf")).toEqual({
      family: "Fira Code",
      weight: 700,
      style: "normal",
    });
  });

  it("没有变体后缀时整段都是族名", () => {
    expect(deriveFamily("Hack.ttf")).toEqual({ family: "Hack", weight: 400, style: "normal" });
    expect(deriveFamily("FiraCode.ttf").family).toBe("Fira Code");
  });

  it("末段不是变体词就留在族名里", () => {
    expect(deriveFamily("FiraCode-Retina.ttf")).toEqual({
      family: "Fira Code Retina",
      weight: 400,
      style: "normal",
    });
  });
});

describe("deriveFontFaceSpecs", () => {
  it("逐项推导，并把 url 带上", () => {
    const specs = deriveFontFaceSpecs([source("SourceCodePro-Regular.otf", "asset:///a.otf")]);

    expect(specs).toEqual([
      {
        family: "Source Code Pro",
        weight: 400,
        style: "normal",
        file: "SourceCodePro-Regular.otf",
        url: "asset:///a.otf",
      },
    ]);
  });

  it("字体文件自己声明的族名压过文件名推导", () => {
    // 这才是常态：文件名把 `JetBrainsMono` 拆成 "Jet Brains Mono"，而字体内部的真名是
    // "JetBrains Mono"。宿主从 `name` 表读出来的那一档优先。
    const specs = deriveFontFaceSpecs([
      {
        file: "JetBrainsMono-Regular.ttf",
        url: "asset:///a.ttf",
        family: "JetBrains Mono",
        weight: 400,
        style: "normal",
      },
    ]);

    expect(specs[0]).toMatchObject({ family: "JetBrains Mono", weight: 400, style: "normal" });
  });

  it("字体文件缺的字段各自回落到文件名推导", () => {
    const specs = deriveFontFaceSpecs([
      { file: "FiraCode-Bold.ttf", url: "asset:///a.ttf", family: null, weight: null, style: null },
    ]);

    expect(specs[0]).toMatchObject({ family: "Fira Code", weight: 700, style: "normal" });
  });

  it("不认识的 style 当作没读到", () => {
    const specs = deriveFontFaceSpecs([
      { file: "FiraCode-Regular.ttf", url: "asset:///a.ttf", style: "oblique-ish" },
    ]);

    expect(specs[0].style).toBe("normal");
  });

  it("overrides 压过字体文件自己声明的", () => {
    const specs = deriveFontFaceSpecs(
      [{ file: "A.ttf", url: "asset:///a.ttf", family: "From File", weight: 400 }],
      { "A.ttf": { family: "From Plugin", weight: 300 } },
    );

    expect(specs[0]).toMatchObject({ family: "From Plugin", weight: 300 });
  });

  it("overrides 按文件名覆盖推导结果", () => {
    const specs = deriveFontFaceSpecs([source("weird-1.ttf")], {
      "weird-1.ttf": { family: "正经名", weight: 500, style: "italic" },
    });

    expect(specs[0]).toMatchObject({ family: "正经名", weight: 500, style: "italic" });
  });

  it("overrides 只覆盖给出的字段", () => {
    const specs = deriveFontFaceSpecs([source("FiraCode-Bold.ttf")], {
      "FiraCode-Bold.ttf": { family: "Fira Code Custom" },
    });

    expect(specs[0]).toMatchObject({ family: "Fira Code Custom", weight: 700 });
  });

  it("overrides 里给空白的族名不算数", () => {
    const specs = deriveFontFaceSpecs([source("FiraCode-Bold.ttf")], {
      "FiraCode-Bold.ttf": { family: "   " },
    });

    expect(specs[0].family).toBe("Fira Code");
  });
});

describe("buildFontFaceCss", () => {
  it("生成完整的 @font-face 规则", () => {
    const css = buildFontFaceCss(
      deriveFontFaceSpecs([source("FiraCode-Bold.ttf", "asset:///a.ttf")]),
    );

    expect(css).toContain('font-family:"Fira Code"');
    expect(css).toContain('url("asset:///a.ttf") format("truetype")');
    expect(css).toContain("font-weight:700");
    expect(css).toContain("font-style:normal");
    expect(css).toContain("font-display:swap");
  });

  it("按扩展名给 format 提示，ttc 不给", () => {
    const hints = (file: string) =>
      buildFontFaceCss(deriveFontFaceSpecs([source(file)])).match(/format\("([a-z0-9]+)"\)/)?.[1];

    expect(hints("A.otf")).toBe("opentype");
    expect(hints("A.woff")).toBe("woff");
    expect(hints("A.woff2")).toBe("woff2");
    expect(hints("A.ttc")).toBeUndefined();
  });

  it("族名与 URL 里的引号、反斜杠被转义", () => {
    const css = buildFontFaceCss([
      {
        family: 'We"ird\\Name',
        weight: 400,
        style: "normal",
        file: "a.ttf",
        url: 'asset:///we"ird\\path.ttf',
      },
    ]);

    // 未转义的引号会把整条规则截断，后面的 font-weight 就丢在字符串外面了。
    expect(css).toContain('font-family:"We\\"ird\\\\Name"');
    expect(css).toContain('url("asset:///we\\"ird\\\\path.ttf")');
    expect(css).toContain("font-weight:400");
  });

  it("空输入得到空字符串", () => {
    expect(buildFontFaceCss([])).toBe("");
  });
});

describe("stackForPluginFamily", () => {
  it("族名在前，等宽兜底在后", () => {
    // 兜底必须是**等宽**字体：插件停用后 @font-face 就没了，那时只剩兜底；
    // 若兜底是中文字体（比例字形），代码会悄悄变成非等宽。
    expect(stackForPluginFamily("Fira Code", '"Cascadia Code", Consolas, monospace')).toBe(
      '"Fira Code", "Cascadia Code", Consolas, monospace',
    );
  });
});
