import { history, historyKeymap, insertNewline, standardKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Prec } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap } from "@codemirror/view";
import { cycleAtCaret, cycleVersionAtCaret, jumpToItem, toggleGhost } from "./commands";
import { Layers, MARKDOWN_EXTENSIONS } from "./format";
import { backspace, enter, toggleBold, toggleCode, toggleItalic, toggleLink } from "./keys";
import { layers } from "./layers";
import { livePreview } from "./preview";

// ⌥J/⌥K cycle, ⌥⇧J/⌥⇧K cycle paragraph versions, ⌥L/⌥H jump between items.
// Match the physical key: Option changes e.key (⌥J types ∆). These keys are
// always consumed, so a stray ∆ never lands in the text.
let lastJump: number | null = null;
const optionKeys = EditorView.domEventHandlers({
  keydown(e, view) {
    if (!e.altKey || e.metaKey || e.ctrlKey) return false;
    if (e.code === "KeyJ" || e.code === "KeyK") {
      const dir = e.code === "KeyJ" ? 1 : -1;
      const spec = e.shiftKey ? cycleVersionAtCaret(view.state, dir) : cycleAtCaret(view.state, dir);
      if (spec) view.dispatch(spec, { scrollIntoView: true });
    } else if ((e.code === "KeyL" || e.code === "KeyH") && !e.shiftKey) {
      const jump = jumpToItem(view.state, e.code === "KeyL" ? 1 : -1, lastJump);
      if (jump) {
        view.dispatch(jump.spec);
        lastJump = jump.index;
      }
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  },
});

const theme = EditorView.theme({
  "&": { color: "inherit", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "visible" },
  ".cm-content": { padding: "0", caretColor: "transparent" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)", marginLeft: "-1px" },
});

export function createEditorState(text: string, initial: Layers): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      history(),
      drawSelection({ cursorBlinkRate: 1060 }),
      dropCursor(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ spellcheck: "true" }),
      EditorView.editorAttributes.of({ class: "page-text" }),
      markdown({ extensions: MARKDOWN_EXTENSIONS, addKeymap: false, completeHTMLTags: false }),
      layers(initial),
      livePreview,
      optionKeys,
      Prec.high(
        keymap.of([
          { key: "Enter", run: enter },
          { key: "Shift-Enter", run: insertNewline },
          { key: "Backspace", run: backspace },
          { key: "Mod-b", run: toggleBold },
          { key: "Mod-i", run: toggleItalic },
          { key: "Mod-e", run: toggleCode },
          { key: "Shift-Mod-k", run: toggleLink },
          { key: "Mod-/", run: toggleGhost },
        ]),
      ),
      keymap.of([...historyKeymap, ...standardKeymap]),
      theme,
    ],
  });
}
