import { afterEach, describe, expect, it } from "vitest";
import {
  getFileRenderer,
  hasPreviewPaneKind,
  isEditableKind,
  isFilePreviewKind,
  listFileTypes,
  matchFileType,
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
