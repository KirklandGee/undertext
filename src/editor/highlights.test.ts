import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parsePage } from "./format";
import { applyWritingFix, highlightsField, issueAt, jumpToIssue, setHighlights, setWritingIssues, WritingIssue } from "./highlights";
import { layersOf, setLayers } from "./layers";
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

  it("show green beside the live checks, and count", () => {
    let state = stateFor(TEXT, true);
    expect(describeEditor(state).checks).toMatchObject({ ran: false, counts: { grammar: 0 } });
    state = state.update(setWritingIssues(issues)).state;
    expect(drawn(state).filter(([c]) => c === "hl hl-grammar")).toEqual([
      ["hl hl-grammar", "yourself"],
      ["hl hl-grammar", "do"],
    ]);
    expect(describeEditor(state).checks).toMatchObject({ ran: true, counts: { grammar: 2 } });
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

  it("offer the fix at the caret before a live mark there", () => {
    let state = stateFor(TEXT, true).update(setWritingIssues(issues)).state;
    state = state.update({ selection: EditorSelection.cursor(22) }).state;
    expect(issueAt(state, 22)).toMatchObject({ kind: "grammar", fix: "you" });
    expect(describeEditor(state).checks).toMatchObject({ here: "Use “you” here.", fix: "you" });
  });

  it("use a fix as an alternative that keeps the original, and undo it", () => {
    let state = stateFor(TEXT, true).update(setWritingIssues(issues)).state;
    const spec = applyWritingFix(state, issues[0]);
    state = state.update(spec!).state;
    expect(state.doc.toString()).toBe("Long walks can help you relax and do it.");
    expect(pageMarkdown(state, "")).toBe("Long walks can help {{yourself|>~you}} relax and do it.\n");
    expect(drawn(state).filter(([c]) => c === "hl hl-grammar")).toEqual([["hl hl-grammar", "do"]]);

    const step = (cmd: typeof undo) => cmd({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    step(undo);
    expect(state.doc.toString()).toBe(TEXT.trimEnd());
    expect(pageMarkdown(state, "")).toBe(TEXT);
    step(redo);
    expect(pageMarkdown(state, "")).toBe("Long walks can help {{yourself|>~you}} relax and do it.\n");
  });

  it("don't use a fix over an alternative, or one with nothing to offer", () => {
    const state = stateFor("Long walks can help {{yourself|you}} relax.\n", true);
    expect(applyWritingFix(state, { from: 20, to: 28, kind: "grammar", note: "", fix: "you" })).toBeNull();
    expect(applyWritingFix(state, { from: 0, to: 8, kind: "grammar", note: "", fix: "" })).toBeNull();
  });
});
