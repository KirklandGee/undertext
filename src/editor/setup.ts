import { baseKeymap } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Node } from "prosemirror-model";
import { Command, EditorState } from "prosemirror-state";
import { serializeInline } from "./markdown";
import {
  altInSelection,
  continueList,
  countWords,
  paragraphAt,
  toggleGhost,
  wordRangeAt,
} from "./commands";
import { keepCut, labPlugin, labSpanAt, labState } from "./lab";
import { altDotsPlugin, caretPlugin, cyclingPlugin, decorationsPlugin, dedupePlugin, targetPlugin } from "./plugins";
import { schema } from "./schema";

export interface EditorHandlers {
  alternatives(): void;
  aiAlternatives(): void;
  lab(): void;
  stash(): void;
  fork(): void;
  escape(): boolean;
}

/** ⌘/ on a proposed cut keeps the text. Anywhere else it ghosts or revives. */
const ghostOrKeep: Command = (state, dispatch) => {
  const cut = labSpanAt(state, state.selection.from, "cuts");
  if (cut) {
    dispatch?.(keepCut(state.tr, cut));
    return true;
  }
  return toggleGhost(state, dispatch);
};

const hardBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
  return true;
};

export function createState(doc: Node, handlers: () => EditorHandlers): EditorState {
  const call = (fn: keyof EditorHandlers): Command => () => {
    const result = handlers()[fn]();
    return result !== false;
  };
  return EditorState.create({
    doc,
    plugins: [
      cyclingPlugin,
      keymap({
        "Mod-z": undo,
        "Shift-Mod-z": redo,
        "Mod-y": redo,
        "Mod-/": ghostOrKeep,
        Enter: continueList,
        "Shift-Enter": hardBreak,
        "Shift-Mod-a": call("alternatives"),
        "Shift-Mod-g": call("aiAlternatives"),
        "Shift-Mod-x": call("stash"),
        "Shift-Mod-d": call("fork"),
        Escape: call("escape"),
      }),
      keymap(baseKeymap),
      history(),
      dropCursor({ color: "var(--accent)", width: 2 }),
      decorationsPlugin,
      altDotsPlugin,
      targetPlugin,
      labPlugin,
      caretPlugin,
      dedupePlugin,
    ],
  });
}

// ---------------------------------------------------------------------------
// Snapshot of the editor that the React chrome needs

export interface EditorInfo {
  words: number;
  chars: number;
  alt: { id: string; variants: string[]; active: number; ai: string[] } | null;
  candidate: { from: number; to: number; text: string } | null;
  para: { pos: number; variants: string[]; active: number } | null;
  lab: {
    kind: "marks" | "cuts";
    label: string;
    percent?: number;
    count: number;
    /** The reason of the mark under the caret, if any. */
    here: string | null;
  } | null;
}

let lastDoc: Node | null = null;
let lastCount = { words: 0, chars: 0 };

export function describe(state: EditorState): EditorInfo {
  if (state.doc !== lastDoc) {
    lastDoc = state.doc;
    lastCount = countWords(state.doc);
  }

  const r = altInSelection(state);
  const alt = r
    ? (() => {
        const variants: string[] = [...r.mark.attrs.variants];
        variants[r.mark.attrs.active] = state.doc.textBetween(r.from, r.to);
        return {
          id: r.mark.attrs.id as string,
          variants,
          active: r.mark.attrs.active as number,
          ai: (r.mark.attrs.ai ?? []) as string[],
        };
      })()
    : null;

  let candidate: EditorInfo["candidate"] = null;
  if (!alt) {
    const { from, to, empty, $from, $to } = state.selection;
    const range = empty ? wordRangeAt(state.doc, from) : $from.sameParent($to) ? { from, to } : null;
    const text = range ? state.doc.textBetween(range.from, range.to, undefined, "\n").trim() : "";
    if (range && text && !text.includes("\n")) candidate = { ...range, text };
  }

  const p = paragraphAt(state);
  let para: EditorInfo["para"] = null;
  if (p) {
    const current = serializeInline(p.node.content);
    const stored: string[] | null = p.node.attrs.variants;
    const variants = stored ? [...stored] : [current];
    const active = stored ? (p.node.attrs.active as number) : 0;
    variants[active] = current;
    para = { pos: p.pos, variants, active };
  }

  const ls = labState(state);
  const lab = ls.kind
    ? {
        kind: ls.kind,
        label: ls.meta?.label ?? "",
        percent: ls.meta?.percent,
        count: ls.set.find().length,
        here: labSpanAt(state, state.selection.from)?.reason ?? null,
      }
    : null;

  return { ...lastCount, alt, candidate, para, lab };
}
