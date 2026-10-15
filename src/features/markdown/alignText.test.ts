import { describe, expect, test } from "vitest";
import {
  absorbsFollowingLine,
  applyAlign,
  blockRangeAt,
  isAlignClose,
  parseAlignMarker,
} from "./alignText";

/** 在 `|` 处放光标，方便把测试的注意力留在文本上。 */
function caretAt(marked: string): { text: string; caret: number } {
  const caret = marked.indexOf("|");
  return { text: marked.replace("|", ""), caret };
}

describe("认标记行", () => {
  test("三种对齐都认，空格可有可无", () => {
    expect(parseAlignMarker("::: center")).toBe("center");
    expect(parseAlignMarker(":::center")).toBe("center");
    expect(parseAlignMarker(":::   right   ")).toBe("right");
    expect(parseAlignMarker("::: left")).toBe("left");
  });

  test("别的行一概不认", () => {
    expect(parseAlignMarker(":::")).toBeNull();
    expect(parseAlignMarker("::: middle")).toBeNull();
    expect(parseAlignMarker("::: center 后面还有字")).toBeNull();
    expect(parseAlignMarker("正文")).toBeNull();
    expect(parseAlignMarker(":: center")).toBeNull();
  });

  test("收尾标记就是光秃秃一个 :::", () => {
    expect(isAlignClose(":::")).toBe(true);
    expect(isAlignClose("  :::  ")).toBe(true);
    expect(isAlignClose("::: center")).toBe(false);
  });
});

describe("找出光标所在的整段", () => {
  test("连续几行算一段，空行是分界", () => {
    const text = "第一行\n第二行\n\n第三行";
    expect(blockRangeAt(text, 1, 1)).toEqual({ start: 0, end: "第一行\n第二行".length });
    expect(blockRangeAt(text, 10, 10)).toEqual({
      start: "第一行\n第二行\n\n".length,
      end: text.length,
    });
  });

  test("范围跨了多行时，整段一起算", () => {
    const text = "a\n\n甲\n乙\n丙\n\nd";
    expect(blockRangeAt(text, 3, 5)).toEqual({
      start: "a\n\n".length,
      end: "a\n\n甲\n乙\n丙".length,
    });
  });

  test("首尾是段的情况", () => {
    expect(blockRangeAt("甲\n乙", 0, 0)).toEqual({ start: 0, end: 3 });
    expect(blockRangeAt("甲\n乙", 3, 3)).toEqual({ start: 0, end: 3 });
  });
});

describe("套上对齐", () => {
  test("单行：上下各加一行标记", () => {
    const { text, caret } = caretAt("前面\n\n这段居中|\n\n后面");
    const result = applyAlign(text, caret, caret, "center");

    expect(result.text).toBe("前面\n\n::: center\n这段居中\n:::\n\n后面");
  });

  test("多行的一段会被整段包住，而不是只包光标那一行", () => {
    // 只包一行会把这一段劈成两半，是用户最容易觉得「怎么只动了一半」的地方。
    const { text, caret } = caretAt("第一行\n第二行|\n第三行");
    const result = applyAlign(text, caret, caret, "center");

    expect(result.text).toBe("::: center\n第一行\n第二行\n第三行\n:::");
  });

  test("不会吃掉相邻的空行", () => {
    const { text, caret } = caretAt("\n\n这段居中|\n\n");
    expect(applyAlign(text, caret, caret, "right").text).toBe("\n\n::: right\n这段居中\n:::\n\n");
  });

  test("有选区时按选区所在的整段来包", () => {
    const text = "甲\n乙\n丙";
    expect(applyAlign(text, 2, 3, "left").text).toBe("::: left\n甲\n乙\n丙\n:::");
  });

  test("空行上点：放一个空容器，光标落在中间", () => {
    const { text, caret } = caretAt("前面\n|\n后面");
    const result = applyAlign(text, caret, caret, "center");

    expect(result.text).toBe("前面\n::: center\n\n:::\n后面");
    // 光标在中间那个空行上，直接就能打正文。
    expect(result.text.slice(result.start, result.end)).toBe("");
    expect(result.text.slice(0, result.start).endsWith("::: center\n")).toBe(true);
  });
});

describe("再点一下", () => {
  test("同一种对齐再点一次就是撤掉", () => {
    const once = applyAlign("这段居中", 0, 4, "center");
    const twice = applyAlign(once.text, once.start, once.end, "center");

    expect(once.text).toBe("::: center\n这段居中\n:::");
    expect(twice.text).toBe("这段居中");
  });

  test("换成另一种对齐只改标记行，不会先撤再加", () => {
    const once = applyAlign("这段居中", 0, 4, "center");
    const changed = applyAlign(once.text, once.start, once.end, "right");

    expect(changed.text).toBe("::: right\n这段居中\n:::");
  });

  test("撤掉之后还给同一段文字留着选区，可以继续点", () => {
    const once = applyAlign("这段居中", 0, 4, "center");
    const twice = applyAlign(once.text, once.start, once.end, "center");

    expect(twice.text.slice(twice.start, twice.end)).toBe("这段居中");
  });

  test("撤掉时前面的正文一个字都不动", () => {
    const source = "前面\n\n::: center\n这段\n:::\n\n后面";
    // 光标落在「这段」里
    const caret = source.indexOf("这段");
    const result = applyAlign(source, caret, caret, "center");

    expect(result.text).toBe("前面\n\n这段\n\n后面");
  });

  test("多行的一段也能撤干净", () => {
    const source = "::: center\n甲\n乙\n:::\n后面";
    const result = applyAlign(source, source.indexOf("乙"), source.indexOf("乙"), "center");

    expect(result.text).toBe("甲\n乙\n后面");
  });

  test("光标停在标记行上也不会套出嵌套容器", () => {
    const source = "::: center\n甲\n乙\n:::";
    const onOpen = applyAlign(source, 2, 2, "center");
    const onClose = applyAlign(source, source.indexOf(":::" , 12), source.indexOf(":::", 12), "center");

    // 无论从标记行的哪一处点下去，处理的都是容器里那段正文。
    expect(onOpen.text).toBe("甲\n乙");
    expect(onClose.text).toBe("甲\n乙");
  });
});

describe("写了一半的容器", () => {
  test("上面开着标记却没有收尾：顺手合上，而不是再套一层", () => {
    const source = "::: center\n这段居中";
    const result = applyAlign(source, source.length, source.length, "center");

    expect(result.text).toBe("::: center\n这段居中\n:::");
  });

  test("写了一半又想换一种对齐：改标记行再合上", () => {
    const source = "::: center\n这段居中";
    const result = applyAlign(source, source.length, source.length, "right");

    expect(result.text).toBe("::: right\n这段居中\n:::");
  });
});

describe("内容以列表 / 表格 / 引用结尾", () => {
  // Markdown 的「惰性续行」：紧跟列表项（或表格行、引用）的那一行会被并进它们里面。
  // 实测 `::: center\n- 甲\n- 乙\n:::` 的最后一个 `:::` 会变成列表里的第三项；
  // 换成表格更糟 —— 会**新增一行数据**。所以这种情况下收尾前面必须空一行。

  test("列表：收尾的 ::: 前面自动空一行", () => {
    expect(applyAlign("- 甲\n- 乙", 2, 2, "center").text).toBe("::: center\n- 甲\n- 乙\n\n:::");
  });

  test("表格：同样自动空一行", () => {
    expect(applyAlign("| a | b |\n| --- | --- |", 2, 2, "center").text).toBe(
      "::: center\n| a | b |\n| --- | --- |\n\n:::",
    );
  });

  test("引用：同样", () => {
    expect(applyAlign("> 引用", 3, 3, "right").text).toBe("::: right\n> 引用\n\n:::");
  });

  test("普通段落不空那一行 —— 绝大多数情况源码就该是干净的三行", () => {
    expect(applyAlign("一段话", 1, 1, "center").text).toBe("::: center\n一段话\n:::");
  });

  test("撤掉时把补的那个空行也收回去", () => {
    const once = applyAlign("- 甲\n- 乙", 2, 2, "center");
    const twice = applyAlign(once.text, once.start, once.end, "center");

    expect(once.text).toBe("::: center\n- 甲\n- 乙\n\n:::");
    expect(twice.text).toBe("- 甲\n- 乙");
  });

  test("隔着空行的容器也能切换对齐", () => {
    const source = "::: center\n- 甲\n- 乙\n\n:::";
    const changed = applyAlign(source, source.indexOf("甲"), source.indexOf("甲"), "right");

    expect(changed.text).toBe("::: right\n- 甲\n- 乙\n\n:::");
  });

  test("判断哪些行会吃掉下一行", () => {
    expect(absorbsFollowingLine("- 列表")).toBe(true);
    expect(absorbsFollowingLine("* 列表")).toBe(true);
    expect(absorbsFollowingLine("+ 列表")).toBe(true);
    expect(absorbsFollowingLine("1. 列表")).toBe(true);
    expect(absorbsFollowingLine("| 表格 |")).toBe(true);
    expect(absorbsFollowingLine("> 引用")).toBe(true);
  });

  test("围栏 / 缩进代码块与标题都**不会**吃掉下一行（实测过，多判只会白白多一行空行）", () => {
    expect(absorbsFollowingLine("```js")).toBe(false);
    expect(absorbsFollowingLine("   缩进代码")).toBe(false);
    expect(absorbsFollowingLine("## 标题")).toBe(false);
    expect(absorbsFollowingLine("普通段落")).toBe(false);
    expect(absorbsFollowingLine("")).toBe(false);
  });
});

describe("往返性质", () => {
  const documents = [
    "单行",
    "第一行\n第二行",
    "\n\n夹在空行之间\n\n",
    "甲\n\n乙\n\n丙",
    "## 标题\n\n正文一段",
  ];

  for (const document of documents) {
    for (const kind of ["left", "center", "right"] as const) {
      test(`${JSON.stringify(document)} 套两次回到原样（${kind}）`, () => {
        // 光标放在第一处正文上：放在空行上是「插入空容器」那条路径，不是这里要测的。
        const caret = document.match(/\S/)?.index ?? 0;
        const once = applyAlign(document, caret, caret, kind);
        const twice = applyAlign(once.text, once.start, once.end, kind);

        // 套一次必然多出两行标记，撤销必须正好还回去。
        expect(once.text).not.toBe(document);
        expect(twice.text).toBe(document);
      });
    }
  }
});
