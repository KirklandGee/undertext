import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { ghostRange } from "./commands";
import { parsePage } from "./format";
import { fixPunctuation, proofingField, punctuationAt, punctuationMistakes } from "./proofing";
import { createEditorState, pageMarkdown } from "./setup";
import { spellingChecked } from "./spelling";

/** A page with Review closed. */
const stateFor = (md: string) => {
  const { text, alts, ghosts, versions } = parsePage(md);
  return createEditorState(text, { alts, ghosts, versions });
};
/** What the page underlines. */
const drawn = (state: EditorState) => {
  const out: string[] = [];
  const iter = state.field(proofingField).decos.iter();
  for (; iter.value; iter.next()) out.push(state.doc.sliceString(iter.from, iter.to));
  return out;
};
const type = (state: EditorState, at: number, text: string) =>
  state.update({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: "input.type" }).state;
const step = (state: EditorState, cmd: typeof undo) => {
  let next = state;
  cmd({ state, dispatch: (tr: Transaction) => (next = tr.state) });
  return next;
};

describe("punctuation marks", () => {
  it("show as you write, with Review closed", () => {
    const state = stateFor("He said , then left .\n");
    expect(drawn(state)).toEqual(["said ,", "left ."]);
    expect(punctuationMistakes(state).map((m) => m.note)).toEqual(["A space before the comma.", "A space before the period."]);
  });

  it("leave ghosts and code alone", () => {
    expect(drawn(stateFor("We {-really-} , went. Run `npm i` , now.\n"))).toEqual([]);
  });

  it("go when you ghost their words, and come back with undo", () => {
    let state = stateFor("We really , went.\n");
    expect(drawn(state)).toEqual(["really ,"]);
    state = state.update(ghostRange(state, 3, 9)!).state;
    expect(pageMarkdown(state, "")).toBe("We {-really-} , went.\n");
    expect(drawn(state)).toEqual([]);
    expect(drawn(step(state, undo))).toEqual(["really ,"]);
  });

  it("wait while you type a mistake, and show once the caret leaves it", () => {
    let state = type(stateFor("He said\n"), 7, " ,");
    expect(state.doc.toString()).toBe("He said ,");
    expect(drawn(state)).toEqual([]);
    expect(punctuationAt(state, 5)).toBeNull();
    // Moving within it, or a check that changes nothing, keeps it waiting.
    state = state.update({ selection: EditorSelection.cursor(8) }).state;
    expect(drawn(state)).toEqual([]);
    state = state.update(spellingChecked([])).state;
    expect(drawn(state)).toEqual([]);
    state = state.update({ selection: EditorSelection.cursor(0) }).state;
    expect(drawn(state)).toEqual(["said ,"]);
    expect(punctuationAt(state, 5)).toMatchObject({ from: 3, to: 9, fix: "said," });
  });

  it("show at once after an edit that isn't typing", () => {
    let state = type(stateFor("He said\n"), 7, " ,");
    expect(drawn(state)).toEqual([]);
    state = state.update({ changes: { from: 0, insert: "So " } }).state;
    expect(state.doc.toString()).toBe("So He said ,");
    expect(drawn(state)).toEqual(["said ,"]);
  });

  it("wait while you delete, too", () => {
    let state = stateFor("It was fine. Then\n");
    state = state.update({ changes: { from: 12, to: 13 }, selection: EditorSelection.cursor(12), userEvent: "delete.backward" }).state;
    expect(state.doc.toString()).toBe("It was fine.Then");
    expect(drawn(state)).toEqual([]);
    state = state.update({ selection: EditorSelection.cursor(0) }).state;
    expect(drawn(state)).toEqual(["fine.Then"]);
  });

  it("wait for the closing bracket while you type on in its paragraph", () => {
    let state = type(stateFor("We left\n\nNext.\n"), 7, " (in a hurry");
    expect(state.doc.toString()).toBe("We left (in a hurry\n\nNext.");
    expect(drawn(state)).toEqual([]);
    state = type(state, 19, ".");
    state = state.update({ selection: EditorSelection.cursor(16) }).state;
    expect(drawn(state)).toEqual([]);
    // The caret in the next paragraph shows it.
    state = state.update({ selection: EditorSelection.cursor(22) }).state;
    expect(drawn(state)).toEqual(["(in"]);
    // Typing on after the sentence ends doesn't hide it again.
    state = type(state, 20, " Then");
    expect(state.doc.toString()).toBe("We left (in a hurry. Then\n\nNext.");
    expect(drawn(state)).toEqual(["(in"]);
  });

  it("fix in place, with the caret after the fix, and undo brings the text back", () => {
    let state = stateFor("He said , then left.\n");
    state = state.update(fixPunctuation(state, punctuationAt(state, 4)!)!).state;
    expect(state.doc.toString()).toBe("He said, then left.");
    expect(state.selection.main.head).toBe(8);
    expect(drawn(state)).toEqual([]);
    const undone = step(state, undo);
    expect(pageMarkdown(undone, "")).toBe("He said , then left.\n");
    expect(drawn(undone)).toEqual(["said ,"]);
    expect(pageMarkdown(step(undone, redo), "")).toBe("He said, then left.\n");
  });

  it("fix as their own undo step, apart from typing", () => {
    // A space typed at the end touches "went ." at 3–9, then the fix at once.
    let state = type(stateFor("We went .\n"), 9, " ");
    state = state.update(fixPunctuation(state, punctuationAt(state, 4)!)!).state;
    expect(state.doc.toString()).toBe("We went. ");
    expect(step(state, undo).doc.toString()).toBe("We went . ");
  });

  it("write a dash in the page's style", () => {
    const state = stateFor("One — two. It was late -- very late.\n");
    const mistake = punctuationAt(state, 25)!;
    expect(mistake).toMatchObject({ note: "Two hyphens for a dash.", fix: "late — very" });
    expect(state.update(fixPunctuation(state, mistake)!).state.doc.toString()).toBe("One — two. It was late — very late.");
  });

  it("offer no fix where a save would change, as over an alternative", () => {
    const state = stateFor("He {{said ,|told}} it.\n");
    expect(state.doc.toString()).toBe("He said , it.");
    expect(punctuationAt(state, 4)).toMatchObject({ from: 3, to: 9, fix: "said," });
    expect(fixPunctuation(state, punctuationAt(state, 4)!)).toBeNull();
  });
});
