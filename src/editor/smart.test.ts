import { undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { parsePage } from "./format";
import { proofingField } from "./proofing";
import { createEditorState, pageMarkdown } from "./setup";
import { smarten, smartInput } from "./smart";

const stateFor = (md: string) => {
  const { text, alts, ghosts, versions } = parsePage(md);
  return createEditorState(text, { alts, ghosts, versions });
};
/** Types each character at the end of the page, as the input handler does: in as typed, then smartened. */
const typeAll = (state: EditorState, text: string) => {
  for (const c of text) {
    const at = state.doc.length;
    state = state.update({ changes: { from: at, insert: c }, selection: EditorSelection.cursor(at + 1), userEvent: "input.type" }).state;
    const spec = smarten(state, at + 1);
    if (spec) state = state.update(spec).state;
  }
  return state;
};
/** The page after typing `text` at the end of `doc`, which is taken as it is, blank lines and all. */
const typed = (doc: string, text: string) => typeAll(createEditorState(doc, { alts: [], ghosts: [], versions: [] }), text).doc.toString();

describe("smart quotes and dashes", () => {
  it("curl quotes: opening after a space or the start, closing after a word", () => {
    expect(typed("", `"Don't," she said. 'Fine.'`)).toBe("“Don’t,” she said. ‘Fine.’");
    expect(typed("", `He said ("yes") and *"no"*.`)).toBe("He said (“yes”) and *“no”*.");
    // Nested quotes open after an opening one; after a dash or a hyphen, a quote closes.
    expect(typed("", `"'Hi,' he said."`)).toBe("“‘Hi,’ he said.”");
    expect(typed("", `"But--" she said. Rock-'n'-roll.`)).toBe("“But—” she said. Rock-’n’-roll.");
    // Next to inline code, a quote is prose.
    expect(typed("", '"`npm`" is it')).toBe("“`npm`” is it");
    // After a quote marker or a tag, a quote opens; an escaped one stays.
    expect(typed("", '>"Hi," she said. <em>"x"</em> and \\"y\\".')).toBe('>“Hi,” she said. <em>“x”</em> and \\"y\\".');
    // After a dash, a quote opens once a word follows it.
    expect(typed("", 'He paused--"Go." "But--" no.')).toBe("He paused—“Go.” “But—” no.");
  });

  it("turn two hyphens into a dash in the page's style", () => {
    expect(typed("", "It was late--very late. Then -- again.")).toBe("It was late—very late. Then — again.");
    expect(typed("One – two.\n\nThree – four.\n\n", "late--very")).toBe("One – two.\n\nThree – four.\n\nlate–very");
    // A third hyphen stays a hyphen: "—-".
    expect(typed("", "a---b")).toBe("a—-b");
    // Between numbers, an en dash; an arrow stays an arrow.
    expect(typed("", "In 1990--1995. A --> B. A <-- B.")).toBe("In 1990–1995. A --> B. A <-- B.");
    expect(typed("", "We scored 3--a disaster.")).toBe("We scored 3—a disaster.");
  });

  it("leave a rule, a table, and a list alone", () => {
    expect(typed("", "---")).toBe("---");
    expect(typed("Text\n\n", "> --")).toBe("Text\n\n> --");
    expect(typed("", "| a | b |\n|--")).toBe("| a | b |\n|--");
    expect(typed("", "a | b\n--- | ---\n:-- | --:")).toBe("a | b\n--- | ---\n:-- | --:");
    expect(typed("", "- --flag")).toBe("- --flag");
  });

  it("leave code, HTML, and link addresses alone", () => {
    expect(typed("", 'Run `x --flag "y"` now')).toBe('Run `x --flag "y"` now');
    expect(typed("```\n", 'say "hi" -- ok')).toBe('```\nsay "hi" -- ok');
    expect(typed("", '<a href="x">')).toBe('<a href="x">');
    expect(typed("", "<!-- a -- note -->")).toBe("<!-- a -- note -->");
    expect(typed("", "[it](https://x.org/a--b)")).toBe("[it](https://x.org/a--b)");
    // After the comment closes, it's prose again.
    expect(typed("<!-- note -->\n\n", '"Hi"')).toBe("<!-- note -->\n\n“Hi”");
    expect(typed("", '<!-- a > b "c" -- d')).toBe('<!-- a > b "c" -- d');
    expect(typed("<!--\nA note\n", '"x" -- y')).toBe('<!--\nA note\n"x" -- y');
    expect(typed("", '<a\n href="x">')).toBe('<a\n href="x">');
    expect(typed("", "See https://x.org/a--b or www.x.org/c--d.")).toBe("See https://x.org/a--b or www.x.org/c--d.");
    expect(typed("", '[1]: https://x.org "Title"')).toBe('[1]: https://x.org "Title"');
    expect(typed("", "Mail me@first--last.org now.")).toBe("Mail me@first--last.org now.");
    // A footnote is prose.
    expect(typed("", '[^1]: He said "hi" -- then')).toBe("[^1]: He said “hi” — then");
    // A comment in code, or a lone "<", turns nothing off.
    expect(typed("", 'Write `<!--` for "it". If a < b, "c" wins.')).toBe("Write `<!--` for “it”. If a < b, “c” wins.");
  });

  it("leave hyphens at the edge of a ghost or an alternative alone", () => {
    // The ghost is "on-", which ends in a hyphen.
    let state = stateFor("Go {-on--}\n");
    expect(state.doc.toString()).toBe("Go on-");
    state = typeAll(state, "-");
    expect(pageMarkdown(state, "")).toBe("Go {-on--}-\n");
    // Hyphens typed after an alternative join it; their dash would too, so they stay hyphens.
    state = typeAll(stateFor("A {{re-|>pre-}}\n"), "-");
    expect(pageMarkdown(state, "")).toBe("A {{re-|>pre--}}\n");
  });

  it("bring back what you typed with ⌘Z right after", () => {
    let state = typeAll(stateFor("We left\n"), "--");
    expect(state.doc.toString()).toBe("We left—");
    undo({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    expect(state.doc.toString()).toBe("We left--");
    state = typeAll(stateFor(""), '"');
    expect(state.doc.toString()).toBe("“");
    undo({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    expect(state.doc.toString()).toBe('"');
    expect(pageMarkdown(state, "")).toBe('"\n');
  });

  it("keep the caret after the new character", () => {
    const state = typeAll(stateFor(""), "a--");
    expect(state.doc.toString()).toBe("a—");
    expect(state.selection.main.head).toBe(2);
  });

  it("run as the editor's input handler, as two steps, and not while composing or for more than a key", () => {
    expect(createEditorState("", { alts: [], ghosts: [], versions: [] }).facet(EditorView.inputHandler)).toContain(smartInput);
    let state = createEditorState("He said ", { alts: [], ghosts: [], versions: [] });
    const view = (composing = false) =>
      ({
        get state() {
          return state;
        },
        composing,
        dispatch: (tr: Transaction | TransactionSpec) => (state = tr instanceof Transaction ? tr.state : state.update(tr).state),
      }) as unknown as EditorView;
    const insert = (text: string) => () =>
      state.update({ changes: { from: state.doc.length, insert: text }, selection: EditorSelection.cursor(state.doc.length + text.length), userEvent: "input.type" });
    expect(smartInput(view(), 8, 8, '"', insert('"'))).toBe(true);
    expect(state.doc.toString()).toBe("He said “");
    // A quote waits for its partner while you type, as a typed one does.
    expect(state.field(proofingField).decos.size).toBe(0);
    let before = state;
    undo({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    expect(state.doc.toString()).toBe('He said "');
    state = before;
    expect(smartInput(view(true), 9, 9, '"', insert('"'))).toBe(false);
    expect(smartInput(view(), 9, 9, 'a"', insert('a"'))).toBe(false);
    before = state;
    expect(state.doc.toString()).toBe("He said “");
  });

  it("do nothing for other characters", () => {
    const state = stateFor("abc\n");
    expect(smarten(state, 3)).toBeNull();
  });
});
