import { afterEach, describe, expect, test, vi } from "vitest";
import {
  blockIndexAtOffset,
  blockOffsetsFromLayer,
  measureBlockOffsets,
  parseBlocks,
  tagPreviewBlocks,
} from "./scrollSync";

class FakeTextNode {
  constructor(public readonly textContent: string) {}
}

class FakeStyle {
  cssText = "";
}

class FakeHTMLElement {
  static onOffsetTopRead: ((element: FakeHTMLElement) => void) | undefined;
  static offsetTopReads = 0;
  static scrollHeightReads = 0;

  readonly style = new FakeStyle();
  readonly children: FakeHTMLElement[] = [];
  readonly attributes = new Map<string, string>();
  className = "";
  clientWidth = 240;
  parentNode: FakeHTMLElement | null = null;
  private line = 0;
  private top = 0;

  constructor(public readonly tagName = "div") {}

  appendChild<T>(child: T): T {
    if (child instanceof FakeTextNode) {
      this.line += child.textContent.split("\n").length - 1;
      return child;
    }

    if (child instanceof FakeHTMLElement) {
      child.parentNode = this;
      if (child.tagName === "span") child.top = this.paddingTop + this.line * this.lineHeight;
      this.children.push(child);
    }
    return child;
  }

  removeChild<T>(child: T): T {
    if (child instanceof FakeHTMLElement) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector<T>(selector: string): T | null {
    if (selector !== ".font-body") return null;
    return this.findByClass("font-body") as T | null;
  }

  get offsetTop(): number {
    FakeHTMLElement.offsetTopReads++;
    FakeHTMLElement.onOffsetTopRead?.(this);
    return this.top;
  }

  get scrollHeight(): number {
    FakeHTMLElement.scrollHeightReads++;
    return 0;
  }

  private findByClass(className: string): FakeHTMLElement | null {
    if (this.className.split(/\s+/).includes(className)) return this;
    for (const child of this.children) {
      const found = child.findByClass(className);
      if (found) return found;
    }
    return null;
  }

  private get lineHeight(): number {
    return this.numberFromStyle("line-height") ?? 20;
  }

  private get paddingTop(): number {
    return this.numberFromStyle("padding-top") ?? 0;
  }

  private numberFromStyle(property: string): number | undefined {
    const match = this.style.cssText.match(new RegExp(`${property}:\\s*([^;]+)`));
    if (!match) return undefined;
    const parsed = parseFloat(match[1]);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}

interface FakeDocument {
  body: FakeHTMLElement;
  createdElements: FakeHTMLElement[];
  createElement(tagName: string): FakeHTMLElement;
  createTextNode(text: string): FakeTextNode;
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;
const originalGetComputedStyle = globalThis.getComputedStyle;

function installFakeDom(): FakeDocument {
  FakeHTMLElement.onOffsetTopRead = undefined;
  FakeHTMLElement.offsetTopReads = 0;
  FakeHTMLElement.scrollHeightReads = 0;

  const fakeDocument: FakeDocument = {
    body: new FakeHTMLElement("body"),
    createdElements: [],
    createElement(tagName: string) {
      const element = new FakeHTMLElement(tagName);
      this.createdElements.push(element);
      return element;
    },
    createTextNode(text: string) {
      return new FakeTextNode(text);
    },
  };

  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("getComputedStyle", () => ({
    width: "200px",
    boxSizing: "border-box",
    font: "16px sans-serif",
    fontSize: "16px",
    fontFamily: "sans-serif",
    fontWeight: "400",
    fontStyle: "normal",
    lineHeight: "18px",
    letterSpacing: "0px",
    wordSpacing: "0px",
    wordBreak: "normal",
    overflowWrap: "break-word",
    wordWrap: "break-word",
    tabSize: "4",
    padding: "4px 8px",
    paddingTop: "4px",
    paddingRight: "8px",
    paddingBottom: "4px",
    paddingLeft: "8px",
    border: "0",
    borderTop: "0",
    borderRight: "0",
    borderBottom: "0",
    borderLeft: "0",
  }));

  return fakeDocument;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalDocument) vi.stubGlobal("document", originalDocument);
  if (originalHTMLElement) vi.stubGlobal("HTMLElement", originalHTMLElement);
  if (originalGetComputedStyle) vi.stubGlobal("getComputedStyle", originalGetComputedStyle);
});

describe("scroll sync helpers", () => {
  test("chooses the last block whose measured offset is at or before scrollTop", () => {
    const offsets = [0, 25, 50, 90];

    expect(blockIndexAtOffset(offsets, -1)).toBe(0);
    expect(blockIndexAtOffset(offsets, 0)).toBe(0);
    expect(blockIndexAtOffset(offsets, 24)).toBe(0);
    expect(blockIndexAtOffset(offsets, 25)).toBe(1);
    expect(blockIndexAtOffset(offsets, 89)).toBe(2);
    expect(blockIndexAtOffset(offsets, 90)).toBe(3);
    expect(blockIndexAtOffset(offsets, 999)).toBe(3);
  });

  test("tags preview block children with sequential block indices", () => {
    installFakeDom();
    const container = new FakeHTMLElement("section");
    const root = new FakeHTMLElement("article");
    root.className = "font-body";
    const heading = new FakeHTMLElement("h1");
    const paragraph = new FakeHTMLElement("p");
    const list = new FakeHTMLElement("ul");

    container.appendChild(root);
    root.appendChild(heading);
    root.appendChild(paragraph);
    root.appendChild(list);

    tagPreviewBlocks(container as unknown as HTMLElement, "content");

    expect(heading.getAttribute("data-block-index")).toBe("0");
    expect(paragraph.getAttribute("data-block-index")).toBe("1");
    expect(list.getAttribute("data-block-index")).toBe("2");
  });

  test("skips re-tagging while the preview is unchanged, and re-tags once it is", () => {
    installFakeDom();
    const container = new FakeHTMLElement("section");
    const root = new FakeHTMLElement("article");
    root.className = "font-body";
    const heading = new FakeHTMLElement("h1");
    container.appendChild(root);
    root.appendChild(heading);

    tagPreviewBlocks(container as unknown as HTMLElement, "content-a");
    expect(heading.getAttribute("data-block-index")).toBe("0");

    // 手动改坏，再拿同样的内容打一次：应当被缓存挡住，不做任何写入。
    heading.setAttribute("data-block-index", "touched");
    tagPreviewBlocks(container as unknown as HTMLElement, "content-a");
    expect(heading.getAttribute("data-block-index")).toBe("touched");

    // 内容变了就必须重打，否则块下标会一直停在旧结构上。
    tagPreviewBlocks(container as unknown as HTMLElement, "content-b");
    expect(heading.getAttribute("data-block-index")).toBe("0");
  });

  test("reads block offsets straight off the highlight layer", () => {
    installFakeDom();
    const content = ["# 标题", "", "段落一", "段落二", "", "```", "code", "```"].join("\n");

    // 高亮层一行一个子元素。假 DOM 只给 span 记 offsetTop，所以这里用 span 建。
    const layer = new FakeHTMLElement("div");
    for (let index = 0; index < content.split("\n").length; index++) {
      layer.appendChild(new FakeTextNode("\n"));
      layer.appendChild(new FakeHTMLElement("span"));
    }

    const blocks = parseBlocks(content);
    expect(blocks.map((block) => block.startLine)).toEqual([0, 2, 5]);

    const offsets = blockOffsetsFromLayer(layer as unknown as HTMLElement, content);
    expect(offsets).toEqual(
      blocks.map(
        (block) => (layer.children[block.startLine] as unknown as { offsetTop: number }).offsetTop,
      ),
    );
    // 三块拿到的必须是三个**不同**的位置 —— 全零说明取错了行。
    expect(new Set(offsets).size).toBe(3);
  });

  test("falls back to the mirror when the layer cannot be trusted", () => {
    installFakeDom();
    const content = "# 标题\n\n段落";

    // 空层：超大文档放弃着色时就是这样。
    expect(
      blockOffsetsFromLayer(new FakeHTMLElement("div") as unknown as HTMLElement, content),
    ).toBeNull();
    expect(blockOffsetsFromLayer(null, content)).toBeNull();

    // 层还没跟上（行数不够）时也不能硬给一份错的。
    const short = new FakeHTMLElement("div");
    short.appendChild(new FakeHTMLElement("span"));
    expect(blockOffsetsFromLayer(short as unknown as HTMLElement, content)).toBeNull();
  });

  test("measures representative markdown blocks from their source line starts", async () => {
    installFakeDom();
    const source = new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement;
    const content = [
      "# Title",
      "",
      "Paragraph line",
      "wrapped second",
      "",
      "- first",
      "- second",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");

    await expect(measureBlockOffsets(content, source)).resolves.toEqual([0, 36, 90, 144]);
  });

  test("skips standalone markdown link reference definitions before visible blocks", async () => {
    installFakeDom();
    const source = new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement;
    const content = [
      "# Title",
      "",
      '[docs]: https://example.com/docs "Documentation"',
      "[api]: /api",
      "",
      "Paragraph with a [docs] link.",
      "",
      "- first",
      "- second",
    ].join("\n");

    await expect(measureBlockOffsets(content, source)).resolves.toEqual([0, 90, 126]);
  });

  test("keeps paragraph reference-shaped lines in the visible paragraph block", async () => {
    installFakeDom();
    const source = new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement;
    const content = [
      "# Title",
      "",
      "Paragraph start",
      "[visible]: https://example.com/visible",
      "Paragraph end",
      "",
      "## Next",
    ].join("\n");

    await expect(measureBlockOffsets(content, source)).resolves.toEqual([0, 36, 108]);
  });

  test("keeps list reference-shaped lines in the visible list block", async () => {
    installFakeDom();
    const source = new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement;
    const content = [
      "# Title",
      "",
      "- first",
      "[visible-list]: https://example.com/list",
      "- second",
      "",
      "## Next",
    ].join("\n");

    await expect(measureBlockOffsets(content, source)).resolves.toEqual([0, 36, 108]);
  });

  test("cleans up its hidden mirror and returns no offsets when already aborted", async () => {
    const fakeDocument = installFakeDom();
    const controller = new AbortController();
    controller.abort();

    const offsets = await measureBlockOffsets(
      "# Title\n\nParagraph",
      new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement,
      controller.signal,
    );

    expect(offsets).toEqual([]);
    expect(fakeDocument.body.children).toHaveLength(0);
  });

  test("cleans up its hidden mirror and may return partial offsets when aborted mid-measurement", async () => {
    const fakeDocument = installFakeDom();
    const controller = new AbortController();
    FakeHTMLElement.onOffsetTopRead = () => {
      if (FakeHTMLElement.offsetTopReads === 2) controller.abort();
    };

    const offsets = await measureBlockOffsets(
      "# One\n\n# Two\n\n# Three\n\n# Four",
      new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement,
      controller.signal,
    );

    expect(offsets).toEqual([0, 36]);
    expect(fakeDocument.body.children).toHaveLength(0);
  });

  test("yields during long marker measurements so async aborts can cancel and clean up", async () => {
    const fakeDocument = installFakeDom();
    const controller = new AbortController();
    const content = Array.from({ length: 130 }, (_, index) => `# Heading ${index}`).join("\n\n");

    setTimeout(() => controller.abort(), 0);

    const offsets = await measureBlockOffsets(
      content,
      new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement,
      controller.signal,
    );

    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets.length).toBeLessThan(130);
    expect(FakeHTMLElement.offsetTopReads).toBe(offsets.length);
    expect(fakeDocument.body.children).toHaveLength(0);
  });

  test("yields during huge mirror construction so async aborts can cancel before attachment", async () => {
    const fakeDocument = installFakeDom();
    const controller = new AbortController();
    const content = Array.from({ length: 300 }, (_, index) => `# Heading ${index}`).join("\n\n");

    setTimeout(() => controller.abort(), 0);

    const offsets = await measureBlockOffsets(
      content,
      new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement,
      controller.signal,
    );

    expect(offsets).toEqual([]);
    expect(FakeHTMLElement.offsetTopReads).toBe(0);
    expect(fakeDocument.body.children).toHaveLength(0);
  });

  test("does not remeasure growing textarea prefixes for long documents", async () => {
    const fakeDocument = installFakeDom();
    const content = Array.from(
      { length: 120 },
      (_, index) => `# Heading ${index}\n\nParagraph ${index}`,
    ).join("\n\n");

    const offsets = await measureBlockOffsets(
      content,
      new FakeHTMLElement("textarea") as unknown as HTMLTextAreaElement,
    );

    expect(offsets).toHaveLength(240);
    expect(
      fakeDocument.createdElements.filter((element) => element.tagName === "textarea"),
    ).toHaveLength(0);
    expect(FakeHTMLElement.scrollHeightReads).toBe(0);
  });
});
