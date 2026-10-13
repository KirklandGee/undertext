import { Node } from "prosemirror-model";
import { EditorState, Transaction } from "prosemirror-state";
import { countWords, findAltById } from "../editor/commands";
import { LabSpan } from "../editor/lab";
import { newId, schema } from "../editor/schema";
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

function docParagraphs(doc: Node): DocParagraph[] {
  const out: DocParagraph[] = [];
  let n = 0;
  doc.forEach((p, offset) => {
    n++;
    // Hard breaks become "\n", so every character maps to one document position.
    const text = p.textBetween(0, p.content.size, undefined, "\n");
    if (text.trim()) out.push({ n, pos: offset + 1, text });
  });
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

const isHeading = (state: EditorState, pos: number) => /^#{1,6}\s/.test(state.doc.resolve(pos).parent.textContent);

const ghostedEntirely = (state: EditorState, r: Range) => {
  let all = true;
  state.doc.nodesBetween(r.from, r.to, (node) => {
    if (node.isText && !schema.marks.ghost.isInSet(node.marks)) all = false;
  });
  return all;
};

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
  "You help a writer edit their own draft. The draft is Markdown: #, **, *, - and > are intentional formatting. " +
  "Paragraphs are numbered like [3]. When you quote text, copy it exactly, character for character, from one paragraph.";

// ---------------------------------------------------------------------------
// 1. Alternatives for a word or sentence

export async function suggestAlternatives(state: EditorState, altId: string): Promise<string[]> {
  const r = findAltById(state.doc, altId);
  if (!r) return [];
  const $from = state.doc.resolve(r.from);
  const start = $from.start();
  const para = $from.parent.textBetween(0, $from.parent.content.size, undefined, "\n");
  const a = r.from - start;
  const b = r.to - start;
  const marked = `${para.slice(0, a)}⟦${para.slice(a, b)}⟧${para.slice(b)}`;
  const existing: string[] = [...r.mark.attrs.variants];
  existing[r.mark.attrs.active] = state.doc.textBetween(r.from, r.to);

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
  const paras = docParagraphs(state.doc);
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
export function applyFixes(state: EditorState, fixes: Fix[]): { tr: Transaction; count: number } {
  const paras = docParagraphs(state.doc);
  const used: Range[] = [];
  const edits: { from: number; to: number; original: string; fixed: string }[] = [];

  for (const fix of fixes) {
    const found = locate(paras, fix.paragraph, fix.find, used);
    if (!found || fix.find === fix.replace) continue;
    const change = narrowChange(fix.find, fix.replace);
    if (!change) continue;
    const from = found.from + change.start;
    const to = from + change.original.length;
    if (state.doc.rangeHasMark(from, to, schema.marks.alt)) continue;
    used.push(found);
    edits.push({ from, to, original: change.original, fixed: change.fixed });
  }

  const tr = state.tr;
  for (const e of edits.sort((x, y) => y.from - x.from)) {
    const marks = (state.doc.nodeAt(e.from)?.marks ?? []).filter((m) => m.type !== schema.marks.alt);
    const alt = schema.marks.alt.create({
      id: newId(),
      variants: [e.original, e.fixed],
      active: 1,
      ai: [e.fixed],
    });
    tr.replaceWith(e.from, e.to, schema.text(e.fixed, alt.addToSet(marks)));
  }
  return { tr, count: edits.length };
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
  const paras = docParagraphs(state.doc);
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
  for (const p of docParagraphs(state.doc)) {
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
  const paras = docParagraphs(state.doc);
  const total = countWords(state.doc).words;
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
    (sum, s) => sum + (state.doc.textBetween(s.from, s.to, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0),
    0,
  );
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

function mockCuts(paras: DocParagraph[]): { paragraph: number; text: string }[] {
  const cuts: { paragraph: number; text: string }[] = [];
  for (const p of paras) {
    for (const m of p.text.matchAll(/ (?:just|really|very|too|then)\b/g)) cuts.push({ paragraph: p.n, text: m[0] });
  }
  return cuts;
}
