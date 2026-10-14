import type { Root, Blockquote } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/;

const remarkAlerts: Plugin<[], Root> = () => (tree) => {
  visit(tree, "blockquote", (node: Blockquote) => {
    const first = node.children[0];
    if (first?.type !== "paragraph") return;

    const text = first.children[0];
    if (text?.type !== "text") return;

    const match = text.value.match(ALERT_RE);
    if (!match) return;

    const alertType = match[1].toLowerCase();

    // Remove the [!TYPE] marker from the text content
    text.value = text.value.slice(match[0].length);

    // If the text node is now empty, clean up
    if (!text.value) {
      first.children.shift();
      // Also remove a leading soft break if present
      if (first.children[0]?.type === "break") {
        first.children.shift();
      }
      // If the entire first paragraph is now empty, remove it
      if (first.children.length === 0) {
        node.children.shift();
      }
    }

    // Attach the alert type as an HTML data attribute
    node.data ??= {};
    node.data.hProperties = {
      ...(node.data.hProperties as Record<string, unknown>),
      "data-alert-type": alertType,
    };
  });
};

export default remarkAlerts;
