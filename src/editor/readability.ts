// Readability checks that run on the page's plain text as you type: sentences that are hard to
// read, weakeners, and words with a simpler alternative. The rules are for English. No editor
// code and no network, so the tests run on plain strings.
//
// The grade is the Automated Readability Index: 4.71 × letters/words + 0.5 × words/sentences −
// 21.43, rounded. A sentence of 14 or more words is hard at grade 10 and very hard at 14.

// "grammar" comes from Claude, on request (src/ai/tasks.ts). The rest come from here.
export const KINDS = [
  "veryHard",
  "hard",
  "adverb",
  "passive",
  "qualifier",
  "intensifier",
  "weakVerb",
  "filler",
  "hidden",
  "negative",
  "simpler",
  "grammar",
] as const;
export type Kind = (typeof KINDS)[number];

export interface Issue {
  from: number;
  to: number;
  kind: Kind;
  /** Why it's marked, e.g. "Very hard to read. 38 words." */
  note: string;
}

export interface Report {
  /** In page order. A sentence comes before the words marked inside it. */
  issues: Issue[];
  /** Weakener marks, each counted once: "really" is an intensifier and an adverb, but one mark. */
  weakeners: number;
  /** Counts for the prose only: no headings, code, or link addresses. */
  words: number;
  letters: number;
  sentences: number;
  /** The page's grade, or null when it has no prose. */
  grade: number | null;
}

interface Span {
  from: number;
  to: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const LETTER = /[\p{L}\p{N}]/gu;

const ari = (letters: number, words: number, sentences: number) =>
  Math.max(0, Math.round(4.71 * (letters / words) + (0.5 * words) / sentences - 21.43));

// ---------------------------------------------------------------------------
// Prose blocks

/** Lines that hold no prose: headings, rules, tables, HTML, and link definitions. */
const NOT_PROSE = /^ {0,3}(?:#{1,6}(?:\s|$)|([-*_])(?:\s*\1){2,}\s*$|=+\s*$|\||<|\[[^\]]+\]:\s)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line under a paragraph that makes it a heading. */
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const INDENTED = /^(?: {4}|\t)/;
const QUOTE = /^\s*(?:>\s?)*/;
const ITEM = /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;
/** Inline markup that holds no prose: code, images, link addresses, HTML tags, and bare URLs. */
const INLINE = /(`+)[\s\S]*?\1|!\[[^\]]*\]\([^)]*\)|\]\([^)]*\)|<[^>\n]*>|\bhttps?:\/\/\S+/g;

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/**
 * Splits the page into paragraphs, list items, and quotes. Each block's text has the same length
 * as the page text it covers, with markup blanked out, so an offset in it is an offset in the page.
 */
function proseBlocks(page: string): { from: number; text: string }[] {
  const blocks: { from: number; text: string }[] = [];
  let start = -1;
  let lines: string[] = [];
  const flush = () => {
    if (start >= 0) blocks.push({ from: start, text: lines.join("\n").replace(INLINE, blank) });
    start = -1;
    lines = [];
  };
  let fence: string | null = null;
  // A paragraph that a setext line can turn into a heading. In a list, an indented line is prose.
  let plain = false;
  let inList = false;
  let pos = 0;
  for (const line of page.split("\n")) {
    const at = pos;
    pos += line.length + 1;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
      continue;
    }
    // A block that starts at the left edge ends a list.
    const edge = !/^\s/.test(line);
    if (f) {
      flush();
      fence = f[1];
      if (edge) inList = false;
      continue;
    }
    if (start >= 0 && plain && SETEXT.test(line)) {
      start = -1;
      lines = [];
      continue;
    }
    if (!line.trim() || NOT_PROSE.test(line)) {
      flush();
      if (line.trim() && edge) inList = false;
      continue;
    }
    // Indented code can't break into a paragraph, but it can start a block.
    if (start < 0 && !inList && INDENTED.test(line)) continue;
    const quote = QUOTE.exec(line)![0].length;
    const item = ITEM.exec(line.slice(quote));
    if (item) flush();
    const lead = quote + (item ? item[0].length : 0);
    const quoted = line.slice(0, quote).includes(">");
    if (start < 0) {
      start = at;
      plain = !item && !quoted;
      inList = Boolean(item) || (inList && INDENTED.test(line));
    } else if (quoted) plain = false;
    lines.push(" ".repeat(lead) + line.slice(lead));
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Sentences

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "cf", "approx", "dept", "inc", "ltd", "mt"]);
/** Abbreviations that are also words, such as "no": they only count before a number, as in "No. 5". */
const BEFORE_NUMBERS = new Set(["no", "fig", "vol", "p", "pp", "ch", "sec"]);

/** Where each sentence starts and ends in `text`, without the space around it. */
export function sentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  const push = (to: number) => {
    const from = start + (text.slice(start, to).length - text.slice(start, to).trimStart().length);
    if (from < to && WORD.test(text.slice(from, to))) out.push({ from, to });
    WORD.lastIndex = 0;
    start = to;
  };
  for (const m of text.matchAll(/[.!?]+["'”’)\]*_]*(?=\s|$)/g)) {
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 8);
    // "p.m. on": the sentence goes on.
    if (/^\s+\p{Ll}/u.test(after)) continue;
    if (m[0][0] === "." && m[0].length === 1) {
      const token = (/[\p{L}.]+$/u.exec(text.slice(Math.max(start, m.index - 12), m.index))?.[0] ?? "").toLowerCase();
      // "Mr. Smith", "No. 5", "J. K. Rowling", "e.g. This".
      if (ABBREVIATIONS.has(token) || (BEFORE_NUMBERS.has(token) && /^\s+\d/.test(after))) continue;
      if (token.length === 1 || token.includes(".")) continue;
    }
    push(end);
  }
  push(text.trimEnd().length);
  return out;
}

// ---------------------------------------------------------------------------
// Words

// The weakener lists follow what Hemingway's web editor marked on test sentences, in October 2026.
// They are short on purpose: a mark that is often wrong teaches you to ignore the marks.

/** Matches any of the phrases as whole words, in any case. A space matches any run of space. */
const phrases = (list: string[]) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}'’-])(?:${list
      .sort((a, b) => b.length - a.length)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+").replace(/'/g, "['’]"))
      .join("|")})(?![\\p{L}\\p{N}'’-])`,
    "giu",
  );

/** The form a phrase is listed under: lower case, single spaces, straight apostrophes. */
const key = (match: string) => match.toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'");

const QUALIFIERS = phrases(["I think", "I believe", "I feel", "in my opinion", "maybe", "perhaps", "possibly", "just"]);

const INTENSIFIERS = phrases([
  "very", "really", "extremely", "totally", "absolutely", "completely", "incredibly", "utterly", "entirely",
  "remarkably", "exceptionally", "hugely",
]);

const FILLERS = phrases([
  "basically", "essentially", "of course", "needless to say", "it goes without saying", "it is worth noting",
  "it should be noted", "it is important to note",
]);

/** Word or phrase → the plainer one. A single word also matches its -s, -ed, and -ing forms. */
const SIMPLER: Record<string, string> = {
  "a majority of": "most", "a number of": "some", accomplish: "do", acquire: "get", additional: "more",
  adequate: "enough", anticipate: "expect", approximately: "about", ascertain: "find out", assist: "help",
  assistance: "help", "at this point in time": "now", attempt: "try", beneficial: "helpful", commence: "start",
  component: "part", consequently: "so", construct: "build", demonstrate: "show", "due to the fact that": "because",
  eliminate: "cut", endeavor: "try", expedite: "speed up", facilitate: "help", finalize: "finish", frequently: "often",
  "in order to": "to", "in spite of the fact that": "although", "in the event that": "if",
  "in the near future": "soon", indicate: "show", initial: "first", initiate: "start",
  leverage: "use", magnitude: "size", methodology: "method", modify: "change", "not many": "few", "not often": "rarely",
  numerous: "many", objective: "aim", obtain: "get", "on a daily basis": "daily", optimal: "best",
  participate: "take part", portion: "part",
  possess: "have", "prior to": "before", purchase: "buy", regarding: "about", remainder: "rest", retain: "keep",
  "subsequent to": "after", subsequently: "later", sufficient: "enough", terminate: "end", transmit: "send",
  utilise: "use", utilization: "use", utilize: "use", "with regard to": "about", "with respect to": "about",
};

/** Verbs whose forms don't follow the rule in `verbForms`: -s, past, -ing, and past participle. */
const IRREGULAR_VERBS: Record<string, string> = {
  carry: "carries carried carrying carried", come: "comes came coming come", creep: "creeps crept creeping crept",
  drink: "drinks drank drinking drunk", eat: "eats ate eating eaten", give: "gives gave giving given",
  have: "has had having had", hurry: "hurries hurried hurrying hurried", make: "makes made making made",
  reach: "reaches reached reaching reached", run: "runs ran running run", rush: "rushes rushed rushing rushed",
  say: "says said saying said", slam: "slams slammed slamming slammed", snap: "snaps snapped snapping snapped",
  speak: "speaks spoke speaking spoken", take: "takes took taking taken", tiptoe: "tiptoes tiptoed tiptoeing tiptoed",
  tread: "treads trod treading trodden",
};

/** A verb's base, -s, past, -ing, and past participle forms. */
function verbForms(base: string): string[] {
  const irregular = IRREGULAR_VERBS[base];
  if (irregular) return [base, ...irregular.split(" ")];
  const past = base.endsWith("e") ? `${base}d` : `${base}ed`;
  return [base, `${base}s`, past, `${base.replace(/e$/, "")}ing`, past];
}
const BE = ["am", "is", "are", "was", "were", "be", "been", "being"];

// Weak verbs: a plain verb and an adverb that one stronger verb replaces, as in "walked slowly".
const WEAK_PAIRS =
  "run quickly: sprint, walk quickly: hurry, walk slowly: stroll, walk quietly: tiptoe, walk carefully: tread, " +
  "eat quickly: gobble, move quickly: rush, move slowly: creep, look quickly: glance, look angrily: glare, " +
  "drink quickly: gulp, say loudly: shout, say softly: murmur, say quietly: whisper, say angrily: snap, " +
  "speak loudly: shout, speak softly: whisper, speak quietly: whisper, talk loudly: shout, talk quietly: whisper, " +
  "close loudly: slam, laugh loudly: guffaw, laugh quietly: chuckle";
/** "walked slowly" → "strolled": the stronger verb, in the same form. */
const WEAK_VERB_FORMS = new Map<string, string>();
for (const pair of WEAK_PAIRS.split(", ")) {
  const [, verb, adverb, stronger] = pair.match(/^(\S+) (\S+): (\S+)$/)!;
  const strong = verbForms(stronger);
  verbForms(verb).forEach((form, i) => {
    // "Run" is the base and the participle: the base wins.
    if (!WEAK_VERB_FORMS.has(`${form} ${adverb}`)) WEAK_VERB_FORMS.set(`${form} ${adverb}`, strong[i]);
  });
}
const WEAK_VERBS = phrases([...WEAK_VERB_FORMS.keys()]);

// Hidden actions: a verb and a noun that hide a plainer verb, as in "made a decision".
const HIDDEN_ACTIONS =
  "make a decision: decide, reach a decision: decide, reach an agreement: agree, reach a conclusion: conclude, " +
  "come to a conclusion: conclude, give consideration to: consider, take into consideration: consider, " +
  "conduct an analysis: analyze, perform an analysis: analyze, make a recommendation: recommend, " +
  "make a suggestion: suggest, make a payment: pay, make use of: use, make a choice: choose, take action: act, " +
  "have the ability to: can, be able to: can, be in agreement with: agree with, have knowledge of: know, " +
  "make an announcement: announce, carry out a review: review, be dependent on: depend on, " +
  "be indicative of: indicate";
const HIDDEN_FORMS = new Map<string, string>();
for (const action of HIDDEN_ACTIONS.split(", ")) {
  const [, verb, rest, plain] = action.match(/^(\S+) (.+): (.+)$/)!;
  for (const form of verb === "be" ? BE : verbForms(verb)) HIDDEN_FORMS.set(`${form} ${rest}`, plain);
}
const HIDDEN = phrases([...HIDDEN_FORMS.keys()]);

// Negatives that one positive word says: "does not have" → "lacks".
const NEGATED_VERBS: Record<string, string> = {
  have: "lacks lack lacked", include: "excludes exclude excluded", remember: "forgets forget forgot",
  accept: "rejects reject rejected", succeed: "fails fail failed", notice: "overlooks overlook overlooked",
  agree: "disagrees disagree disagreed", "pay attention to": "ignores ignore ignored",
};
const NEGATIVE_FORMS = new Map([
  ["not able to", "unable to"],
  ["not possible", "impossible"],
  ["not certain", "uncertain"],
  ["not honest", "dishonest"],
  ["not unlike", "like"],
]);
for (const [verb, plain] of Object.entries(NEGATED_VERBS)) {
  const [does, doBase, did] = plain.split(" ");
  for (const [aux, word] of [["does", does], ["do", doBase], ["did", did]]) {
    NEGATIVE_FORMS.set(`${aux} not ${verb}`, word);
    NEGATIVE_FORMS.set(`${aux}n't ${verb}`, word);
  }
}
const NEGATIVE = phrases([...NEGATIVE_FORMS.keys()]);

/** A word's forms, and some that don't exist, which never match. */
function forms(word: string): string[] {
  if (word.includes(" ")) return [word];
  if (word.endsWith("e")) return [word, `${word}s`, `${word}d`, `${word.slice(0, -1)}ing`];
  if (/[^aeiou]y$/.test(word)) return [word, `${word.slice(0, -1)}ies`, `${word.slice(0, -1)}ied`, `${word}ing`];
  const out = [word, `${word}s`, `${word}es`, `${word}ed`, `${word}ing`];
  // One vowel before the last consonant may double it: transmit, transmitted.
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(word)) out.push(`${word}${word.at(-1)}ed`, `${word}${word.at(-1)}ing`);
  return out;
}

const SIMPLER_FORMS = new Map(Object.entries(SIMPLER).flatMap(([word, plain]) => forms(word).map((f) => [f, plain])));
const SIMPLER_WORDS = phrases([...SIMPLER_FORMS.keys()]);

const ADVERB = /(?<![\p{L}\p{N}'’-])\p{L}+ly(?![\p{L}\p{N}'’-])/giu;
/** Words that end in -ly but are not adverbs, or that Hemingway leaves alone. */
const NOT_ADVERBS = new Set(
  (
    "only early daily weekly monthly yearly hourly nightly family reply apply supply comply imply rely ally rally " +
    "tally belly bully jelly lily fly butterfly holy ugly silly lonely lovely friendly unfriendly likely unlikely " +
    "elderly costly deadly lively curly oily hilly chilly wily italy july emily kelly sally molly holly assembly " +
    "anomaly monopoly homily folly jolly melancholy " +
    "usually finally recently rarely generally especially exactly currently actually approximately hardly " +
    "immediately unfortunately definitely awfully completely"
  ).split(" "),
);

const IRREGULAR =
  "known done made given taken written seen built held told found kept left lost paid said sent shown sold taught " +
  "thought brought bought caught chosen driven eaten fallen forgotten forgiven gotten hidden born borne broken " +
  "beaten begun bitten blown drawn drunk flown frozen grown hung hurt laid led lent meant met put set shut spent " +
  "spoken stolen struck sung thrown torn understood woken won worn bound cast cut felt fought heard hit shaken shot " +
  "sought split spread stuck sworn swept withdrawn mistaken misled misunderstood";
const PASSIVE = new RegExp(
  `(?<![\\p{L}'’-])(?:am|is|are|was|were|be|been|being)\\s+(?:\\p{L}+ly\\s+)?(\\p{L}+ed|${IRREGULAR.replace(/ /g, "|")})(?![\\p{L}'’-])`,
  "giu",
);
/** Words that end in -ed but are not past participles. */
const NOT_PARTICIPLES = new Set(
  "need bed red shed seed feed speed breed greed weed deed creed steed indeed hundred sacred naked wicked rugged ragged".split(" "),
);

const NOTES: Record<"adverb" | "passive" | "qualifier" | "intensifier" | "filler", string> = {
  adverb: "Adverb. Cut it if the sentence holds without it.",
  passive: "Passive voice. Say who does it.",
  qualifier: "Qualifier. It softens the point.",
  intensifier: "Intensifier. It rarely adds strength.",
  filler: "Filler. It adds words, not meaning.",
};

/**
 * Marks in one block. Weakeners and simpler words never overlap each other. Adverbs and passive voice
 * may: "really" is an intensifier and an adverb, as Hemingway counts it.
 */
function wordIssues(text: string): { issues: Issue[]; weakeners: number } {
  const candidates: Issue[] = [];
  const add = (re: RegExp, kind: Kind, note: (match: string) => string | null) => {
    for (const m of text.matchAll(re)) {
      const n = note(m[0]);
      if (n) candidates.push({ from: m.index, to: m.index + m[0].length, kind, note: n });
    }
  };
  // Earlier in the list wins when two start at the same place and have the same length.
  add(FILLERS, "filler", () => NOTES.filler);
  add(QUALIFIERS, "qualifier", () => NOTES.qualifier);
  add(INTENSIFIERS, "intensifier", () => NOTES.intensifier);
  add(HIDDEN, "hidden", (m) => `Hidden action. Try “${HIDDEN_FORMS.get(key(m))}”.`);
  add(NEGATIVE, "negative", (m) => `Negative. Try “${NEGATIVE_FORMS.get(key(m))}”.`);
  add(WEAK_VERBS, "weakVerb", (m) => `Weak verb. Try “${WEAK_VERB_FORMS.get(key(m))}”.`);
  add(SIMPLER_WORDS, "simpler", (m) => `Simpler: ${SIMPLER_FORMS.get(key(m))}.`);
  candidates.sort((a, b) => a.from - b.from || b.to - a.to);

  const kept: Issue[] = [];
  for (const c of candidates) {
    const last = kept[kept.length - 1];
    if (!last || c.from >= last.to) kept.push(c);
  }
  const marks = [...kept];
  let shared = 0;
  for (const m of text.matchAll(ADVERB)) {
    if (NOT_ADVERBS.has(m[0].toLowerCase())) continue;
    const holder = marks.find((i) => i.from <= m.index && m.index < i.to);
    // A word with a simpler alternative is marked once, as that.
    if (holder?.kind === "simpler") continue;
    if (holder) shared++;
    kept.push({ from: m.index, to: m.index + m[0].length, kind: "adverb", note: NOTES.adverb });
  }
  for (const m of text.matchAll(PASSIVE)) {
    if (NOT_PARTICIPLES.has(m[1].toLowerCase())) continue;
    kept.push({ from: m.index, to: m.index + m[0].length, kind: "passive", note: NOTES.passive });
  }
  return { issues: kept, weakeners: kept.filter((i) => i.kind !== "simpler").length - shared };
}

// ---------------------------------------------------------------------------
// The page

interface BlockResult {
  issues: Issue[];
  weakeners: number;
  words: number;
  letters: number;
  sentences: number;
}

function checkBlock(text: string): BlockResult {
  const result: BlockResult = { issues: [], weakeners: 0, words: 0, letters: 0, sentences: 0 };
  for (const s of sentences(text)) {
    const sentence = text.slice(s.from, s.to);
    const words = sentence.match(WORD)?.length ?? 0;
    const letters = sentence.match(LETTER)?.length ?? 0;
    result.words += words;
    result.letters += letters;
    result.sentences += 1;
    if (words < 14) continue;
    const grade = ari(letters, words, 1);
    if (grade >= 14) result.issues.push({ ...s, kind: "veryHard", note: `Very hard to read. ${words} words.` });
    else if (grade >= 10) result.issues.push({ ...s, kind: "hard", note: `Hard to read. ${words} words.` });
  }
  const marks = wordIssues(text);
  result.issues.push(...marks.issues);
  result.weakeners = marks.weakeners;
  return result;
}

// Most keystrokes change one block. The rest come from the last page's results, and only those are
// kept, so the cache never outgrows the page.
let seen = new Map<string, BlockResult>();

export function checkPage(page: string): Report {
  const report: Report = { issues: [], weakeners: 0, words: 0, letters: 0, sentences: 0, grade: null };
  const kept = new Map<string, BlockResult>();
  for (const block of proseBlocks(page)) {
    const result = seen.get(block.text) ?? kept.get(block.text) ?? checkBlock(block.text);
    kept.set(block.text, result);
    for (const i of result.issues) report.issues.push({ ...i, from: i.from + block.from, to: i.to + block.from });
    report.weakeners += result.weakeners;
    report.words += result.words;
    report.letters += result.letters;
    report.sentences += result.sentences;
  }
  seen = kept;
  report.issues.sort((a, b) => a.from - b.from || b.to - a.to);
  if (report.words) report.grade = ari(report.letters, report.words, report.sentences);
  return report;
}
