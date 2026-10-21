import { parseDocx } from "../../src/docx/parse.js";
import { layoutDocument, defaultLayoutOptions } from "../../src/layout/index.js";
import { hitTest } from "../../src/edit/hit-test.js";

export async function runHit(bytes, pageIndex, x, y) {
  const doc = await parseDocx(bytes);
  const layout = layoutDocument(doc, defaultLayoutOptions());
  const caret = hitTest(layout, pageIndex, x, y);
  const block = caret ? layout.keyToBlock.get(caret.blockKey) : null;
  return { caret, text: block ? block.items.map((i) => i.text ?? "").join("") : null };
}
globalThis.runHit = runHit;
