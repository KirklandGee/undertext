import { EditorSelection, EditorState, Facet, Prec, StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, showTooltip, Tooltip } from "@codemirror/view";
import { ghostRange } from "./commands";
import { applyFix, BLOCK_START, issueAt, leadLength, nextIssue, shownIssues, touchesCode } from "./highlights";
import { layersOf } from "./layers";
import { Issue, Kind, sentences } from "./readability";

// The popover: a click on a Review highlight explains it and offers what to do. It belongs to the
// caret: it shows while the caret stays in its mark, and closes when you type, move the caret off
// the mark, select, press Esc, or close Review. So it never points at text that changed.

const openEffect = StateEffect.define<Issue | null>();

/** The mark the popover is open on, while it still shows and the caret is in it. */
const popoverField = StateField.define<Issue | null>({
  create: () => null,
  update(open, tr) {
    for (const e of tr.effects) if (e.is(openEffect)) return e.value;
    if (!open || tr.docChanged) return null;
    const sel = tr.state.selection.main;
    if (!sel.empty || sel.head < open.from || sel.head > open.to) return null;
    const same = (i: Issue) => i.from === open.from && i.to === open.to && i.kind === open.kind;
    return shownIssues(tr.state).some(same) ? open : null;
  },
  provide: (f) => showTooltip.from(f, (open) => (open ? tooltipFor(open) : null)),
});

export const popoverAt = (state: EditorState): Issue | null => state.field(popoverField, false) ?? null;

/** Opens the popover on the innermost mark at the caret. Null with a selection, off a mark, or with Review closed. */
export function openPopover(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main;
  const issue = sel.empty ? issueAt(state, sel.head) : null;
  return issue ? { effects: openEffect.of(issue) } : null;
}

export const closePopover: TransactionSpec = { effects: openEffect.of(null) };

/** A Review row's jump: the caret goes to the next mark of these kinds, and the popover opens on it. */
export function jumpToMark(state: EditorState, kinds: readonly Kind[], dir: 1 | -1): TransactionSpec | null {
  const issue = nextIssue(state, kinds, dir);
  if (!issue) return null;
  return {
    selection: EditorSelection.cursor(issue.from),
    effects: [EditorView.scrollIntoView(issue.from, { y: "center" }), openEffect.of(issue)],
  };
}

// ---------------------------------------------------------------------------
// What to do about a mark

export interface PopoverAction {
  /** "fix" uses the suggestion as an alternative, "ghost" dims the words, "rewrite" asks Claude. */
  kind: "fix" | "ghost" | "rewrite";
  label: string;
}

const CUTS: readonly Kind[] = ["adverb", "qualifier", "intensifier", "filler"];
const SENTENCES: readonly Kind[] = ["passive", "hard", "veryHard"];

/** A hard sentence itself, or the sentence around another mark, after any list or quote marker. */
function sentenceAround(state: EditorState, issue: Issue): { from: number; to: number } {
  if (issue.kind === "hard" || issue.kind === "veryHard") return issue;
  const line = state.doc.lineAt(issue.from);
  const s = sentences(line.text).find((s) => line.from + s.from <= issue.from && issue.to <= line.from + s.to);
  return s ? { from: line.from + Math.max(s.from, leadLength(line.text)), to: line.from + s.to } : issue;
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
  if (!text.trim() || (leadLength(line.text) >= from - line.from && BLOCK_START.test(text))) return "It starts the line with Markdown markup.";
  return null;
}

/**
 * The text Claude would rewrite for a mark: the sentence, or the alternative that is exactly the
 * sentence, which the rewrites then join. Null where an alternative there would save a different page.
 */
export function rewriteRange(state: EditorState, issue: Issue): { from: number; to: number } | null {
  const range = sentenceAround(state, issue);
  return blocker(state, range.from, range.to, true) ? null : range;
}

/** Why the popover offers nothing for a mark, in a line. Null when it offers something. */
export function whyNoAction(state: EditorState, issue: Issue): string | null {
  if (actionsFor(state, issue).length) return null;
  const fallback = "Changing it here would change what's saved.";
  if (issue.fix) return blocker(state, issue.from, issue.to, false) ?? fallback;
  if (CUTS.includes(issue.kind)) {
    const inAlt = layersOf(state).alts.some((a) => a.from < issue.to && a.to > issue.from);
    return inAlt ? "It's inside an alternative, where a ghost isn't saved." : fallback;
  }
  if (SENTENCES.includes(issue.kind) || issue.kind === "hidden") {
    const range = sentenceAround(state, issue);
    return blocker(state, range.from, range.to, true) ?? fallback;
  }
  return null;
}

/** What the popover offers for a mark, best first. Empty when nothing fits there. */
export function actionsFor(state: EditorState, issue: Issue): PopoverAction[] {
  if (issue.fix) return applyFix(state, issue) ? [{ kind: "fix", label: issue.fix }] : [];
  if (CUTS.includes(issue.kind)) return ghostRange(state, issue.from, issue.to) ? [{ kind: "ghost", label: "Ghost it" }] : [];
  if (SENTENCES.includes(issue.kind) || issue.kind === "hidden") {
    return rewriteRange(state, issue) ? [{ kind: "rewrite", label: "Rewrite with Claude" }] : [];
  }
  return [];
}

/** The change an action makes. Null for a rewrite, which the app runs with Claude. */
export function runAction(state: EditorState, issue: Issue, action: PopoverAction): TransactionSpec | null {
  if (action.kind === "fix") return applyFix(state, issue);
  if (action.kind === "ghost") return ghostRange(state, issue.from, issue.to);
  return null;
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

/** ⌥↩: the first action for the mark at the caret, as a change, or as the text for Claude to rewrite. */
export function firstAction(state: EditorState): { spec?: TransactionSpec; rewrite?: RewriteTarget } | null {
  const sel = state.selection.main;
  const issue = popoverAt(state) ?? (sel.empty ? issueAt(state, sel.head) : null);
  const action = issue && actionsFor(state, issue)[0];
  if (!issue || !action) return null;
  if (action.kind === "rewrite") return { rewrite: rewriteTarget(state, issue)! };
  const spec = runAction(state, issue, action);
  return spec ? { spec } : null;
}

// ---------------------------------------------------------------------------
// The popover on the page

const TITLES: Record<Kind, string> = {
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

const ADVICE: Record<Kind, string> = {
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
const KEY_HINTS: Record<PopoverAction["kind"], string> = { fix: "uses it", ghost: "ghosts it", rewrite: "asks Claude" };

const HINTS: Record<PopoverAction["kind"], string> = {
  fix: "Becomes an alternative. ⌥K brings your words back.",
  ghost: "Dims it, so you can read the sentence without it. ⌘/ brings it back.",
  rewrite: "Asks Claude for rewrites of the sentence. ↑↓ picks one.",
};

/** Runs Claude's rewrite. The app gives it; tests leave it out. */
type Rewrite = (target: RewriteTarget) => void;
const rewriteFacet = Facet.define<Rewrite, Rewrite>({ combine: (all) => all[0] ?? (() => {}) });

function tooltipFor(issue: Issue): Tooltip {
  return {
    pos: issue.from,
    end: issue.to,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "hl-pop";
      const title = dom.appendChild(document.createElement("div"));
      title.className = `hl-pop-title hl-pop-${issue.kind}`;
      title.textContent = TITLES[issue.kind];
      const words = view.state.doc.sliceString(issue.from, issue.to).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
      const advice = issue.kind === "grammar" ? issue.note : SENTENCES.includes(issue.kind) && issue.kind !== "passive" ? `${words} words. ${ADVICE[issue.kind]}` : ADVICE[issue.kind];
      const text = dom.appendChild(document.createElement("p"));
      text.className = "hl-pop-text";
      text.textContent = advice;
      const actions = actionsFor(view.state, issue);
      const why = whyNoAction(view.state, issue);
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
          button.title = HINTS[action.kind];
          // Keep the caret, and the popover, where they are until the action runs.
          button.addEventListener("mousedown", (e) => e.preventDefault());
          button.addEventListener("click", () => run(view, issue, action));
        }
        const hint = dom.appendChild(document.createElement("p"));
        hint.className = "hl-pop-hint";
        hint.textContent = `⌥↩ ${KEY_HINTS[actions[0].kind]} · esc closes`;
      }
      return { dom };
    },
  };
}

function run(view: EditorView, issue: Issue, action: PopoverAction) {
  if (action.kind === "rewrite") {
    const target = rewriteTarget(view.state, issue);
    view.dispatch(closePopover);
    if (target) view.state.facet(rewriteFacet)(target);
  } else {
    const spec = runAction(view.state, issue, action);
    if (spec) view.dispatch(spec);
  }
  view.focus();
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
        {
          key: "Alt-Enter",
          run: (view) => {
            const next = firstAction(view.state);
            if (!next) return false;
            if (next.spec) view.dispatch(next.spec);
            else if (next.rewrite) {
              view.dispatch(closePopover);
              view.state.facet(rewriteFacet)(next.rewrite);
            }
            return true;
          },
        },
      ]),
    ),
  ];
}
