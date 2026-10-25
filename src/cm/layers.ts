import { invertedEffects } from "@codemirror/commands";
import { ChangeDesc, EditorState, Extension, Range, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { Alt, Layers, newId } from "./format";

// The layers live beside the text, not in it. Each range moves with edits.
// Commands change them with `setLayers`, in the same transaction as the text,
// and undo restores them from a snapshot (see `invertLayers`).

export const emptyLayers: Layers = { alts: [], ghosts: [], versions: [] };

/** Moves every range through a change. Alternatives and ghosts don't grow when you type at their edges. */
export function mapLayers(l: Layers, changes: ChangeDesc): Layers {
  if (changes.empty || (!l.alts.length && !l.ghosts.length && !l.versions.length)) return l;
  return {
    alts: l.alts
      .map((a) => ({ ...a, from: changes.mapPos(a.from, 1), to: changes.mapPos(a.to, -1) }))
      .filter((a) => a.from < a.to),
    ghosts: l.ghosts
      .map((g) => ({ from: changes.mapPos(g.from, 1), to: changes.mapPos(g.to, -1) }))
      .filter((g) => g.from < g.to),
    versions: l.versions.map((v) => ({ ...v, at: changes.mapPos(v.at, -1) })),
  };
}

/** Replaces every layer. Positions refer to the document after the transaction's changes. */
export const setLayers = StateEffect.define<Layers>({ map: (l, changes) => mapLayers(l, changes) });

export const layersField = StateField.define<Layers>({
  create: () => emptyLayers,
  update(value, tr) {
    let next = mapLayers(value, tr.changes);
    for (const e of tr.effects) if (e.is(setLayers)) next = e.value;
    return next === value ? value : normalize(next, tr.newDoc);
  },
});

export const layersOf = (state: EditorState) => state.field(layersField);

/**
 * Keeps the layers in shapes the file can hold. An alternative never spans a
 * line break: a split gives each part its own id. A version must start a
 * paragraph: after a join it is dropped, as the joined paragraph takes the
 * first one's versions.
 */
function normalize(l: Layers, doc: Text): Layers {
  const alts: Alt[] = [];
  for (const a of l.alts) {
    const text = doc.sliceString(a.from, a.to);
    if (!text.includes("\n")) {
      alts.push(a);
      continue;
    }
    let start = a.from;
    let first = true;
    for (const part of text.split("\n")) {
      if (part.trim()) {
        alts.push({ ...a, from: start, to: start + part.length, id: first ? a.id : newId() });
        first = false;
      }
      start += part.length + 1;
    }
  }
  const seen = new Set<number>();
  const versions = l.versions.filter((v) => {
    if (seen.has(v.at) || !isBlockStart(doc, v.at)) return false;
    seen.add(v.at);
    return true;
  });
  return { alts: alts.sort((a, b) => a.from - b.from), ghosts: l.ghosts, versions };
}

export function isBlockStart(doc: Text, at: number): boolean {
  if (at < 0 || at > doc.length) return false;
  const line = doc.lineAt(at);
  if (line.from !== at || !line.text.trim()) return false;
  return line.number === 1 || !doc.line(line.number - 1).text.trim();
}

/** The lines of the paragraph that starts at `at`. */
export function blockLines(doc: Text, at: number): { from: number; to: number; lines: number[] } {
  let line = doc.lineAt(at);
  const lines = [line.from];
  while (line.number < doc.lines) {
    const next = doc.line(line.number + 1);
    if (!next.text.trim()) break;
    line = next;
    lines.push(line.from);
  }
  return { from: at, to: line.to, lines };
}

// ---------------------------------------------------------------------------
// Undo: history tracks text only, so a change that touches a layer stores a
// snapshot of all layers from before it. Edits away from every layer store
// nothing: mapping alone undoes them.

function touches(l: Layers, changes: ChangeDesc): boolean {
  let hit = false;
  changes.iterChangedRanges((fromA, toA) => {
    hit ||=
      l.alts.some((a) => fromA <= a.to && toA >= a.from) ||
      l.ghosts.some((g) => fromA <= g.to && toA >= g.from) ||
      // A version also depends on the blank line before it.
      l.versions.some((v) => fromA <= v.at && toA >= v.at - 2);
  });
  return hit;
}

const invertLayers = invertedEffects.of((tr) => {
  const before = tr.startState.field(layersField);
  const changed = tr.effects.some((e) => e.is(setLayers)) || (tr.docChanged && touches(before, tr.changes));
  return changed ? [setLayers.of(before)] : [];
});

// ---------------------------------------------------------------------------
// Drawing

const ghostMark = Decoration.mark({ class: "ghost" });

const layerDecorations = EditorView.decorations.compute([layersField], (state) => {
  const l = layersOf(state);
  const ranges: Range<Decoration>[] = [];
  for (const a of l.alts) {
    ranges.push(
      Decoration.mark({
        class: "alt",
        attributes: {
          "data-alt-id": a.id,
          "data-count": String(a.variants.length),
          "data-active": String(a.active),
          "data-variants": JSON.stringify(a.variants),
        },
      }).range(a.from, a.to),
    );
  }
  for (const g of l.ghosts) ranges.push(ghostMark.range(g.from, g.to));
  for (const v of l.versions) {
    const deco = Decoration.line({
      class: `has-versions${v.active !== 0 ? " modified" : ""}`,
      attributes: { "data-vid": v.vid, "data-count": String(v.variants.length) },
    });
    for (const from of blockLines(state.doc, v.at).lines) ranges.push(deco.range(from));
  }
  return Decoration.set(ranges, true);
});

/** The layers, starting from what the file held. */
export const layers = (initial: Layers = emptyLayers): Extension => [
  layersField.init(() => initial),
  invertLayers,
  layerDecorations,
];
