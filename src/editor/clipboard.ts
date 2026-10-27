import { EditorSelection, EditorState, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { rangeMarkdown, union } from "./commands";
import { newId, parseInline, Span } from "./format";
import { layersOf, mapLayers, setLayers } from "./layers";

// Copy, cut and paste keep alternatives and ghosts. Other apps get the
// plain text, which is standard Markdown. Undertext also gets the selection
// with its layers, in a private clipboard type. Some webviews drop private
// types, so the last copy is also kept here and matched by its text.

const MIME = "application/x-undertext";
let lastCopy: { text: string; md: string } | null = null;

/** The range as Undertext Markdown, with the layers inside it. Null when it holds none. */
export function sliceMarkdown(state: EditorState, from: number, to: number): string | null {
  const l = layersOf(state);
  const has = l.alts.some((a) => a.from >= from && a.to <= to) || l.ghosts.some((g) => g.from < to && g.to > from);
  return has ? rangeMarkdown(state, from, to) : null;
}

/** Replaces `from..to` with Undertext Markdown, bringing its layers in with new ids. */
export function insertMarkdown(state: EditorState, from: number, to: number, md: string): TransactionSpec {
  const slice = parseInline(md);
  const changes = state.changes({ from, to, insert: slice.text });
  const mapped = mapLayers(layersOf(state), changes);
  const shift = <T extends Span>(r: T): T => ({ ...r, from: r.from + from, to: r.to + from });
  // An alternative can't hold another, so a pasted one inside an alternative keeps only its words.
  const pasted = slice.alts.map((a) => ({ ...shift(a), id: newId() }));
  const inside = (a: Span) => mapped.alts.some((m) => m.from < a.to && m.to > a.from);
  const alts = [...mapped.alts, ...pasted.filter((a) => !inside(a))].sort((a, b) => a.from - b.from);
  // A ghost on part of an alternative isn't saved, so a pasted one there is left out.
  const cuts = (g: Span) => alts.some((a) => a.from < g.to && a.to > g.from && (a.from < g.from || a.to > g.to));
  return {
    changes,
    effects: setLayers.of({
      ...mapped,
      alts,
      ghosts: union([...mapped.ghosts, ...slice.ghosts.map(shift).filter((g) => !cuts(g))]),
    }),
    selection: EditorSelection.cursor(from + slice.text.length),
    scrollIntoView: true,
    userEvent: "input.paste",
  };
}

function writeClipboard(e: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  const { state } = view;
  const { from, to, empty } = state.selection.main;
  if (empty || !e.clipboardData || state.selection.ranges.length > 1) return false;
  const md = sliceMarkdown(state, from, to);
  if (md === null) {
    lastCopy = null;
    return false;
  }
  const text = state.doc.sliceString(from, to);
  lastCopy = { text, md };
  e.clipboardData.setData("text/plain", text);
  e.clipboardData.setData(MIME, md);
  e.preventDefault();
  if (cut) {
    view.dispatch({
      changes: { from, to },
      selection: EditorSelection.cursor(from),
      scrollIntoView: true,
      userEvent: "delete.cut",
    });
  }
  return true;
}

export const clipboard = EditorView.domEventHandlers({
  copy: (e, view) => writeClipboard(e, view, false),
  cut: (e, view) => writeClipboard(e, view, true),
  paste(e, view) {
    const data = e.clipboardData;
    const text = data?.getData("text/plain") ?? "";
    const md = data?.getData(MIME) || (lastCopy && lastCopy.text === text ? lastCopy.md : "");
    if (!md || view.state.selection.ranges.length > 1) return false;
    e.preventDefault();
    const { from, to } = view.state.selection.main;
    view.dispatch(insertMarkdown(view.state, from, to, md));
    return true;
  },
});
