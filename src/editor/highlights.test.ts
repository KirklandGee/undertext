import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parsePage } from "./format";
import { highlightsField, jumpToIssue, setHighlights } from "./highlights";
import { layersOf, setLayers } from "./layers";
import { createEditorState, describe as describeEditor } from "./setup";

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
    expect(describeEditor(state).checks).toBeNull();

    state = state.update(setHighlights({ on: true })).state;
    expect(drawn(state)).toEqual([
      ["hl hl-adverb", "quickly"],
      ["hl hl-passive", "was closed"],
    ]);
    expect(counts(state)).toMatchObject({ adverb: 1, passive: 1, hard: 0, simpler: 0 });

    state = state.update(setHighlights({ on: false })).state;
    expect(drawn(state)).toEqual([]);
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
    expect(describeEditor(state).checks?.here).toBe("Adverb. A stronger verb may not need it.");
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
