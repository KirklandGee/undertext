import { Fragment, Mark, Node } from "prosemirror-model";
import { newId, schema } from "./schema";

// File format: plain Markdown plus three small extensions.
//
//   {{tension|pressure|>struggle}}   word/sentence alternatives. First is the
//                                    original. `>` marks the active one.
//   {{calls|~judgments}}             `~` marks a suggestion that came from AI.
//   {-maybe cut this-}               ghosted (dimmed) text.
//   :::alt / :::or* / :::            whole-paragraph versions. `*` = active.
//   <!-- overflow -->                everything after this line is overflow.
//
// Everything else is kept as literal text, so other Markdown survives a
// round trip untouched. `~~x~~` is ordinary strikethrough.

export const OVERFLOW_MARKER = "<!-- overflow -->";

// `~` stays escapable so `\~` in files from before `{-x-}` still reads as `~`.
const ESCAPABLE = new Set(["\\", "~", "{", "}", "|", ">"]);

export interface ParsedFile {
  doc: Node;
  overflow: string;
}

export function parseFile(md: string): ParsedFile {
  const text = md.replace(/\r\n?/g, "\n");
  const marker = /^<!-- overflow -->[ \t]*$/m.exec(text);
  const body = marker ? text.slice(0, marker.index) : text;
  const overflow = marker
    ? text.slice(marker.index + marker[0].length).replace(/^\n+/, "").trimEnd()
    : "";

  const lines = body.split("\n");
  const paragraphs: Node[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) paragraphs.push(createParagraph(buf.join("\n")));
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^:::alt(\*)?\s*$/.exec(line);
    if (open) {
      const block = readVariantBlock(lines, i, Boolean(open[1]));
      if (block) {
        flush();
        paragraphs.push(createParagraph(block.variants[block.active], block.variants, block.active));
        i = block.end;
        continue;
      }
    }
    if (line.trim() === "") flush();
    else buf.push(line);
  }
  flush();

  if (!paragraphs.length) paragraphs.push(schema.nodes.paragraph.create());
  return { doc: schema.nodes.doc.create(null, paragraphs), overflow };
}

export function serializeFile(doc: Node, overflow: string): string {
  const blocks: string[] = [];
  doc.forEach((p) => {
    const block = serializeParagraph(p);
    if (block.trim() !== "") blocks.push(block);
  });
  let out = blocks.join("\n\n");
  if (overflow.trim()) out += `${out ? "\n\n" : ""}${OVERFLOW_MARKER}\n\n${overflow.trim()}`;
  return `${out}\n`;
}

export function createParagraph(src: string, variants?: string[], active = 0): Node {
  const hasVariants = variants && variants.length > 1;
  return schema.nodes.paragraph.create(
    hasVariants ? { vid: newId(), variants, active } : null,
    parseInline(src),
  );
}

export function parseInline(src: string): Fragment {
  return Fragment.from(parseInlineNodes(src, Mark.none));
}

/** Inline Markdown as display text: the active alternatives, no ghost syntax, no escapes. */
export function inlineText(src: string): string {
  const fragment = parseInline(src);
  return fragment.textBetween(0, fragment.size, undefined, "\n");
}

export function serializeParagraph(node: Node): string {
  const current = serializeInline(node.content);
  const variants: string[] | null = node.attrs.variants;
  if (!variants || variants.length < 2) return current;
  const active: number = node.attrs.active;
  const lines: string[] = [];
  variants.forEach((v, k) => {
    lines.push(`${k === 0 ? ":::alt" : ":::or"}${k === active ? "*" : ""}`);
    lines.push(k === active ? current : v);
  });
  lines.push(":::");
  return lines.join("\n");
}

export function serializeInline(content: Fragment): string {
  const segments: { ghost: boolean; text: string }[] = [];
  const nodes: Node[] = [];
  content.forEach((n) => nodes.push(n));

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const alt = schema.marks.alt.isInSet(node.marks);
    if (alt && node.isText) {
      let current = node.text ?? "";
      let ghost = Boolean(schema.marks.ghost.isInSet(node.marks));
      while (i + 1 < nodes.length && sameAlt(nodes[i + 1], alt)) {
        i++;
        current += nodes[i].text ?? "";
        ghost = ghost && Boolean(schema.marks.ghost.isInSet(nodes[i].marks));
      }
      segments.push({ ghost, text: serializeAlt(alt, current) });
    } else {
      const ghost = Boolean(schema.marks.ghost.isInSet(node.marks));
      segments.push({ ghost, text: node.isText ? escapeText(node.text ?? "", ghost) : "\n" });
    }
  }

  let out = "";
  let inGhost = false;
  for (const seg of segments) {
    if (seg.ghost !== inGhost) {
      out += inGhost ? "-}" : "{-";
      inGhost = seg.ghost;
    }
    out += seg.text;
  }
  if (inGhost) out += "-}";
  return out;
}

function sameAlt(node: Node, alt: Mark): boolean {
  const other = schema.marks.alt.isInSet(node.marks);
  return Boolean(node.isText && other && other.attrs.id === alt.attrs.id);
}

function serializeAlt(alt: Mark, current: string): string {
  const variants: string[] = [...alt.attrs.variants];
  const active: number = alt.attrs.active;
  if (variants.length < 2) return escapeText(current);
  variants[active] = current;
  const ai: string[] = alt.attrs.ai ?? [];
  const parts = variants.map(
    (v, k) => `${k === active && active !== 0 ? ">" : ""}${ai.includes(v) ? "~" : ""}${escapeVariant(v)}`,
  );
  return `{{${parts.join("|")}}}`;
}

/** In a ghost, `-}` would end it early, so its `}` gets a backslash. */
function escapeText(text: string, inGhost = false): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || (inGhost && ch === "}" && text[i - 1] === "-")) out += `\\${ch}`;
    else if (ch === "\\" && (i === text.length - 1 || ESCAPABLE.has(text[i + 1]))) out += "\\\\";
    else out += ch;
  }
  return out;
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

function parseInlineNodes(src: string, marks: readonly Mark[]): Node[] {
  const out: Node[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(schema.text(buf, marks));
    buf = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push(schema.nodes.hard_break.create(null, null, marks));
      i++;
      continue;
    }
    if (src.startsWith("{-", i)) {
      const close = findGhostEnd(src, i + 2);
      if (close > i + 2) {
        flush();
        const ghost = schema.marks.ghost.create().addToSet(marks);
        out.push(...parseInlineNodes(src.slice(i + 2, close), ghost));
        i = close + 2;
        continue;
      }
    }
    if (src.startsWith("{{", i)) {
      const alt = parseAlt(src, i);
      if (alt) {
        flush();
        const mark = schema.marks.alt.create({ id: newId(), variants: alt.variants, active: alt.active, ai: alt.ai });
        out.push(schema.text(alt.variants[alt.active], mark.addToSet(marks)));
        i = alt.end;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Finds the `-}` that closes a ghost. Skips escapes and whole alternatives, so `{{a|b-}}` can't end it. */
function findGhostEnd(src: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\" && ESCAPABLE.has(src[j + 1])) {
      j++;
      continue;
    }
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

function readVariantBlock(
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
