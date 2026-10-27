import { EditorState, TransactionSpec } from "@codemirror/state";
import { addAiAlternatives, blockAt, countWords, findAlt, syncedVariants } from "../editor/commands";
import { Alt, newId } from "../editor/format";
import { fitFix, touchesCode, WritingIssue } from "../editor/highlights";
import { LabSpan } from "../editor/lab";
import { layersOf, mapLayers, setLayers } from "../editor/layers";
import { checkPage, Kind } from "../editor/readability";
import { callClaude } from "./client";

// Each Lab feature is one Claude call with a JSON answer. Claude quotes the
// text it means; we find those quotes in the document ourselves, so a wrong
// quote is dropped instead of changing the wrong words.

// ---------------------------------------------------------------------------
// Paragraphs as Claude sees them

interface DocParagraph {
  /** 1-based label sent to Claude. */
  n: number;
  /** Document position of the paragraph's first character. */
  pos: number;
  text: string;
}

/** The page's paragraphs: runs of lines between blank lines. */
function docParagraphs(state: EditorState): DocParagraph[] {
  const { doc } = state;
  const out: DocParagraph[] = [];
  let start = -1;
  let lines: string[] = [];
  const flush = () => {
    if (start >= 0) out.push({ n: out.length + 1, pos: start, text: lines.join("\n") });
    start = -1;
    lines = [];
  };
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (!line.text.trim()) {
      flush();
      continue;
    }
    if (start < 0) start = line.from;
    lines.push(line.text);
  }
  flush();
  return out;
}

const numbered = (paras: DocParagraph[]) => paras.map((p) => `[${p.n}] ${p.text}`).join("\n\n");

interface Range {
  from: number;
  to: number;
}

/** Finds a quote in its paragraph (or, if Claude misnumbered it, in any paragraph). */
function locate(paras: DocParagraph[], n: number, quote: string, used: Range[]): Range | null {
  if (!quote) return null;
  const order = [...paras.filter((p) => p.n === n), ...paras.filter((p) => p.n !== n)];
  for (const p of order) {
    let i = p.text.indexOf(quote);
    while (i >= 0) {
      const range = { from: p.pos + i, to: p.pos + i + quote.length };
      if (!used.some((u) => u.from < range.to && u.to > range.from)) return range;
      i = p.text.indexOf(quote, i + 1);
    }
  }
  return null;
}

const isHeading = (state: EditorState, pos: number) => /^#{1,6}\s/.test(state.doc.lineAt(pos).text);

const ghostedEntirely = (state: EditorState, r: Range) =>
  layersOf(state).ghosts.some((g) => g.from <= r.from && g.to >= r.to);

const object = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const list = (item: object) => ({ type: "array", items: item });
const str = { type: "string" };
const int = { type: "integer" };

const VOICE =
  "You help a writer edit their own draft. The draft is Markdown: #, **, *, ~~, - and > are intentional formatting." +
  "Paragraphs are numbered like [3]. When you quote text, copy it exactly, character for character, from one paragraph.";

// ---------------------------------------------------------------------------
// 1. Alternatives for a word or sentence

export async function suggestAlternatives(state: EditorState, altId: string): Promise<string[]> {
  const r = findAlt(state, altId);
  const block = r ? blockAt(state, r.from) : null;
  if (!r || !block) return [];
  const para = state.doc.sliceString(block.from, block.to);
  const a = r.from - block.from;
  const b = r.to - block.from;
  const marked = `${para.slice(0, a)}⟦${para.slice(a, b)}⟧${para.slice(b)}`;
  const existing = syncedVariants(state, r);

  const answer = await callClaude<{ alternatives: string[] }>(
    {
      system:
        "You suggest other ways to say one part of a writer's sentence. The part is marked with ⟦ ⟧. " +
        "Each suggestion must drop in place of the marked text without changing anything around it: " +
        "same grammatical role and form (number, tense, article agreement aside), fitting the meaning and tone. " +
        "Mix close synonyms with a few that shift the nuance. Don't repeat options the writer already has.",
      prompt: `Paragraph:\n${marked}\n\nOptions the writer already has: ${existing.map((v) => `"${v}"`).join(", ")}\n\nSuggest 6 alternatives for the marked text.`,
      schema: object({ alternatives: list(str) }),
      effort: "low",
      maxTokens: 8000,
    },
    () => ({ alternatives: ["option one", "option two", "option three"] }),
  );
  return answer.alternatives;
}

// ---------------------------------------------------------------------------
// 2. Typos and punctuation, applied as alternatives (the fix active, the original kept)

interface Fix {
  paragraph: number;
  find: string;
  replace: string;
}

export async function findFixes(state: EditorState): Promise<Fix[]> {
  const paras = docParagraphs(state);
  if (!paras.length) return [];
  const answer = await callClaude<{ fixes: Fix[] }>(
    {
      system:
        `${VOICE} Find typos, misspellings, and punctuation mistakes only. Don't change word choice, style, or tone, ` +
        "and don't rephrase. For each fix, quote a short snippet (a few words, unique within its paragraph) as `find`, " +
        "and give the same snippet corrected as `replace`. Return an empty list if the draft is clean.",
      prompt: numbered(paras),
      schema: object({ fixes: list(object({ paragraph: int, find: str, replace: str })) }),
      effort: "medium",
      maxTokens: 16000,
    },
    () => mockFixes(paras),
  );
  return answer.fixes;
}

/** One transaction: each fix becomes an alternative with the fix active. */
export function applyFixes(state: EditorState, fixes: Fix[]): { spec: TransactionSpec; count: number } {
  const paras = docParagraphs(state);
  const used: Range[] = [];
  const edits: { from: number; to: number; original: string; fixed: string }[] = [];

  for (const fix of fixes) {
    const found = locate(paras, fix.paragraph, fix.find, used);
    if (!found || fix.find === fix.replace) continue;
    const change = narrowChange(fix.find, fix.replace);
    if (!change) continue;
    const start = found.from + change.start;
    const fit = fitFix(state, start, start + change.original.length, change.fixed);
    if (!fit) continue;
    const { from, to } = fit;
    if (edits.some((e) => e.from < to && e.to > from)) continue;
    used.push(found);
    edits.push({ from, to, original: state.doc.sliceString(from, to), fixed: fit.fix });
  }

  const changes = state.changes(edits.map((e) => ({ from: e.from, to: e.to, insert: e.fixed })));
  const mapped = mapLayers(layersOf(state), changes);
  const alts: Alt[] = edits.map((e) => {
    const from = changes.mapPos(e.from, -1);
    return { from, to: from + e.fixed.length, id: newId(), variants: [e.original, e.fixed], active: 1, ai: [e.fixed] };
  });
  const spec: TransactionSpec = {
    changes,
    effects: setLayers.of({ ...mapped, alts: [...mapped.alts, ...alts].sort((x, y) => x.from - y.from) }),
  };
  return { spec, count: edits.length };
}

/**
 * Shrinks "the cat sat on teh mat" → "the cat sat on the mat" to the changed
 * word ("teh" → "the"), widened to whole words so it reads as an alternative.
 */
export function narrowChange(find: string, replace: string): { start: number; original: string; fixed: string } | null {
  let start = 0;
  while (start < find.length && start < replace.length && find[start] === replace[start]) start++;
  let endF = find.length;
  let endR = replace.length;
  while (endF > start && endR > start && find[endF - 1] === replace[endR - 1]) {
    endF--;
    endR--;
  }
  const word = (c: string | undefined) => Boolean(c && /[\p{L}\p{N}'’]/u.test(c));
  while (start > 0 && word(find[start - 1])) start--;
  while (endF < find.length && word(find[endF])) {
    endF++;
    endR++;
  }
  // A pure insertion (a missing comma) needs a word to attach to.
  if (start === endF) {
    while (start > 0 && !word(find[start - 1])) start--;
    while (start > 0 && word(find[start - 1])) start--;
  }
  const original = find.slice(start, endF);
  const fixed = replace.slice(start, endR);
  return original.trim() && fixed.trim() && original !== fixed ? { start, original, fixed } : null;
}

// ---------------------------------------------------------------------------
// 3. Checks that mark text with a reason

export type CheckId = "weak" | "long" | "convoluted" | "tone" | "hedges";

export const CHECKS: { id: CheckId; label: string; title: string; ai: boolean }[] = [
  { id: "weak", label: "Weakest sentences", title: "Mark the weakest sentences", ai: true },
  { id: "long", label: "Long sentences", title: "Mark sentences that run long", ai: false },
  { id: "convoluted", label: "Convoluted sentences", title: "Mark convoluted sentences", ai: true },
  { id: "tone", label: "Off-tone words", title: "Mark words that don't fit the tone", ai: true },
  { id: "hedges", label: "Hedges and filler", title: "Mark hedges and filler", ai: true },
];

const CHECK_INSTRUCTIONS: Record<Exclude<CheckId, "long">, string> = {
  weak: "Mark the weakest sentences: ones that add little, repeat a point made elsewhere, or stay vague. Mark at most 6.",
  convoluted:
    "Mark sentences that are hard to follow on a first read: tangled structure, too many clauses, or unclear references.",
  tone:
    "First work out the tone of the whole piece. Then mark words or short phrases that don't fit it, " +
    "such as jargon or ornate words in plain writing, or slang in formal writing.",
  hedges:
    "Mark hedges and filler: words and short phrases that soften or pad without adding meaning " +
    "(for example just, really, very, sort of, I think, in order to, it's worth noting that). Mark only the hedge itself.",
};

interface MarkResult {
  paragraph: number;
  text: string;
  reason: string;
}

export async function runCheck(state: EditorState, check: CheckId): Promise<LabSpan[]> {
  if (check === "long") return longSentences(state);
  const paras = docParagraphs(state);
  if (!paras.length) return [];
  const answer = await callClaude<{ marks: MarkResult[] }>(
    {
      system:
        `${VOICE} ${CHECK_INSTRUCTIONS[check]} For each mark, quote the exact text and give a reason in under 12 words. ` +
        "Don't mark headings. Return an empty list if nothing qualifies.",
      prompt: numbered(paras),
      schema: object({ marks: list(object({ paragraph: int, text: str, reason: str })) }),
      effort: "medium",
      maxTokens: 16000,
    },
    () => ({ marks: paras.slice(1, 3).map((p) => ({ paragraph: p.n, text: p.text.split(/(?<=\.)\s/)[0], reason: "Mock reason" })) }),
  );
  const used: Range[] = [];
  const spans: LabSpan[] = [];
  for (const m of answer.marks) {
    const r = locate(paras, m.paragraph, m.text, used);
    if (!r || isHeading(state, r.from)) continue;
    used.push(r);
    spans.push({ ...r, reason: m.reason });
  }
  return spans;
}

/** No AI needed: sentences over `limit` words. */
export function longSentences(state: EditorState, limit = 30): LabSpan[] {
  const spans: LabSpan[] = [];
  for (const p of docParagraphs(state)) {
    if (/^#{1,6}\s/.test(p.text)) continue;
    for (const m of p.text.matchAll(/[^.!?\n]+(?:[.!?]+["'”’)\]]*|$)/g)) {
      const words = m[0].match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
      if (words <= limit) continue;
      const lead = m[0].length - m[0].trimStart().length;
      const from = p.pos + m.index + lead;
      spans.push({ from, to: p.pos + m.index + m[0].trimEnd().length, reason: `${words} words` });
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// 4. Trim: Claude picks text to delete, never rewrites

export const TRIMS = [
  { id: "slight", label: "Slight trim", percent: 10 },
  { id: "tighten", label: "Tighten more", percent: 20 },
  { id: "sharper", label: "Even sharper", percent: 35 },
  { id: "half", label: "Cut in half", percent: 50 },
] as const;

export type TrimId = (typeof TRIMS)[number]["id"];

export async function proposeTrim(state: EditorState, percent: number): Promise<LabSpan[]> {
  const paras = docParagraphs(state);
  const total = countWords(state).words;
  if (!paras.length || !total) return [];
  const target = Math.max(1, Math.round((total * percent) / 100));
  const answer = await callClaude<{ cuts: { paragraph: number; text: string }[] }>(
    {
      system:
        `${VOICE} Tighten the draft by choosing text to delete. Never rewrite or add words: only pick exact, ` +
        "contiguous spans to remove. After every cut in a paragraph, what remains must still read correctly, " +
        "so include a neighbouring comma or space in a cut when that keeps the punctuation clean. " +
        "Cut filler, hedges, repetition, and asides before substance. Don't cut headings.",
      prompt: `Cut about ${target} words (${percent}% of ${total}).\n\n${numbered(paras)}`,
      schema: object({ cuts: list(object({ paragraph: int, text: str })) }),
      effort: percent >= 35 ? "high" : "medium",
      maxTokens: 32000,
    },
    () => ({ cuts: mockCuts(paras) }),
  );
  const used: Range[] = [];
  const spans: LabSpan[] = [];
  for (const c of answer.cuts) {
    const r = locate(paras, c.paragraph, c.text, used);
    if (!r || isHeading(state, r.from) || ghostedEntirely(state, r)) continue;
    used.push(r);
    spans.push(r);
  }
  return spans.sort((a, b) => a.from - b.from);
}

export function wordsIn(state: EditorState, spans: LabSpan[]): number {
  return spans.reduce(
    (sum, s) => sum + (state.doc.sliceString(s.from, s.to).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// 5. Writing issues: grammar and style, marked pink in Review, each with a fix

export interface WritingAnswer {
  paragraph: number;
  find: string;
  replace: string;
  reason: string;
}

/**
 * Claude's answer quotes the page. The page may change while Claude works, so place the answer
 * with writingIssuesFrom on the page as it is when the answer comes.
 */
export async function findWritingIssues(state: EditorState): Promise<WritingAnswer[]> {
  const paras = docParagraphs(state);
  if (!paras.length) return [];
  const answer = await callClaude<{ issues: WritingAnswer[] }>(
    {
      system:
        `${VOICE} Find writing issues: grammar, spelling, punctuation, a wrong or missing word, a broken idiom, ` +
        "a sentence fragment, or words that don't agree. Don't flag style choices that are correct, and don't " +
        "rewrite for taste. Don't flag headings. For each issue, quote a short snippet (a few words, unique within " +
        "its paragraph) as `find`, give the same snippet corrected as `replace`, and a reason in under 10 words. " +
        "Mark at most 30. Return an empty list if there are none.",
      prompt: numbered(paras),
      schema: object({ issues: list(object({ paragraph: int, find: str, replace: str, reason: str })) }),
      effort: "medium",
      maxTokens: 16000,
    },
    () => ({ issues: mockWritingIssues(paras) }),
  );
  return answer.issues;
}

/**
 * Finds each quote on the page and marks the words that change, with the fix for them. A change
 * with no word to swap, such as a deletion, marks the whole quote. Headings, ghosts, and code are
 * skipped.
 */
export function writingIssuesFrom(state: EditorState, answers: WritingAnswer[]): WritingIssue[] {
  const paras = docParagraphs(state);
  const used: Range[] = [];
  const issues: WritingIssue[] = [];
  for (const a of answers) {
    if (a.find === a.replace) continue;
    const found = locate(paras, a.paragraph, a.find, used);
    if (!found || isHeading(state, found.from) || ghostedEntirely(state, found) || touchesCode(state, found.from, found.to)) continue;
    used.push(found);
    const change = narrowChange(a.find, a.replace);
    const from = found.from + (change?.start ?? 0);
    const to = change ? from + change.original.length : found.to;
    issues.push({ from, to, kind: "grammar", note: a.reason, fix: change ? change.fixed : a.replace });
  }
  return issues.sort((x, y) => x.from - y.from);
}

// ---------------------------------------------------------------------------
// 6. Rewrites of a marked sentence, from Review's popover

/** What a rewrite must fix, by the kind of mark it is for. */
const REWRITE_GOALS: Partial<Record<Kind, string>> = {
  passive:
    "Put it in the active voice: name who or what acts. If the paragraph doesn't say who acts, choose a " +
    "fitting subject, or recast the sentence so its subject acts, as in “The door swung shut”.",
  hard: "Make it easier to read: fewer words, plainer words, or two sentences.",
  veryHard: "Make it easier to read: fewer words, plainer words, or two sentences.",
  hidden: "Use a plain verb in place of the noun that hides the action, as “decided” for “made a decision”.",
};

/** How the prompt names each kind of mark. */
const MARK_NAMES: Partial<Record<Kind, string>> = { passive: "passive voice", hidden: "a hidden action" };

/**
 * What Claude is asked for a rewrite of the alternative `altId`: the paragraph with it marked, the
 * goal, the words the checks flagged when they are only part of it, and the rewrites it has.
 */
export function rewritePrompt(state: EditorState, altId: string, kind: Kind, phrase: string): { system: string; prompt: string } | null {
  const r = findAlt(state, altId);
  const block = r ? blockAt(state, r.from) : null;
  if (!r || !block) return null;
  const para = state.doc.sliceString(block.from, block.to);
  const a = r.from - block.from;
  const b = r.to - block.from;
  const marked = `${para.slice(0, a)}⟦${para.slice(a, b)}⟧${para.slice(b)}`;
  const flagged = MARK_NAMES[kind] && phrase !== para.slice(a, b) ? ` The checks flagged “${phrase}” as ${MARK_NAMES[kind]}.` : "";
  const others = syncedVariants(state, r).filter((v) => v !== para.slice(a, b));
  return {
    system:
      `${VOICE} Rewrite the part of the writer's paragraph marked with ⟦ ⟧. ${REWRITE_GOALS[kind] ?? ""}${flagged} ` +
      "Keep its meaning, facts, and tone, and add nothing new. Each rewrite replaces the marked text on its own, " +
      "on one line. Make them differ from each other, and from the rewrites the writer has already.",
    prompt:
      `Paragraph:\n${marked}\n\nRewrites the writer has already: ${others.length ? others.map((v) => `“${v}”`).join(", ") : "none"}.\n\n` +
      "Suggest 6 rewrites of the marked text.",
  };
}

/** Claude's rewrites of the marked text, aimed at what the mark is about. */
export async function suggestRewrites(state: EditorState, altId: string, kind: Kind, phrase: string): Promise<string[]> {
  const ask = rewritePrompt(state, altId, kind, phrase);
  if (!ask) return [];
  const answer = await callClaude<{ rewrites: string[] }>(
    {
      ...ask,
      schema: object({ rewrites: list(str) }),
      effort: "low",
      maxTokens: 8000,
    },
    () => ({ rewrites: ["Someone closed it.", "It was closed.", "It swung shut."] }),
  );
  return answer.rewrites;
}

/** Whether a text still has the issue a mark was about. Hard and very hard count as one. */
function stillHas(kind: Kind, text: string): boolean {
  const sentence = (k: Kind) => k === "hard" || k === "veryHard";
  return checkPage(text).issues.some((i) => i.kind === kind || (sentence(kind) && sentence(i.kind)));
}

/**
 * Adds Claude's rewrites to the alternative, keeping only those the live checks no longer mark the
 * same way: a rewrite of passive voice with passive voice left is dropped. Null when none is left.
 */
export function addRewrites(state: EditorState, altId: string, kind: Kind, texts: string[]): TransactionSpec | null {
  return addAiAlternatives(state, altId, texts.filter((t) => !stillHas(kind, t)));
}

// ---------------------------------------------------------------------------
// Development mocks (plain browser only)

function mockFixes(paras: DocParagraph[]): { fixes: Fix[] } {
  const fixes: Fix[] = [];
  for (const p of paras) {
    for (const m of p.text.matchAll(/\bteh\b/g)) fixes.push({ paragraph: p.n, find: m[0], replace: "the" });
  }
  return { fixes };
}

/** A doubled word, and "And" at the start of a sentence. */
function mockWritingIssues(paras: DocParagraph[]): WritingAnswer[] {
  const issues: WritingAnswer[] = [];
  for (const p of paras) {
    for (const m of p.text.matchAll(/\b(\w+) \1\b/g)) {
      issues.push({ paragraph: p.n, find: m[0], replace: m[1], reason: "The same word twice." });
    }
    for (const m of p.text.matchAll(/(?:^|[.!?] )And (\w+)/g)) {
      const find = m[0].replace(/^[.!?] /, "");
      const word = m[1][0].toUpperCase() + m[1].slice(1);
      issues.push({ paragraph: p.n, find, replace: word, reason: "A sentence that starts with And." });
    }
  }
  return issues;
}

function mockCuts(paras: DocParagraph[]): { paragraph: number; text: string }[] {
  const cuts: { paragraph: number; text: string }[] = [];
  for (const p of paras) {
    for (const m of p.text.matchAll(/ (?:just|really|very|too|then)\b/g)) cuts.push({ paragraph: p.n, text: m[0] });
  }
  return cuts;
}
