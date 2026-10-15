import { describe, expect, test } from "vitest";
import { caretAfterChange, createEditorHistory } from "./history";

/** 可控时钟：合并窗口是按时间判断的，真等下去测试会很慢也很脆。 */
function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("按文件分开", () => {
  test("两个文件各自一条历史，互不干扰", () => {
    const time = clock();
    const history = createEditorHistory({ now: time.now });

    history.record("a.md", "", "A 的内容", true);
    history.record("b.py", "", "B 的内容", true);

    expect(history.undo("a.md")).toBe("");
    expect(history.undo("b.py")).toBe("");

    // 撤 A 不该动到 B 的重做分支。
    expect(history.canRedo("a.md")).toBe(true);
    expect(history.redo("a.md")).toBe("A 的内容");
  });

  test("这正是那个 bug：撤的必须是当前文件自己的那一步", () => {
    // 同一个 textarea 上换过值，原生栈会把 A 的编辑当成 B 的历史。
    const time = clock();
    const history = createEditorHistory({ now: time.now });

    history.record("A", "", "在 A 里打的字", true);
    time.advance(5000);
    history.record("B", "", "在 B 里打的字", true);

    expect(history.undo("B")).toBe("");
    // B 撤到底之后就没有了，**不会**串到 A 的内容。
    expect(history.undo("B")).toBeNull();
    expect(history.undo("A")).toBe("");
  });

  test("没登记过的文件没有可撤的东西", () => {
    const history = createEditorHistory();
    expect(history.undo("never-seen")).toBeNull();
    expect(history.canUndo("never-seen")).toBe(false);
  });
});

describe("连续输入合并成一步", () => {
  test("合并窗口内的多次输入只算一步", () => {
    const time = clock();
    const history = createEditorHistory({ now: time.now, coalesceMs: 500 });

    history.record("n", "", "a", true);
    time.advance(100);
    history.record("n", "a", "ab", true);
    time.advance(100);
    history.record("n", "ab", "abc", true);

    // 三次输入，一次撤销就该回到空白。
    expect(history.undo("n")).toBe("");
    expect(history.canUndo("n")).toBe(false);
  });

  test("超过合并窗口后另起一步", () => {
    const time = clock();
    const history = createEditorHistory({ now: time.now, coalesceMs: 500 });

    history.record("n", "", "a", true);
    time.advance(1000);
    history.record("n", "a", "ab", true);

    expect(history.undo("n")).toBe("a");
    expect(history.undo("n")).toBe("");
  });

  test("显式动作（coalesce=false）永远单独成步", () => {
    const time = clock();
    const history = createEditorHistory({ now: time.now, coalesceMs: 10_000 });

    history.record("n", "", "a", true);
    // 哪怕紧接着发生，也不该并进上一步 —— 替换、格式化这类动作是一件事。
    history.record("n", "a", "b", false);

    expect(history.undo("n")).toBe("a");
  });
});

describe("重做分支", () => {
  test("撤销之后发生新编辑，重做分支被砍掉", () => {
    const history = createEditorHistory();
    history.record("n", "", "一", false);
    history.record("n", "一", "二", false);

    expect(history.undo("n")).toBe("一");
    expect(history.canRedo("n")).toBe(true);

    history.record("n", "一", "三", false);

    expect(history.canRedo("n")).toBe(false);
    // 从「三」往回撤一步是「一」，再一步才是最初的空。
    expect(history.undo("n")).toBe("一");
    expect(history.undo("n")).toBe("");
  });

  test("重做到头就停住", () => {
    const history = createEditorHistory();
    history.record("n", "", "一", false);

    expect(history.undo("n")).toBe("");
    expect(history.redo("n")).toBe("一");
    expect(history.redo("n")).toBeNull();
  });
});

describe("上限与淘汰", () => {
  test("每份内容最多留 maxSteps 步", () => {
    const history = createEditorHistory({ maxSteps: 3 });
    for (let index = 1; index <= 10; index += 1) {
      history.record("n", String(index - 1), String(index), false);
    }

    let steps = 0;
    while (history.undo("n") !== null) steps += 1;

    expect(steps).toBe(3);
  });

  test("同时跟踪的文件超上限时，淘汰最久没动过的那个", () => {
    const history = createEditorHistory({ maxDocuments: 2 });

    history.record("old", "", "旧", false);
    history.record("middle", "", "中", false);
    history.record("new", "", "新", false);

    expect(history.canUndo("old")).toBe(false);
    expect(history.canUndo("middle")).toBe(true);
    expect(history.canUndo("new")).toBe(true);
  });

  test("被碰过的文件不会被当成最久未动", () => {
    const history = createEditorHistory({ maxDocuments: 2 });

    history.record("a", "", "A", false);
    history.record("b", "", "B", false);
    // 再动一次 a，最久未动的就变成 b
    history.record("a", "A", "AA", false);
    history.record("c", "", "C", false);

    expect(history.canUndo("a")).toBe(true);
    expect(history.canUndo("b")).toBe(false);
  });
});

describe("内容没变时不记", () => {
  test("受控组件回填同一个值不会多出一步", () => {
    const history = createEditorHistory();
    history.record("n", "", "一", false);
    history.record("n", "一", "一", false);

    expect(history.undo("n")).toBe("");
    expect(history.canUndo("n")).toBe(false);
  });
});

describe("caretAfterChange", () => {
  test("插入：光标落在插入内容之后", () => {
    expect(caretAfterChange("abc", "abXc")).toBe(3);
  });

  test("删除：光标落在删除位置", () => {
    expect(caretAfterChange("abc", "ac")).toBe(1);
  });

  test("整体替换：光标到末尾", () => {
    expect(caretAfterChange("abc", "xyz")).toBe(3);
  });

  test("内容相同：光标停在末尾", () => {
    expect(caretAfterChange("abc", "abc")).toBe(3);
  });
});
