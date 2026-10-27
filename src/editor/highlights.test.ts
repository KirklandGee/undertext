import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parsePage } from "./format";
import {
  applyFix,
  highlightsField,
  issueAt,
  jumpToIssue,
  setHighlights,
  setWritingIssues,
  WritingIssue,
  writingIssues,
} from "./highlights";
import { emptyLayers, layersOf, setLayers } from "./layers";
import { createEditorState, describe as describeEditor, pageMarkdown } from "./setup";

const stateFor = (md: string, on = false) => {
  const { text, alts, ghosts, versions } = parsePage(md);
  return createEditorState(text, { alts, ghosts, versions }, undefined, { on, hidden: [] });
};

/** What the page draws: each highlight's class and the text it covers. */
const drawn = (state: EditorState) => {
  const out: [string, string][] = [];
  const iter = state.field(highlightsField).decos.iter();
  for (; iter.value; iter.next()) out.push([iter.value.spec.class, state.doc.sliceString(iter.from, iter.to)]);
  return out;
};

const counts = (state: EditorState) => describeEditor(state).checks?.counts;

describe("live highlights", () => {
  it("draw nothing until Review turns them on, then mark the page", () => {
    let state = stateFor("She quickly left. The door was closed.\n");
    expect(drawn(state)).toEqual([]);
    // The top bar shows the grade with Review closed, so the checks still run. The caret's reason doesn't show.
    // 7 words, 30 letters, 2 sentences: 4.71 × 30/7 + 0.5 × 7/2 − 21.43 = 0.51, grade 1.
    expect(describeEditor(state).checks).toMatchObject({ grade: 1, sentences: 2, here: null });

    state = state.update(setHighlights({ on: true })).state;
    expect(drawn(state)).toEqual([
      ["hl hl-adverb", "quickly"],
      ["hl hl-passive", "was closed"],
    ]);
    expect(counts(state)).toMatchObject({ adverb: 1, passive: 1, hard: 0, simpler: 0 });

    state = state.update(setHighlights({ on: false })).state;
    expect(drawn(state)).toEqual([]);
  });

  it("leave the explaining to the popover: no hover tooltips", () => {
    const iter = stateFor("She quickly left.\n", true).field(highlightsField).decos.iter();
    expect(iter.value?.spec).toEqual({ class: "hl hl-adverb" });
  });

  it("count an intensifier that is also an adverb as one weakener", () => {
    const state = stateFor("He ran really fast.\n", true);
    expect(describeEditor(state).checks).toMatchObject({ weakeners: 1, counts: { intensifier: 1, adverb: 1 } });
  });

  it("keep counting a hidden kind, but don't draw it", () => {
    let state = stateFor("She quickly left. The door was closed.\n", true);
    state = state.update(setHighlights({ hidden: ["adverb"] })).state;
    expect(drawn(state)).toEqual([["hl hl-passive", "was closed"]]);
    expect(counts(state)).toMatchObject({ adverb: 1, passive: 1 });
  });

  it("don't explain or jump to a hidden kind", () => {
    let state = stateFor("She quickly left. The door was closed.\n", true);
    state = state.update(setHighlights({ hidden: ["adverb"] })).state;
    state = state.update({ selection: EditorSelection.cursor(6) }).state;
    expect(describeEditor(state).checks?.here).toBeNull();
    expect(jumpToIssue(state, ["adverb"], 1)).toBeNull();
    expect(state.update(jumpToIssue(state, ["passive"], 1)!).state.selection.main.head).toBe(27);
  });

  it("start a page with the hidden kinds it is given", () => {
    const state = createEditorState("She quickly left. The door was closed.", emptyLayers, undefined, {
      on: true,
      hidden: ["adverb"],
    });
    expect(drawn(state)).toEqual([["hl hl-passive", "was closed"]]);
  });

  it("explain a marked word at the caret before its sentence", () => {
    // 17 words, 91 letters: 4.71 × 91/17 + 0.5 × 17 − 21.43 = 12.28, grade 12, hard.
    const text = "Writers quickly build long sentences because each new idea wants another clause before the reader can pause.";
    let state = stateFor(`${text}\n`, true);
    expect(counts(state)).toMatchObject({ hard: 1, adverb: 1 });
    state = state.update({ selection: EditorSelection.cursor(10) }).state;
    expect(describeEditor(state).checks?.here).toBe("Adverb. Cut it if the sentence holds without it.");
  });

  it("follow each edit", () => {
    let state = stateFor("She quickly left.\n", true);
    state = state.update({ changes: { from: 0, insert: "He slowly sat. " } }).state;
    expect(drawn(state)).toEqual([
      ["hl hl-adverb", "slowly"],
      ["hl hl-adverb", "quickly"],
    ]);
    state = state.update({ changes: { from: 0, to: 15 } }).state;
    expect(drawn(state)).toEqual([["hl hl-adverb", "quickly"]]);
  });

  it("skip ghosted text, as the word count does", () => {
    let state = stateFor("She {-quickly-} left.\n", true);
    expect(drawn(state)).toEqual([]);

    state = stateFor("She quickly left.\n", true);
    expect(counts(state)).toMatchObject({ adverb: 1 });
    state = state.update({ effects: setLayers.of({ ...layersOf(state), ghosts: [{ from: 4, to: 11 }] }) }).state;
    expect(drawn(state)).toEqual([]);
    expect(counts(state)).toMatchObject({ adverb: 0 });
  });

  it("give the grade, the sentences, and why the text at the caret is marked", () => {
    // 6 words, 25 letters, 2 sentences: 4.71 × 25/6 + 0.5 × 6/2 − 21.43 = −0.31, grade 0.
    let state = stateFor("She quickly left. He slowly sat.\n", true);
    expect(describeEditor(state).checks).toMatchObject({ grade: 0, sentences: 2, here: null });
    state = state.update({ selection: EditorSelection.cursor(25) }).state;
    expect(describeEditor(state).checks?.here).toBe("Adverb. Cut it if the sentence holds without it.");
  });

  it("say nothing about the caret's text while Review is closed", () => {
    const state = stateFor("She quickly left.\n").update({ selection: EditorSelection.cursor(6) }).state;
    expect(describeEditor(state).checks?.here).toBeNull();
    expect(describeEditor(state.update(setHighlights({ on: true })).state).checks?.here).toBe(
      "Adverb. Cut it if the sentence holds without it.",
    );
  });

  it("jump to the next or previous mark of a kind, and wrap around", () => {
    let state = stateFor("She quickly left. He slowly sat.\n", true);
    const caret = () => state.selection.main.head;
    const jump = (dir: 1 | -1) => (state = state.update(jumpToIssue(state, ["adverb"], dir)!).state);
    jump(1);
    expect(caret()).toBe(4);
    jump(1);
    expect(caret()).toBe(21);
    jump(1);
    expect(caret()).toBe(4);
    jump(-1);
    expect(caret()).toBe(21);
    expect(jumpToIssue(state, ["passive"], 1)).toBeNull();
    expect(jumpToIssue(stateFor("She quickly left.\n"), ["adverb"], 1)).toBeNull();
  });
});

describe("writing issues from Claude", () => {
  // "yourself" at 20–28, "do" at 39–41.
  const TEXT = "Long walks can help yourself relax and do it.\n";
  const issues: WritingIssue[] = [
    { from: 20, to: 28, kind: "grammar", note: "Use “you” here.", fix: "you" },
    { from: 39, to: 41, kind: "grammar", note: "Use “doing”.", fix: "doing" },
  ];

  it("show pink beside the live checks, and count", () => {
    let state = stateFor(TEXT, true);
    expect(describeEditor(state).checks).toMatchObject({ ran: false, counts: { grammar: 0 } });
    state = state.update(setWritingIssues(issues)).state;
    expect(drawn(state).filter(([c]) => c === "hl hl-grammar")).toEqual([
      ["hl hl-grammar", "yourself"],
      ["hl hl-grammar", "do"],
    ]);
    expect(describeEditor(state).checks).toMatchObject({ ran: true, counts: { grammar: 2 } });
  });

  it("put a writing issue's fix before a live mark at the caret, and jump to it", () => {
    const issue: WritingIssue = { from: 4, to: 11, kind: "grammar", note: "Use “fast”.", fix: "fast" };
    let state = stateFor("She quickly left.\n", true).update(setWritingIssues([issue])).state;
    expect(counts(state)).toMatchObject({ adverb: 1, grammar: 1 });
    state = state.update({ selection: EditorSelection.cursor(6) }).state;
    expect(describeEditor(state).checks).toMatchObject({ here: "Use “fast”.", fix: "fast" });
    state = state.update({ selection: EditorSelection.cursor(0) }).state;
    expect(state.update(jumpToIssue(state, ["grammar"], 1)!).state.selection.main.head).toBe(4);
  });

  it("move with edits, and drop the one whose text you change", () => {
    let state = stateFor(TEXT, true).update(setWritingIssues(issues)).state;
    state = state.update({ changes: { from: 0, insert: "So. " } }).state;
    const grammar = () => drawn(state).filter(([c]) => c === "hl hl-grammar");
    expect(grammar()).toEqual([
      ["hl hl-grammar", "yourself"],
      ["hl hl-grammar", "do"],
    ]);
    state = state.update({ changes: { from: 43, to: 45, insert: "doing" } }).state;
    expect(state.doc.toString()).toBe("So. Long walks can help yourself relax and doing it.");
    expect(grammar()).toEqual([["hl hl-grammar", "yourself"]]);
    expect(describeEditor(state).checks?.counts.grammar).toBe(1);
  });

  it("offer the fix at the caret", () => {
    let state = stateFor(TEXT, true).update(setWritingIssues(issues)).state;
    state = state.update({ selection: EditorSelection.cursor(22) }).state;
    expect(issueAt(state, 22)).toMatchObject({ kind: "grammar", fix: "you" });
    expect(describeEditor(state).checks).toMatchObject({
      here: "Use “you” here.",
      fix: "you",
      fixHint: "Replaces it. ⌘Z brings it back.",
    });
  });

  // A writing issue is a mistake, not a style choice, so its fix replaces the words.
  it("replace the words with a fix, with no alternative, and undo it", () => {
    let state = stateFor(TEXT, true).update(setWritingIssues(issues)).state;
    const spec = applyFix(state, issues[0]);
    state = state.update(spec!).state;
    expect(state.doc.toString()).toBe("Long walks can help you relax and do it.");
    expect(layersOf(state).alts).toEqual([]);
    expect(pageMarkdown(state, "")).toBe("Long walks can help you relax and do it.\n");
    expect(drawn(state).filter(([c]) => c === "hl hl-grammar")).toEqual([["hl hl-grammar", "do"]]);

    const step = (cmd: typeof undo) => cmd({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    step(undo);
    expect(state.doc.toString()).toBe(TEXT.trimEnd());
    expect(pageMarkdown(state, "")).toBe(TEXT);
    step(redo);
    expect(pageMarkdown(state, "")).toBe("Long walks can help you relax and do it.\n");
  });

  it("keep the layers after a longer fix where they are, through undo and redo", () => {
    const issue: WritingIssue = { from: 0, to: 3, kind: "grammar", note: "Needs an apostrophe.", fix: "It's" };
    let state = stateFor("Its {-really-} easy {{now|soon}}.\n", true);
    expect(state.doc.toString()).toBe("Its really easy now.");
    state = state.update(applyFix(state, issue)!).state;
    expect(state.doc.toString()).toBe("It's really easy now.");
    expect(pageMarkdown(state, "")).toBe("It's {-really-} easy {{now|soon}}.\n");

    const step = (cmd: typeof undo) => cmd({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    step(undo);
    expect(pageMarkdown(state, "")).toBe("Its {-really-} easy {{now|soon}}.\n");
    step(redo);
    expect(pageMarkdown(state, "")).toBe("It's {-really-} easy {{now|soon}}.\n");
  });

  it("drop a doubled word and its space, and save the page as shown", () => {
    let state = stateFor("We saw the the cat.\n", true);
    const issue: WritingIssue = { from: 7, to: 15, kind: "grammar", note: "A word twice.", fix: "the " };
    state = state.update(applyFix(state, issue)!).state;
    expect(state.doc.toString()).toBe("We saw the cat.");
    const saved = pageMarkdown(state, "");
    expect(saved).toBe("We saw the cat.\n");
    expect(parsePage(saved).text).toBe("We saw the cat.");
  });

  it("offer no fix where it can't apply, as over an alternative", () => {
    const issue: WritingIssue = { from: 4, to: 7, kind: "grammar", note: "Spelling.", fix: "the" };
    let state = stateFor("Fix teh now.\n", true).update(setWritingIssues([issue])).state;
    state = state.update({ selection: EditorSelection.cursor(5) }).state;
    expect(describeEditor(state).checks).toMatchObject({ here: "Spelling.", fix: "the" });

    state = stateFor("Fix {{teh|the}} now.\n", true).update(setWritingIssues([issue])).state;
    state = state.update({ selection: EditorSelection.cursor(5) }).state;
    expect(describeEditor(state).checks).toMatchObject({ here: "Spelling.", fix: null });
  });

  it("drop writing issues that don't fit the page, so later edits still work", () => {
    let state = stateFor("Short.\n", true);
    state = state.update(
      setWritingIssues([
        { from: 2, to: 38, kind: "grammar", note: "Ends past the page.", fix: "x" },
        { from: 30, to: 38, kind: "grammar", note: "Gone.", fix: "x" },
      ]),
    ).state;
    state = state.update({ changes: { from: 0, insert: "A " } }).state;
    expect(state.doc.toString()).toBe("A Short.");
    expect(writingIssues(state)).toEqual([]);
  });

  it("offer no fix in code, as when the writer added backticks after Claude looked", () => {
    const issue: WritingIssue = { from: 5, to: 8, kind: "grammar", note: "Spelling.", fix: "the" };
    let state = stateFor("Run `teh` now.\n", true).update(setWritingIssues([issue])).state;
    expect(applyFix(state, issue)).toBeNull();
    state = state.update({ selection: EditorSelection.cursor(6) }).state;
    expect(describeEditor(state).checks).toMatchObject({ here: "Spelling.", fix: null });
  });

  it("offer no fix that would split its line", () => {
    const state = stateFor("We teh cat.\n", true);
    expect(applyFix(state, { from: 3, to: 6, kind: "grammar", note: "", fix: "the\rx" })).toBeNull();
    expect(applyFix(state, { from: 3, to: 6, kind: "grammar", note: "", fix: "the" })).not.toBeNull();
  });

  it("offer no fix that would leave a space at a line's end", () => {
    const state = stateFor("We saw it  \n", true);
    expect(state.doc.toString()).toBe("We saw it  ");
    expect(applyFix(state, { from: 7, to: 11, kind: "grammar", note: "", fix: "it " })).toBeNull();
  });

  it("don't use a fix over an alternative, or one with nothing to offer", () => {
    const state = stateFor("Long walks can help {{yourself|you}} relax.\n", true);
    expect(applyFix(state, { from: 20, to: 28, kind: "grammar", note: "", fix: "you" })).toBeNull();
    expect(applyFix(state, { from: 0, to: 8, kind: "grammar", note: "", fix: "" })).toBeNull();
  });
});
