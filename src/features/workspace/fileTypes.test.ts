import { afterEach, describe, expect, it } from "vitest";
import {
  getFileRenderer,
  hasPreviewPaneKind,
  isEditableKind,
  isFilePreviewKind,
  listFileTypes,
  matchFileType,
  newFileBytes,
  parseViewToolbar,
  registerFileType,
  resetFileTypes,
  subscribeFileTypes,
  type FileType,
} from "./fileTypes";

function pythonType(overrides: Partial<FileType> = {}): FileType {
  return {
    id: "python",
    extensions: ["py", "PYW"],
    label: "Python",
    badge: "PY",
    color: "#3572A5",
    kind: "code",
    language: "python",
    ...overrides,
  };
}

afterEach(() => {
  resetFileTypes();
});

describe("文件类型注册表", () => {
  it("新建文件模板按 base64 解码成原始字节", () => {
    const type = pythonType({ newFile: "UEsDBA==" });
    expect(Array.from(newFileBytes(type) ?? [])).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("没有模板或模板坏掉时返回 null，让新建退回 0 字节", () => {
    expect(newFileBytes(pythonType())).toBeNull();
    // 注册那一层会拒绝坏 base64；这里防的是注册表被别处直接塞了坏值。
    expect(newFileBytes(pythonType({ newFile: "不是 base64" }))).toBeNull();
  });

  it("默认只认 Markdown —— 没装插件时工作文件夹里只看得见 .md", () => {
    expect(listFileTypes().map((type) => type.id)).toEqual(["markdown"]);

    expect(matchFileType("md")?.id).toBe("markdown");
    expect(matchFileType("py")).toBeNull();
    expect(matchFileType("png")).toBeNull();
  });

  it("注册后按扩展名匹配，大小写不敏感", () => {
    registerFileType(pythonType());

    expect(matchFileType("py")?.id).toBe("python");
    expect(matchFileType("PY")?.id).toBe("python");
    expect(matchFileType("pyw")?.id).toBe("python");
  });

  it("扩展名上的前导点会被剥掉", () => {
    registerFileType(pythonType({ extensions: [".py"] }));

    expect(matchFileType("py")?.id).toBe("python");
  });

  it("注销后不再匹配", () => {
    const dispose = registerFileType(pythonType());
    expect(matchFileType("py")).not.toBeNull();

    dispose();

    expect(matchFileType("py")).toBeNull();
    expect(listFileTypes().map((type) => type.id)).toEqual(["markdown"]);
  });

  it("同一个 id 重新注册是替换而不是累加", () => {
    registerFileType(pythonType({ label: "第一版" }));
    registerFileType(pythonType({ label: "第二版" }));

    const entries = listFileTypes().filter((type) => type.id === "python");
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("第二版");
  });

  it("插件可以覆盖内置规则", () => {
    // 后注册的胜出，所以插件能把 .md 换成自己的渲染方式。
    registerFileType(pythonType({ id: "custom-md", extensions: ["md"], label: "自定义 Markdown" }));

    expect(matchFileType("md")?.label).toBe("自定义 Markdown");
  });

  it("快照引用保持稳定（否则 useSyncExternalStore 会无限重渲染）", () => {
    const first = listFileTypes();
    expect(listFileTypes()).toBe(first);

    registerFileType(pythonType());
    const second = listFileTypes();
    expect(second).not.toBe(first);

    // 变化之后仍然稳定
    expect(listFileTypes()).toBe(second);
  });

  it("注册与注销都会通知订阅者", () => {
    let calls = 0;
    const unsubscribe = subscribeFileTypes(() => {
      calls += 1;
    });

    const dispose = registerFileType(pythonType());
    expect(calls).toBe(1);

    dispose();
    expect(calls).toBe(2);

    unsubscribe();
    registerFileType(pythonType({ id: "other" }));
    expect(calls).toBe(2);
  });

  it("重复调用注销函数只生效一次", () => {
    let calls = 0;
    const unsubscribe = subscribeFileTypes(() => {
      calls += 1;
    });

    const dispose = registerFileType(pythonType());
    dispose();
    dispose();

    expect(calls).toBe(2);
    unsubscribe();
  });

  it("空扩展名或未注册的扩展名返回 null", () => {
    expect(matchFileType(null)).toBeNull();
    expect(matchFileType(undefined)).toBeNull();
    expect(matchFileType("")).toBeNull();
  });
});

describe("kind 的两种能力", () => {
  it("编辑器：代码/文本/Markdown/表格有，图片媒体没有", () => {
    for (const kind of ["code", "text", "markdown", "table"] as const) {
      expect(isEditableKind(kind), kind).toBe(true);
    }
    for (const kind of ["image", "media", "custom", "none"] as const) {
      expect(isEditableKind(kind), kind).toBe(false);
    }
  });

  it("预览面板：只有 Markdown 与表格有", () => {
    // `code` / `text` 打开就只是编辑器 —— 这正是「.py、.log、.txt 不该挂预览窗格」。
    expect(hasPreviewPaneKind("markdown")).toBe(true);
    expect(hasPreviewPaneKind("table")).toBe(true);

    for (const kind of ["code", "text", "image", "media", "custom", "none"] as const) {
      expect(hasPreviewPaneKind(kind), kind).toBe(false);
    }
  });

  it("两个能力互不包含：有编辑器的可能没有预览，反之亦然", () => {
    // 有编辑器但没预览
    expect(isEditableKind("code")).toBe(true);
    expect(hasPreviewPaneKind("code")).toBe(false);
    // 有预览但没编辑器
    expect(isEditableKind("image")).toBe(false);
    expect(hasPreviewPaneKind("image")).toBe(false);
  });

  it("isFilePreviewKind 拒绝拼错的 kind", () => {
    expect(isFilePreviewKind("code")).toBe(true);
    expect(isFilePreviewKind("cdoe")).toBe(false);
    expect(isFilePreviewKind("")).toBe(false);
  });
});

describe("自定义渲染器", () => {
  const renderer = async () => "<p>hi</p>";

  it("随类型一起注册，注销时一并清掉", () => {
    const dispose = registerFileType(pythonType({ kind: "custom" }), renderer);
    expect(getFileRenderer("python")).toBe(renderer);

    dispose();

    expect(getFileRenderer("python")).toBeNull();
  });

  it("重新注册会替换渲染器", () => {
    const second = async () => "<p>2</p>";
    registerFileType(pythonType({ kind: "custom" }), renderer);
    registerFileType(pythonType({ kind: "custom" }), second);

    expect(getFileRenderer("python")).toBe(second);
  });

  it("重新注册时不带渲染器，要清掉旧的", () => {
    // 否则会留下一个指向已卸载插件的函数，调用时挂在一个已经不存在的 token 上。
    registerFileType(pythonType({ kind: "custom" }), renderer);
    registerFileType(pythonType({ kind: "code" }));

    expect(getFileRenderer("python")).toBeNull();
  });

  it("resetFileTypes 会清空渲染器", () => {
    registerFileType(pythonType({ kind: "custom" }), renderer);

    resetFileTypes();

    expect(getFileRenderer("python")).toBeNull();
  });
});

/**
 * 工具栏声明是**插件交上来的不可信输入**（`view.toolbar`）。
 *
 * 与 `parseViewMessage` 同一条原则：认不出来的一律丢掉，不猜。区别是粒度 —— 一项坏了
 * 只丢那一项，整份声明还留着：少一个按钮总好过预览区整个打不开。
 */
describe("校验插件声明的视图工具栏", () => {
  it("照原样收下认得出的几种（只读小字会补上默认宽度的省略）", () => {
    expect(
      parseViewToolbar([
        { kind: "button", id: "zoom-in", label: "+", title: "放大" },
        { kind: "readout", id: "zoom" },
        { kind: "input", id: "goto", placeholder: "跳转", width: 44 },
        { kind: "separator" },
        { kind: "button", id: "spread", label: "连续", toggle: true },
      ]),
    ).toEqual([
      { kind: "button", id: "zoom-in", label: "+", title: "放大" },
      { kind: "readout", id: "zoom" },
      { kind: "input", id: "goto", placeholder: "跳转", width: 44 },
      { kind: "separator" },
      { kind: "button", id: "spread", label: "连续", toggle: true },
    ]);
  });

  it("不是数组、空数组、只有分隔线 —— 都当没声明", () => {
    expect(parseViewToolbar(undefined)).toBeUndefined();
    expect(parseViewToolbar("button")).toBeUndefined();
    expect(parseViewToolbar([])).toBeUndefined();
    expect(parseViewToolbar([{ kind: "separator" }])).toBeUndefined();
    expect(parseViewToolbar([{ kind: "separator" }, { kind: "separator" }])).toBeUndefined();
  });

  it("认不出的 kind 与「文字图标都没有」的按钮丢掉，剩下的照收", () => {
    const items = parseViewToolbar([
      { kind: "让宿主画点东西", id: "x", label: "x" },
      { kind: "button", id: "empty" },
      { kind: "button", id: "ok", label: "好" },
    ]);

    expect(items).toEqual([{ kind: "button", id: "ok", label: "好" }]);
  });

  it("只有图标、没有 label 的按钮是合法的（图标已经把它说清楚了）", () => {
    const items = parseViewToolbar([
      { kind: "button", id: "next", title: "下一页", icon: "icons/page-next.svg" },
      { kind: "button", id: "both", label: "适应宽度", icon: "icons/fit-width.svg" },
    ]);

    expect(items).toEqual([
      { kind: "button", id: "next", title: "下一页", icon: "icons/page-next.svg" },
      { kind: "button", id: "both", label: "适应宽度", icon: "icons/fit-width.svg" },
    ]);
  });

  it("id 不合规、或重名的丢掉 —— 它要当 key / 命令名 / 状态名用", () => {
    const items = parseViewToolbar([
      { kind: "button", id: "带空格 的", label: "a" },
      { kind: "button", id: "", label: "b" },
      { kind: "button", id: "fit", label: "适应" },
      { kind: "button", id: "fit", label: "再来一个" },
    ]);

    expect(items).toEqual([{ kind: "button", id: "fit", label: "适应" }]);
  });

  it("按钮的文字有长度上限：空白的丢掉，超长的丢掉（不截断，免得出现半截词）", () => {
    const items = parseViewToolbar([
      { kind: "button", id: "a", label: "   " },
      { kind: "button", id: "b", label: "字".repeat(40) },
    ]);

    expect(items).toBeUndefined();
  });

  it("输入框宽度被夹进 36–160", () => {
    const items = parseViewToolbar([
      { kind: "input", id: "a", width: 1 },
      { kind: "input", id: "b", width: 9999 },
      { kind: "input", id: "c", width: Number.NaN },
    ]);

    expect(items).toEqual([
      { kind: "input", id: "a", width: 36 },
      { kind: "input", id: "b", width: 160 },
      { kind: "input", id: "c" },
    ]);
  });

  it("连着的分隔线合成一条，末尾那条也不要", () => {
    const items = parseViewToolbar([
      { kind: "button", id: "a", label: "A" },
      { kind: "separator" },
      { kind: "separator" },
      { kind: "button", id: "b", label: "B" },
      { kind: "separator" },
    ]);

    expect(items).toEqual([
      { kind: "button", id: "a", label: "A" },
      { kind: "separator" },
      { kind: "button", id: "b", label: "B" },
    ]);
  });

  it("项数封顶，多的直接砍掉", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      kind: "button",
      id: `b${index}`,
      label: "x",
    }));

    // 24 而不是更小：这一排是**被扩展的视图与扩展它的插件共用**的，
    // PDF 阅读器自己就用掉 13 项。
    expect(parseViewToolbar(many)).toHaveLength(24);
  });

  it("下拉菜单：认得出 value/label，颜色原样带过来", () => {
    expect(
      parseViewToolbar([
        {
          kind: "menu",
          id: "tool",
          label: "标注",
          title: "标注方式",
          options: [
            { value: "rect", label: "矩形" },
            { value: "pen", label: "自由笔", color: "#ffd400" },
          ],
        },
      ]),
    ).toEqual([
      {
        kind: "menu",
        id: "tool",
        label: "标注",
        title: "标注方式",
        options: [
          { value: "rect", label: "矩形" },
          { value: "pen", label: "自由笔", color: "#ffd400" },
        ],
      },
    ]);
  });

  it("下拉里一项都认不出来时，整个菜单丢掉（不给一个点开是空的死按钮）", () => {
    for (const options of [undefined, [], "矩形", [{ value: "a" }], [{ label: "矩形" }], [{}]]) {
      expect(
        parseViewToolbar([{ kind: "menu", id: "tool", label: "标注", options }]),
      ).toBeUndefined();
    }
  });

  it("下拉里坏掉的选项丢掉，好的留下；value 重名的只留第一个", () => {
    const items = parseViewToolbar([
      {
        kind: "menu",
        id: "tool",
        label: "标注",
        options: [
          { value: "rect", label: "矩形" },
          { value: "rect", label: "重名的" },
          { value: "", label: "空值" },
          { value: "pen" },
          { value: "ellipse", label: "圆形" },
        ],
      },
    ]);

    expect(items?.[0]).toMatchObject({
      kind: "menu",
      options: [
        { value: "rect", label: "矩形" },
        { value: "ellipse", label: "圆形" },
      ],
    });
  });
});

/**
 * 图标（`icon`）。
 *
 * 这里只管**收下还是丢掉**：路径合不合法由后端把关（与 css / js 同一条原则，
 * 前端不重复写一遍规则）。真正读文件、消毒、画出来在 `PluginFileView` 与
 * `PluginViewToolbar` 那边。
 */
describe("工具栏图标的声明", () => {
  it("按钮与菜单选项都能带图标，原样收下", () => {
    const items = parseViewToolbar([
      { kind: "button", id: "zoom-in", label: "放大", icon: "icons/zoom-in.svg" },
      {
        kind: "menu",
        id: "tool",
        label: "指针",
        options: [
          { value: "pointer", label: "指针", icon: "icons/pointer.svg" },
          { value: "rect", label: "矩形" },
        ],
      },
    ]);

    expect(items?.[0]).toMatchObject({ icon: "icons/zoom-in.svg" });
    expect(items?.[1]).toMatchObject({
      kind: "menu",
      options: [
        { value: "pointer", label: "指针", icon: "icons/pointer.svg" },
        { value: "rect", label: "矩形" },
      ],
    });
    // 没写 icon 的那一项不该凭空多出一个字段（渲染那边靠有没有它来分叉）
    expect((items?.[1] as { options: object[] }).options[1]).not.toHaveProperty("icon");
  });

  it("空串、非字符串、超长的路径一律丢掉 —— 但那一项本身留着", () => {
    for (const icon of ["", "   ", 42, null, `icons/${"x".repeat(200)}.svg`]) {
      const items = parseViewToolbar([{ kind: "button", id: "a", label: "甲", icon }]);
      expect(items?.[0]).toMatchObject({ kind: "button", id: "a", label: "甲" });
      expect(items?.[0]).not.toHaveProperty("icon");
    }
  });

  it("readout / input 上没有图标这回事（它们不该画出多余的东西）", () => {
    const items = parseViewToolbar([
      { kind: "readout", id: "zoom", icon: "icons/zoom.svg" },
      { kind: "input", id: "goto", icon: "icons/goto.svg" },
    ]);
    expect(items?.[0]).not.toHaveProperty("icon");
    expect(items?.[1]).not.toHaveProperty("icon");
  });
});
