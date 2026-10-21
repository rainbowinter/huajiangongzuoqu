/**
 * OOXML 的 XML 读取助手。
 *
 * 命名空间必须按 `namespaceURI` 判，不能按前缀 —— 文档里的前缀是作者随便起的，
 * `w:p` 和 `a:p` 的 localName 都叫 `p`。所以这一层只认 (namespaceURI, localName)，
 * 再给几个读属性的短函数。
 */

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const V_NS = "urn:schemas-microsoft-com:vml";
export const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const XML_NS = "http://www.w3.org/XML/1998/namespace";

export function parseXml(text, label) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`${label} 不是一份合法的 XML。`);
  }
  return document;
}

export function isW(element, localName) {
  return Boolean(element) && element.localName === localName && element.namespaceURI === W_NS;
}

export function isNs(element, namespaceURI, localName) {
  return Boolean(element) && element.localName === localName && element.namespaceURI === namespaceURI;
}

/** 直接子元素里所有 `w:<localName>`。 */
export function children(element, localName) {
  if (!element) return [];
  const result = [];
  for (const childElement of element.children) {
    if (isW(childElement, localName)) result.push(childElement);
  }
  return result;
}

/** 直接子元素里第一个 `w:<localName>`。 */
export function child(element, localName) {
  if (!element) return null;
  for (const childElement of element.children) {
    if (isW(childElement, localName)) return childElement;
  }
  return null;
}

/** 任意命名空间下、按 localName 找第一个后代。 */
export function firstDescendant(element, localName, namespaceURI) {
  if (!element) return null;
  for (const descendant of element.getElementsByTagName("*")) {
    if (descendant.localName !== localName) continue;
    if (namespaceURI && descendant.namespaceURI !== namespaceURI) continue;
    return descendant;
  }
  return null;
}

export function allDescendants(element, localName, namespaceURI) {
  const result = [];
  if (!element) return result;
  for (const descendant of element.getElementsByTagName("*")) {
    if (descendant.localName !== localName) continue;
    if (namespaceURI && descendant.namespaceURI !== namespaceURI) continue;
    result.push(descendant);
  }
  return result;
}

/** 读 `w:<name>` 属性。`getAttributeNS` 对带前缀的文档最稳。 */
export function attr(element, name, namespaceURI = W_NS) {
  if (!element) return null;
  const value = element.getAttributeNS(namespaceURI, name);
  if (value !== null) return value;
  // 少数工具生成的 XML 不声明命名空间，退回到带前缀的写法；
  // 还有像 `w:docGrid/@type` 这种**本身不带命名空间**的属性。
  const plain = element.getAttribute(name);
  if (plain !== null) return plain;
  return element.getAttribute(`w:${name}`);
}

export function numAttr(element, name, fallback = null) {
  const value = attr(element, name);
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `w:b` / `w:keepNext` 这类开关：
 * 没有 `w:val` 就是 true；`w:val="0"` / `"false"` / `"off"` 是 false。
 */
export function boolAttr(element, name, fallback = false) {
  if (!element) return fallback;
  const value = attr(element, name);
  if (value === null) return true;
  return !(value === "0" || value === "false" || value === "off");
}

/** `w:val` 的简写。 */
export function val(element, fallback = null) {
  return attr(element, "val") ?? fallback;
}

/** `w:<name>` 直接子元素是否存在。 */
export function hasChild(element, localName) {
  return Boolean(child(element, localName));
}
