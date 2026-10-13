import { Schema } from "prosemirror-model";

// The document is plain Markdown text. Undertext adds three layers on top:
// - `alt` mark: alternatives for a word or sentence (variants are plain strings)
// - `ghost` mark: dimmed text that you may cut later
// - paragraph `variants`: whole-paragraph versions (stored as inline Markdown)
export const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "(text | hard_break)*",
      attrs: {
        // Variant group id. Used to detect copies made by splits and pastes.
        vid: { default: null },
        variants: { default: null },
        active: { default: 0 },
      },
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: {},
    hard_break: {
      inline: true,
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
  },
  marks: {
    alt: {
      attrs: {
        id: {},
        variants: {},
        active: { default: 0 },
        /** Variant texts that came from AI. */
        ai: { default: [] },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: "span[data-alt-id]",
          getAttrs: (dom) => {
            const el = dom as HTMLElement;
            try {
              return {
                id: newId(),
                variants: JSON.parse(el.dataset.variants ?? "[]"),
                active: Number(el.dataset.active ?? 0),
                ai: JSON.parse(el.dataset.ai ?? "[]"),
              };
            } catch {
              return false;
            }
          },
        },
      ],
      toDOM: (mark) => {
        const { id, variants, active, ai } = mark.attrs;
        return [
          "span",
          {
            class: "alt",
            "data-alt-id": id,
            "data-count": String(variants.length),
            "data-active": String(active),
            "data-variants": JSON.stringify(variants),
            "data-ai": JSON.stringify(ai),
          },
          0,
        ];
      },
    },
    ghost: {
      inclusive: false,
      parseDOM: [{ tag: "span.ghost" }],
      toDOM: () => ["span", { class: "ghost" }, 0],
    },
  },
});

let counter = 0;
export function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}
