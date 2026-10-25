import { history, historyKeymap, insertNewline, standardKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Prec, StateCommand } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap } from "@codemirror/view";
import { clipboard } from "./clipboard";
import {
  altInSelection,
  blockAt,
  countWords,
  cycleAtCaret,
  cycleVersionAtCaret,
  jumpToItem,
  rangeMarkdown,
  syncedVariants,
  toggleGhost,
  versionAt,
  wordRangeAt,
} from "./commands";
import { Layers, MARKDOWN_EXTENSIONS, serializePage } from "./format";
import { inkLayers } from "./ink";
import { backspace, enter, toggleBold, toggleCode, toggleItalic, toggleLink } from "./keys";
import { jumpToLabSpan, keepCut, lab, labSpanAt, labSpans, labState } from "./lab";
import { layers, layersField, layersOf } from "./layers";
import { livePreview } from "./preview";

export interface EditorHandlers {
  alternatives(): void;
  aiAlternatives(): void;
  lab(): void;
  stash(): void;
  fork(): void;
  escape(): boolean;
}

/** ⌘/ on a proposed cut keeps the text. Anywhere else it ghosts or revives. */
const ghostOrKeep: StateCommand = (target) => {
  const { state, dispatch } = target;
  const cut = labSpanAt(state, state.selection.main.from, "cuts");
  if (cut) {
    dispatch(state.update(keepCut(cut)));
    return true;
  }
  return toggleGhost(target);
};

// ⌥J/⌥K cycle, ⌥⇧J/⌥⇧K cycle paragraph versions, ⌥L/⌥H jump between items.
// Match the physical key: Option changes e.key (⌥J types ∆). These keys are
// always consumed, so a stray ∆ never lands in the text.
let lastJump: number | null = null;
const optionKeys = EditorView.domEventHandlers({
  keydown(e, view) {
    if (!e.altKey || e.metaKey || e.ctrlKey) return false;
    const { state } = view;
    if (e.code === "KeyJ" || e.code === "KeyK") {
      const dir = e.code === "KeyJ" ? 1 : -1;
      const spec = e.shiftKey ? cycleVersionAtCaret(state, dir) : cycleAtCaret(state, dir);
      if (spec) view.dispatch(spec, { scrollIntoView: true });
    } else if ((e.code === "KeyL" || e.code === "KeyH") && !e.shiftKey) {
      const dir = e.code === "KeyL" ? 1 : -1;
      // While Lab results are showing, move between them instead.
      const labJump = jumpToLabSpan(state, dir);
      const jump = labJump ? null : jumpToItem(state, dir, lastJump);
      if (labJump) view.dispatch(labJump);
      else if (jump) {
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

export function createEditorState(text: string, initial: Layers, handlers?: () => EditorHandlers): EditorState {
  const call = (fn: keyof EditorHandlers) => () => {
    if (!handlers) return false;
    return handlers()[fn]() !== false;
  };
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
      lab,
      livePreview,
      inkLayers,
      clipboard,
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
          { key: "Mod-/", run: ghostOrKeep },
          { key: "Shift-Mod-a", run: call("alternatives") },
          { key: "Shift-Mod-g", run: call("aiAlternatives") },
          { key: "Shift-Mod-x", run: call("stash") },
          { key: "Shift-Mod-d", run: call("fork") },
          { key: "Escape", run: call("escape") },
        ]),
      ),
      keymap.of([...historyKeymap, ...standardKeymap]),
      theme,
    ],
  });
}

/** The file a save would write. */
export function pageMarkdown(state: EditorState, overflow: string): string {
  return serializePage({ text: state.doc.toString(), ...layersOf(state), overflow });
}

// ---------------------------------------------------------------------------
// Snapshot of the editor that the React chrome needs

export interface EditorInfo {
  words: number;
  chars: number;
  alt: { id: string; variants: string[]; active: number; ai: string[] } | null;
  candidate: { from: number; to: number; text: string } | null;
  /** The paragraph at the caret. `at` is where it starts. */
  para: { at: number; variants: string[]; active: number } | null;
  lab: {
    kind: "marks" | "cuts";
    label: string;
    percent?: number;
    count: number;
    /** The reason of the mark under the caret, if any. */
    here: string | null;
  } | null;
}

let lastCounted: { doc: unknown; layers: unknown; counts: { words: number; chars: number } } | null = null;

export function describe(state: EditorState): EditorInfo {
  const l = state.field(layersField);
  if (!lastCounted || lastCounted.doc !== state.doc || lastCounted.layers !== l) {
    lastCounted = { doc: state.doc, layers: l, counts: countWords(state) };
  }

  const a = altInSelection(state);
  const alt = a ? { id: a.id, variants: syncedVariants(state, a), active: a.active, ai: a.ai } : null;

  let candidate: EditorInfo["candidate"] = null;
  if (!alt) {
    const { from, to, empty } = state.selection.main;
    const range = empty ? wordRangeAt(state, from) : { from, to };
    const text = range ? state.doc.sliceString(range.from, range.to).trim() : "";
    if (range && text && !text.includes("\n")) candidate = { ...range, text };
  }

  let para: EditorInfo["para"] = null;
  const block = blockAt(state);
  if (block) {
    const current = rangeMarkdown(state, block.from, block.to);
    const v = versionAt(state);
    const variants = v ? [...v.variants] : [current];
    const active = v ? v.active : 0;
    variants[active] = current;
    para = { at: block.from, variants, active };
  }

  const ls = labState(state);
  const labInfo = ls.kind
    ? {
        kind: ls.kind,
        label: ls.meta?.label ?? "",
        percent: ls.meta?.percent,
        count: labSpans(state).length,
        here: labSpanAt(state, state.selection.main.from)?.reason ?? null,
      }
    : null;

  return { ...lastCounted.counts, alt, candidate, para, lab: labInfo };
}
