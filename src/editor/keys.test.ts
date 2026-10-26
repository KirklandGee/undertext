import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, StateCommand } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { parsePage, serializePage } from "./format";
import { backspace, enter, setHeading, toggleBold, toggleItalic, toggleLink, toggleList } from "./keys";
import { layersOf } from "./layers";
import { createEditorState } from "./setup";

// In these strings `‸` is the caret, and `«` `»` wrap a selection.

function stateFor(marked: string): EditorState {
  const text = marked.replace(/[‸«»]/g, "");
  const caret = marked.indexOf("‸");
  const selection =
    caret >= 0 ? EditorSelection.cursor(caret) : EditorSelection.range(marked.indexOf("«"), marked.indexOf("»") - 1);
  return createEditorState(text, { alts: [], ghosts: [], versions: [] }).update({ selection }).state;
}

const show = (state: EditorState) => {
  const { from, to, empty } = state.selection.main;
  const text = state.doc.toString();
  return empty ? `${text.slice(0, from)}‸${text.slice(from)}` : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`;
};

const run = (state: EditorState, cmd: StateCommand) => {
  let next = state;
  cmd({ state, dispatch: (tr) => (next = tr.state) });
  return { state: next, text: show(next) };
};

/** A stand-in view: enough for commands that only read state and dispatch. */
const runView = (state: EditorState, cmd: (view: EditorView) => boolean) => {
  let next = state;
  const view = { state, dispatch: (spec: object) => (next = state.update(spec).state) } as unknown as EditorView;
  cmd(view);
  return show(next);
};

describe("Enter", () => {
  it("starts a new paragraph", () => {
    expect(run(stateFor("One two‸"), enter).text).toBe("One two\n\n‸");
    expect(run(stateFor("One ‸two"), enter).text).toBe("One\n\n‸two");
  });

  it("continues a list and ends it on an empty item", () => {
    expect(run(stateFor("- a‸"), enter).text).toBe("- a\n- ‸");
    expect(run(stateFor("1. a‸\n2. b"), enter).text).toBe("1. a\n2. ‸\n3. b");
    expect(run(stateFor("- a\n- ‸"), enter).text).toBe("- a\n\n‸");
    expect(run(stateFor("- a\n- ‸\n- b"), enter).text).toBe("- a\n\n‸\n\n- b");
  });

  it("moves a paragraph's versions down with its text", () => {
    const page = parsePage(":::alt\nA.\n:::or*\nB.\n:::\n");
    const state = createEditorState(page.text, page).update({ selection: EditorSelection.cursor(0) }).state;
    const next = run(state, enter).state;
    expect(next.doc.toString()).toBe("\n\nB.");
    expect(layersOf(next).versions[0].at).toBe(2);
  });
});

describe("Enter in a list", () => {
  it("starts the next numbered item on the next line", () => {
    expect(run(stateFor("1. First list item‸"), enter).text).toBe("1. First list item\n2. ‸");
  });

  it.each([
    ["- a‸", "- a\n- ‸"],
    ["  * a‸", "  * a\n  * ‸"],
    ["9) a‸", "9) a\n10) ‸"],
  ])("continues %j", (before, after) => {
    expect(run(stateFor(before), enter).text).toBe(after);
  });

  it.each([
    ["1. one‸ two", "1. one\n2. ‸two"],
    ["- one ‸  two", "- one\n- ‸two"],
    ["1. a‸ ", "1. a\n2. ‸"],
    ["> a‸ b", "> a\n> ‸b"],
    ["- one‸\t two", "- one\n- ‸two"],
  ])("splits %j without stray spaces", (before, after) => {
    expect(run(stateFor(before), enter).text).toBe(after);
  });

  it.each([
    ["1.‸ a", "1.\n2. ‸ a"],
    ["- [ ]‸ a", "- [ ]\n- [ ] ‸ a"],
    [">‸ a", ">\n> ‸ a"],
  ])("keeps the space that ends the marker in %j", (before, after) => {
    expect(run(stateFor(before), enter).text).toBe(after);
  });

  it("undoes a split in one step, apart from the typing before it", () => {
    const typed = stateFor("1. on‸ two").update({
      changes: { from: 5, insert: "e" },
      selection: EditorSelection.cursor(6),
      userEvent: "input.type",
    }).state;
    const split = run(typed, enter);
    expect(split.text).toBe("1. one\n2. ‸two");
    expect(run(split.state, undo).text).toBe("1. one‸ two");
  });

  it("moves a ghost that starts at the caret into the new item", () => {
    const page = parsePage("1. Cut this{- , frankly,-} now.\n");
    const state = createEditorState(page.text, page).update({ selection: EditorSelection.cursor(11) }).state;
    const save = (s: EditorState) => serializePage({ text: s.doc.toString(), ...layersOf(s), overflow: "" });
    const split = run(state, enter).state;
    expect(save(split)).toBe("1. Cut this\n2. {-, frankly,-} now.\n");
    const undone = run(split, undo).state;
    expect(save(undone)).toBe("1. Cut this{- , frankly,-} now.\n");
    expect(save(run(undone, redo).state)).toBe("1. Cut this\n2. {-, frankly,-} now.\n");
  });

  it("leaves a selection to the default Enter", () => {
    expect(enter({ state: stateFor("- one «two» three"), dispatch: () => {} })).toBe(false);
  });

  it("renumbers the items below", () => {
    expect(run(stateFor("1. a‸\n2. b\n3. c"), enter).text).toBe("1. a\n2. ‸\n3. b\n4. c");
    expect(run(stateFor("8. a‸\n9. b"), enter).text).toBe("8. a\n9. ‸\n10. b");
  });

  it("renumbers past nested lines and stops at the end of the list", () => {
    expect(run(stateFor("1. a‸\n   - x\n2. b"), enter).text).toBe("1. a\n2. ‸\n   - x\n3. b");
    expect(run(stateFor("1. a‸\n2) b"), enter).text).toBe("1. a\n2. ‸\n2) b");
  });

  it("drops an empty item and leaves a paragraph to type in", () => {
    expect(run(stateFor("1. a\n2. ‸"), enter).text).toBe("1. a\n\n‸");
    expect(run(stateFor("1. a\n2. ‸ "), enter).text).toBe("1. a\n\n‸");
    expect(run(stateFor("- a\n- ‸ \n- b"), enter).text).toBe("- a\n\n‸\n\n- b");
  });

  it("leaves plain text and the marker itself alone", () => {
    expect(run(stateFor("Just‸ text"), enter).text).toBe("Just\n\n‸text");
    expect(run(stateFor("1.5‸ million"), enter).text).toBe("1.5\n\n‸million");
    expect(run(stateFor("1‸. a"), enter).text).toBe("1‸. a");
    expect(enter({ state: stateFor("1‸. a"), dispatch: () => {} })).toBe(false);
  });
});

describe("Backspace", () => {
  it("joins a paragraph to the one above", () => {
    expect(runView(stateFor("One.\n\n‸Two."), backspace)).toBe("One.‸Two.");
  });

  it("deletes one character elsewhere", () => {
    expect(runView(stateFor("One.\n\nTw‸o."), backspace)).toBe("One.\n\nT‸o.");
  });
});

describe("formatting", () => {
  it("wraps and unwraps a selection", () => {
    const wrapped = run(stateFor("a «word» here"), toggleBold);
    expect(wrapped.text).toBe("a **«word»** here");
    expect(run(wrapped.state, toggleBold).text).toBe("a «word» here");
  });

  it("unwraps from a cursor inside, and wraps the word at the cursor", () => {
    expect(run(stateFor("a **wo‸rd** here"), toggleBold).text).toBe("a wo‸rd here");
    expect(run(stateFor("a wo‸rd here"), toggleItalic).text).toBe("a *wo‸rd* here");
  });

  it("keeps markers next to the text", () => {
    expect(run(stateFor("a« word »here"), toggleBold).text).toBe("a **«word»** here");
  });

  it("makes and removes a link", () => {
    expect(run(stateFor("see «this» page"), toggleLink).text).toBe("see [this](‸) page");
    expect(run(stateFor("see [th‸is](https://x.y) page"), toggleLink).text).toBe("see th‸is page");
  });
});

describe("headings and lists", () => {
  it("sets, changes, and removes a heading", () => {
    const h2 = run(stateFor("Ti‸tle"), setHeading(2));
    expect(h2.text).toBe("## Ti‸tle");
    expect(run(h2.state, setHeading(1)).text).toBe("# Ti‸tle");
    expect(run(h2.state, setHeading(2)).text).toBe("Ti‸tle");
    expect(run(stateFor("- Ti‸tle"), setHeading(1)).text).toBe("# Ti‸tle");
  });

  it("makes lines a list, and back", () => {
    const bullets = run(stateFor("«one\ntwo»"), toggleList("bullet"));
    expect(bullets.text).toBe("- «one\n- two»");
    expect(run(bullets.state, toggleList("bullet")).text).toBe("«one\ntwo»");
    expect(run(bullets.state, toggleList("ordered")).text).toBe("1. «one\n2. two»");
    expect(run(stateFor("  - o‸ne"), toggleList("task")).text).toBe("  - [ ] o‸ne");
    expect(run(stateFor("# Ti‸tle"), toggleList("bullet")).text).toBe("- Ti‸tle");
  });

  it("starts a list on an empty line and skips blank lines in a selection", () => {
    expect(run(stateFor("‸"), toggleList("bullet")).text).toBe("- ‸");
    expect(run(stateFor("«a\n\nb»"), toggleList("ordered")).text).toBe("1. «a\n\n2. b»");
  });
});
