import { describe, expect, test } from "vitest";

/**
 * `custom.css` 第 3 节那张「语义钩子」清单，是给用户与插件作者看的**接口**。
 * 一旦清单里写着一个界面上根本没有的类名，照着它写 CSS 的人就会对着空气调半天。
 *
 * 所以这里做一件很朴素的事：**把清单抄出来，逐个到源码里找**。找不到就是清单过时了
 * —— 要么把类名补上去，要么把它从清单里删掉。
 *
 * 「源码」= `src/` 下所有 `.ts` / `.tsx` / `.css` 的正文（**去掉注释**、**去掉测试文件**）。
 * 之所以把 `.css` 也算进来：清单里有一部分是**本来就带样式**的既有语义类
 * （`.md-body` / `.outline-item` / `.katex-display` / `.mac-window-controls`…），
 * 它们本来就不在 `.tsx` 里以字面量出现（有的由 KaTeX 自己挂、有的由 mdast 钩子生成）。
 *
 * 用 Vite 的 `?raw` / `import.meta.glob` 而不是 `node:fs`：这个项目的 tsconfig 不带
 * node 类型（同 `features/plugins/codeOutline.test.ts` 的说明），而且它走的是同一条
 * 构建管线 —— 测试读到的与运行时加载的是同一份文本。
 */

const CSS_FILES = import.meta.glob("/src/**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CODE_FILES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 从 custom.css 的「3. 语义钩子」一节里抄出所有 `.foo-bar` 名字。 */
function documentedHooks(): string[] {
  const css = Object.entries(CSS_FILES).find(([file]) => file.endsWith("/styles/custom.css"));
  expect(css, "没找到 src/styles/custom.css").toBeTruthy();

  const text = css![1];
  const from = text.indexOf("* 3. 语义钩子");
  const to = text.indexOf("* 4. 万一还是得盖");
  expect(from, "custom.css 里找不到第 3 节").toBeGreaterThan(-1);
  expect(to, "custom.css 里找不到第 4 节").toBeGreaterThan(from);

  const block = text.slice(from, to);
  const names = new Set<string>();
  // 写法一：用反引号括起来的 `.foo`
  for (const m of block.matchAll(/`\.([a-z][a-z0-9-]*)`/g)) names.add(m[1]);
  // 写法二：行首（可能在 `*` 注释里）直接以 `.foo` 开头
  for (const m of block.matchAll(/^\s*\*?\s*\.([a-z][a-z0-9-]*)/gm)) names.add(m[1]);
  return [...names].sort();
}

/**
 * 源码全文（已去注释、去测试文件）。
 *
 * 判定方式是「这个名字有没有作为一个**独立的词**出现过」，而不是解析 `className` 属性
 * —— 钩子并不总是字面量写在 `className=` 上：`NotePad.tsx` 把它拼在一个变量里
 * （`surfaceWrapperClassName`），`md-align-*` 是运行时拼出来的。按词边界找更实在。
 */
function sourceText(): string {
  const files = { ...CSS_FILES, ...CODE_FILES };
  let text = "";
  for (const [file, raw] of Object.entries(files)) {
    // ⚠️ 跳过 custom.css 自己 —— 清单就写在那份文件的注释里，把它算进「源码」的话，
    // 每个钩子都能在那段注释里找到自己，这个测试就永远绿。
    if (file.endsWith("/styles/custom.css")) continue;
    // 测试文件里提到某个类名，不等于界面上真的有它。
    if (/\.test\.tsx?$/.test(file)) continue;
    // 去注释，免得「源码里提过一嘴」也被算数。
    text += raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
  }
  return text;
}

describe("custom.css 里那张语义钩子清单", () => {
  const hooks = documentedHooks();
  const haystack = sourceText();

  test("清单本身抄得出东西（防止解析写歪了变成永远通过）", () => {
    expect(hooks.length).toBeGreaterThan(80);
    expect(haystack.length).toBeGreaterThan(100_000);
  });

  test("清单里每一个钩子都能在源码里找到", () => {
    const missing = hooks.filter(
      (name) => !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(haystack),
    );
    expect(
      missing,
      `这些类名写在文档里、源码里却不存在：${missing.join(", ")}\n` +
        "要么把类名补到对应的元素上，要么把它从 custom.css 第 3 节删掉。",
    ).toEqual([]);
  });
});
