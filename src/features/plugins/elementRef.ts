/**
 * 面板点击事件的元素描述符。
 *
 * 沙箱 Worker 里没有 DOM，`postMessage` 也传不了 DOM 节点，因此 v1 的
 * `onClick(target: HTMLElement)` 在 v2 里必须是**可序列化的描述符**。这是 v2 相对
 * v1 的必然破坏性变更，会写进迁移指南。
 *
 * 为降低迁移成本，描述符自带一小套查询助手，足够覆盖已装的 `outline` 插件
 * （它做的是 `target.closest(".outline-item")` + `getAttribute("data-index")`，
 * 对应 `ref.closestClass("outline-item")` + `ref.data("index")`）。
 *
 * `closest()` 只支持极小的选择器语法，**不是**完整的 CSS 选择器引擎，语法见
 * `matchesSelector` 的注释。
 */

/** 描述符里保留的属性白名单。避免把 value 之外的敏感信息一路带进插件。 */
const ATTR_ALLOWLIST = new Set([
  "href",
  "value",
  "name",
  "type",
  "title",
  "disabled",
  "role",
  "aria-label",
]);

const MAX_CLASSES = 16;
const MAX_TEXT_LENGTH = 200;
const MAX_PATH_DEPTH = 8;

export interface ElementRefShape {
  /** 小写标签名。 */
  tag: string;
  id: string;
  classes: string[];
  /** 仅含 `data-*` 与白名单属性。 */
  attrs: Record<string, string>;
}

export interface ElementRef extends ElementRefShape {
  /** 去空白后的可见文本，截断到 200 字符。 */
  text: string;
  /** 自身及祖先，最多 8 层。 */
  path: ElementRefShape[];
}

export interface ElementRefHelpers {
  readonly ref: ElementRef;
  /** 读 `data-*`，等价于 v1 的 `element.dataset[key]`。 */
  data(key: string): string | null;
  /** 读白名单属性。 */
  attr(name: string): string | null;
  /** 按受限语法向上找最近匹配的祖先（含自身）。 */
  closest(selector: string): ElementRefShape | null;
  /** `closest(".class")` 的便捷写法。 */
  closestClass(name: string): ElementRefShape | null;
}

function describeShape(element: Element): ElementRefShape {
  const attrs: Record<string, string> = {};

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("data-") || ATTR_ALLOWLIST.has(name)) {
      attrs[name] = attribute.value;
    }
  }

  return {
    tag: element.tagName.toLowerCase(),
    id: element.id ?? "",
    classes: Array.from(element.classList).slice(0, MAX_CLASSES),
    attrs,
  };
}

/** 把真实 DOM 节点转成可跨线程传输的描述符。 */
export function describeElement(element: Element): ElementRef {
  const path: ElementRefShape[] = [];
  let current: Element | null = element;

  while (current && path.length < MAX_PATH_DEPTH) {
    path.push(describeShape(current));
    current = current.parentElement;
  }

  const shape = path[0] ?? describeShape(element);
  const text = (element.textContent ?? "").trim();

  return {
    ...shape,
    text: text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text,
    path,
  };
}

/**
 * 受限选择器匹配。
 *
 * 支持：`tag`、`.class`、`#id`、`[data-x]`、`[data-x="v"]`，以及
 * `tag.class` / `tag[data-x]` 这类两段组合。不支持后代、子代、逗号分组等。
 */
function matchesSelector(shape: ElementRefShape, selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed) return false;

  const attrMatch = /^([a-zA-Z0-9-]*)\[([a-zA-Z0-9-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]$/.exec(
    trimmed,
  );
  if (attrMatch) {
    const [, tag, attr, quoted, singleQuoted] = attrMatch;
    if (tag && shape.tag !== tag.toLowerCase()) return false;
    const expected = quoted ?? singleQuoted;
    const actual = shape.attrs[attr.toLowerCase()];
    if (actual === undefined) return false;
    return expected === undefined || actual === expected;
  }

  const classMatch = /^([a-zA-Z0-9-]*)\.([a-zA-Z0-9_-]+)$/.exec(trimmed);
  if (classMatch) {
    const [, tag, className] = classMatch;
    if (tag && shape.tag !== tag.toLowerCase()) return false;
    return shape.classes.includes(className);
  }

  if (trimmed.startsWith(".")) {
    return shape.classes.includes(trimmed.slice(1));
  }

  if (trimmed.startsWith("#")) {
    return shape.id === trimmed.slice(1);
  }

  return shape.tag === trimmed.toLowerCase();
}

/** 在插件侧构造查询助手。纯函数，不依赖任何宿主对象。 */
export function createElementRefHelpers(ref: ElementRef): ElementRefHelpers {
  return {
    ref,
    data(key) {
      return ref.attrs[`data-${key.toLowerCase()}`] ?? null;
    },
    attr(name) {
      const lower = name.toLowerCase();
      return ATTR_ALLOWLIST.has(lower) ? (ref.attrs[lower] ?? null) : null;
    },
    closest(selector) {
      for (const shape of ref.path) {
        if (matchesSelector(shape, selector)) return shape;
      }
      return null;
    },
    closestClass(name) {
      return this.closest(`.${name}`);
    },
  };
}
