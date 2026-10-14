import { Mark, MarkType, Node } from "prosemirror-model";
import { Command, EditorState, TextSelection, Transaction } from "prosemirror-state";
import { parseInline, serializeInline } from "./markdown";
import { newId, schema } from "./schema";

const { alt, ghost } = schema.marks;

export interface AltRange {
  from: number;
  to: number;
  mark: Mark;
}

// ---------------------------------------------------------------------------
// Finding things

export function findAltById(doc: Node, id: string): AltRange | null {
  let range: AltRange | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = alt.isInSet(node.marks);
    if (!mark || mark.attrs.id !== id) return;
    if (!range) range = { from: pos, to: pos + node.nodeSize, mark };
    else range.to = pos + node.nodeSize;
  });
  return range;
}

export function altAtPos(doc: Node, pos: number): AltRange | null {
  const $pos = doc.resolve(pos);
  const mark = alt.isInSet($pos.nodeAfter?.marks ?? []) ?? alt.isInSet($pos.nodeBefore?.marks ?? []);
  return mark ? findAltById(doc, mark.attrs.id) : null;
}

export function altInSelection(state: EditorState): AltRange | null {
  const { from, to, empty } = state.selection;
  if (empty) return altAtPos(state.doc, from);
  let found: string | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    const mark = alt.isInSet(node.marks);
    if (mark && !found) found = mark.attrs.id;
  });
  return found ? findAltById(state.doc, found) : null;
}

export function markRangeAt(doc: Node, pos: number, type: MarkType): { from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const start = $pos.start();
  const children: { node: Node; from: number }[] = [];
  parent.forEach((node, offset) => children.push({ node, from: start + offset }));
  let idx = children.findIndex((c) => c.from <= pos && pos < c.from + c.node.nodeSize && type.isInSet(c.node.marks));
  if (idx < 0) idx = children.findIndex((c) => c.from + c.node.nodeSize === pos && type.isInSet(c.node.marks));
  if (idx < 0) return null;
  let a = idx;
  let b = idx;
  while (a > 0 && type.isInSet(children[a - 1].node.marks)) a--;
  while (b < children.length - 1 && type.isInSet(children[b + 1].node.marks)) b++;
  return { from: children[a].from, to: children[b].from + children[b].node.nodeSize };
}

export function wordRangeAt(doc: Node, pos: number): { from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const start = $pos.start();
  const text = parent.textBetween(0, parent.content.size, undefined, "\n");
  const isWord = (c: string | undefined) => Boolean(c && /[\p{L}\p{N}'’-]/u.test(c));
  let a = pos - start;
  let b = a;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return a === b ? null : { from: start + a, to: start + b };
}

export function paragraphAt(state: EditorState, pos = state.selection.from): { pos: number; node: Node } | null {
  const $pos = state.doc.resolve(pos);
  if ($pos.depth < 1) return null;
  const p = $pos.before(1);
  return { pos: p, node: state.doc.nodeAt(p)! };
}

export function findParagraphByVid(doc: Node, vid: string): number | null {
  let found: number | null = null;
  doc.forEach((node, offset) => {
    if (found === null && node.attrs.vid === vid) found = offset;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Word and sentence alternatives

/** Wraps a range in a new alt mark. The current text becomes the original. */
export function createAlt(state: EditorState, from: number, to: number): { tr: Transaction; id: string } | null {
  const $from = state.doc.resolve(from);
  if (!$from.sameParent(state.doc.resolve(to))) return null;
  const raw = state.doc.textBetween(from, to, undefined, "\n");
  if (raw.includes("\n")) return null;
  from += raw.length - raw.trimStart().length;
  to -= raw.length - raw.trimEnd().length;
  if (from >= to) return null;

  let existing: string | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    existing ??= alt.isInSet(node.marks)?.attrs.id ?? null;
  });
  if (existing) return { tr: state.tr, id: existing };

  const id = newId();
  const text = state.doc.textBetween(from, to);
  const tr = state.tr.addMark(from, to, alt.create({ id, variants: [text], active: 0, ai: [] }));
  return { tr, id };
}

function syncedVariants(state: EditorState, r: AltRange): string[] {
  const variants: string[] = [...r.mark.attrs.variants];
  variants[r.mark.attrs.active] = state.doc.textBetween(r.from, r.to);
  return variants;
}

function replaceAlt(
  state: EditorState,
  r: AltRange,
  variants: string[],
  active: number,
  ai: string[] = r.mark.attrs.ai ?? [],
): Transaction {
  const tr = state.tr;
  const first = state.doc.nodeAt(r.from);
  const otherMarks = (first?.marks ?? []).filter((m) => m.type !== alt);
  const mark = alt.create({ id: r.mark.attrs.id, variants, active, ai: ai.filter((t) => variants.includes(t)) });
  const text = variants[active];
  const { from: selFrom, to: selTo } = state.selection;
  const selectionInside = selFrom >= r.from && selTo <= r.to;

  tr.replaceWith(r.from, r.to, schema.text(text, mark.addToSet(otherMarks)));
  const shift = fixArticle(tr, r.from, text);
  if (selectionInside) tr.setSelection(TextSelection.create(tr.doc, r.from + shift + text.length));
  return tr;
}

export function setAltActive(state: EditorState, id: string, index: number): Transaction | null {
  const r = findAltById(state.doc, id);
  if (!r) return null;
  const variants = syncedVariants(state, r);
  if (index < 0 || index >= variants.length) return null;
  return replaceAlt(state, r, variants, index);
}

export function cycleAlt(state: EditorState, id: string, dir: 1 | -1): Transaction | null {
  const r = findAltById(state.doc, id);
  if (!r) return null;
  const n = r.mark.attrs.variants.length;
  if (n < 2) return null;
  return setAltActive(state, id, (r.mark.attrs.active + dir + n) % n);
}

export function addAltVariant(state: EditorState, id: string, text: string): Transaction | null {
  const r = findAltById(state.doc, id);
  const value = text.trim();
  if (!r || !value || value.includes("\n")) return null;
  const variants = syncedVariants(state, r);
  const existing = variants.indexOf(value);
  if (existing >= 0) return replaceAlt(state, r, variants, existing);
  variants.push(value);
  return replaceAlt(state, r, variants, variants.length - 1);
}

/** Adds AI suggestions without switching away from the current text. */
export function addAiAlternatives(state: EditorState, id: string, texts: string[]): Transaction | null {
  const r = findAltById(state.doc, id);
  if (!r) return null;
  const variants = syncedVariants(state, r);
  const seen = new Set(variants.map((v) => v.toLowerCase()));
  const added: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text || text.includes("\n") || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    variants.push(text);
    added.push(text);
  }
  if (!added.length) return null;
  return replaceAlt(state, r, variants, r.mark.attrs.active, [...(r.mark.attrs.ai ?? []), ...added]);
}

export function removeAltVariant(state: EditorState, id: string, index: number): Transaction | null {
  const r = findAltById(state.doc, id);
  if (!r) return null;
  const variants = syncedVariants(state, r);
  if (variants.length < 2) return state.tr.removeMark(r.from, r.to, alt);
  const active: number = r.mark.attrs.active;
  variants.splice(index, 1);
  const next = index === active ? Math.max(0, index - 1) : index < active ? active - 1 : active;
  return replaceAlt(state, r, variants, next);
}

/** Removes alt marks that have only one variant left. */
export function cleanupSingleAlts(state: EditorState): Transaction | null {
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    const mark = node.isText ? alt.isInSet(node.marks) : null;
    if (mark && mark.attrs.variants.length < 2) tr.removeMark(pos, pos + node.nodeSize, alt);
  });
  return tr.docChanged ? tr : null;
}

// ---------------------------------------------------------------------------
// Keyboard: cycle at the caret, jump between items with versions

/** Cycles the word or sentence at the caret, or else its paragraph. */
export function cycleAtCaret(state: EditorState, dir: 1 | -1): Transaction | null {
  const r = altInSelection(state);
  if (r && r.mark.attrs.variants.length > 1) return cycleAlt(state, r.mark.attrs.id, dir);
  return cycleParagraphAtCaret(state, dir);
}

export function cycleParagraphAtCaret(state: EditorState, dir: 1 | -1): Transaction | null {
  const p = paragraphAt(state);
  return p ? cycleParagraph(state, p.pos, dir) : null;
}

export interface VersionedItem {
  from: number;
  to: number;
  kind: "alt" | "para";
}

/** Everything that has more than one version, in document order. A paragraph comes before its words. */
export function versionedItems(doc: Node): VersionedItem[] {
  const items: VersionedItem[] = [];
  doc.forEach((p, offset) => {
    if ((p.attrs.variants?.length ?? 0) > 1) items.push({ from: offset + 1, to: offset + p.nodeSize - 1, kind: "para" });
    const alts = new Map<string, VersionedItem>();
    p.forEach((child, childOffset) => {
      const mark = alt.isInSet(child.marks);
      if (!mark || mark.attrs.variants.length < 2) return;
      const from = offset + 1 + childOffset;
      const to = from + child.nodeSize;
      const item = alts.get(mark.attrs.id);
      if (item) item.to = to;
      else alts.set(mark.attrs.id, { from, to, kind: "alt" });
    });
    items.push(...alts.values());
  });
  return items;
}

/**
 * Moves the caret to the next or previous item with versions, wrapping around.
 * `lastIndex` breaks ties when a paragraph and its first word start at the same spot.
 */
export function jumpToItem(
  state: EditorState,
  dir: 1 | -1,
  lastIndex: number | null,
): { tr: Transaction; index: number } | null {
  const items = versionedItems(state.doc);
  if (!items.length) return null;
  const head = state.selection.head;
  let index: number;
  if (lastIndex !== null && items[lastIndex]?.from === head) index = lastIndex + dir;
  else if (dir > 0) index = items.findIndex((i) => i.from > head);
  else index = items.findLastIndex((i) => i.from < head);
  const n = items.length;
  index = index < 0 ? (dir > 0 ? 0 : n - 1) : (index + n) % n;
  const tr = state.tr.setSelection(TextSelection.create(state.doc, items[index].from)).scrollIntoView();
  return { tr, index };
}

// ---------------------------------------------------------------------------
// a / an

/** Fixes "a"/"an" before `from`. Returns how far `from` moved. */
function fixArticle(tr: Transaction, from: number, word: string): number {
  const $pos = tr.doc.resolve(from);
  const start = $pos.start();
  const winStart = Math.max(start, from - 12);
  const before = tr.doc.textBetween(winStart, from, undefined, "\n");
  const re = winStart === start ? /(?:^|[^\p{L}\p{N}])(an|a)(\s+)$/iu : /[^\p{L}\p{N}](an|a)(\s+)$/iu;
  const m = re.exec(before);
  if (!m) return 0;
  const article = m[1];
  const wantAn = startsWithVowelSound(word);
  if (wantAn === (article.toLowerCase() === "an")) return 0;
  let replacement = wantAn ? "an" : "a";
  if (article === article.toUpperCase() && article.length > 1) replacement = replacement.toUpperCase();
  else if (article[0] === article[0].toUpperCase()) replacement = replacement[0].toUpperCase() + replacement.slice(1);
  const artFrom = from - m[2].length - article.length;
  const marks = tr.doc.nodeAt(artFrom)?.marks ?? [];
  tr.replaceWith(artFrom, artFrom + article.length, schema.text(replacement, marks));
  return replacement.length - article.length;
}

export function startsWithVowelSound(word: string): boolean {
  const w = word.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
  if (!w) return false;
  if (["hour", "honest", "honor", "honour", "heir"].some((p) => w.startsWith(p))) return true;
  if (["uni", "use", "usu", "uti", "eu", "one", "once", "ubiq", "uk"].some((p) => w.startsWith(p))) return false;
  if (/^(8|11|18)/.test(w)) return true;
  return /^[aeiou]/.test(w);
}

// ---------------------------------------------------------------------------
// Paragraph versions

function syncedParagraphVariants(node: Node): string[] {
  const current = serializeInline(node.content);
  const variants: string[] | null = node.attrs.variants;
  if (!variants) return [current];
  const next = [...variants];
  next[node.attrs.active] = current;
  return next;
}

function replaceParagraph(state: EditorState, pos: number, node: Node, variants: string[], active: number): Transaction {
  const tr = state.tr;
  const content = parseInline(variants[active]);
  const { from } = state.selection;
  const selectionInside = from > pos && from < pos + node.nodeSize;
  tr.replaceWith(pos + 1, pos + 1 + node.content.size, content);
  const keep = variants.length > 1;
  tr.setNodeMarkup(pos, undefined, {
    vid: keep ? (node.attrs.vid ?? newId()) : null,
    variants: keep ? variants : null,
    active: keep ? active : 0,
  });
  if (selectionInside) tr.setSelection(TextSelection.create(tr.doc, pos + 1 + content.size));
  return tr;
}

export function setParagraphActive(state: EditorState, pos: number, index: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const variants = syncedParagraphVariants(node);
  if (index < 0 || index >= variants.length) return null;
  return replaceParagraph(state, pos, node, variants, index);
}

export function cycleParagraph(state: EditorState, pos: number, dir: 1 | -1): Transaction | null {
  const node = state.doc.nodeAt(pos);
  const n = node?.attrs.variants?.length ?? 0;
  if (!node || n < 2) return null;
  return setParagraphActive(state, pos, (node.attrs.active + dir + n) % n);
}

/** Copies the current paragraph into a new version and makes it active. */
export function forkParagraph(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const variants = syncedParagraphVariants(node);
  const active: number = node.attrs.variants ? node.attrs.active : 0;
  variants.push(variants[active]);
  return state.tr.setNodeMarkup(pos, undefined, {
    vid: node.attrs.vid ?? newId(),
    variants,
    active: variants.length - 1,
  });
}

export function removeParagraphVariant(state: EditorState, pos: number, index: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node?.attrs.variants) return null;
  const variants = syncedParagraphVariants(node);
  const active: number = node.attrs.active;
  variants.splice(index, 1);
  const next = index === active ? Math.max(0, index - 1) : index < active ? active - 1 : active;
  return replaceParagraph(state, pos, node, variants, next);
}

// ---------------------------------------------------------------------------
// Ghost and overflow

export const toggleGhost: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) {
    const r = markRangeAt(state.doc, from, ghost);
    if (!r) return false;
    dispatch?.(state.tr.removeMark(r.from, r.to, ghost));
    return true;
  }
  const tr = state.doc.rangeHasMark(from, to, ghost)
    ? state.tr.removeMark(from, to, ghost)
    : state.tr.addMark(from, to, ghost.create());
  dispatch?.(tr);
  return true;
};

export function reviveAt(state: EditorState, pos: number): Transaction | null {
  const r = markRangeAt(state.doc, pos, ghost);
  return r ? state.tr.removeMark(r.from, r.to, ghost) : null;
}

export function takeSelectionText(state: EditorState): { tr: Transaction; text: string } | null {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const text = state.doc.textBetween(from, to, "\n\n", "\n");
  return { tr: state.tr.deleteSelection(), text };
}

// ---------------------------------------------------------------------------
// Settling: keep the current choice and drop the rest

/** Keeps the current text of an alternative and drops the others. */
export function dropAlt(state: EditorState, id: string): Transaction | null {
  const r = findAltById(state.doc, id);
  return r ? state.tr.removeMark(r.from, r.to, alt) : null;
}

/** Keeps the current version of a paragraph and drops the others. */
export function settleParagraph(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node?.attrs.variants) return null;
  return state.tr.setNodeMarkup(pos, undefined, { vid: null, variants: null, active: 0 });
}

/** Keeps every current choice in the document. Ghosts stay as they are. */
export function settleAll(state: EditorState): Transaction | null {
  const tr = state.tr.removeMark(0, state.doc.content.size, alt);
  state.doc.forEach((p, offset) => {
    if (p.attrs.variants) tr.setNodeMarkup(offset, undefined, { vid: null, variants: null, active: 0 });
  });
  return tr.docChanged ? tr : null;
}

export function hasGhosts(doc: Node): boolean {
  return doc.rangeHasMark(0, doc.content.size, ghost);
}

export function reviveAll(state: EditorState): Transaction | null {
  return hasGhosts(state.doc) ? state.tr.removeMark(0, state.doc.content.size, ghost) : null;
}

/** Deletes all ghosted text: "make the cuts". */
export function deleteGhosts(state: EditorState): Transaction | null {
  const ranges: { from: number; to: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isInline || !ghost.isInSet(node.marks)) return;
    const last = ranges[ranges.length - 1];
    if (last && last.to === pos) last.to = pos + node.nodeSize;
    else ranges.push({ from: pos, to: pos + node.nodeSize });
  });
  if (!ranges.length) return null;
  const tr = state.tr;
  for (const r of ranges.reverse()) {
    // Don't leave a double space where the ghost was.
    const $from = state.doc.resolve(r.from);
    const before = r.from > $from.start() ? state.doc.textBetween(r.from - 1, r.from) : " ";
    const after = r.to < $from.end() ? state.doc.textBetween(r.to, r.to + 1) : "";
    tr.delete(r.from, before === " " && after === " " ? r.to + 1 : r.to);
  }
  return tr;
}

// ---------------------------------------------------------------------------
// Lists

// A list is plain text: one item per line, lines split by hard breaks, all in
// one paragraph. That is how a Markdown list loads from disk.
const LIST_MARKER = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)/;

const lineEndAt = (text: string, i: number) => {
  const n = text.indexOf("\n", i);
  return n < 0 ? text.length : n;
};

/** Enter in a list item starts the next item. Enter in an empty item ends the list. */
export const continueList: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to) || $from.parent.type !== schema.nodes.paragraph) return false;
  const para = $from.parent;
  // A hard break is one position wide, so string offsets match paragraph offsets.
  const text = para.textBetween(0, para.content.size, undefined, "\n");
  const offset = $from.parentOffset;
  const lineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = lineEndAt(text, offset);
  const line = text.slice(lineStart, lineEnd);
  const m = LIST_MARKER.exec(line);
  if (!m || offset < lineStart + m[0].length) return false;
  if (!dispatch) return true;

  const start = $from.start();
  const tr = state.tr;

  if (line.slice(m[0].length).trim() === "") {
    // Drop the empty item. Lines before and after stay as their own paragraphs.
    const hasBefore = lineStart > 0;
    const hasAfter = lineEnd < text.length;
    let pos = start + (hasBefore ? lineStart - 1 : lineStart);
    tr.delete(pos, start + (hasAfter ? lineEnd + 1 : lineEnd));
    if (hasBefore) {
      tr.split(pos);
      pos += 2;
    }
    if (hasAfter) tr.split(pos);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos)).scrollIntoView());
    return true;
  }

  const [, indent, bullet, num, delim, space] = m;

  // Renumber the items below at the same level. Nested lines are skipped.
  // Done first: these edits sit after the caret, so its positions stay valid.
  if (num) {
    let n = Number(num) + 1;
    const edits: { from: number; to: number; text: string }[] = [];
    for (let s = lineEndAt(text, $to.parentOffset) + 1; s <= text.length; ) {
      const e = lineEndAt(text, s);
      const next = text.slice(s, e);
      const lead = /^\s*/.exec(next)![0].length;
      const item = LIST_MARKER.exec(next);
      if (lead <= indent.length) {
        if (!item?.[3] || lead < indent.length || item[4] !== delim) break;
        edits.push({ from: s + lead, to: s + lead + item[3].length, text: String(++n) });
      }
      s = e + 1;
    }
    for (const ed of edits.reverse()) tr.insertText(ed.text, start + ed.from, start + ed.to);
  }

  // Don't carry spaces around the caret into either item.
  let a = offset;
  while (a > lineStart + m[0].length && /[ \t]/.test(text[a - 1])) a--;
  let b = $to.parentOffset;
  while (b < text.length && /[ \t]/.test(text[b])) b++;

  const marker = `${indent}${bullet ?? `${Number(num) + 1}${delim}`}${space}`;
  tr.replaceWith(start + a, start + b, [schema.nodes.hard_break.create(), schema.text(marker)]);
  dispatch(tr.setSelection(TextSelection.create(tr.doc, start + a + 1 + marker.length)).scrollIntoView());
  return true;
};

// ---------------------------------------------------------------------------
// Counting

export function countWords(doc: Node): { words: number; chars: number } {
  let text = "";
  doc.forEach((p) => {
    p.forEach((n) => {
      if (n.isText && !ghost.isInSet(n.marks)) text += n.text;
      else text += " ";
    });
    text += "\n";
  });
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return { words, chars: text.replace(/\s/g, "").length };
}
