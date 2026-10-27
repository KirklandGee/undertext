import { EditorSelection, EditorState, Facet, Prec, StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, showTooltip, Tooltip } from "@codemirror/view";
import { BLOCK_START, ghostAt, ghostRange, leadLength, removeSpan, reviveAt, touchesCode, unbalancedMarkup } from "./commands";
import { applyFix, issueAt, nextIssue, reviewOpen, shownIssues, writingIssues } from "./highlights";
import { layersOf } from "./layers";
import { Issue, Kind, sentences } from "./readability";

// The popover: a click on a Review highlight explains it and offers what to do. It belongs to the
// caret: it shows while the caret stays in its mark, and closes when you type, move the caret off
// the mark, select, press Esc, or close Review. So it never points at text that changed. While
// Review is open, a ghost gets one too, to remove it or bring it back.

/** A ghost, as the popover sees it. */
export interface GhostMark {
  from: number;
  to: number;
  kind: "ghost";
  note: string;
  fix?: undefined;
}

/** What the popover can be open on: a Review mark, or a ghost. */
export type Mark = Issue | GhostMark;

/** The mark the popover is open on, and where it sits: at the caret when it opened. */
type Open = Mark & { at: number };

const GHOST_NOTE = "Ghosted: dimmed, and left out of the word count.";

/** The ghost at `pos`, while Review is open. */
function ghostMarkAt(state: EditorState, pos: number): GhostMark | null {
  const g = reviewOpen(state) ? ghostAt(state, pos) : null;
  return g && { from: g.from, to: g.to, kind: "ghost", note: GHOST_NOTE };
}

const openEffect = StateEffect.define<Open | null>();

/** The mark the popover is open on, while it still shows and the caret is in it. */
const popoverField = StateField.define<Open | null>({
  create: () => null,
  update(open, tr) {
    for (const e of tr.effects) if (e.is(openEffect)) return e.value;
    if (!open || tr.docChanged) return null;
    // New layers or new issues from Claude can change what it offers: it closes rather than go stale.
    if (layersOf(tr.startState) !== layersOf(tr.state) || writingIssues(tr.startState) !== writingIssues(tr.state)) return null;
    const sel = tr.state.selection.main;
    if (!sel.empty || sel.head < open.from || sel.head > open.to) return null;
    const same = (i: { from: number; to: number; kind: string }) => i.from === open.from && i.to === open.to && i.kind === open.kind;
    if (open.kind === "ghost") return ghostMarkAt(tr.state, sel.head) && layersOf(tr.state).ghosts.some((g) => same({ ...g, kind: "ghost" })) ? open : null;
    return shownIssues(tr.state).some(same) ? open : null;
  },
  provide: (f) => showTooltip.from(f, (open) => (open ? tooltipFor(open) : null)),
});

export const popoverAt = (state: EditorState): Mark | null => state.field(popoverField, false) ?? null;

/** The mark the caret is on: the popover's, else a ghost, as ghosted text isn't marked, else the innermost Review mark. */
function markAtCaret(state: EditorState): Mark | null {
  const sel = state.selection.main;
  return popoverAt(state) ?? (sel.empty ? (ghostMarkAt(state, sel.head) ?? issueAt(state, sel.head)) : null);
}

/**
 * Opens the popover on the ghost at the caret, or the innermost mark there. Null with a selection,
 * off a mark, or with Review closed.
 */
export function openPopover(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main;
  const mark = sel.empty ? (ghostMarkAt(state, sel.head) ?? issueAt(state, sel.head)) : null;
  return mark ? { effects: openEffect.of({ ...mark, at: sel.head }) } : null;
}

export const closePopover: TransactionSpec = { effects: openEffect.of(null) };

/** A Review row's jump: the caret goes to the next mark of these kinds, and the popover opens on it. */
export function jumpToMark(state: EditorState, kinds: readonly Kind[], dir: 1 | -1): TransactionSpec | null {
  const issue = nextIssue(state, kinds, dir);
  if (!issue) return null;
  return {
    selection: EditorSelection.cursor(issue.from),
    effects: [EditorView.scrollIntoView(issue.from, { y: "center" }), openEffect.of({ ...issue, at: issue.from })],
  };
}

// ---------------------------------------------------------------------------
// What to do about a mark

export interface PopoverAction {
  /**
   * "fix" uses the suggestion as an alternative, or Claude's fix in place of a mistake, "ghost"
   * dims the words, "remove" deletes them,
   * "revive" brings a ghost back, and "rewrite" asks Claude.
   */
  kind: "fix" | "ghost" | "remove" | "revive" | "rewrite";
  label: string;
}

const REMOVE: PopoverAction = { kind: "remove", label: "Remove it" };

const CUTS: readonly Kind[] = ["adverb", "qualifier", "intensifier", "filler"];
const SENTENCES: readonly Kind[] = ["passive", "hard", "veryHard"];

/** A hard sentence itself, or the sentence around another mark, after any list or quote marker. */
function sentenceAround(state: EditorState, issue: Issue): { from: number; to: number } {
  if (issue.kind === "hard" || issue.kind === "veryHard") return { from: issue.from, to: issue.to };
  const line = state.doc.lineAt(issue.from);
  const s = sentences(line.text).find((s) => line.from + s.from <= issue.from && issue.to <= line.from + s.to);
  if (!s) return { from: issue.from, to: issue.to };
  const range = { from: line.from + Math.max(s.from, leadLength(line.text)), to: line.from + s.to };
  // A sentence with no end on its line goes on in the next one, unless that one starts a block of
  // its own: a list item, a heading, a quote, a table.
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text.trimStart() : "";
  const open = !/[.!?]["'”’)\]*_~]*$/.test(line.text.slice(0, s.to)) && s.to === line.text.trimEnd().length;
  return open && next && !BLOCK_START.test(next) ? { ...range, to: state.doc.line(line.number + 1).to } : range;
}

/**
 * Why a change to `from`–`to` would save a different page, or null when it wouldn't. An alternative
 * that is exactly the range may stay, when the change adds to it.
 */
function blocker(state: EditorState, from: number, to: number, sameAlt: boolean): string | null {
  const line = state.doc.lineAt(from);
  if (to > line.to) return "It runs across a line break.";
  if (touchesCode(state, from, to)) return "It has code in it.";
  const cuts = (r: { from: number; to: number }) => r.from < to && r.to > from;
  const l = layersOf(state);
  if (l.ghosts.some((g) => cuts(g) && (g.from > from || g.to < to))) return "It has a ghosted word. Revive it with ⌘/ first.";
  if (l.alts.some((a) => cuts(a) && !(sameAlt && a.from === from && a.to === to))) return "Part of it already has alternatives.";
  const text = state.doc.sliceString(from, to);
  if (unbalancedMarkup(text)) return "It cuts through bold or italic text.";
  if (!text.trim() || (leadLength(line.text) >= from - line.from && BLOCK_START.test(text))) return "It starts the line with Markdown markup.";
  return null;
}

/**
 * The text Claude would rewrite for a mark: the sentence, or the alternative that is exactly the
 * sentence, which the rewrites then join. Null where an alternative there would save a different page.
 */
export function rewriteRange(state: EditorState, issue: Mark): { from: number; to: number } | null {
  if (issue.kind === "ghost") return null;
  const range = sentenceAround(state, issue);
  return blocker(state, range.from, range.to, true) ? null : range;
}

/** Why the popover can't offer a mark's usual action, in a line: its fix, a ghost, or a rewrite. Null when it can. */
export function whyNoAction(state: EditorState, issue: Mark): string | null {
  if (issue.kind === "ghost" || issue.kind === "grammar" && !issue.fix) return null;
  const main = actionsFor(state, issue).filter((a) => a.kind !== "remove");
  if (main.length) return null;
  const fallback = "Changing it here would change what's saved.";
  if (issue.fix) {
    const same = layersOf(state).alts.some((a) => a.from === issue.from && a.to === issue.to);
    if (same) return "It's an alternative already. ⌥J and ⌥K switch its versions.";
    return blocker(state, issue.from, issue.to, false) ?? fallback;
  }
  if (CUTS.includes(issue.kind)) {
    const inAlt = layersOf(state).alts.some((a) => a.from < issue.to && a.to > issue.from);
    return inAlt ? "It's inside an alternative, where a ghost isn't saved. Select the whole alternative and press ⌘/." : fallback;
  }
  if (SENTENCES.includes(issue.kind) || issue.kind === "hidden") {
    const range = sentenceAround(state, issue);
    return blocker(state, range.from, range.to, true) ?? fallback;
  }
  return null;
}

/** What the popover offers for a mark, best first. Empty when nothing fits there. */
export function actionsFor(state: EditorState, issue: Mark): PopoverAction[] {
  if (issue.kind === "ghost") return [REMOVE, { kind: "revive", label: "Revive it" }];
  if (issue.fix) return applyFix(state, issue) ? [{ kind: "fix", label: issue.fix }] : [];
  // Claude's issue with no fix says to cut the words.
  if (issue.kind === "grammar") return [REMOVE];
  if (CUTS.includes(issue.kind)) {
    return ghostRange(state, issue.from, issue.to) ? [{ kind: "ghost", label: "Ghost it" }, REMOVE] : [REMOVE];
  }
  if (SENTENCES.includes(issue.kind) || issue.kind === "hidden") {
    return rewriteRange(state, issue) ? [{ kind: "rewrite", label: "Suggest rewrites" }] : [];
  }
  return [];
}

/**
 * The change an action makes. Null for a rewrite, which the app runs with Claude. Ghosting keeps
 * the popover open on the new ghost, so "Remove it" is still a click away.
 */
export function runAction(state: EditorState, issue: Mark, action: PopoverAction): TransactionSpec | null {
  if (action.kind === "fix") return issue.kind === "ghost" ? null : applyFix(state, issue);
  if (action.kind === "remove") return removeSpan(state, issue);
  if (action.kind === "revive") return reviveAt(state, issue.from);
  if (action.kind !== "ghost") return null;
  const spec = ghostRange(state, issue.from, issue.to);
  // The new ghost may join one next to it.
  const ghost = spec && layersOf(state.update(spec).state).ghosts.find((g) => g.from <= issue.from && issue.to <= g.to);
  if (!spec || !ghost) return spec;
  const open: Open = { from: ghost.from, to: ghost.to, kind: "ghost", note: GHOST_NOTE, at: state.selection.main.head };
  return { effects: [spec.effects as StateEffect<unknown>, openEffect.of(open)] };
}

/** What Claude rewrites, and why: the range, the kind of mark, and the words it flagged. */
export interface RewriteTarget {
  from: number;
  to: number;
  kind: Kind;
  phrase: string;
}

function rewriteTarget(state: EditorState, issue: Issue): RewriteTarget | null {
  const range = rewriteRange(state, issue);
  return range && { ...range, kind: issue.kind, phrase: state.doc.sliceString(issue.from, issue.to) };
}

/** Review's "Use" button: the fix of the popover's mark, or of the mark at the caret. */
export function useFixAt(state: EditorState): TransactionSpec | null {
  const issue = markAtCaret(state);
  return issue && issue.kind !== "ghost" ? applyFix(state, issue) : null;
}

/** ⌥↩: the first action for the mark at the caret, as a change, or as the text for Claude to rewrite. */
export function firstAction(state: EditorState): { spec?: TransactionSpec; rewrite?: RewriteTarget } | null {
  const issue = markAtCaret(state);
  const action = issue && actionsFor(state, issue)[0];
  if (!issue || !action) return null;
  if (action.kind === "rewrite" && issue.kind !== "ghost") return { rewrite: rewriteTarget(state, issue)! };
  const spec = runAction(state, issue, action);
  return spec ? { spec } : null;
}

// ---------------------------------------------------------------------------
// The popover on the page

const TITLES: Record<Mark["kind"], string> = {
  ghost: "Ghosted",
  veryHard: "Very hard to read",
  hard: "Hard to read",
  adverb: "Adverb",
  passive: "Passive voice",
  qualifier: "Qualifier",
  intensifier: "Intensifier",
  weakVerb: "Weak verb",
  filler: "Filler",
  hidden: "Hidden action",
  negative: "Negative",
  simpler: "Simpler word",
  grammar: "Writing issue",
};

const ADVICE: Record<Mark["kind"], string> = {
  ghost: "Dimmed, so you can read the sentence without it. It's left out of the word count.",
  veryHard: "Split it, or use shorter words.",
  hard: "Split it, or use shorter words.",
  adverb: "An -ly word often props up a weak verb. Cut it if the sentence holds without it.",
  passive: "It hides who acts. “The door was closed” becomes “She closed the door”.",
  qualifier: "It hedges. Say it plainly, or cut it.",
  intensifier: "It tries to add force and rarely does. Cut it, or use a stronger word.",
  weakVerb: "One precise verb says more than a verb and an adverb.",
  filler: "It adds words, not meaning.",
  hidden: "The action hides in a noun. Use the verb.",
  negative: "Say what is, not what isn't.",
  simpler: "A plainer word says the same.",
  grammar: "",
};

/** What ⌥↩ does, for the hint under the buttons. */
const KEY_HINTS: Record<PopoverAction["kind"], string> = {
  fix: "uses it",
  ghost: "ghosts it",
  remove: "removes it",
  revive: "revives it",
  rewrite: "suggests rewrites",
};

const HINTS: Record<PopoverAction["kind"], string> = {
  fix: "Becomes an alternative. ⌥K brings your words back.",
  ghost: "Dims it, so you can read the sentence without it. ⌘/ brings it back.",
  remove: "Deletes it, and tidies the spaces around it. ⌘Z brings it back.",
  revive: "Brings it back to full strength, and into the word count.",
  rewrite: "Suggests rewrites of the sentence. ↑↓ picks one.",
};

/** What a button does, for its tooltip. A writing issue's fix replaces a mistake, so it keeps no alternative. */
export function actionHint(issue: Mark, action: PopoverAction): string {
  return action.kind === "fix" && issue.kind === "grammar" ? "Replaces it. ⌘Z brings it back." : HINTS[action.kind];
}

/** Runs Claude's rewrite. The app gives it; tests leave it out. */
type Rewrite = (target: RewriteTarget) => void;
const rewriteFacet = Facet.define<Rewrite, Rewrite>({ combine: (all) => all[0] ?? (() => {}) });

/** What the popover says about a mark: its title, explanation, reason for no action, actions, and key hint. */
export function popoverContent(state: EditorState, issue: Mark) {
  // A hard sentence's word count is the one Review counts: prose only, as its note says.
  const words = issue.note.match(/(\d+) words/)?.[1];
  const text = issue.kind === "grammar" ? issue.note : words ? `${words} words. ${ADVICE[issue.kind]}` : ADVICE[issue.kind];
  const actions = actionsFor(state, issue);
  return {
    title: TITLES[issue.kind],
    text,
    why: whyNoAction(state, issue),
    actions,
    hint: actions.length ? `⌥↩ ${KEY_HINTS[actions[0].kind]} · esc closes` : null,
  };
}

function tooltipFor(open: Open): Tooltip {
  return {
    pos: open.at,
    create(view) {
      const issue: Mark = open;
      const { title: heading, text: advice, why, actions, hint: keys } = popoverContent(view.state, issue);
      const dom = document.createElement("div");
      dom.className = "hl-pop";
      const title = dom.appendChild(document.createElement("div"));
      title.className = `hl-pop-title hl-pop-${issue.kind}`;
      title.textContent = heading;
      const text = dom.appendChild(document.createElement("p"));
      text.className = "hl-pop-text";
      text.textContent = advice;
      if (why) {
        const line = dom.appendChild(document.createElement("p"));
        line.className = "hl-pop-why";
        line.textContent = why;
      }
      if (actions.length) {
        const row = dom.appendChild(document.createElement("div"));
        row.className = "hl-pop-actions";
        for (const action of actions) {
          const button = row.appendChild(document.createElement("button"));
          button.className = `hl-pop-action hl-pop-${action.kind}`;
          button.textContent = action.label;
          button.title = actionHint(issue, action);
          // Keep the caret, and the popover, where they are until the action runs.
          button.addEventListener("mousedown", (e) => e.preventDefault());
          button.addEventListener("click", () => run(view, issue, action));
        }
        const hint = dom.appendChild(document.createElement("p"));
        hint.className = "hl-pop-hint";
        hint.textContent = keys;
      }
      return { dom };
    },
  };
}

function run(view: EditorView, issue: Mark, action: PopoverAction) {
  if (action.kind === "rewrite") {
    const target = issue.kind === "ghost" ? null : rewriteTarget(view.state, issue);
    view.dispatch(closePopover);
    if (target) view.state.facet(rewriteFacet)(target);
  } else {
    const spec = runAction(view.state, issue, action);
    if (spec) view.dispatch(spec);
  }
  view.focus();
}

/** ⌥↩, from the key or the palette: runs the first action at the caret. False when there is none. */
export function runFirstAction(view: EditorView): boolean {
  const next = firstAction(view.state);
  if (!next) return false;
  if (next.spec) view.dispatch(next.spec);
  else if (next.rewrite) {
    view.dispatch(closePopover);
    view.state.facet(rewriteFacet)(next.rewrite);
  }
  return true;
}

/** The popover, its click, ⌥↩, and Esc. `onRewrite` runs Claude's rewrite of a range. */
export function popover(onRewrite?: Rewrite) {
  return [
    popoverField,
    onRewrite ? rewriteFacet.of(onRewrite) : [],
    EditorView.domEventHandlers({
      // After the click has placed the caret. A double click or a drag selects, and opens nothing.
      click(e, view) {
        if (e.detail > 1 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
        const spec = openPopover(view.state);
        if (spec) view.dispatch(spec);
        return false;
      },
    }),
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (!popoverAt(view.state)) return false;
            view.dispatch(closePopover);
            return true;
          },
        },
        { key: "Alt-Enter", run: runFirstAction },
      ]),
    ),
  ];
}
