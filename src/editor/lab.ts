import { EditorState, Plugin, PluginKey, TextSelection, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "./schema";

// The Lab layer: temporary results from a check or a trim. Nothing here is
// saved to the file or changes the text until you act on it.
//
// - marks: spans with a reason ("Hedge: softens the claim").
// - cuts:  spans a trim proposes to delete, shown faded. Click one to keep it.

export interface LabSpan {
  from: number;
  to: number;
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

export const labKey = new PluginKey<LabState>("undertext-lab");

const empty: LabState = { kind: null, meta: null, set: DecorationSet.empty };

export const labPlugin = new Plugin<LabState>({
  key: labKey,
  state: {
    init: () => empty,
    apply(tr, prev, _old, state) {
      const action = tr.getMeta(labKey) as LabAction | undefined;
      if (action?.type === "clear") return empty;
      if (action?.type === "set") {
        const decos = action.spans.map((s) =>
          Decoration.inline(
            s.from,
            s.to,
            action.kind === "marks"
              ? { class: "lab-mark", title: s.reason ?? "" }
              : { class: "lab-cut", title: "Proposed cut. Click to keep it." },
            { reason: s.reason },
          ),
        );
        return { kind: action.kind, meta: action.meta, set: DecorationSet.create(state.doc, decos) };
      }
      if (!prev.kind) return prev;

      let set = prev.set.map(tr.mapping, tr.doc);
      if (action?.type === "remove") set = set.remove(set.find(action.from, action.to));
      // Editing inside a mark or cut drops it: the text it described is gone.
      if (tr.docChanged) {
        tr.mapping.maps.forEach((map, i) => {
          map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
            const after = tr.mapping.slice(i + 1);
            const from = after.map(newStart, -1);
            const to = after.map(newEnd, 1);
            set = set.remove(set.find(from, to).filter((d) => d.from < to && d.to > from));
          });
        });
      }
      return set.find().length ? { ...prev, set } : empty;
    },
  },
  props: {
    decorations: (state) => labKey.getState(state)?.set,
    handleClick(view, pos) {
      const cut = labSpanAt(view.state, pos, "cuts");
      if (!cut) return false;
      view.dispatch(keepCut(view.state.tr, cut));
      return true;
    },
  },
});

export function labState(state: EditorState): LabState {
  return labKey.getState(state) ?? empty;
}

/** Marks or cuts in document order. */
export function labSpans(state: EditorState): LabSpan[] {
  return labState(state)
    .set.find()
    .map((d) => ({ from: d.from, to: d.to, reason: d.spec.reason as string | undefined }))
    .sort((a, b) => a.from - b.from);
}

export function labSpanAt(state: EditorState, pos: number, kind?: "marks" | "cuts"): LabSpan | null {
  const lab = labState(state);
  if (!lab.kind || (kind && lab.kind !== kind)) return null;
  const hit = lab.set.find(pos, pos).find((d) => d.from <= pos && pos <= d.to);
  return hit ? { from: hit.from, to: hit.to, reason: hit.spec.reason } : null;
}

export const setLab = (tr: Transaction, kind: "marks" | "cuts", meta: LabMeta, spans: LabSpan[]) =>
  tr.setMeta(labKey, { type: "set", kind, meta, spans } satisfies LabAction);

export const clearLab = (tr: Transaction) => tr.setMeta(labKey, { type: "clear" } satisfies LabAction);

export const keepCut = (tr: Transaction, span: LabSpan) =>
  tr.setMeta(labKey, { type: "remove", from: span.from, to: span.to } satisfies LabAction);

/** Moves the caret to the next or previous mark or cut. Returns null when there is none. */
export function jumpToLabSpan(state: EditorState, dir: 1 | -1): Transaction | null {
  const spans = labSpans(state);
  if (!spans.length) return null;
  const head = state.selection.head;
  let index = dir > 0 ? spans.findIndex((s) => s.from > head) : spans.findLastIndex((s) => s.from < head);
  if (index < 0) index = dir > 0 ? 0 : spans.length - 1;
  const span = spans[index];
  return state.tr.setSelection(TextSelection.create(state.doc, span.from)).scrollIntoView();
}

/** Applies every proposed cut: deletes it, and avoids leaving a double space behind. */
export function makeCuts(state: EditorState): Transaction | null {
  const spans = labSpans(state);
  if (!spans.length) return null;
  const tr = clearLab(state.tr);
  for (const s of [...spans].reverse()) {
    const $from = state.doc.resolve(s.from);
    const before = s.from > $from.start() ? state.doc.textBetween(s.from - 1, s.from) : " ";
    const after = s.to < $from.end() ? state.doc.textBetween(s.to, s.to + 1) : "";
    tr.delete(s.from, before === " " && after === " " ? s.to + 1 : s.to);
  }
  return tr;
}

/** Turns marks or proposed cuts into ordinary ghosts, which are saved with the file. */
export function ghostLabSpans(state: EditorState): Transaction | null {
  const spans = labSpans(state);
  if (!spans.length) return null;
  const tr = clearLab(state.tr);
  for (const s of spans) tr.addMark(s.from, s.to, schema.marks.ghost.create());
  return tr;
}
