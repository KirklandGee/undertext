import { EditorSelection, EditorState, StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { deleteSpans } from "./commands";
import { Span } from "./format";
import { layersOf, setLayers } from "./layers";

// The Lab layer: temporary results from a check or a trim. Nothing here is
// saved to the file or changes the text until you act on it.
//
// - marks: spans with a reason ("Hedge: softens the claim").
// - cuts:  spans a trim proposes to delete, shown faded. Click one to keep it.

export interface LabSpan extends Span {
  reason?: string;
}

export interface LabMeta {
  /** What produced the layer, e.g. "Hedges and filler" or "Slight trim". */
  label: string;
  /** For trims: target share of words to cut. */
  percent?: number;
}

interface LabState {
  kind: "marks" | "cuts" | null;
  meta: LabMeta | null;
  set: DecorationSet;
}

type LabAction =
  | { type: "set"; kind: "marks" | "cuts"; meta: LabMeta; spans: LabSpan[] }
  | { type: "remove"; from: number; to: number }
  | { type: "clear" };

const labEffect = StateEffect.define<LabAction>();
const empty: LabState = { kind: null, meta: null, set: Decoration.none };

export const labField = StateField.define<LabState>({
  create: () => empty,
  update(prev, tr) {
    const action = tr.effects.find((e) => e.is(labEffect))?.value as LabAction | undefined;
    if (action?.type === "clear") return empty;
    if (action?.type === "set") {
      const decos = action.spans.map((s) =>
        Decoration.mark(
          action.kind === "marks"
            ? { class: "lab-mark", attributes: { title: s.reason ?? "" }, reason: s.reason }
            : { class: "lab-cut", attributes: { title: "Proposed cut. Click to keep it." } },
        ).range(s.from, s.to),
      );
      return { kind: action.kind, meta: action.meta, set: Decoration.set(decos, true) };
    }
    if (!prev.kind) return prev;

    let set = prev.set.map(tr.changes);
    if (action?.type === "remove") set = set.update({ filter: (f, t) => !(f === action.from && t === action.to) });
    // Editing inside a mark or cut drops it: the text it described is gone.
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      set = set.update({ filter: (f, t) => !(f < toB && t > fromB) });
    });
    return set.size ? { ...prev, set } : empty;
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.set),
});

export function labState(state: EditorState): LabState {
  return state.field(labField, false) ?? empty;
}

/** Marks or cuts in document order. */
export function labSpans(state: EditorState): LabSpan[] {
  const out: LabSpan[] = [];
  const iter = labState(state).set.iter();
  for (; iter.value; iter.next()) out.push({ from: iter.from, to: iter.to, reason: iter.value.spec.reason });
  return out;
}

export function labSpanAt(state: EditorState, pos: number, kind?: "marks" | "cuts"): LabSpan | null {
  const lab = labState(state);
  if (!lab.kind || (kind && lab.kind !== kind)) return null;
  return labSpans(state).find((s) => s.from <= pos && pos <= s.to) ?? null;
}

export const setLab = (kind: "marks" | "cuts", meta: LabMeta, spans: LabSpan[]): TransactionSpec => ({
  effects: labEffect.of({ type: "set", kind, meta, spans }),
});

export const clearLab = (): TransactionSpec => ({ effects: labEffect.of({ type: "clear" }) });

export const keepCut = (span: LabSpan): TransactionSpec => ({
  effects: labEffect.of({ type: "remove", from: span.from, to: span.to }),
});

/** Moves the caret to the next or previous mark or cut. Returns null when there is none. */
export function jumpToLabSpan(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  const spans = labSpans(state);
  if (!spans.length) return null;
  const head = state.selection.main.head;
  let index = dir > 0 ? spans.findIndex((s) => s.from > head) : spans.findLastIndex((s) => s.from < head);
  if (index < 0) index = dir > 0 ? 0 : spans.length - 1;
  return { selection: EditorSelection.cursor(spans[index].from), scrollIntoView: true };
}

/** Applies every proposed cut: deletes it, and avoids leaving a double space behind. */
export function makeCuts(state: EditorState): TransactionSpec | null {
  const spans = labSpans(state);
  if (!spans.length) return null;
  return { changes: deleteSpans(state, spans), effects: labEffect.of({ type: "clear" }) };
}

/** Turns marks or proposed cuts into ordinary ghosts, which are saved with the file. */
export function ghostLabSpans(state: EditorState): TransactionSpec | null {
  const spans = labSpans(state);
  if (!spans.length) return null;
  const l = layersOf(state);
  const ghosts = [...l.ghosts, ...spans.map(({ from, to }) => ({ from, to }))].sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const g of ghosts) {
    const last = merged[merged.length - 1];
    if (last && g.from <= last.to) last.to = Math.max(last.to, g.to);
    else merged.push({ ...g });
  }
  return { effects: [setLayers.of({ ...l, ghosts: merged }), labEffect.of({ type: "clear" })] };
}

/** Clicking a proposed cut keeps that text. */
const keepOnClick = EditorView.domEventHandlers({
  click(e, view) {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const cut = pos === null ? null : labSpanAt(view.state, pos, "cuts");
    if (!cut) return false;
    view.dispatch(keepCut(cut));
    return true;
  },
});

export const lab = [labField, keepOnClick];
