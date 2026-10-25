import { history, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  addAltVariant,
  countWords,
  createAlt,
  cycleAlt,
  cycleAtCaret,
  deleteGhosts,
  findAlt,
  forkVersion,
  jumpToItem,
  removeAltVariant,
  settleAll,
  setVersionActive,
  startsWithVowelSound,
  toggleGhost,
  versionedItems,
} from "./commands";
import { parsePage, serializePage } from "./format";
import { layers, layersOf } from "./layers";

const stateFor = (md: string) => {
  const page = parsePage(md);
  return EditorState.create({ doc: page.text, extensions: [history(), layers(page)] });
};

const save = (state: EditorState) => serializePage({ text: state.doc.toString(), ...layersOf(state), overflow: "" });
const apply = (state: EditorState, spec: TransactionSpec | null) => {
  expect(spec).not.toBeNull();
  return state.update(spec!).state;
};
const run = (state: EditorState, cmd: typeof undo) => {
  let next = state;
  cmd({ state, dispatch: (tr) => (next = tr.state) });
  return next;
};
const at = (state: EditorState, needle: string) => state.doc.toString().indexOf(needle);
const select = (state: EditorState, from: number, to = from) =>
  state.update({ selection: EditorSelection.range(from, to) }).state;
const altIdAt = (state: EditorState, needle: string) =>
  layersOf(state).alts.find((a) => a.from <= at(state, needle) && at(state, needle) < a.to)!.id;

describe("alternatives", () => {
  it("creates, adds, cycles, and removes", () => {
    let state = stateFor("Much of the tension comes from here.\n");
    const created = createAlt(state, at(state, "tension"), at(state, "tension") + 7)!;
    state = apply(state, created.spec);
    state = apply(state, addAltVariant(state, created.id, "pressure"));
    expect(state.doc.toString()).toBe("Much of the pressure comes from here.");
    state = apply(state, cycleAlt(state, created.id, 1));
    expect(state.doc.toString()).toBe("Much of the tension comes from here.");
    expect(save(state)).toBe("Much of the {{tension|pressure}} comes from here.\n");
    state = apply(state, removeAltVariant(state, created.id, 1));
    expect(save(state)).toBe("Much of the tension comes from here.\n");
  });

  it("keeps in-place edits of the active variant", () => {
    let state = stateFor("the {{tension|>struggle}} here\n");
    const id = altIdAt(state, "struggle");
    const pos = at(state, "struggle") + "struggle".length - 1;
    state = state.update({ changes: { from: pos, insert: "s" } }).state;
    state = apply(state, cycleAlt(state, id, 1));
    state = apply(state, cycleAlt(state, id, 1));
    expect(state.doc.toString()).toBe("the strugglse here");
  });

  it("takes letters typed at its end, but not a space or text at its start", () => {
    let state = stateFor("an {{elephant|owl}} here\n");
    const alt = () => layersOf(state).alts[0];
    const type = (pos: number, text: string) =>
      (state = state.update({ changes: { from: pos, insert: text }, userEvent: "input.type" }).state);
    type(alt().to, "s");
    expect(save(state)).toBe("an {{elephants|owl}} here\n");
    type(alt().to, " ");
    type(alt().to + 1, "big");
    type(alt().from, "x");
    expect(save(state)).toBe("an x{{elephants|owl}} big here\n");
  });

  it("doesn't grow when a change lands at its edges", () => {
    let state = stateFor("a {{b|c}} d\n");
    const alt = layersOf(state).alts[0];
    state = state.update({ changes: [{ from: alt.from, insert: "x" }, { from: alt.to, insert: "y" }] }).state;
    expect(save(state)).toBe("a x{{b|c}}y d\n");
  });

  it("fixes a/an", () => {
    let state = stateFor("like a {{paperclip|eraser|thumbtack}} for example\n");
    const id = altIdAt(state, "paperclip");
    state = apply(state, cycleAlt(state, id, 1));
    expect(state.doc.toString()).toBe("like an eraser for example");
    state = apply(state, cycleAlt(state, id, 1));
    expect(state.doc.toString()).toBe("like a thumbtack for example");
    expect(startsWithVowelSound("hour")).toBe(true);
    expect(startsWithVowelSound("user")).toBe(false);
  });

  it("gives each part of a split alternative its own id", () => {
    let state = stateFor("say {{hello world|hi}} now\n");
    state = state.update({ changes: { from: at(state, " world"), to: at(state, " world") + 1, insert: "\n" } }).state;
    const ids = layersOf(state).alts.map((a) => a.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("undo", () => {
  it("undoes and redoes a cycle", () => {
    let state = stateFor("the {{tension|pressure}} here\n");
    const id = altIdAt(state, "tension");
    state = apply(state, cycleAlt(state, id, 1));
    expect(save(state)).toBe("the {{tension|>pressure}} here\n");
    state = run(state, undo);
    expect(save(state)).toBe("the {{tension|pressure}} here\n");
    state = run(state, redo);
    expect(save(state)).toBe("the {{tension|>pressure}} here\n");
  });

  it("brings back an alternative whose text was deleted", () => {
    let state = stateFor("one {{two|deux}} three\n");
    state = state.update({ changes: { from: 0, to: state.doc.length } }).state;
    expect(layersOf(state).alts).toEqual([]);
    state = run(state, undo);
    expect(save(state)).toBe("one {{two|deux}} three\n");
  });

  it("restores an alternative after typing over its end", () => {
    let state = stateFor("one {{two|deux}} three\n");
    const end = at(state, " three");
    state = state.update({ changes: { from: end - 2, to: end + 3, insert: "X" } }).state;
    state = run(state, undo);
    expect(save(state)).toBe("one {{two|deux}} three\n");
  });

  it("undoes a ghost toggle", () => {
    let state = select(stateFor("one two three\n"), 4, 7);
    state = run(state, toggleGhost);
    expect(save(state)).toBe("one {-two-} three\n");
    state = run(state, undo);
    expect(save(state)).toBe("one two three\n");
  });

  it("undoes typing far from any layer without touching the layers", () => {
    let state = stateFor("{{a|b}} and some words\n");
    state = state.update({ changes: { from: state.doc.length, insert: " more" } }).state;
    state = run(state, undo);
    expect(save(state)).toBe("{{a|b}} and some words\n");
  });
});

describe("paragraph versions", () => {
  it("forks, edits in place, and switches", () => {
    let state = stateFor("Original paragraph.\n");
    state = apply(state, forkVersion(state, 0));
    state = state.update({ changes: { from: state.doc.length, insert: " Edited." } }).state;
    expect(save(state)).toBe(":::alt\nOriginal paragraph.\n:::or*\nOriginal paragraph. Edited.\n:::\n");
    state = apply(state, setVersionActive(state, 0, 0));
    expect(state.doc.toString()).toBe("Original paragraph.");
    state = run(state, undo);
    expect(state.doc.toString()).toBe("Original paragraph. Edited.");
  });

  it("brings in the layers of the version it switches to", () => {
    let state = stateFor("Intro.\n\n:::alt\nOld {-faint-}.\n:::or*\nNew {{word|term}}.\n:::\n");
    state = apply(state, setVersionActive(state, 8, 0));
    expect(state.doc.toString()).toBe("Intro.\n\nOld faint.");
    expect(layersOf(state).ghosts).toEqual([{ from: 12, to: 17 }]);
    expect(save(state)).toBe("Intro.\n\n:::alt*\nOld {-faint-}.\n:::or\nNew {{word|term}}.\n:::\n");
  });

  it("drops a version when its paragraph joins the one above", () => {
    let state = stateFor("Above.\n\n:::alt\nA.\n:::or\nB.\n:::\n");
    state = state.update({ changes: { from: 6, to: 8 } }).state;
    expect(layersOf(state).versions).toEqual([]);
    state = run(state, undo);
    expect(layersOf(state).versions).toHaveLength(1);
  });
});

describe("keyboard navigation", () => {
  const md = "Start {{one|uno}} here.\n\nPlain paragraph.\n\n:::alt\n{{two|dos}} and more.\n:::or\nOther version.\n:::\n";

  it("lists items in order, paragraph before its words", () => {
    expect(versionedItems(stateFor(md)).map((i) => i.kind)).toEqual(["alt", "para", "alt"]);
  });

  it("jumps forward and back with wrap-around", () => {
    let state = stateFor(md);
    const items = versionedItems(state);
    let last: number | null = null;
    const jump = (dir: 1 | -1) => {
      const r = jumpToItem(state, dir, last)!;
      state = apply(state, r.spec);
      last = r.index;
      return state.selection.main.head;
    };
    expect(jump(1)).toBe(items[0].from);
    expect(jump(1)).toBe(items[1].from);
    expect(jump(1)).toBe(items[2].from);
    expect(jump(1)).toBe(items[0].from);
    expect(jump(-1)).toBe(items[2].from);
  });

  it("cycles the word at the caret before its paragraph", () => {
    let state = select(stateFor(md), 7);
    state = apply(state, cycleAtCaret(state, 1));
    expect(state.doc.line(1).text).toBe("Start uno here.");
    state = select(state, at(state, "Plain") + 1);
    expect(cycleAtCaret(state, 1)).toBeNull();
  });
});

describe("ghosts and counting", () => {
  it("excludes ghosted words from the count", () => {
    const state = stateFor("one two {-three-} four\n");
    expect(countWords(state).words).toBe(3);
  });

  it("deletes ghosted text without leaving double spaces", () => {
    let state = stateFor("Keep this. {-Maybe cut.-} Keep that.\n");
    state = apply(state, deleteGhosts(state));
    expect(state.doc.toString()).toBe("Keep this. Keep that.");
  });

  it("accepts all current choices and keeps ghosts", () => {
    let state = stateFor("A {{one|>uno}} word. {-gone-}\n\n:::alt\nFirst.\n:::or*\nSecond.\n:::\n");
    state = apply(state, settleAll(state));
    expect(save(state)).toBe("A uno word. {-gone-}\n\nSecond.\n");
    expect(findAlt(state, "x")).toBeNull();
  });
});
