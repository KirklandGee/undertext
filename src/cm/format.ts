import { Autolink, parser as baseParser, Strikethrough, TaskList } from "@lezer/markdown";

// File format: plain Markdown plus small extensions.
//
//   {{tension|pressure|>struggle}}   word/sentence alternatives. First is the
//                                    original. `>` marks the active one.
//   {{calls|~judgments}}             `~` marks a suggestion that came from AI.
//   {-maybe cut this-}               ghosted (dimmed) text.
//   :::alt / :::or* / :::            whole-paragraph versions. `*` = active.
//   <!-- overflow -->                everything after this line is overflow.
//
// The page text is the file without those extensions: the active text of
// each alternative and version, ghosts without their braces. Everything else
// stays as written, backslashes included. Extensions are not read in code.

export const OVERFLOW_MARKER = "<!-- overflow -->";

/** The Markdown dialect, shared with the editor: CommonMark plus these. */
export const MARKDOWN_EXTENSIONS = [Strikethrough, TaskList, Autolink];
const mdParser = baseParser.configure(MARKDOWN_EXTENSIONS);

export interface Span {
  from: number;
  to: number;
}

export interface Alt extends Span {
  id: string;
  /** The entry at `active` may be stale: the page text is the truth. */
  variants: string[];
  active: number;
  /** Variant texts that came from AI. */
  ai: string[];
}

export interface Version {
  /** Where the paragraph starts in the page text. */
  at: number;
  vid: string;
  /** Inline Markdown with extensions. The entry at `active` may be stale. */
  variants: string[];
  active: number;
}

export interface Layers {
  alts: Alt[];
  ghosts: Span[];
  versions: Version[];
}

export interface Page extends Layers {
  text: string;
  overflow: string;
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

// Escapes inside `{{ }}`. Body text keeps every backslash as written.
const ESCAPABLE = new Set(["\\", "~", "{", "}", "|", ">"]);
const VERSION_OPEN = /^:::alt(\*)?\s*$/;
// Source of a blank line. Build a fresh RegExp per use: global ones keep state.
const BLANK_LINE = "\\n[ \\t]*\\n";

// ---------------------------------------------------------------------------
// Reading

export function parsePage(md: string): Page {
  const src = md.replace(/\r\n?/g, "\n");
  const marker = /^<!-- overflow -->[ \t]*$/m.exec(src);
  const body = (marker ? src.slice(0, marker.index) : src).replace(/\n+$/, "");
  const overflow = marker
    ? src.slice(marker.index + marker[0].length).replace(/^\n+/, "").trimEnd()
    : "";

  const out: Page = { text: "", alts: [], ghosts: [], versions: [], overflow };
  const code = codeRanges(body);
  const lines = body.split("\n");
  let runStart = 0;
  let lineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const open = VERSION_OPEN.exec(lines[i]);
    const block = open && !inSpans(code, lineStart) ? readVersionBlock(lines, i, Boolean(open[1])) : null;
    if (block) {
      readInline(body, runStart, lineStart, code, out);
      out.versions.push({ at: out.text.length, vid: newId(), variants: block.variants, active: block.active });
      const active = block.variants[block.active];
      readInline(active, 0, active.length, codeRanges(active), out);
      for (let j = i; j <= block.end; j++) lineStart += lines[j].length + 1;
      // The newline after `:::` belongs to the text that follows.
      runStart = lineStart - 1;
      i = block.end;
      continue;
    }
    lineStart += lines[i].length + 1;
  }
  readInline(body, runStart, body.length, code, out);
  out.versions = out.versions.filter((v) => v.variants.length > 1);
  return out;
}

/** Code spans and blocks, where the extensions are not read. */
function codeRanges(src: string): Span[] {
  const spans: Span[] = [];
  mdParser.parse(src).iterate({
    enter(node) {
      if (node.name === "InlineCode" || node.name === "FencedCode" || node.name === "CodeBlock") {
        spans.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return spans;
}

const inSpans = (spans: Span[], pos: number) => spans.some((s) => s.from <= pos && pos < s.to);

function readInline(src: string, from: number, to: number, code: Span[], out: Page) {
  let i = from;
  while (i < to) {
    const span = code.find((s) => s.from <= i && i < s.to);
    if (span) {
      const end = Math.min(span.to, to);
      out.text += src.slice(i, end);
      i = end;
      continue;
    }
    if (src[i] === "\\" && i + 1 < to) {
      out.text += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (src.startsWith("{-", i)) {
      const close = findGhostEnd(src, i + 2, to, code);
      if (close > i + 2) {
        const start = out.text.length;
        readInline(src, i + 2, close, code, out);
        out.ghosts.push({ from: start, to: out.text.length });
        i = close + 2;
        continue;
      }
    }
    if (src.startsWith("{{", i)) {
      const alt = parseAlt(src, i);
      if (alt && alt.end <= to) {
        const start = out.text.length;
        out.text += alt.variants[alt.active];
        out.alts.push({ from: start, to: out.text.length, id: newId(), ...alt });
        i = alt.end;
        continue;
      }
    }
    out.text += src[i];
    i++;
  }
}

/** Finds the `-}` that closes a ghost. Skips escapes, code and whole alternatives. A blank line ends the search. */
function findGhostEnd(src: string, from: number, to: number, code: Span[]): number {
  for (let j = from; j < to; j++) {
    const span = code.find((s) => s.from <= j && j < s.to);
    if (span) {
      j = span.to - 1;
      continue;
    }
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "\n" && /^\n[ \t]*\n/.test(src.slice(j, j + 40))) return -1;
    if (src.startsWith("{{", j)) {
      const alt = parseAlt(src, j);
      if (alt) {
        j = alt.end - 1;
        continue;
      }
    }
    if (src.startsWith("-}", j)) return j;
  }
  return -1;
}

function parseAlt(
  src: string,
  start: number,
): { variants: string[]; active: number; ai: string[]; end: number } | null {
  const variants: string[] = [];
  const aiIndexes = new Set<number>();
  let active = 0;
  let cur = "";
  let atStart = true;
  let j = start + 2;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\n") return null;
    if (ch === "\\" && ESCAPABLE.has(src[j + 1])) {
      cur += src[j + 1];
      atStart = false;
      j += 2;
      continue;
    }
    if (atStart && (ch === " " || ch === "\t")) {
      j++;
      continue;
    }
    // Markers before the text: `>` active, `~` from AI. Either order works.
    if (atStart && ch === ">") {
      active = variants.length;
      j++;
      continue;
    }
    if (atStart && ch === "~") {
      aiIndexes.add(variants.length);
      j++;
      continue;
    }
    if (src.startsWith("}}", j)) {
      variants.push(cur.trimEnd());
      const kept = variants.filter((v) => v !== "");
      if (!kept.length) return null;
      const activeText = variants[active] || kept[0];
      const ai = variants.filter((v, k) => v !== "" && aiIndexes.has(k));
      return { variants: kept, active: kept.indexOf(activeText), ai, end: j + 2 };
    }
    if (ch === "|") {
      variants.push(cur.trimEnd());
      cur = "";
      atStart = true;
      j++;
      continue;
    }
    cur += ch;
    atStart = false;
    j++;
  }
  return null;
}

function readVersionBlock(
  lines: string[],
  start: number,
  firstActive: boolean,
): { variants: string[]; active: number; end: number } | null {
  const variants: string[] = [];
  let active = firstActive ? 0 : -1;
  let cur: string[] = [];
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (/^:::\s*$/.test(line)) {
      variants.push(trimBlankLines(cur));
      return { variants, active: Math.max(active, 0), end: j };
    }
    const or = /^:::or(\*)?\s*$/.exec(line);
    if (or) {
      variants.push(trimBlankLines(cur));
      cur = [];
      if (or[1]) active = variants.length;
      continue;
    }
    cur.push(line);
  }
  return null;
}

function trimBlankLines(lines: string[]): string {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b).join("\n");
}

// ---------------------------------------------------------------------------
// Writing

export function serializePage(page: Page): string {
  const { text } = page;
  const code = codeRanges(text);
  const alts = [...page.alts].filter((a) => a.from < a.to).sort((a, b) => a.from - b.from);
  const ghosts = ghostPieces(text, page.ghosts, alts);
  const versions = [...page.versions].filter((v) => v.variants.length > 1).sort((a, b) => a.at - b.at);
  const ctx: WriteContext = { text, code, alts, ghosts };

  let out = "";
  let pos = 0;
  for (const v of versions) {
    if (v.at < pos || (v.at > 0 && text[v.at - 1] !== "\n")) continue;
    const end = blockEnd(text, v.at);
    out += writeRange(ctx, pos, v.at);
    const current = writeRange(ctx, v.at, end);
    const lines: string[] = [];
    v.variants.forEach((variant, k) => {
      lines.push(`${k === 0 ? ":::alt" : ":::or"}${k === v.active ? "*" : ""}`);
      lines.push(k === v.active ? current : variant);
    });
    lines.push(":::");
    out += lines.join("\n");
    pos = end;
  }
  out += writeRange(ctx, pos, text.length);
  out = out.replace(/\n+$/, "");

  const overflow = page.overflow.trim();
  if (overflow) out += `${out ? "\n\n" : ""}${OVERFLOW_MARKER}\n\n${overflow}`;
  return `${out}\n`;
}

/** Where the paragraph that starts at `at` ends: the next blank line, or the end. */
export function blockEnd(text: string, at: number): number {
  const re = new RegExp(BLANK_LINE, "g");
  re.lastIndex = at;
  const m = re.exec(text);
  return m ? m.index : text.length;
}

/** The current inline Markdown of a paragraph, with extensions, as a version variant. */
export function serializeBlock(page: Pick<Page, "text" | "alts" | "ghosts">, from: number, to: number): string {
  const alts = [...page.alts].filter((a) => a.from < a.to).sort((a, b) => a.from - b.from);
  const ctx = { text: page.text, code: codeRanges(page.text), alts, ghosts: ghostPieces(page.text, page.ghosts, alts) };
  return writeRange(ctx, from, to);
}

interface WriteContext {
  text: string;
  code: Span[];
  alts: Alt[];
  ghosts: Span[];
}

/**
 * Ghost ranges as the file can hold them: never across a blank line, and
 * never over part of an alternative (that part is dropped).
 */
function ghostPieces(text: string, ghosts: Span[], alts: Alt[]): Span[] {
  const pieces: Span[] = [];
  for (const g of [...ghosts].sort((a, b) => a.from - b.from)) {
    let parts: Span[] = [{ from: g.from, to: g.to }];
    for (const a of alts) {
      if (a.from < g.from && a.to > g.from) parts = parts.map((p) => (p.from < a.to ? { ...p, from: a.to } : p));
      if (a.from < g.to && a.to > g.to) parts = parts.map((p) => (p.to > a.from ? { ...p, to: a.from } : p));
    }
    for (const p of parts) {
      let start = p.from;
      for (const m of text.slice(p.from, p.to).matchAll(new RegExp(BLANK_LINE, "g"))) {
        pieces.push({ from: start, to: p.from + m.index });
        start = p.from + m.index + m[0].length;
      }
      pieces.push({ from: start, to: p.to });
    }
  }
  const kept = pieces.filter((p) => text.slice(p.from, p.to).trim() !== "");
  // Merge touching pieces, so two ghosts side by side write as one.
  const merged: Span[] = [];
  for (const p of kept) {
    const last = merged[merged.length - 1];
    if (last && p.from <= last.to) last.to = Math.max(last.to, p.to);
    else merged.push({ ...p });
  }
  return merged;
}

function writeRange(ctx: WriteContext, from: number, to: number): string {
  const { text, code, alts, ghosts } = ctx;
  let out = "";
  let i = from;
  while (i < to) {
    const ghostStart = ghosts.find((g) => g.from === i);
    if (ghostStart && ghostStart.to <= to) {
      out += `{-${writeGhost(ctx, ghostStart.from, ghostStart.to)}-}`;
      i = ghostStart.to;
      continue;
    }
    const alt = alts.find((a) => a.from === i);
    if (alt && alt.to <= to) {
      out += writeAlt(alt, text.slice(alt.from, alt.to));
      i = alt.to;
      continue;
    }
    const next = nextStop(ctx, i, to);
    out += escapeText(text, i, next, code, false, next < to ? "open" : null);
    i = next;
  }
  return out;

  function writeGhost(c: WriteContext, a: number, b: number): string {
    let s = "";
    let j = a;
    while (j < b) {
      const inner = c.alts.find((x) => x.from === j);
      if (inner && inner.to <= b) {
        s += writeAlt(inner, c.text.slice(inner.from, inner.to));
        j = inner.to;
        continue;
      }
      const stop = Math.min(b, ...c.alts.filter((x) => x.from > j).map((x) => x.from));
      s += escapeText(c.text, j, stop, c.code, true, stop < b ? "open" : "close");
      j = stop;
    }
    return s;
  }
}

function nextStop(ctx: WriteContext, i: number, to: number): number {
  let next = to;
  for (const g of ctx.ghosts) if (g.from > i && g.from < next) next = g.from;
  for (const a of ctx.alts) if (a.from > i && a.from < next) next = a.from;
  return next;
}

const escapedAt = (text: string, i: number) => {
  let n = 0;
  while (i - n - 1 >= 0 && text[i - n - 1] === "\\") n++;
  return n % 2 === 1;
};

/**
 * Adds a backslash only where text would read as an extension: `{{`, `{-`,
 * a `:::alt` or overflow line, and `-}` inside a ghost. Never in code.
 * `after` is the syntax written right after this text, if any.
 */
function escapeText(
  text: string,
  from: number,
  to: number,
  code: Span[],
  inGhost: boolean,
  after: "open" | "close" | null,
): string {
  let out = "";
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (!inSpans(code, i) && !escapedAt(text, i)) {
      const last = i === to - 1;
      const lineStart = i === 0 || text[i - 1] === "\n";
      const opensExtension =
        ch === "{" && (last ? after === "open" : text[i + 1] === "{" || text[i + 1] === "-");
      const endsGhost = inGhost && ch === "}" && text[i - 1] === "-";
      const lineEnd = text.indexOf("\n", i);
      const line = lineStart ? text.slice(i, lineEnd < 0 ? text.length : lineEnd) : "";
      const looksLikeMarker = lineStart && (VERSION_OPEN.test(line) || /^<!-- overflow -->[ \t]*$/.test(line));
      // A lone backslash would escape the syntax that follows. Doubled, it still reads as one.
      const escapesSyntax = last && after !== null && ch === "\\";
      if (opensExtension || endsGhost || looksLikeMarker || escapesSyntax) out += "\\";
    }
    out += ch;
  }
  return out;
}

function writeAlt(alt: Alt, current: string): string {
  const variants = [...alt.variants];
  if (variants.length < 2) return current;
  variants[alt.active] = current;
  const parts = variants.map(
    (v, k) => `${k === alt.active && alt.active !== 0 ? ">" : ""}${alt.ai.includes(v) ? "~" : ""}${escapeVariant(v)}`,
  );
  return `{{${parts.join("|")}}}`;
}

function escapeVariant(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "|" || ch === "}" || ((ch === ">" || ch === "~") && i === 0)) out += `\\${ch}`;
    else if (ch === "\\" && (i === text.length - 1 || ESCAPABLE.has(text[i + 1]))) out += "\\\\";
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display

/** Inline Markdown as page text and layers, with positions from 0. */
export function parseInline(src: string): Page {
  const page: Page = { text: "", alts: [], ghosts: [], versions: [], overflow: "" };
  readInline(src, 0, src.length, codeRanges(src), page);
  return page;
}

/** Inline Markdown as display text: the active alternatives, no ghost braces. */
export const inlineText = (src: string) => parseInline(src).text;
