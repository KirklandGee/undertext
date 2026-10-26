import { EditorSelection, EditorState, StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { layersOf } from "./layers";
import { checkPage, Issue, Kind, Report } from "./readability";

// Live highlights: hard sentences, weakeners, and simpler words (src/editor/readability.ts). They
// show while Review is open, which is Hemingway's Edit mode. Nothing here is saved to the file or
// changes the text.

export interface HighlightSettings {
  on: boolean;
  /** Kinds that are counted but not drawn. */
  hidden: readonly Kind[];
}

interface HighlightState extends HighlightSettings {
  report: Report | null;
  decos: DecorationSet;
}

const OFF: HighlightSettings = { on: false, hidden: [] };
const settingsEffect = StateEffect.define<Partial<HighlightSettings>>();

// One decoration per kind and note, so a keystroke builds no new ones.
const marks = new Map<string, Decoration>();
function markFor(issue: Issue): Decoration {
  const key = `${issue.kind}\n${issue.note}`;
  let mark = marks.get(key);
  if (!mark) {
    mark = Decoration.mark({ class: `hl hl-${issue.kind}`, attributes: { title: issue.note } });
    marks.set(key, mark);
  }
  return mark;
}

/** The page text with ghosts blanked out. Ghosted text doesn't count, as in the word count. */
function pageText(state: EditorState): string {
  let text = state.doc.toString();
  for (const g of layersOf(state).ghosts) {
    text = text.slice(0, g.from) + text.slice(g.from, g.to).replace(/[^\n]/g, " ") + text.slice(g.to);
  }
  return text;
}

function build(state: EditorState, settings: HighlightSettings): HighlightState {
  if (!settings.on) return { ...settings, report: null, decos: Decoration.none };
  const report = checkPage(pageText(state));
  const shown = report.issues.filter((i) => !settings.hidden.includes(i.kind));
  return { ...settings, report, decos: Decoration.set(shown.map((i) => markFor(i).range(i.from, i.to)), true) };
}

export const highlightsField = StateField.define<HighlightState>({
  create: (state) => build(state, OFF),
  update(prev, tr) {
    let settings: HighlightSettings | null = null;
    for (const e of tr.effects) if (e.is(settingsEffect)) settings = { ...(settings ?? prev), ...e.value };
    if (settings) return build(tr.state, { on: settings.on, hidden: settings.hidden });
    if (prev.on && (tr.docChanged || layersOf(tr.startState) !== layersOf(tr.state))) return build(tr.state, prev);
    return prev;
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decos),
});

export const highlights = (settings: HighlightSettings = OFF) => highlightsField.init((state) => build(state, settings));

export const setHighlights = (settings: Partial<HighlightSettings>): TransactionSpec => ({
  effects: settingsEffect.of(settings),
});

/** The report, while highlights are on. */
export function highlightReport(state: EditorState): Report | null {
  return state.field(highlightsField, false)?.report ?? null;
}

/** The mark at `pos` that shows: a marked word before the sentence around it. */
export function issueAt(state: EditorState, pos: number): Issue | null {
  const h = state.field(highlightsField, false);
  if (!h?.report) return null;
  const here = h.report.issues.filter((i) => i.from <= pos && pos <= i.to && !h.hidden.includes(i.kind));
  return here.find((i) => i.kind !== "hard" && i.kind !== "veryHard") ?? here[0] ?? null;
}

/** Moves the caret to the next or previous mark of these kinds, in mid-window. Null when there is none. */
export function jumpToIssue(state: EditorState, kinds: readonly Kind[], dir: 1 | -1): TransactionSpec | null {
  const list = highlightReport(state)?.issues.filter((i) => kinds.includes(i.kind)) ?? [];
  if (!list.length) return null;
  const head = state.selection.main.head;
  let index = dir > 0 ? list.findIndex((i) => i.from > head) : list.findLastIndex((i) => i.from < head);
  if (index < 0) index = dir > 0 ? 0 : list.length - 1;
  const at = list[index].from;
  return { selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) };
}
