import { invoke } from "@tauri-apps/api/core";

/**
 * 随包分发的说明文档。
 *
 * 文件名写成字面量联合类型，是为了让**这边的白名单**和 Rust 侧
 * （`src-tauri/src/docs.rs` 的 `ALLOWED_DOCS`）一眼能对上 —— 那边不认识的名字会被
 * 直接拒绝。两边要一起加。
 */
export type BundledDocName = "whats-new.md" | "guide.md" | "feedback.md";

/** 读一篇随包文档的正文（Markdown 源码）。读不到会抛错，由调用方决定怎么提示。 */
export async function readBundledDoc(name: BundledDocName): Promise<string> {
  return invoke<string>("read_bundled_doc", { name });
}
