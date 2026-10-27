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
  /** Text that could replace it, in its form and case, e.g. "strolled" for "walked slowly". */
  fix?: string;
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

/** Tags whose HTML block runs to a closing tag, even across blank lines. */
const RAW_HTML = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;
/** Tags whose HTML block runs to a blank line, as CommonMark has them. */
const BLOCK_HTML =
  /^ {0,3}<\/?(?:address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|legend|li|main|menu|nav|ol|optgroup|option|p|search|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)(?=[\s/>]|$)/i;
/** Any other tag alone on its line. */
const LONE_TAG = /^ {0,3}<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>\s*$/i;

/**
 * Where the HTML block that `line` starts ends: at a line that matches, or "blank" at a blank line.
 * Null when the line starts none, or ends it on the same line.
 */
function htmlBlock(line: string, inParagraph: boolean): RegExp | "blank" | null {
  if (/^ {0,3}<!--/.test(line)) return line.includes("-->", line.indexOf("<!--") + 4) ? null : /-->/;
  const raw = RAW_HTML.exec(line);
  if (raw) return new RegExp(`</${raw[1]}>`, "i").test(line) ? null : new RegExp(`</${raw[1]}>`, "i");
  if (BLOCK_HTML.test(line) || (!inParagraph && LONE_TAG.test(line))) return "blank";
  return null;
}

/** A heading line, and the marks around its text: "## Title ##". */
const ATX = /^ {0,3}#{1,6}(?=\s|$)|[ \t]#+[ \t]*$/g;

/**
 * Splits the page into paragraphs, list items, and quotes, and with `headings`, headings too. Each
 * block's text has the same length as the page text it covers, with markup blanked out, so an
 * offset in it is an offset in the page.
 */
export function proseBlocks(page: string, { headings = false } = {}): { from: number; text: string }[] {
  const blocks: { from: number; text: string }[] = [];
  let start = -1;
  let lines: string[] = [];
  const flush = () => {
    if (start >= 0) blocks.push({ from: start, text: lines.join("\n").replace(INLINE, blank) });
    start = -1;
    lines = [];
  };
  let fence: string | null = null;
  let html: RegExp | "blank" | null = null;
  // A paragraph that a setext line can turn into a heading. In a list, an indented line is prose.
  let plain = false;
  let inList = false;
  let pos = 0;
  for (const line of page.split("\n")) {
    const at = pos;
    pos += line.length + 1;
    if (html) {
      if (html === "blank" ? !line.trim() : html.test(line)) html = null;
      continue;
    }
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
      if (headings) flush();
      start = -1;
      lines = [];
      continue;
    }
    if (headings && /^ {0,3}#{1,6}(?:\s|$)/.test(line)) {
      flush();
      blocks.push({ from: at, text: line.replace(ATX, blank).replace(INLINE, blank) });
      if (edge) inList = false;
      continue;
    }
    html = htmlBlock(line, start >= 0);
    if (html) {
      flush();
      if (edge) inList = false;
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

/** Verbs whose forms don't follow the rules in `verbForms`: -s, past, -ing, and past participle. */
const IRREGULAR_VERBS: Record<string, string> = {
  agree: "agrees agreed agreeing agreed", build: "builds built building built", buy: "buys bought buying bought",
  choose: "chooses chose choosing chosen", come: "comes came coming come", creep: "creeps crept creeping crept",
  cut: "cuts cut cutting cut", do: "does did doing done", drink: "drinks drank drinking drunk",
  eat: "eats ate eating eaten", find: "finds found finding found", get: "gets got getting gotten",
  give: "gives gave giving given", have: "has had having had", keep: "keeps kept keeping kept",
  know: "knows knew knowing known", make: "makes made making made", pay: "pays paid paying paid",
  run: "runs ran running run", say: "says said saying said", send: "sends sent sending sent",
  show: "shows showed showing shown", slam: "slams slammed slamming slammed", snap: "snaps snapped snapping snapped",
  speak: "speaks spoke speaking spoken", speed: "speeds sped speeding sped", take: "takes took taking taken",
  tiptoe: "tiptoes tiptoed tiptoeing tiptoed", tread: "treads trod treading trodden",
};

/** A verb's base, -s, past, -ing, and past participle forms. */
function verbForms(base: string): string[] {
  const irregular = IRREGULAR_VERBS[base];
  if (irregular) return [base, ...irregular.split(" ")];
  const y = /[^aeiou]y$/.test(base) ? base.slice(0, -1) : null;
  const s = y ? `${y}ies` : /(?:s|x|z|ch|sh)$/.test(base) ? `${base}es` : `${base}s`;
  const past = y ? `${y}ied` : base.endsWith("e") ? `${base}d` : `${base}ed`;
  const ing = /[^e]e$/.test(base) ? `${base.slice(0, -1)}ing` : `${base}ing`;
  return [base, s, past, ing, past];
}

/**
 * What a verb form can be. "Present" is "am" and "are"; "inf" is "be", as after "will". A plain
 * base form is either.
 */
type Role = "base" | "present" | "inf" | "s" | "past" | "ing" | "pp";
const FORM_ROLES: Role[] = ["base", "s", "past", "ing", "pp"];
const BE_ROLES: Record<string, Role> = { am: "present", is: "s", are: "present", was: "past", were: "past", be: "inf", been: "pp", being: "ing" };
const BE = Object.keys(BE_ROLES);

/** A phrase's plainer words, and what form the phrase's verb can be. */
interface Swap {
  plain: string;
  roles: Role[];
}
const addSwap = (map: Map<string, Swap>, phrase: string, plain: string, role: Role) => {
  const swap = map.get(phrase);
  if (swap) swap.roles.push(role);
  else map.set(phrase, { plain, roles: [role] });
};

/** Helper verbs a participle follows, as in "has made" or "was acquired", and contractions of them. */
const PERFECT = /^(?:has|have|had|having|am|is|are|was|were|be|been|being)$|.['’](?:s|ve|d|re|m)$/iu;
/** Words a plain infinitive follows, as in "will make", and "we'll make". */
const MODAL = /^(?:to|will|would|can|cannot|could|may|might|must|shall|should|do|does|did|wo|ca|sha)$|.['’]ll$/iu;
/** Words that can stand between a helper verb and its verb, as in "has not made" or "has finally made". */
const BETWEEN = new Set(["not", "never", "already", "also", "always", "just", "ever", "still"]);
const PRONOUNS = new Set(["i", "you", "he", "she", "it", "we", "they"]);

/**
 * Whether `before` ends with a helper verb that `helper` matches, maybe with "n't", maybe then one
 * word: "not", an adverb, or, in a question that starts with the helper, its subject ("Has she").
 */
function endsWithHelper(before: string, helper: RegExp): boolean {
  if (!/\s$/.test(before)) return false;
  const words = [...before.matchAll(/[\p{L}'’]+/gu)];
  const end = (m: RegExpMatchArray) => m.index! + m[0].length;
  const is = (m: RegExpMatchArray | undefined) => !!m && helper.test(m[0].replace(/n['’]t$/iu, ""));
  const last = words[words.length - 1];
  if (!last || before.slice(end(last)).trim()) return false;
  if (is(last)) return true;
  const prev = words[words.length - 2];
  if (!prev || before.slice(end(prev), last.index).trim() || !is(prev)) return false;
  const word = last[0].toLowerCase();
  if (BETWEEN.has(word) || (word.endsWith("ly") && !LY_WORDS.has(word))) return true;
  return PRONOUNS.has(word) && /(?:^|[.!?]["'”’)]*\s+)$/u.test(before.slice(0, prev.index));
}

/** The form the matched verb has here, from the words before it. A form listed as past comes before its participle. */
function roleHere(roles: Role[], before: string): Role {
  if (roles.includes("pp") && endsWithHelper(before, PERFECT)) return "pp";
  if (roles.includes("base") && endsWithHelper(before, MODAL)) return "inf";
  return roles[0];
}

/** The plainer words in a form. Null where "can" has no such form, as in "will can". */
function inflect(plain: string, role: Role): string | null {
  const [verb, ...rest] = plain.split(" ");
  const tail = rest.length ? ` ${rest.join(" ")}` : "";
  if (verb === "can") {
    const modal = { present: "can", s: "can", base: "can", past: "could" }[role as string];
    return modal ? modal + tail : null;
  }
  const f = verbForms(verb);
  return { base: f[0], present: f[0], inf: f[0], s: f[1], past: f[2], ing: f[3], pp: f[4] }[role] + tail;
}

// Weak verbs: a plain verb and an adverb that one stronger verb replaces, as in "walked slowly".
const WEAK_PAIRS =
  "run quickly: sprint, walk quickly: hurry, walk slowly: stroll, walk quietly: tiptoe, walk carefully: tread, " +
  "eat quickly: gobble, move quickly: rush, move slowly: creep, look quickly: glance, look angrily: glare, " +
  "drink quickly: gulp, say loudly: shout, say softly: murmur, say quietly: whisper, say angrily: snap, " +
  "speak loudly: shout, speak softly: whisper, speak quietly: whisper, talk loudly: shout, talk quietly: whisper, " +
  "close loudly: slam, laugh loudly: guffaw, laugh quietly: chuckle";
/** "walked slowly" → "stroll", put in the same form where it's marked. */
const WEAK_VERB_FORMS = new Map<string, Swap>();
for (const pair of WEAK_PAIRS.split(", ")) {
  const [, verb, adverb, stronger] = pair.match(/^(\S+) (\S+): (\S+)$/)!;
  verbForms(verb).forEach((form, i) => addSwap(WEAK_VERB_FORMS, `${form} ${adverb}`, stronger, FORM_ROLES[i]));
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
const HIDDEN_FORMS = new Map<string, Swap>();
for (const action of HIDDEN_ACTIONS.split(", ")) {
  const [, verb, rest, plain] = action.match(/^(\S+) (.+): (.+)$/)!;
  if (verb === "be") for (const form of BE) addSwap(HIDDEN_FORMS, `${form} ${rest}`, plain, BE_ROLES[form]);
  else verbForms(verb).forEach((form, i) => addSwap(HIDDEN_FORMS, `${form} ${rest}`, plain, FORM_ROLES[i]));
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

/** A word's forms and what each can be, and some that don't exist, which never match. */
function forms(word: string): [string, Role[]][] {
  if (word.includes(" ")) return [[word, ["base"]]];
  const ed: Role[] = ["past", "pp"];
  if (word.endsWith("e")) return [[word, ["base"]], [`${word}s`, ["s"]], [`${word}d`, ed], [`${word.slice(0, -1)}ing`, ["ing"]]];
  if (/[^aeiou]y$/.test(word)) {
    const stem = word.slice(0, -1);
    return [[word, ["base"]], [`${stem}ies`, ["s"]], [`${stem}ied`, ed], [`${word}ing`, ["ing"]]];
  }
  const out: [string, Role[]][] = [[word, ["base"]], [`${word}s`, ["s"]], [`${word}es`, ["s"]], [`${word}ed`, ed], [`${word}ing`, ["ing"]]];
  // One vowel before the last consonant may double it: transmit, transmitted.
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(word)) out.push([`${word}${word.at(-1)}ed`, ed], [`${word}${word.at(-1)}ing`, ["ing"]]);
  return out;
}

const SIMPLER_FORMS = new Map<string, Swap>(
  Object.entries(SIMPLER).flatMap(([word, plain]) => forms(word).map(([f, roles]) => [f, { plain, roles }])),
);
const SIMPLER_WORDS = phrases([...SIMPLER_FORMS.keys()]);

const ADVERB = /(?<![\p{L}\p{N}'’-])\p{L}+ly(?![\p{L}\p{N}'’-])/giu;
/** Words that end in -ly but are not adverbs. */
const LY_WORDS = new Set(
  (
    "only early daily weekly monthly yearly hourly nightly family reply apply supply comply imply rely ally rally " +
    "tally belly bully jelly lily fly butterfly holy ugly silly lonely lovely friendly unfriendly likely unlikely " +
    "elderly costly deadly lively curly oily hilly chilly wily italy july emily kelly sally molly holly assembly " +
    "anomaly monopoly homily folly jolly melancholy"
  ).split(" "),
);
/** Words that end in -ly and aren't marked: not adverbs, or adverbs Hemingway leaves alone. */
const NOT_ADVERBS = new Set([
  ...LY_WORDS,
  ..."usually finally recently rarely generally especially exactly currently actually approximately hardly immediately unfortunately definitely awfully completely".split(
    " ",
  ),
]);

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

/** Plain words that can't follow a word like "a", "the", "his", or "this". "Many" can follow most of those. */
const DETERMINERS = new Set(["more", "most", "some", "enough"]);
const AFTER_DETERMINER =
  /(?<![\p{L}\p{N}])(?:a|an|the|this|that|these|those|my|your|his|her|its|our|their|each|every|any|no)\s+$/iu;

/** Starts with a capital where the marked text does. */
const matchCase = (fix: string, marked: string) => (/^\p{Lu}/u.test(marked) ? fix[0].toUpperCase() + fix.slice(1) : fix);

/**
 * Marks in one block. Weakeners and simpler words never overlap each other. Adverbs and passive voice
 * may: "really" is an intensifier and an adverb, as Hemingway counts it.
 */
function wordIssues(text: string): { issues: Issue[]; weakeners: number } {
  const candidates: Issue[] = [];
  type Mark = Pick<Issue, "note" | "fix"> & { to?: number };
  const add = (re: RegExp, kind: Kind, mark: (m: RegExpExecArray) => Mark) => {
    for (const m of text.matchAll(re)) candidates.push({ from: m.index, to: m.index + m[0].length, kind, ...mark(m) });
  };
  const before = (m: RegExpExecArray) => text.slice(Math.max(0, m.index - 40), m.index);
  const after = (m: RegExpExecArray) => text.slice(m.index + m[0].length, m.index + m[0].length + 20);
  /**
   * The plainer words, in the form and case of the marked ones. `fits` says whether they would read
   * right in place; where they wouldn't, the mark stays with the `none` note.
   */
  const swap =
    (map: Map<string, Swap>, note: (fix: string) => string, none: string, fits = (_m: RegExpExecArray, _plain: string) => true) =>
    (m: RegExpExecArray): Mark => {
      const { plain, roles } = map.get(key(m[0]))!;
      const fix = fits(m, plain) ? inflect(plain, roleHere(roles, before(m))) : null;
      return fix === null ? { note: none } : { note: note(matchCase(fix, m[0])), fix: matchCase(fix, m[0]) };
    };
  // Earlier in the list wins when two start at the same place and have the same length.
  add(FILLERS, "filler", () => ({ note: NOTES.filler }));
  add(QUALIFIERS, "qualifier", () => ({ note: NOTES.qualifier }));
  add(INTENSIFIERS, "intensifier", () => ({ note: NOTES.intensifier }));
  const hidden = swap(HIDDEN_FORMS, (fix) => `Hidden action. Try “${fix}”.`, "Hidden action. Use a plain verb.");
  add(HIDDEN, "hidden", (m) => {
    // "Carried out a review of the code": the verb takes the "of" with it, "reviewed the code".
    const of = /^\s+of(?![\p{L}\p{N}])(?!\s+course(?![\p{L}\p{N}]))/u.exec(after(m));
    const mark = hidden(m);
    return of && !/\sof$/i.test(m[0]) && mark.fix ? { ...mark, to: m.index + m[0].length + of[0].length } : mark;
  });
  add(NEGATIVE, "negative", (m) => {
    // "Does not have to go" isn't "lacks to go".
    if (/have$/i.test(m[0]) && /^\s+(?:to|any)(?![\p{L}\p{N}])/u.test(after(m))) return { note: "Negative. Say what is, not what isn't." };
    const fix = matchCase(NEGATIVE_FORMS.get(key(m[0]))!, m[0]);
    return { note: `Negative. Try “${fix}”.`, fix };
  });
  add(WEAK_VERBS, "weakVerb", swap(WEAK_VERB_FORMS, (fix) => `Weak verb. Try “${fix}”.`, "Weak verb. Use one precise verb."));
  const simpler = swap(SIMPLER_FORMS, (fix) => `Simpler: ${fix}.`, "Simpler word. Reword it plainly.", (m, plain) => {
    // "An additional fee" isn't "an more fee", and "do not often see" isn't "do rarely see".
    if (DETERMINERS.has(plain) && AFTER_DETERMINER.test(before(m))) return false;
    if (plain === "many" && /(?<![\p{L}\p{N}])(?:a|an|each|every)\s+$/iu.test(before(m))) return false;
    if (plain === "rarely" && (/(?<![\p{L}\p{N}])(?:do|does|did)\s+$/iu.test(before(m)) || /^\s+that(?![\p{L}\p{N}])/u.test(after(m)))) return false;
    return true;
  });
  add(SIMPLER_WORDS, "simpler", simpler);
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
