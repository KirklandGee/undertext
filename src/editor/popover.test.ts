import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parsePage } from "./format";
import { setHighlights, setWritingIssues, WritingIssue } from "./highlights";
import {
  actionsFor,
  closePopover,
  firstAction,
  jumpToMark,
  openPopover,
  popoverAt,
  rewriteRange,
  runAction,
  whyNoAction,
} from "./popover";
import { createEditorState, pageMarkdown } from "./setup";

const stateFor = (md: string, on = true) => {
  const { text, alts, ghosts, versions } = parsePage(md);
  return createEditorState(text, { alts, ghosts, versions }, undefined, { on, hidden: [] });
};
const caret = (state: EditorState, pos: number) => state.update({ selection: EditorSelection.cursor(pos) }).state;
/** Puts the caret at `pos` and opens the popover there, as a click does. */
const click = (state: EditorState, pos: number) => {
  const next = caret(state, pos);
  const spec = openPopover(next);
  return spec ? next.update(spec).state : next;
};
/** The open popover's kind and the text it is about. */
const shown = (state: EditorState) => {
  const issue = popoverAt(state);
  return issue && [issue.kind, state.doc.sliceString(issue.from, issue.to)];
};
const undoRedo = (state: EditorState) => {
  const step = (cmd: typeof undo) => cmd({ state, dispatch: (tr: Transaction) => (state = tr.state) });
  step(undo);
  const undone = pageMarkdown(state, "");
  step(redo);
  return [undone, pageMarkdown(state, "")];
};

describe("the popover", () => {
  // "was quickly closed" at 9–27, "quickly" at 13–20.
  const PASSIVE = "The door was quickly closed.\n";

  it("opens on the innermost mark at the caret, only while Review is open", () => {
    expect(shown(click(stateFor(PASSIVE), 15))).toEqual(["adverb", "quickly"]);
    expect(shown(click(stateFor(PASSIVE), 10))).toEqual(["passive", "was quickly closed"]);
    expect(openPopover(caret(stateFor(PASSIVE), 1))).toBeNull();
    expect(openPopover(caret(stateFor(PASSIVE, false), 15))).toBeNull();
    expect(openPopover(stateFor(PASSIVE).update({ selection: EditorSelection.range(13, 20) }).state)).toBeNull();
  });

  it("stays on its mark while the caret is in it, and closes on anything else", () => {
    // "walked slowly" at 4–17.
    const open = click(stateFor("She walked slowly home.\n"), 6);
    expect(shown(open)).toEqual(["weakVerb", "walked slowly"]);
    expect(shown(caret(open, 14))).toEqual(["weakVerb", "walked slowly"]);
    expect(popoverAt(caret(open, 20))).toBeNull();
    expect(popoverAt(open.update({ selection: EditorSelection.range(4, 10) }).state)).toBeNull();
    expect(popoverAt(open.update({ changes: { from: 8, insert: "x" } }).state)).toBeNull();
    // Any edit closes it, even one that leaves its mark as it was.
    expect(popoverAt(open.update({ changes: { from: 23, insert: " Then." } }).state)).toBeNull();
    expect(popoverAt(open.update(closePopover).state)).toBeNull();
    expect(popoverAt(open.update(setHighlights({ on: false })).state)).toBeNull();
    expect(popoverAt(open.update(setHighlights({ hidden: ["weakVerb"] })).state)).toBeNull();
  });

  it("opens on the mark a Review row jumps to", () => {
    let state = stateFor("She quickly left. The door was closed.\n");
    state = state.update(jumpToMark(state, ["passive"], 1)!).state;
    expect(state.selection.main.head).toBe(27);
    expect(shown(state)).toEqual(["passive", "was closed"]);
    expect(jumpToMark(state, ["veryHard"], 1)).toBeNull();
  });
});

describe("popover actions", () => {
  it("use a suggestion as an alternative that keeps your words", () => {
    let state = stateFor("She walked slowly home.\n");
    const issue = popoverAt(click(state, 6))!;
    expect(actionsFor(state, issue)).toEqual([{ kind: "fix", label: "strolled" }]);
    state = state.update(runAction(state, issue, actionsFor(state, issue)[0])!).state;
    expect(state.doc.toString()).toBe("She strolled home.");
    expect(pageMarkdown(state, "")).toBe("She {{walked slowly|>~strolled}} home.\n");
    expect(undoRedo(state)).toEqual(["She walked slowly home.\n", "She {{walked slowly|>~strolled}} home.\n"]);
  });

  it("ghost a word you might cut", () => {
    // "really" at 6–12 is an intensifier and an adverb; the popover shows the first.
    let state = stateFor("It is really done.\n");
    const issue = popoverAt(click(state, 8))!;
    expect(issue).toMatchObject({ kind: "intensifier", from: 6, to: 12 });
    expect(actionsFor(state, issue)).toEqual([{ kind: "ghost", label: "Ghost it" }]);
    state = state.update(runAction(state, issue, actionsFor(state, issue)[0])!).state;
    expect(state.doc.toString()).toBe("It is really done.");
    expect(pageMarkdown(state, "")).toBe("It is {-really-} done.\n");
    expect(undoRedo(state)).toEqual(["It is really done.\n", "It is {-really-} done.\n"]);
  });

  it("offer a Claude rewrite of the whole sentence for passive voice, after any list marker", () => {
    // "The door was closed by him." at 12–39; "was closed" at 21–31.
    const state = stateFor("- She left. The door was closed by him.\n");
    const issue = popoverAt(click(state, 23))!;
    expect(issue).toMatchObject({ kind: "passive", from: 21, to: 31 });
    expect(actionsFor(state, issue)).toEqual([{ kind: "rewrite", label: "Rewrite with Claude" }]);
    expect(rewriteRange(state, issue)).toEqual({ from: 12, to: 39 });
    // Claude runs from the app, so the action itself changes nothing here.
    expect(runAction(state, issue, actionsFor(state, issue)[0])).toBeNull();

    const first = stateFor("- The door was closed.\n");
    expect(rewriteRange(first, popoverAt(click(first, 12))!)).toEqual({ from: 2, to: 22 });
  });

  it("add Claude's rewrites to a sentence that is already an alternative", () => {
    // "The door was closed." at 0–20 became an alternative in an earlier rewrite.
    const state = stateFor("{{The door was closed.|Someone closed the door.}}\n");
    const issue = popoverAt(click(state, 12))!;
    expect(actionsFor(state, issue)).toEqual([{ kind: "rewrite", label: "Rewrite with Claude" }]);
    expect(rewriteRange(state, issue)).toEqual({ from: 0, to: 20 });
  });

  it("say why when nothing fits", () => {
    const why = (md: string, pos: number) => {
      const state = stateFor(md);
      const issue = popoverAt(click(state, pos))!;
      return [issue.kind, actionsFor(state, issue).length, whyNoAction(state, issue)];
    };
    expect(why("The {-old-} door was closed.\n", 18)).toEqual(["passive", 0, "It has a ghosted word. Revive it with ⌘/ first."]);
    expect(why("The {{door|gate}} was closed.\n", 12)).toEqual(["passive", 0, "Part of it already has alternatives."]);
    expect(why("The `door` was closed.\n", 13)).toEqual(["passive", 0, "It has code in it."]);
    expect(why("She {{walked slowly|ran}} home.\n", 6)).toEqual(["weakVerb", 0, "Part of it already has alternatives."]);
    expect(why("{{It is really done.|It is done.}}\n", 8)).toEqual([
      "intensifier",
      0,
      "It's inside an alternative, where a ghost isn't saved.",
    ]);
    expect(why("She walked slowly home.\n", 6)).toEqual(["weakVerb", 1, null]);
  });

  it("ghost a word that is a whole alternative, which saves", () => {
    let state = stateFor("It is {{really|truly}} done.\n");
    const issue = popoverAt(click(state, 8))!;
    expect(actionsFor(state, issue)).toEqual([{ kind: "ghost", label: "Ghost it" }]);
    state = state.update(runAction(state, issue, actionsFor(state, issue)[0])!).state;
    const saved = pageMarkdown(state, "");
    expect(saved).toBe("It is {-{{really|truly}}-} done.\n");
    expect(parsePage(saved).ghosts).toEqual([{ from: 6, to: 12 }]);
  });

  it("offer Claude's fix for a writing issue", () => {
    const issue: WritingIssue = { from: 4, to: 7, kind: "grammar", note: "Spelling.", fix: "the" };
    const state = stateFor("Fix teh now.\n").update(setWritingIssues([issue])).state;
    expect(actionsFor(state, issue)).toEqual([{ kind: "fix", label: "the" }]);
  });

  it("offer nothing that would save a different page", () => {
    // A suggestion over an alternative, and a rewrite of a sentence with code in it.
    const alt = stateFor("She {{walked slowly|ran}} home.\n");
    expect(actionsFor(alt, popoverAt(click(alt, 6))!)).toEqual([]);
    const code = stateFor("The `door` was closed.\n");
    const passive = popoverAt(click(code, 13))!;
    expect(passive).toMatchObject({ kind: "passive" });
    expect(rewriteRange(code, passive)).toBeNull();
    expect(actionsFor(code, passive)).toEqual([]);
  });

  it("run the first action at the caret with ⌥↩, popover or not", () => {
    const weak = caret(stateFor("She walked slowly home.\n"), 6);
    const fix = firstAction(weak)!;
    expect(weak.update(fix.spec!).state.doc.toString()).toBe("She strolled home.");
    const passive = caret(stateFor("The door was closed.\n"), 12);
    expect(firstAction(passive)).toEqual({ rewrite: { from: 0, to: 20, kind: "passive", phrase: "was closed" } });
    expect(firstAction(caret(stateFor("Plain words here.\n"), 3))).toBeNull();
  });
});
