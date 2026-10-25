import { EditorSelection, EditorState, StateCommand } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { parsePage } from "./format";
import { backspace, enter, toggleBold, toggleItalic, toggleLink } from "./keys";
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
