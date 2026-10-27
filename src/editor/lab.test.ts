import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { addRewrites, applyFixes, longSentences, narrowChange, rewritePrompt, writingIssuesFrom } from "../ai/tasks";
import { matchScore, rank } from "../palette/match";
import { buildCommands, GROUPS, PaletteCommand, PaletteContext } from "../palette/commands";
import { createAlt, findAlt } from "./commands";
import { parsePage } from "./format";
import { setHighlights, setWritingIssues } from "./highlights";
import { ghostLabNotice, ghostLabSpans, labSpans, labSpansThatCutAlternatives, makeCuts, setLab } from "./lab";
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

  it("marks Claude's writing issues on the words that change, with the fix", () => {
    const state = stateFor("# Rest will help yourself relax\n\nRest will help yourself relax. Plan the the plan. It works.\n");
    const issues = writingIssuesFrom(state, [
      { paragraph: 1, find: "help yourself relax", replace: "help you relax", reason: "In a heading." },
      { paragraph: 2, find: "help yourself relax", replace: "help you relax", reason: "Use “you” here." },
      { paragraph: 2, find: "the the plan", replace: "the plan", reason: "A word twice." },
      { paragraph: 2, find: "not in the text", replace: "x", reason: "Gone." },
      { paragraph: 2, find: "It works.", replace: "It works.", reason: "No change." },
      { paragraph: 2, find: "It works.", replace: "", reason: "Cut it." },
    ]);
    // A fix that deletes the whole quote leaves no word to swap in: the quote is marked, with no fix.
    expect(issues).toEqual([
      { from: 48, to: 56, kind: "grammar", note: "Use “you” here.", fix: "you" },
      { from: 73, to: 81, kind: "grammar", note: "A word twice.", fix: "plan" },
      { from: 83, to: 92, kind: "grammar", note: "Cut it.", fix: "" },
    ]);
  });

  it("keeps a fix that adds or drops a space through a save, and leaves code alone", () => {
    const state = stateFor("It ended.Next we left. Hello , world. Run `teh` now.\n");
    const { spec, count } = applyFixes(state, [
      { paragraph: 1, find: "ended.Next", replace: "ended. Next" },
      { paragraph: 1, find: "Hello , world", replace: "Hello, world" },
      { paragraph: 1, find: "`teh`", replace: "`the`" },
    ]);
    expect(count).toBe(2);
    const next = state.update(spec).state;
    expect(next.doc.toString()).toBe("It ended. Next we left. Hello, world. Run `teh` now.");
    const saved = pageMarkdown(next, "");
    expect(saved).toBe("It {{ended.Next|>~ended. Next}} we left. {{Hello ,|>~Hello,}} world. Run `teh` now.\n");
    const back = parsePage(saved);
    expect(back.text).toBe("It ended. Next we left. Hello, world. Run `teh` now.");
    expect(back.alts.map((a) => a.variants)).toEqual([
      ["ended.Next", "ended. Next"],
      ["Hello ,", "Hello,"],
    ]);
  });

  it("leaves a fix out where its alternative would save a different page", () => {
    const count = (md: string, find: string, replace: string) =>
      applyFixes(stateFor(`${md}\n`), [{ paragraph: 1, find, replace }]).count;
    // The whole word would cut into a ghost, take in code, or start a line with list or heading markup.
    expect(count("We {-met.Then-},now go.", ",now", ", now")).toBe(0);
    expect(count("Set `max size`=10.Then restart.", "10.Then", "10. Then")).toBe(0);
    expect(count("-Buy milk", "-Buy", "- Buy")).toBe(0);
    expect(count("#Setup", "#Setup", "# Setup")).toBe(0);
    expect(count("> -  Teh cat sat.", "-  Teh", "- Teh")).toBe(0);
    expect(count("- One.\n  -  Teh cat sat.", "-  Teh", "- Teh")).toBe(0);
    expect(count("Run `npm install to start.", "`npm install", "`npm install`")).toBe(0);
    expect(count("Some text here.\n\n    teh = 1", "teh", "the")).toBe(0);
  });

  it("skips a fix that overlaps one before it", () => {
    const state = stateFor("We met.Then,now go.\n");
    const { spec, count } = applyFixes(state, [
      { paragraph: 1, find: "met.Then", replace: "met. Then" },
      { paragraph: 1, find: ",now", replace: ", now" },
    ]);
    expect(count).toBe(1);
    const next = state.update(spec).state;
    expect(next.doc.toString()).toBe("We met. Then,now go.");
    expect(pageMarkdown(next, "")).toBe("We {{met.Then|>~met. Then}},now go.\n");
  });

  it("undoes and redoes typo fixes", () => {
    let state = stateFor("The cat sat on teh mat.\n");
    state = state.update(applyFixes(state, [{ paragraph: 1, find: "on teh mat", replace: "on the mat" }]).spec).state;
    expect(pageMarkdown(state, "")).toBe("The cat sat on {{teh|>~the}} mat.\n");
    const step = (cmd: typeof undo) => cmd({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    step(undo);
    expect(pageMarkdown(state, "")).toBe("The cat sat on teh mat.\n");
    step(redo);
    expect(pageMarkdown(state, "")).toBe("The cat sat on {{teh|>~the}} mat.\n");
  });

  it("leaves Claude's writing issues in code and ghosts alone, and marks each spot once", () => {
    const state = stateFor("Run `teh` now. {-We recieve it.-}\n\n```\nwe recieve it\n```\n\nthe cat and the cat.\n\n    teh = 1\n");
    const issues = writingIssuesFrom(state, [
      { paragraph: 1, find: "teh", replace: "the", reason: "Spelling." },
      { paragraph: 1, find: "We recieve it.", replace: "We receive it.", reason: "Spelling." },
      { paragraph: 2, find: "recieve", replace: "receive", reason: "Spelling." },
      { paragraph: 3, find: "the cat", replace: "the dog", reason: "One." },
      { paragraph: 3, find: "the cat", replace: "the dog", reason: "Two." },
      { paragraph: 4, find: "teh", replace: "the", reason: "Indented code." },
    ]);
    expect(issues).toEqual([
      { from: 58, to: 61, kind: "grammar", note: "One.", fix: "dog" },
      { from: 70, to: 73, kind: "grammar", note: "Two.", fix: "dog" },
    ]);
  });

  it("keeps only Claude's rewrites that fix the mark, as no passive voice left", () => {
    // The answer one real run gave for "Rewrite with Claude" on this sentence's passive voice.
    const answer = [
      "The door was shut quickly.",
      "Someone quickly closed the door.",
      "The door swung shut.",
      "The door was slammed shut.",
      "The door was hastily pulled closed.",
      "In an instant, the door was shut.",
    ];
    let state = stateFor("The door was quickly closed.\n");
    const made = createAlt(state, 0, 28)!;
    state = state.update(made.spec).state;
    state = state.update(addRewrites(state, made.id, "passive", answer)!).state;
    expect(findAlt(state, made.id)!.variants).toEqual([
      "The door was quickly closed.",
      "Someone quickly closed the door.",
      "The door swung shut.",
    ]);
    const saved = "{{The door was quickly closed.|~Someone quickly closed the door.|~The door swung shut.}}\n";
    expect(pageMarkdown(state, "")).toBe(saved);
    const step = (cmd: typeof undo) => cmd({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    step(undo);
    // An alternative with one variant left saves as plain text.
    expect(pageMarkdown(state, "")).toBe("The door was quickly closed.\n");
    step(redo);
    expect(pageMarkdown(state, "")).toBe(saved);
    expect(addRewrites(state, made.id, "passive", ["It was shut.", "The door was closed."])).toBeNull();
    // A backtick or a lone carriage return would change the page the file reopens as.
    expect(addRewrites(state, made.id, "passive", ["He shut `the door.", "He shut it.\rThen he left.", "He <!-- shut it."])).toBeNull();
    // Half of some bold, or block markup where the sentence starts its line, would change the page.
    const kept = state.update(addRewrites(state, made.id, "passive", ["**He shut the door.", "- He shut it.", "He **shut** it."])!).state;
    expect(findAlt(kept, made.id)!.variants.slice(3)).toEqual(["He **shut** it."]);

    // A rewrite of a very hard sentence that is still hard doesn't fix it either.
    // 20 words, 99 letters: grade 12, hard.
    const hard =
      "Writers often build long sentences because each new idea wants another clause before the reader can pause or rest here.";
    state = state.update(addRewrites(state, made.id, "veryHard", [hard, "Writers pile on clauses. Readers need a rest."])!).state;
    expect(findAlt(state, made.id)!.variants.slice(3)).toEqual(["Writers pile on clauses. Readers need a rest."]);
  });

  it("tells Claude the goal, the words the checks flagged, and the rewrites the writer has", () => {
    // "The door was quickly closed by the wind that came in." at 16–69.
    let state = stateFor("She left early. The door was quickly closed by the wind that came in.\n");
    const made = createAlt(state, 16, 69)!;
    state = state.update(made.spec).state;
    const passive = rewritePrompt(state, made.id, "passive", "was quickly closed")!;
    expect(passive.system).toContain("Put it in the active voice: name who or what acts.");
    expect(passive.system).toContain("The checks flagged “was quickly closed” as passive voice.");
    expect(passive.prompt).toBe(
      "Paragraph:\nShe left early. ⟦The door was quickly closed by the wind that came in.⟧\n\n" +
        "Rewrites the writer has already: none.\n\nSuggest 6 rewrites of the marked text.",
    );
    // A hard sentence is flagged as a whole, so there is no phrase to name.
    const hard = rewritePrompt(state, made.id, "hard", "The door was quickly closed by the wind that came in.")!;
    expect(hard.system).toContain("Make it easier to read");
    expect(hard.system).not.toContain("flagged");

    state = stateFor("{{The door was closed.|Someone closed the door.}}\n");
    const alt = layersOf(state).alts[0];
    expect(rewritePrompt(state, alt.id, "passive", "was closed")!.prompt).toBe(
      "Paragraph:\n⟦The door was closed.⟧\n\nRewrites the writer has already: “Someone closed the door.”.\n\n" +
        "Suggest 6 rewrites of the marked text.",
    );
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

  it("leaves a mark on part of an alternative as a mark, since a save would lose its ghost", () => {
    // "two words" at 4–13 is an alternative. "one two" cuts into it; "three" doesn't.
    let state = stateFor("one {{two words|deux mots}} three four\n");
    state = state.update(setLab("marks", { label: "Hedges" }, [{ from: 0, to: 7, reason: "A" }, { from: 14, to: 19, reason: "B" }])).state;
    expect(labSpansThatCutAlternatives(state)).toEqual([{ from: 0, to: 7, reason: "A" }]);
    expect(ghostLabNotice(state)).toBe("1 mark stays: it covers part of an alternative, where a ghost isn't saved.");
    state = state.update(ghostLabSpans(state)!).state;
    expect(layersOf(state).ghosts).toEqual([{ from: 14, to: 19 }]);
    expect(labSpans(state)).toEqual([{ from: 0, to: 7, reason: "A" }]);
    expect(pageMarkdown(state, "")).toBe("one {{two words|deux mots}} {-three-} four\n");
    // With only such marks left, there's nothing to ghost.
    expect(ghostLabSpans(state)).toBeNull();
    const step = (cmd: typeof undo) => cmd({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    step(undo);
    expect(pageMarkdown(state, "")).toBe("one {{two words|deux mots}} three four\n");
    step(redo);
    expect(pageMarkdown(state, "")).toBe("one {{two words|deux mots}} {-three-} four\n");

    // With several marks, only those that go are taken off.
    let many = stateFor("one {{two words|deux mots}} three four five\n");
    many = many.update(setLab("marks", { label: "Hedges" }, [{ from: 0, to: 7 }, { from: 14, to: 19 }, { from: 25, to: 29 }])).state;
    many = many.update(ghostLabSpans(many)!).state;
    expect(labSpans(many)).toEqual([{ from: 0, to: 7, reason: undefined }]);
    expect(layersOf(many).ghosts).toEqual([
      { from: 14, to: 19 },
      { from: 25, to: 29 },
    ]);

    const cuts = stateFor("one {{two words|deux mots}} three\n").update(
      setLab("cuts", { label: "Slight trim" }, [{ from: 0, to: 7 }, { from: 8, to: 19 }]),
    ).state;
    expect(ghostLabNotice(cuts)).toBe("2 proposed cuts stay: they cover part of an alternative, where a ghost isn't saved.");
    expect(ghostLabNotice(stateFor("one two\n"))).toBeNull();
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

  const noop = () => {};
  const ctx = (s: EditorState, panels: Partial<PaletteContext> = {}, actions: Partial<PaletteContext["actions"]> = {}): PaletteContext => ({
    view: { state: s, dispatch: noop as never },
    info: describeEditor(s),
    layers: true,
    overflowOpen: false,
    reviewOpen: false,
    altOpen: false,
    ...panels,
    actions: {
      save: noop,
      open: noop,
      newDoc: noop,
      welcome: noop,
      toggleLayers: noop,
      setOverflowOpen: noop,
      setReviewOpen: noop,
      openAlternatives: noop,
      closeAlternatives: noop,
      stash: noop,
      fork: noop,
      aiAlternatives: noop,
      fixTypos: noop,
      findIssues: noop,
      useFix: noop,
      check: noop,
      trim: noop,
      walkLab: noop,
      makeCuts: noop,
      ghostLab: noop,
      ghost: noop,
      firstAction: noop,
      clearLab: noop,
      setKey: noop,
      connectSubscription: noop,
      ...actions,
    },
  });

  it("offers commands for what is under the caret", () => {
    let state = stateFor("the {{tension|pressure}} here\n\n:::alt\nOne.\n:::or*\nTwo.\n:::\n");
    state = state.update({ selection: EditorSelection.cursor(at(state, "tension") + 2) }).state;
    const titles = buildCommands(ctx(state)).map((c) => c.title);
    expect(titles).toContain("Use “pressure”");
    expect(titles).toContain("Keep “tension”, drop the other alternatives");
    expect(titles).toContain("Bold");
    expect(titles).not.toContain("Ghost the selection");

    state = state.update({ selection: EditorSelection.cursor(at(state, "Two")) }).state;
    expect(buildCommands(ctx(state)).map((c) => c.title)).toContain("Switch to version 1: “One.”");
  });

  it("lists the checks under Review, and opens or closes it", () => {
    const state = stateFor("One sentence here.\n");
    const asked: boolean[] = [];
    const find = (commands: PaletteCommand[], id: string) => commands.find((c) => c.id === id)!;

    const closed = buildCommands(ctx(state, {}, { setReviewOpen: (open) => asked.push(open) }));
    expect(find(closed, "lab.open")).toMatchObject({ group: "Review", title: "Open Review", shortcut: "⌘⇧E" });
    expect(find(closed, "lab.typos").group).toBe("Review");
    expect(find(closed, "lab.trim.half").group).toBe("Review");
    expect(find(closed, "overflow.toggle").title).toBe("Open Overflow");
    find(closed, "lab.open").run();
    expect(asked).toEqual([true]);

    const open = buildCommands(ctx(state, { reviewOpen: true }, { setReviewOpen: (open) => asked.push(open) }));
    expect(find(open, "lab.open").title).toBe("Close Review");
    expect(find(open, "overflow.toggle").title).toBe("Open Overflow");
    find(open, "lab.open").run();
    expect(asked).toEqual([true, false]);

    expect(GROUPS).toContain("Review");
    expect(GROUPS).not.toContain("Lab");
  });

  it("lists ⌥↩'s ghost or rewrite for the mark at the caret", () => {
    const ran: string[] = [];
    const find = (state: EditorState) =>
      buildCommands(ctx(state, {}, { firstAction: () => ran.push("first") })).find((c) => c.id === "lab.firstAction");
    let state = stateFor("It is really done.\n").update(setHighlights({ on: true })).state;
    state = state.update({ selection: EditorSelection.cursor(8) }).state;
    expect(find(state)).toMatchObject({ group: "Review", title: "Ghost it", shortcut: "⌥↩" });
    find(state)!.run();
    expect(ran).toEqual(["first"]);
    // A suggestion has its own entry, "Use the fix".
    state = stateFor("She walked slowly home.\n").update(setHighlights({ on: true })).state;
    expect(find(state.update({ selection: EditorSelection.cursor(6) }).state)).toBeUndefined();
  });

  it("ghosts the selection through the app, which says why when it can't", () => {
    const ran: string[] = [];
    const state = stateFor("one {{two words|deux mots}} three\n").update({ selection: EditorSelection.range(4, 7) }).state;
    const entry = buildCommands(ctx(state, {}, { ghost: () => ran.push("ghost") })).find((c) => c.id === "ghost.add")!;
    entry.run();
    expect(ran).toEqual(["ghost"]);
  });

  it("finds writing issues, and offers the fix at the caret", () => {
    const ran: string[] = [];
    const find = (commands: PaletteCommand[], id: string) => commands.find((c) => c.id === id);
    const actions = { findIssues: () => ran.push("find"), useFix: () => ran.push("fix") };
    let state = stateFor("Rest will help yourself relax.\n").update(setHighlights({ on: true })).state;
    expect(find(buildCommands(ctx(state, {}, actions)), "lab.issues")).toMatchObject({ group: "Review", title: "Find writing issues" });
    expect(find(buildCommands(ctx(state, {}, actions)), "lab.useFix")).toBeUndefined();

    state = state.update(setWritingIssues([{ from: 15, to: 23, kind: "grammar", note: "Use “you”.", fix: "you" }])).state;
    state = state.update({ selection: EditorSelection.cursor(17) }).state;
    const commands = buildCommands(ctx(state, {}, actions));
    expect(find(commands, "lab.useFix")).toMatchObject({ group: "Review", title: "Use the fix: “you”" });
    find(commands, "lab.issues")!.run();
    find(commands, "lab.useFix")!.run();
    expect(ran).toEqual(["find", "fix"]);
  });
});
