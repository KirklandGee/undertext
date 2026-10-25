import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { applyFixes, longSentences, narrowChange } from "../ai/tasks";
import { matchScore, rank } from "../palette/match";
import { buildCommands, PaletteContext } from "../palette/commands";
import { parsePage } from "./format";
import { ghostLabSpans, labSpans, makeCuts, setLab } from "./lab";
import { layersOf } from "./layers";
import { createEditorState, describe as describeEditor, pageMarkdown } from "./setup";

const stateFor = (md: string) => {
  const { text, alts, ghosts, versions } = parsePage(md);
  return createEditorState(text, { alts, ghosts, versions });
};
const at = (state: EditorState, needle: string) => state.doc.toString().indexOf(needle);

describe("AI results on the page", () => {
  it("narrows a fix to whole words", () => {
    expect(narrowChange("sat on teh mat", "sat on the mat")).toMatchObject({ original: "teh", fixed: "the" });
    expect(narrowChange("however we go", "however, we go")).toMatchObject({ original: "however", fixed: "however," });
    expect(narrowChange("same", "same")).toBeNull();
  });

  it("applies fixes as alternatives that keep the original", () => {
    const state = stateFor("The cat sat on teh mat.\n");
    const { spec, count } = applyFixes(state, [
      { paragraph: 1, find: "on teh mat", replace: "on the mat" },
      { paragraph: 1, find: "not in the text", replace: "x" },
    ]);
    expect(count).toBe(1);
    const next = state.update(spec).state;
    expect(next.doc.toString()).toBe("The cat sat on the mat.");
    expect(pageMarkdown(next, "")).toBe("The cat sat on {{teh|>~the}} mat.\n");
  });

  it("finds long sentences without AI", () => {
    const long = `${"word ".repeat(35).trim()}.`;
    const state = stateFor(`Short one. ${long} Another short.\n`);
    const spans = longSentences(state);
    expect(spans).toHaveLength(1);
    expect(state.doc.sliceString(spans[0].from, spans[0].to)).toBe(long);
  });
});

describe("the Lab", () => {
  it("makes cuts cleanly and drops marks when their text is edited", () => {
    let state = stateFor("Keep this. Really just cut this. Keep that.\n");
    const cut = { from: at(state, "Really"), to: at(state, "Really") + "Really just cut this.".length };
    state = state.update(setLab("cuts", { label: "Slight trim" }, [cut])).state;
    expect(labSpans(state)).toHaveLength(1);
    expect(state.update(makeCuts(state)!).state.doc.toString()).toBe("Keep this. Keep that.");

    state = state.update(setLab("marks", { label: "Hedges" }, [{ from: at(state, "Really"), to: at(state, "Really") + 6, reason: "hedge" }])).state;
    state = state.update({ changes: { from: at(state, "Really") + 2, insert: "x" } }).state;
    expect(labSpans(state)).toHaveLength(0);
  });

  it("keeps marks when the edit is elsewhere", () => {
    let state = stateFor("Keep this. Really.\n");
    state = state.update(setLab("marks", { label: "Hedges" }, [{ from: at(state, "Really"), to: at(state, "Really") + 6 }])).state;
    state = state.update({ changes: { from: 0, insert: "Now " } }).state;
    expect(labSpans(state)).toEqual([{ from: 15, to: 21, reason: undefined }]);
  });

  it("turns marks into ghosts", () => {
    let state = stateFor("one two three\n");
    state = state.update(setLab("marks", { label: "Hedges" }, [{ from: 4, to: 7 }])).state;
    state = state.update(ghostLabSpans(state)!).state;
    expect(layersOf(state).ghosts).toEqual([{ from: 4, to: 7 }]);
    expect(labSpans(state)).toEqual([]);
  });
});

describe("command palette", () => {
  it("matches prefixes, word starts, and loose letters", () => {
    expect(matchScore("new", "New document")).toBeGreaterThan(matchScore("doc", "New document")!);
    expect(matchScore("nw doc", "New document")).not.toBeNull();
    expect(matchScore("xyz", "New document")).toBeNull();
    const items = [
      { title: "Ghost the selection", group: "Ghost" },
      { title: "New document", group: "Document", keywords: "file" },
    ];
    expect(rank(items, "file")[0].title).toBe("New document");
  });

  it("offers commands for what is under the caret", () => {
    let state = stateFor("the {{tension|pressure}} here\n\n:::alt\nOne.\n:::or*\nTwo.\n:::\n");
    state = state.update({ selection: EditorSelection.cursor(at(state, "tension") + 2) }).state;
    const noop = () => {};
    const ctx = (s: EditorState): PaletteContext => ({
      view: { state: s, dispatch: noop as never },
      info: describeEditor(s),
      layers: true,
      overflowOpen: false,
      altOpen: false,
      actions: {
        save: noop,
        open: noop,
        newDoc: noop,
        welcome: noop,
        toggleLayers: noop,
        setOverflowOpen: noop,
        openAlternatives: noop,
        closeAlternatives: noop,
        stash: noop,
        fork: noop,
        aiAlternatives: noop,
        openLab: noop,
        fixTypos: noop,
        check: noop,
        trim: noop,
        walkLab: noop,
        makeCuts: noop,
        ghostLab: noop,
        clearLab: noop,
        setKey: noop,
        connectSubscription: noop,
      },
    });
    const titles = buildCommands(ctx(state)).map((c) => c.title);
    expect(titles).toContain("Use “pressure”");
    expect(titles).toContain("Keep “tension”, drop the other alternatives");
    expect(titles).toContain("Bold");
    expect(titles).not.toContain("Ghost the selection");

    state = state.update({ selection: EditorSelection.cursor(at(state, "Two")) }).state;
    expect(buildCommands(ctx(state)).map((c) => c.title)).toContain("Switch to version 1: “One.”");
  });
});
