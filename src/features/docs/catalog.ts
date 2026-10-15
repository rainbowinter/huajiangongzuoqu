import type { BundledDocName } from "./api";

/**
 * 「关于」拉出来的那几项。
 *
 * 顺序就是界面上从上到下的顺序：「这一版改了什么」最常看，放最上面；「怎么反馈」放最后。
 */
export interface AboutDoc {
  name: BundledDocName;
  /** i18n key。文案在各语言 translation.json 的 `main.about` 下。 */
  titleKey: string;
  /** 兜底文案 —— 词条缺了也不会显示成一个 key。 */
  fallbackTitle: string;
}

export const ABOUT_DOCS: readonly AboutDoc[] = Object.freeze([
  { name: "whats-new.md", titleKey: "main.about.whatsNew", fallbackTitle: "新功能" },
  { name: "guide.md", titleKey: "main.about.guide", fallbackTitle: "使用指南" },
  { name: "feedback.md", titleKey: "main.about.feedback", fallbackTitle: "意见反馈" },
]);
