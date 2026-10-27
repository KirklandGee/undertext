import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { ChangeSet, EditorSelection, EditorState, StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { Alt, newId } from "./format";
import { layersOf, mapLayers, setLayers } from "./layers";
import { checkPage, Issue, Kind, Report } from "./readability";

// Highlights: hard sentences, weakeners, and simpler words (src/editor/readability.ts), and the
// writing issues Claude finds on request. The checks always run, so the top bar can show the
// grade. They show on the page only while Review is open, which is Hemingway's Edit mode.
// Nothing here is saved to the file or changes the text, until you use a fix.

export interface HighlightSettings {
  on: boolean;
  /** Kinds that are counted but not drawn. */
  hidden: readonly Kind[];
}

/** A grammar or style issue from Claude. `fix` replaces the text, or is empty when there is none. */
export interface WritingIssue extends Issue {
  kind: "grammar";
  fix: string;
}

interface HighlightState extends HighlightSettings {
  report: Report;
  /** Null until Claude has looked at the page. */
  writing: WritingIssue[] | null;
  decos: DecorationSet;
}

const OFF: HighlightSettings = { on: false, hidden: [] };
const settingsEffect = StateEffect.define<Partial<HighlightSettings>>();
const writingEffect = StateEffect.define<WritingIssue[] | null>();

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

function draw(s: Omit<HighlightState, "decos">): HighlightState {
  if (!s.on) return { ...s, decos: Decoration.none };
  const shown = [...s.report.issues, ...(s.writing ?? [])].filter((i) => !s.hidden.includes(i.kind));
  return { ...s, decos: Decoration.set(shown.map((i) => markFor(i).range(i.from, i.to)), true) };
}

export const highlightsField = StateField.define<HighlightState>({
  create: (state) => draw({ ...OFF, report: checkPage(pageText(state)), writing: null }),
  update(prev, tr) {
    let next = prev;
    let changed = false;
    if (tr.docChanged || layersOf(tr.startState) !== layersOf(tr.state)) {
      next = { ...next, report: checkPage(pageText(tr.state)), writing: mapWriting(prev.writing, tr.changes) };
      changed = true;
    }
    for (const e of tr.effects) {
      if (e.is(settingsEffect)) next = { ...next, ...e.value };
      // An issue placed on another version of the page would break every later edit.
      else if (e.is(writingEffect)) next = { ...next, writing: e.value && e.value.filter((i) => i.to <= tr.state.doc.length) };
      else continue;
      changed = true;
    }
    return changed ? draw(next) : prev;
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decos),
});

/** Moves writing issues with an edit. An edit that touches an issue's text drops it. */
function mapWriting(writing: WritingIssue[] | null, changes: ChangeSet): WritingIssue[] | null {
  if (!writing || changes.empty) return writing;
  const out: WritingIssue[] = [];
  for (const i of writing) {
    let touched = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (fromA < i.to && toA > i.from) touched = true;
    });
    if (!touched) out.push({ ...i, from: changes.mapPos(i.from, 1), to: changes.mapPos(i.to, -1) });
  }
  return out;
}

export const highlights = (settings: HighlightSettings = OFF) =>
  highlightsField.init((state) => draw({ ...settings, report: checkPage(pageText(state)), writing: null }));

export const setHighlights = (settings: Partial<HighlightSettings>): TransactionSpec => ({
  effects: settingsEffect.of(settings),
});

/** Claude's writing issues, in page order. Null forgets them. */
export const setWritingIssues = (issues: WritingIssue[] | null): TransactionSpec => ({
  effects: writingEffect.of(issues && [...issues].sort((a, b) => a.from - b.from)),
});

/** The report of the live checks. It is there with Review closed too, for the top bar. */
export function highlightReport(state: EditorState): Report | null {
  return state.field(highlightsField, false)?.report ?? null;
}

/** Claude's writing issues, or null when it hasn't looked at the page. */
export function writingIssues(state: EditorState): WritingIssue[] | null {
  return state.field(highlightsField, false)?.writing ?? null;
}

/**
 * The mark at `pos` that shows, while Review is open: a writing issue first, as it has a fix, then
 * a marked word, then the sentence around it.
 */
export function issueAt(state: EditorState, pos: number): Issue | WritingIssue | null {
  const h = state.field(highlightsField, false);
  if (!h?.on) return null;
  const here = [...(h.writing ?? []), ...h.report.issues].filter(
    (i) => i.from <= pos && pos <= i.to && !h.hidden.includes(i.kind),
  );
  return here.find((i) => i.kind !== "hard" && i.kind !== "veryHard") ?? here[0] ?? null;
}

/** Moves the caret to the next or previous shown mark of these kinds, in mid-window. Null when there is none. */
export function jumpToIssue(state: EditorState, kinds: readonly Kind[], dir: 1 | -1): TransactionSpec | null {
  const h = state.field(highlightsField, false);
  if (!h?.on) return null;
  const list = [...h.report.issues, ...(h.writing ?? [])]
    .filter((i) => kinds.includes(i.kind) && !h.hidden.includes(i.kind))
    .sort((a, b) => a.from - b.from);
  if (!list.length) return null;
  const head = state.selection.main.head;
  let index = dir > 0 ? list.findIndex((i) => i.from > head) : list.findLastIndex((i) => i.from < head);
  if (index < 0) index = dir > 0 ? 0 : list.length - 1;
  const at = list[index].from;
  return { selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) };
}

const CODE = ["InlineCode", "FencedCode", "CodeBlock"];
/** What may come before a line's first word: indent, quote markers, and list markers. */
const LINE_LEAD = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*$/;
/** Text that would make a block of its own at the start of a line. */
const BLOCK_START = /^(?:[#>*+=_|<~-]|\d+[.)])/;

/** Whether `from`–`to` touches code. An alternative there would be saved as literal text. */
export function touchesCode(state: EditorState, from: number, to: number): boolean {
  let code = false;
  (ensureSyntaxTree(state, to, 200) ?? syntaxTree(state)).iterate({
    from,
    to,
    enter: (n) => {
      if (CODE.includes(n.name)) code = true;
      return !code;
    },
  });
  return code;
}

/**
 * Where a fix of `from`–`to` can go as an alternative. The file format trims each variant, so a
 * space at either edge would be lost on save: "the the " → "the " becomes "the the" → "the", and
 * "ended.Next" → "ended. Next" takes in the whole word. Null when the fix changes nothing, or would
 * leave its line, start a line with Markdown markup, cut into a ghost or an alternative, touch
 * code, or add or remove a backtick: each of those would save a different page.
 */
export function fitFix(state: EditorState, from: number, to: number, fix: string): { from: number; to: number; fix: string } | null {
  const line = state.doc.lineAt(from);
  if (to > line.to || /[\r\n]/.test(fix)) return null;
  const text = line.text;
  const space = (c: string | undefined) => c === " " || c === "\t";
  let a = from - line.from;
  let b = to - line.from;
  let insert = fix;
  // Spaces both sides share stay outside the alternative.
  while (a < b && space(text[a]) && text[a] === insert[0]) [a, insert] = [a + 1, insert.slice(1)];
  while (a < b && space(text[b - 1]) && text[b - 1] === insert.at(-1)) [b, insert] = [b - 1, insert.slice(0, -1)];
  // Otherwise take in the word on that side, and the spaces before it.
  if (a === b || !insert || space(text[a]) || space(insert[0])) {
    const start = a;
    while (a > 0 && space(text[a - 1])) a--;
    while (a > 0 && !space(text[a - 1])) a--;
    insert = text.slice(a, start) + insert;
  }
  if (a === b || !insert || space(text[b - 1]) || space(insert.at(-1))) {
    const end = b;
    while (b < text.length && space(text[b])) b++;
    while (b < text.length && !space(text[b])) b++;
    insert += text.slice(end, b);
  }
  const original = text.slice(a, b);
  const edge = (s: string) => !s.trim() || s !== s.trim();
  if (edge(original) || edge(insert) || original === insert) return null;
  if (/`/.test(original + insert)) return null;
  if (LINE_LEAD.test(text.slice(0, a)) && [original, insert].some((s) => BLOCK_START.test(s))) return null;
  const range = { from: line.from + a, to: line.from + b };
  const cuts = (r: { from: number; to: number }) => r.from < range.to && r.to > range.from;
  const l = layersOf(state);
  if (l.ghosts.some((g) => cuts(g) && (g.from > range.from || g.to < range.to))) return null;
  if (l.alts.some(cuts) || touchesCode(state, range.from, range.to)) return null;
  return { ...range, fix: insert };
}

/**
 * Uses a writing issue's fix as an alternative, with the fix active and the original kept, as typo
 * fixes do. Null when the issue has no fix, or the fix has no place (see fitFix).
 */
export function applyWritingFix(state: EditorState, issue: WritingIssue): TransactionSpec | null {
  const fit = issue.fix ? fitFix(state, issue.from, issue.to, issue.fix) : null;
  if (!fit) return null;
  const { fix } = fit;
  const original = state.doc.sliceString(fit.from, fit.to);
  const changes = state.changes({ from: fit.from, to: fit.to, insert: fix });
  const mapped = mapLayers(layersOf(state), changes);
  const from = changes.mapPos(fit.from, -1);
  const alt: Alt = { from, to: from + fix.length, id: newId(), variants: [original, fix], active: 1, ai: [fix] };
  return {
    changes,
    effects: setLayers.of({ ...mapped, alts: [...mapped.alts, alt].sort((x, y) => x.from - y.from) }),
  };
}
