import { describe, expect, test } from "vitest";
import {
  createElementRefHelpers,
  markElementRef,
  reviveElementRef,
  type ElementRef,
  type ElementRefHelpers,
} from "./elementRef";

/**
 * 只测描述符上的查询助手。
 *
 * `describeElement` 需要真实 DOM，而本项目的 vitest 跑在 node 环境（没有 jsdom），
 * 因此那部分留待窗口级冒烟验证。这里覆盖的是插件侧真正会用到的那一半，
 * 也是 `outline` 插件迁移后最依赖的部分。
 */
function ref(overrides: Partial<ElementRef> = {}): ElementRef {
  return {
    tag: "button",
    id: "",
    classes: ["outline-item"],
    attrs: { "data-index": "2" },
    text: "第二章",
    path: [
      { tag: "button", id: "", classes: ["outline-item"], attrs: { "data-index": "2" } },
      { tag: "div", id: "outline-body", classes: ["panel"], attrs: {} },
      { tag: "aside", id: "", classes: ["sidebar"], attrs: {} },
    ],
    ...overrides,
  };
}

describe("data() 与 attr()", () => {
  test("data() 读 data-* 属性（v1 的 element.dataset 对应物）", () => {
    expect(createElementRefHelpers(ref()).data("index")).toBe("2");
    expect(createElementRefHelpers(ref()).data("missing")).toBeNull();
  });

  test("attr() 只暴露白名单属性", () => {
    const helpers = createElementRefHelpers(
      ref({ attrs: { "data-index": "2", title: "标题", "secret-token": "不应该暴露" } }),
    );

    expect(helpers.attr("title")).toBe("标题");
    expect(
      helpers.attr("secret-token"),
      "非白名单属性必须读不到，否则会把宿主信息一路带进插件",
    ).toBeNull();
  });
});

describe("closest() 的受限选择器语法", () => {
  test("支持 .class", () => {
    const helpers = createElementRefHelpers(ref());
    expect(helpers.closest(".outline-item")?.tag).toBe("button");
  });

  test("支持 #id", () => {
    const helpers = createElementRefHelpers(ref());
    expect(helpers.closest("#outline-body")?.tag).toBe("div");
  });

  test('支持 [data-x] 与 [data-x="v"]', () => {
    const helpers = createElementRefHelpers(ref());

    expect(helpers.closest("[data-index]")?.tag).toBe("button");
    expect(helpers.closest('[data-index="2"]')?.tag).toBe("button");
    expect(helpers.closest('[data-index="9"]')).toBeNull();
  });

  test("支持 tag.class 与 tag[data-x] 组合", () => {
    const helpers = createElementRefHelpers(ref());

    expect(helpers.closest("button.outline-item")?.tag).toBe("button");
    expect(helpers.closest("div.outline-item")).toBeNull();
    expect(helpers.closest("button[data-index]")?.tag).toBe("button");
  });

  test("向上找到最近的祖先", () => {
    const helpers = createElementRefHelpers(ref());
    expect(helpers.closest(".sidebar")?.tag).toBe("aside");
  });

  test("找不到时返回 null", () => {
    expect(createElementRefHelpers(ref()).closest(".nope")).toBeNull();
  });

  test("空选择器不匹配任何东西", () => {
    expect(createElementRefHelpers(ref()).closest("   ")).toBeNull();
  });

  test("closestClass 是 .class 的便捷写法", () => {
    const helpers = createElementRefHelpers(ref());
    expect(helpers.closestClass("outline-item")).toEqual(ref().path[0]);
  });
});

describe("outline 插件的迁移写法可行性", () => {
  test("v1 的 closest('.outline-item') + getAttribute('data-index') 能一一对应到 v2", () => {
    // v1 写法：
    //   const btn = target.closest(".outline-item");
    //   const index = Number(btn.getAttribute("data-index"));
    // v2 写法：
    const helpers = createElementRefHelpers(ref());
    const btn = helpers.closestClass("outline-item");
    const index = Number(helpers.data("index"));

    expect(btn).not.toBeNull();
    expect(index).toBe(2);
  });
});

describe("跨线程还原", () => {
  test("标记过的描述符还原后带查询助手，插件侧的写法才能跑起来", () => {
    // 这正是 outline 插件点击目录项时的调用路径：宿主送裸对象，插件调方法。
    const revived = reviveElementRef(markElementRef(ref())) as ElementRef & ElementRefHelpers;

    expect(revived.closestClass("outline-item")).toEqual(ref().path[0]);
    expect(revived.data("index")).toBe("2");
    expect(revived.text).toBe("第二章");
  });

  test("没标记的对象原样返回", () => {
    const plain = { tag: "button", text: "第二章" };
    expect(reviveElementRef(plain)).toBe(plain);
    expect(reviveElementRef("字符串")).toBe("字符串");
    expect(reviveElementRef(null)).toBeNull();
  });

  test("标记不会污染原始描述符", () => {
    const original = ref();
    markElementRef(original);
    expect(Object.keys(original)).not.toContain("__floralElementRef");
  });
});
