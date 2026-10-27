import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parsePage } from "./format";
import { createEditorState, pageMarkdown } from "./setup";
import {
  fixSpelling,
  guessesFor,
  learnSpelling,
  misspellingAt,
  misspellings,
  setGuesses,
  spellingBlocks,
  spellingChecked,
  spellingField,
  unlearnSpelling,
} from "./spelling";

const stateFor = (md: string) => {
  const { text, alts, ghosts, versions } = parsePage(md);
  return createEditorState(text, { alts, ghosts, versions });
};
const apply = (state: EditorState, spec: TransactionSpec | null) => {
  expect(spec).not.toBeNull();
  return state.update(spec!).state;
};
/** The checker's answer: these offsets misspelled in this text. */
const answer = (text: string, words: [number, number][], language: string | null = "en") => ({ text, checked: { language, words } });
/** What the page underlines: the words. */
const drawn = (state: EditorState) => {
  const out: string[] = [];
  const iter = state.field(spellingField).decos.iter();
  for (; iter.value; iter.next()) out.push(state.doc.sliceString(iter.from, iter.to));
  return out;
};
const marked = (state: EditorState) => misspellings(state).map((w) => [w.word, w.from, w.to]);
const type = (state: EditorState, at: number, text: string) =>
  state.update({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: "input.type" }).state;
const undoRedo = (state: EditorState) => {
  const step = (cmd: typeof undo) => cmd({ state, dispatch: (tr: Transaction) => (state = tr.state) });
  step(undo);
  const undone = state;
  step(redo);
  return [undone, state];
};

describe("spelling", () => {
  it("checks paragraphs, headings, and list items, without markup, code, link addresses, or ghosts", () => {
    const state = stateFor(
      "# Teh plan\n" +
        "Some **bolld** text, `cde`, and [a lnk](http://exmple.com).\n" +
        "- a lisst {-ghostt-}\n" +
        "```\ncodde\n```\n",
    );
    expect(spellingBlocks(state)).toEqual([
      { from: 0, text: "  Teh plan" },
      // `cde` is 5 characters, "](http://exmple.com)" 20.
      { from: 11, text: "Some   bolld   text, " + " ".repeat(5) + ", and [a lnk" + " ".repeat(20) + "." },
      { from: 71, text: "  a lisst" + " ".repeat(7) },
    ]);
  });

  it("underlines the words the checker finds, where they are on the page", () => {
    // "Teh" at 0–3, "recieve" at 16–23.
    const state = apply(stateFor("Teh cat sat. We recieve it.\n"), spellingChecked([answer("Teh cat sat. We recieve it.", [[0, 3], [16, 23]])]));
    expect(misspellings(state)).toEqual([
      { from: 0, to: 3, word: "Teh", language: "en" },
      { from: 16, to: 23, word: "recieve", language: "en" },
    ]);
    expect(drawn(state)).toEqual(["Teh", "recieve"]);
    expect(misspellingAt(state, 23)).toMatchObject({ word: "recieve" });
    expect(misspellingAt(state, 24)).toBeNull();
    // Nothing is saved to the file.
    expect(pageMarkdown(state, "")).toBe("Teh cat sat. We recieve it.\n");
  });

  it("drops an answer for a paragraph that changed while the checker looked, and keeps the rest", () => {
    let state = stateFor("Teh cat.\n\nWe recieve it.\n");
    state = state.update({ changes: { from: 4, insert: "black " } }).state;
    state = apply(state, spellingChecked([answer("Teh cat.", [[0, 3]]), answer("We recieve it.", [[3, 10]])]));
    expect(marked(state)).toEqual([["recieve", 19, 26]]);
    // The changed paragraph's old text is forgotten, so the next check asks about its new text.
    expect([...state.field(spellingField).cache.keys()]).toEqual(["We recieve it."]);
  });

  it("moves marks with edits, and drops a mark when its word changes", () => {
    // "Teh" at 0–3, "recieve" at 12–19.
    let state = apply(stateFor("Teh cat. We recieve it.\n"), spellingChecked([answer("Teh cat. We recieve it.", [[0, 3], [12, 19]])]));
    state = state.update({ changes: { from: 4, insert: "black " } }).state;
    expect(marked(state)).toEqual([["Teh", 0, 3], ["recieve", 18, 25]]);
    // A letter right after a word makes another word.
    state = state.update({ changes: { from: 3, insert: "s" } }).state;
    expect(marked(state)).toEqual([["recieve", 19, 26]]);
    state = state.update({ changes: { from: 22, to: 23 } }).state;
    expect(state.doc.toString()).toBe("Tehs black cat. We receve it.");
    expect(marked(state)).toEqual([]);
  });

  it("after a pause, marks text the checker answered before, as after an undo", () => {
    let state = apply(stateFor("We recieve it.\n"), spellingChecked([answer("We recieve it.", [[3, 10]])]));
    state = state.update({ changes: { from: 3, to: 10, insert: "get" } }).state;
    expect(marked(state)).toEqual([]);
    state = state.update({ changes: { from: 3, to: 6, insert: "recieve" } }).state;
    expect(marked(state)).toEqual([]);
    // The check after a pause asks the checker only about new text, and refreshes the marks.
    state = apply(state, spellingChecked([]));
    expect(marked(state)).toEqual([["recieve", 3, 10]]);
  });

  it("waits to underline a word while you type it", () => {
    let state = type(stateFor("We reciev\n"), 9, "e");
    state = apply(state, spellingChecked([answer("We recieve", [[3, 10]])]));
    expect(marked(state)).toEqual([["recieve", 3, 10]]);
    expect(drawn(state)).toEqual([]);
    // The caret moves on: the word is done.
    state = state.update({ selection: EditorSelection.cursor(0) }).state;
    expect(drawn(state)).toEqual(["recieve"]);
    // A space after it is done too.
    state = type(stateFor("We recieve\n"), 10, " ");
    state = apply(state, spellingChecked([answer("We recieve ", [[3, 10]])]));
    expect(drawn(state)).toEqual(["recieve"]);
  });

  it("unmarks a learned word in any case, also in answers that come after", () => {
    const page = "Teh cat and teh dog. Wrod.";
    let state = apply(stateFor(`${page}\n`), spellingChecked([answer(page, [[0, 3], [12, 15], [21, 25]])]));
    state = apply(state, learnSpelling("teh"));
    expect(marked(state)).toEqual([["Wrod", 21, 25]]);
    state = apply(state, spellingChecked([answer(page, [[0, 3], [12, 15], [21, 25]])]));
    expect(marked(state)).toEqual([["Wrod", 21, 25]]);
  });

  it("unlearning a word forgets the answers that had it, and marks it at the next answer", () => {
    let state = stateFor("Teh cat.\n\nA dog.\n");
    state = apply(state, spellingChecked([answer("Teh cat.", [[0, 3]]), answer("A dog.", [])]));
    state = apply(state, learnSpelling("teh"));
    expect(marked(state)).toEqual([]);
    // From the page's capitalized form, as a right click finds it.
    state = apply(state, unlearnSpelling("Teh"));
    // The checker gets asked again about the paragraph with the word, even one learned in another app.
    expect([...state.field(spellingField).cache.keys()]).toEqual(["A dog."]);
    expect(marked(state)).toEqual([]);
    state = apply(state, spellingChecked([answer("Teh cat.", [[0, 3]])]));
    expect(marked(state)).toEqual([["Teh", 0, 3]]);
  });

  it("keeps the checker's guesses for a word", () => {
    let state = stateFor("We recieve it.\n");
    expect(guessesFor(state, "recieve")).toBeNull();
    state = apply(state, setGuesses("recieve", ["receive", "relieve"]));
    expect(guessesFor(state, "recieve")).toEqual(["receive", "relieve"]);
  });

  it("puts a guess in place of the word, with the caret after it, and undo brings the word back", () => {
    let state = apply(stateFor("We recieve it.\n"), spellingChecked([answer("We recieve it.", [[3, 10]])]));
    state = apply(state, fixSpelling(state, misspellingAt(state, 5)!, "receive"));
    expect(pageMarkdown(state, "")).toBe("We receive it.\n");
    expect(state.selection.main.head).toBe(10);
    expect(marked(state)).toEqual([]);
    const [undone, redone] = undoRedo(state);
    expect(pageMarkdown(undone, "")).toBe("We recieve it.\n");
    expect(pageMarkdown(redone, "")).toBe("We receive it.\n");
  });

  it("fixes a word that is a whole alternative, and the alternative keeps it", () => {
    // "larg" is the shown variant, at 2–6.
    let state = apply(stateFor("A {{big|>larg}} dog.\n"), spellingChecked([answer("A larg dog.", [[2, 6]])]));
    state = apply(state, fixSpelling(state, misspellingAt(state, 3)!, "large"));
    expect(pageMarkdown(state, "")).toBe("A {{big|>large}} dog.\n");
    const [undone, redone] = undoRedo(state);
    expect(pageMarkdown(undone, "")).toBe("A {{big|>larg}} dog.\n");
    expect(pageMarkdown(redone, "")).toBe("A {{big|>large}} dog.\n");
  });

  it("fixes a word at the edge of a longer alternative, inside it", () => {
    let state = apply(stateFor("A {{big|>larg dog}}.\n"), spellingChecked([answer("A larg dog.", [[2, 6]])]));
    state = apply(state, fixSpelling(state, misspellingAt(state, 3)!, "large"));
    expect(pageMarkdown(state, "")).toBe("A {{big|>large dog}}.\n");
  });

  it("won't fix a word that an alternative cuts through, where a save couldn't keep it", () => {
    // The alternative is "big" or "larg"; "large" ends past it, at 2–7.
    const state = apply(stateFor("A {{big|>larg}}e dog.\n"), spellingChecked([answer("A large dog.", [[2, 7]])]));
    expect(fixSpelling(state, misspellingAt(state, 3)!, "large")).toBeNull();
  });
});
