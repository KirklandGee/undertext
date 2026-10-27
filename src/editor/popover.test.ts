import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, showTooltip } from "@codemirror/view";
import { createAlt } from "./commands";
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
  popoverContent,
  rewriteRange,
  runAction,
  useFixAt,
  whyNoAction,
} from "./popover";
import { createEditorState, describe as describeEditor, EditorHandlers, pageMarkdown } from "./setup";

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
    // A change to the layers or to Claude's issues could change what it offers, so it closes.
    expect(popoverAt(open.update(createAlt(open, 4, 10)!.spec).state)).toBeNull();
    expect(popoverAt(open.update(setWritingIssues([])).state)).toBeNull();
  });

  it("sits where you clicked, so it shows even when its mark starts off screen", () => {
    const tooltipAt = (state: EditorState) => state.facet(showTooltip).find(Boolean)?.pos;
    expect(tooltipAt(click(stateFor("She walked slowly home.\n"), 14))).toBe(14);
    let state = stateFor("She quickly left. The door was closed.\n");
    state = state.update(jumpToMark(state, ["passive"], 1)!).state;
    expect(tooltipAt(state)).toBe(27);
  });

  it("is what the Review panel and ⌥↩ describe after a jump", () => {
    // A hard sentence that starts with a simpler phrase, "In the event that". 18 words, grade 11.
    const text =
      "In the event that the committee approves the long and detailed proposal tomorrow morning, we will build it.";
    let state = stateFor(`${text}\n`);
    state = state.update(jumpToMark(state, ["hard"], 1)!).state;
    expect(shown(state)).toEqual(["hard", text]);
    expect(describeEditor(state).checks).toMatchObject({ here: "Hard to read. 18 words.", fix: null, action: "Rewrite with Claude" });
  });

  it("opens on the mark a Review row jumps to", () => {
    let state = stateFor("She quickly left. The door was closed.\n");
    state = state.update(jumpToMark(state, ["passive"], 1)!).state;
    expect(state.selection.main.head).toBe(27);
    expect(shown(state)).toEqual(["passive", "was closed"]);
    expect(jumpToMark(state, ["veryHard"], 1)).toBeNull();
  });
});

describe("the popover at the edges", () => {
  it("stays open at either end of its mark, and on a transaction that changes nothing", () => {
    // "walked slowly" at 4–17.
    const open = click(stateFor("She walked slowly home.\n"), 6);
    expect(shown(caret(open, 4))).toEqual(["weakVerb", "walked slowly"]);
    expect(shown(caret(open, 17))).toEqual(["weakVerb", "walked slowly"]);
    let state = stateFor("She quickly left. The door was closed.\n");
    state = state.update(jumpToMark(state, ["passive"], 1)!).state;
    expect(shown(state.update({}).state)).toEqual(["passive", "was closed"]);
  });

  it("closes when its own kind is hidden, though another mark covers the same words", () => {
    // "really" at 6–12 is an intensifier and an adverb.
    const open = click(stateFor("It is really done.\n"), 8);
    expect(shown(open)).toEqual(["intensifier", "really"]);
    expect(popoverAt(open.update(setHighlights({ hidden: ["intensifier"] })).state)).toBeNull();
  });

  it("shows Claude's writing issue before a live mark on the same words", () => {
    // Claude's issue covers "walked slowly home" at 4–22, longer than the weak verb at 4–17.
    const issue: WritingIssue = { from: 4, to: 22, kind: "grammar", note: "Say “walked home slowly”.", fix: "walked home slowly" };
    const state = stateFor("She walked slowly home.\n").update(setWritingIssues([issue])).state;
    expect(shown(click(state, 6))).toEqual(["grammar", "walked slowly home"]);
  });

  it("uses the fix of the popover's mark from Review's button, wherever the caret is in it", () => {
    // The popover is on "walked slowly" at 4–17; the caret moves onto "slowly", an adverb too.
    const state = caret(click(stateFor("She walked slowly home.\n"), 6), 14);
    expect(describeEditor(state).checks?.fix).toBe("strolled");
    expect(state.update(useFixAt(state)!).state.doc.toString()).toBe("She strolled home.");
  });

  it("runs ⌥↩ on the popover's mark, and not on a selection", () => {
    // A hard sentence that starts with "Really,", an intensifier and an adverb.
    const text =
      "Really, writers often build long sentences because each new idea wants another clause before the reader can pause.";
    let state = stateFor(`${text}\n`);
    state = state.update(jumpToMark(state, ["hard"], 1)!).state;
    expect(firstAction(state)).toEqual({ rewrite: { from: 0, to: text.length, kind: "hard", phrase: text } });
    const selected = stateFor("She walked slowly home.\n").update({ selection: EditorSelection.range(4, 10) }).state;
    expect(firstAction(selected)).toBeNull();
  });
});

describe("the popover's keys", () => {
  // Runs the binding for `key` the way the editor does.
  const press = (state: EditorState, key: string) => {
    const binding = state.facet(keymap).flat().find((b) => b.key === key && b.run?.toString().length);
    let next = state;
    const view = { state, dispatch: (spec: TransactionSpec | Transaction) => (next = next.update(spec as TransactionSpec).state) };
    const handled = binding!.run!(view as unknown as EditorView);
    return { handled, state: next };
  };
  const handlers = (said: string[]): EditorHandlers =>
    ({ notice: (m: string) => said.push(m), rewrite: (t: { phrase: string }) => said.push(`rewrite ${t.phrase}`) }) as unknown as EditorHandlers;
  const withHandlers = (md: string, said: string[]) => {
    const { text, alts, ghosts, versions } = parsePage(md);
    return createEditorState(text, { alts, ghosts, versions }, () => handlers(said), { on: true, hidden: [] });
  };

  it("⌥↩ uses the suggestion, or asks the app for Claude's rewrite", () => {
    const said: string[] = [];
    const weak = caret(withHandlers("She walked slowly home.\n", said), 6);
    expect(press(weak, "Alt-Enter").state.doc.toString()).toBe("She strolled home.");
    const passive = caret(withHandlers("The door was closed.\n", said), 12);
    expect(press(passive, "Alt-Enter").handled).toBe(true);
    expect(said).toEqual(["rewrite was closed"]);
  });

  it("Esc closes the popover first, and does nothing more", () => {
    const open = click(withHandlers("She walked slowly home.\n", []), 6);
    const after = press(open, "Escape");
    expect(after.handled).toBe(true);
    expect(popoverAt(after.state)).toBeNull();
    expect(press(after.state, "Escape").handled).not.toBe(true);
  });

  it("⌘/ tells the app why it won't ghost part of an alternative", () => {
    const said: string[] = [];
    const state = withHandlers("one {{two words|deux mots}} three\n", said).update({ selection: EditorSelection.range(4, 7) }).state;
    expect(press(state, "Mod-/").handled).toBe(true);
    expect(said).toEqual(["A ghost on part of an alternative isn't saved. Ghost all of it, or none."]);
  });
});

describe("popover actions", () => {
  it("offer a ghost for each kind of word you might cut, and a rewrite for each kind of sentence", () => {
    const first = (md: string, pos: number) => {
      const state = stateFor(md);
      const issue = popoverAt(click(state, pos))!;
      return [issue.kind, actionsFor(state, issue).map((a) => a.kind)];
    };
    expect(first("She left quickly.\n", 11)).toEqual(["adverb", ["ghost"]]);
    expect(first("It is basically done.\n", 8)).toEqual(["filler", ["ghost"]]);
    expect(first("It is perhaps done.\n", 8)).toEqual(["qualifier", ["ghost"]]);
    expect(first("He will be able to swim.\n", 10)).toEqual(["hidden", ["rewrite"]]);
    // 20 words, grade 12: hard. 19 long words, grade 29: very hard.
    expect(
      first("Writers often build long sentences because each new idea wants another clause before the reader can pause or rest here.\n", 3),
    ).toEqual(["hard", ["rewrite"]]);
    expect(
      first(
        "Organizations underestimate how complicated documentation becomes when several departments contribute overlapping requirements without coordinating their terminology or their priorities.\n",
        3,
      ),
    ).toEqual(["veryHard", ["rewrite"]]);
  });

  it("use a suggestion as an alternative that keeps your words", () => {
    let state = stateFor("She walked slowly home.\n");
    const issue = popoverAt(click(state, 6))!;
    expect(actionsFor(state, issue)).toEqual([{ kind: "fix", label: "strolled" }]);
    state = state.update(runAction(state, issue, actionsFor(state, issue)[0])!).state;
    expect(state.doc.toString()).toBe("She strolled home.");
    expect(pageMarkdown(state, "")).toBe("She {{walked slowly|>~strolled}} home.\n");
    expect(undoRedo(state)).toEqual(["She walked slowly home.\n", "She {{walked slowly|>~strolled}} home.\n"]);
  });

  it("fix the article before a suggestion, and back again with the original", () => {
    let state = stateFor("It was an initial test.\n");
    const issue = popoverAt(click(state, 12))!;
    expect(issue).toMatchObject({ kind: "simpler", fix: "first" });
    state = state.update(runAction(state, issue, actionsFor(state, issue)[0])!).state;
    expect(state.doc.toString()).toBe("It was a first test.");
    expect(pageMarkdown(state, "")).toBe("It was a {{initial|>~first}} test.\n");
    expect(undoRedo(state)).toEqual(["It was an initial test.\n", "It was a {{initial|>~first}} test.\n"]);
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
    // A task item's checkbox stays out of it.
    const task = stateFor("- [ ] The door was closed.\n");
    expect(rewriteRange(task, popoverAt(click(task, 16))!)).toEqual({ from: 6, to: 26 });
    // So does nothing of a bold sentence at the start of a line.
    const bold = stateFor("**The door was closed.**\n");
    expect(rewriteRange(bold, popoverAt(click(bold, 12))!)).toEqual({ from: 0, to: 24 });
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
    // A sentence that goes on past a line break in its paragraph.
    expect(why("She left. The door was closed by the wind\nthat came in.\n", 21)).toEqual(["passive", 0, "It runs across a line break."]);
    // A list item or a heading on the next line isn't more of the sentence.
    expect(why("- The door was closed by them\n- They left\n", 12)).toEqual(["passive", 1, null]);
    expect(why("The door was closed by them\n# Next\n", 10)).toEqual(["passive", 1, null]);
    // Bold that starts in one sentence and ends in the next.
    expect(why("**She left. The door was closed.**\n", 23)).toEqual(["passive", 0, "It cuts through bold or italic text."]);
    expect(why("She {{walked slowly|ran}} home.\n", 6)).toEqual(["weakVerb", 0, "It's an alternative already. ⌥J and ⌥K switch its versions."]);
    expect(why("She {{walked|ran}} slowly home.\n", 6)).toEqual(["weakVerb", 0, "Part of it already has alternatives."]);
    expect(why("{{It is really done.|It is done.}}\n", 8)).toEqual([
      "intensifier",
      0,
      "It's inside an alternative, where a ghost isn't saved. Select the whole alternative and press ⌘/.",
    ]);
    expect(why("She walked slowly home.\n", 6)).toEqual(["weakVerb", 1, null]);
  });

  it("count a hard sentence's words as Review does, without link addresses", () => {
    // 17 words, 89 letters: 4.71 × 89/17 + 0.5 × 17 − 21.43 = 11.73, grade 12, hard.
    const md =
      "Writers often build long sentences because each new idea wants another clause before the [reader](https://example.com/x/y/z) can pause.\n";
    const state = stateFor(md);
    const issue = popoverAt(click(state, 3))!;
    expect(issue.kind).toBe("hard");
    expect(popoverContent(state, issue)).toMatchObject({
      title: "Hard to read",
      text: "17 words. Split it, or use shorter words.",
    });
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
