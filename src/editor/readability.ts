// Readability checks that run on the page's plain text as you type: sentences that are hard to
// read, weakeners, and words with a simpler alternative. The rules are for English. No editor
// code and no network, so the tests run on plain strings.
//
// The grade is the Automated Readability Index: 4.71 × letters/words + 0.5 × words/sentences −
// 21.43, rounded. A sentence of 14 or more words is hard at grade 10 and very hard at 14.

export const KINDS = ["veryHard", "hard", "adverb", "passive", "qualifier", "intensifier", "filler", "simpler"] as const;
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
  let pos = 0;
  for (const line of page.split("\n")) {
    const at = pos;
    pos += line.length + 1;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
      continue;
    }
    if (f) {
      flush();
      fence = f[1];
      continue;
    }
    if (!line.trim() || NOT_PROSE.test(line)) {
      flush();
      continue;
    }
    const quote = QUOTE.exec(line)![0].length;
    const item = ITEM.exec(line.slice(quote));
    if (item) flush();
    const lead = quote + (item ? item[0].length : 0);
    if (start < 0) start = at;
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

/**
 * Matches any of the phrases as whole words, in any case. A space matches any run of space. `raw`
 * holds patterns that are already regular expressions.
 */
const phrases = (list: string[], raw: string[] = []) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}'’-])(?:${[
      ...raw,
      ...list
        .sort((a, b) => b.length - a.length)
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+").replace(/'/g, "['’]")),
    ].join("|")})(?![\\p{L}\\p{N}'’-])`,
    "giu",
  );

const QUALIFIERS = phrases(
  [
    "I think", "I believe", "I feel", "I guess", "I suppose", "in my opinion", "maybe", "perhaps", "possibly",
    "probably", "presumably", "apparently", "seemingly", "arguably", "somewhat", "fairly", "quite", "just",
    "more or less", "to some extent",
  ],
  // "Rather than" and "what kind of" are not hedges.
  ["rather(?!\\s+than)", "(?<!(?:what|this|that|the|any|some|every|which|one)\\s+)(?:sort|kind)\\s+of"],
);

const INTENSIFIERS = phrases([
  "very", "really", "extremely", "totally", "absolutely", "completely", "incredibly", "highly", "truly", "utterly",
  "entirely", "literally", "seriously", "awfully", "terribly", "insanely", "hugely", "remarkably", "exceptionally",
]);

const FILLERS = phrases([
  "basically", "actually", "essentially", "honestly", "obviously", "of course", "needless to say",
  "it goes without saying", "you know", "as a matter of fact", "at the end of the day", "for all intents and purposes",
  "the fact that", "it is worth noting that", "it's worth noting that", "it should be noted that",
  "it is important to note that", "in terms of", "all things considered",
]);

/** Word or phrase → the plainer one. A single word also matches its -s, -ed, and -ing forms. */
const SIMPLER: Record<string, string> = {
  "a majority of": "most", "a number of": "some", accomplish: "do", acquire: "get", additional: "more",
  adequate: "enough", anticipate: "expect", approximately: "about", ascertain: "find out", assist: "help",
  assistance: "help", "at this point in time": "now", attempt: "try", beneficial: "helpful", commence: "start",
  component: "part", consequently: "so", construct: "build", demonstrate: "show", "due to the fact that": "because",
  eliminate: "cut", endeavor: "try", expedite: "speed up", facilitate: "help", finalize: "finish", frequently: "often",
  "has the ability to": "can", "in order to": "to", "in spite of the fact that": "although", "in the event that": "if",
  "in the near future": "soon", indicate: "show", initial: "first", initiate: "start", "is able to": "can",
  leverage: "use", magnitude: "size", methodology: "method", modify: "change", numerous: "many", objective: "aim",
  obtain: "get", "on a daily basis": "daily", optimal: "best", participate: "take part", portion: "part",
  possess: "have", "prior to": "before", purchase: "buy", regarding: "about", remainder: "rest", retain: "keep",
  "subsequent to": "after", subsequently: "later", sufficient: "enough", terminate: "end", transmit: "send",
  utilise: "use", utilization: "use", utilize: "use", "with regard to": "about", "with respect to": "about",
};

const forms = (word: string) =>
  word.includes(" ")
    ? [word]
    : word.endsWith("e")
      ? [word, `${word}s`, `${word}d`, `${word.slice(0, -1)}ing`]
      : [word, `${word}s`, `${word}es`, `${word}ed`, `${word}ing`];

const SIMPLER_FORMS = new Map(Object.entries(SIMPLER).flatMap(([word, plain]) => forms(word).map((f) => [f, plain])));
const SIMPLER_WORDS = phrases([...SIMPLER_FORMS.keys()]);

const ADVERB = /(?<![\p{L}\p{N}'’-])\p{L}+ly(?![\p{L}\p{N}'’-])/giu;
/** Words that end in -ly but are not adverbs, or are too common to mark. */
const NOT_ADVERBS = new Set(
  (
    "only early daily weekly monthly yearly hourly nightly family reply apply supply comply imply rely ally rally " +
    "tally belly bully jelly lily fly butterfly holy ugly silly lonely lovely friendly unfriendly likely unlikely " +
    "elderly costly deadly lively curly oily hilly chilly wily italy july emily kelly sally molly holly assembly " +
    "anomaly monopoly homily folly jolly melancholy"
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

const NOTES: Record<Exclude<Kind, "hard" | "veryHard" | "simpler">, string> = {
  adverb: "Adverb. A stronger verb may not need it.",
  passive: "Passive voice. Say who does it.",
  qualifier: "Qualifier. It softens the point.",
  intensifier: "Intensifier. It rarely adds strength.",
  filler: "Filler. It adds words, not meaning.",
};

/** Marks in one block. Weakeners and simpler words never overlap each other; passive voice may hold them. */
function wordIssues(text: string): Issue[] {
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
  add(SIMPLER_WORDS, "simpler", (m) => `Simpler: ${SIMPLER_FORMS.get(m.toLowerCase().replace(/\s+/g, " "))}.`);
  add(ADVERB, "adverb", (m) => (NOT_ADVERBS.has(m.toLowerCase()) ? null : NOTES.adverb));
  candidates.sort((a, b) => a.from - b.from || b.to - a.to);

  const kept: Issue[] = [];
  for (const c of candidates) {
    const last = kept[kept.length - 1];
    if (!last || c.from >= last.to) kept.push(c);
  }
  for (const m of text.matchAll(PASSIVE)) {
    if (NOT_PARTICIPLES.has(m[1].toLowerCase())) continue;
    kept.push({ from: m.index, to: m.index + m[0].length, kind: "passive", note: NOTES.passive });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// The page

interface BlockResult {
  issues: Issue[];
  words: number;
  letters: number;
  sentences: number;
}

function checkBlock(text: string): BlockResult {
  const result: BlockResult = { issues: [], words: 0, letters: 0, sentences: 0 };
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
  result.issues.push(...wordIssues(text));
  return result;
}

// Most keystrokes change one block. The rest come from here.
const seen = new Map<string, BlockResult>();

export function checkPage(page: string): Report {
  const report: Report = { issues: [], words: 0, letters: 0, sentences: 0, grade: null };
  for (const block of proseBlocks(page)) {
    let result = seen.get(block.text);
    if (!result) {
      if (seen.size > 5000) seen.clear();
      result = checkBlock(block.text);
      seen.set(block.text, result);
    }
    for (const i of result.issues) report.issues.push({ ...i, from: i.from + block.from, to: i.to + block.from });
    report.words += result.words;
    report.letters += result.letters;
    report.sentences += result.sentences;
  }
  report.issues.sort((a, b) => a.from - b.from || b.to - a.to);
  if (report.words) report.grade = ari(report.letters, report.words, report.sentences);
  return report;
}
