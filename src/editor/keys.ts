import { deleteCharBackward, insertNewline } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { ChangeSpec, EditorSelection, EditorState, StateCommand, Transaction } from "@codemirror/state";
import { Command, EditorView } from "@codemirror/view";
import { SyntaxNode } from "@lezer/common";
import { wordRangeAt } from "./commands";
import { isBlockStart, layersOf, mapLayers, setLayers } from "./layers";

// Editing keys. Enter starts a new paragraph, as in the old editor: it
// inserts a blank line. Lists and quotes continue instead.

/** The nearest node named one of `names` around `pos`, looking at both sides. */
function nodeAt(state: EditorState, pos: number, names: string[]): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (names.includes(n.name)) return n;
    }
  }
  return null;
}

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });
const EMPTY_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?$/;
/** Quote and list markup up to, not including, the space after it. */
const BARE_MARKER = /^[\s>]*(?:(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?)?$/;

/** Enter: continue a list or quote, a plain line in code, else a new paragraph. */
export const enter: StateCommand = (target) => {
  const { state, dispatch } = target;
  const { head } = state.selection.main;
  if (nodeAt(state, head, ["FencedCode", "CodeBlock"])) return insertNewline(target);
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  if (nodeAt(state, head, ["ListItem", "Blockquote"])) {
    // CodeMirror drops the spaces before the caret, but not those after it. A
    // caret right after a marker, as in `1.‸ a`, keeps the space that ends it.
    let to = head;
    const bare = BARE_MARKER.test(state.doc.sliceString(line.from, head));
    while (!bare && to < line.to && /[ \t]/.test(state.doc.sliceString(to, to + 1))) to++;
    // An empty top-level item ends the list: drop it, and leave a paragraph to
    // type in, with blank lines around it. Items below become a list of their
    // own. A nested one goes to CodeMirror, which outdents it.
    if (range.empty && EMPTY_ITEM.test(line.text) && !/^\s/.test(line.text) && to === line.to) {
      const hasAfter = line.number < state.doc.lines && state.doc.line(line.number + 1).text.trim() !== "";
      dispatch(
        state.update({
          changes: { from: line.from, to: line.to, insert: hasAfter ? "\n\n" : "\n" },
          selection: EditorSelection.cursor(line.from + 1),
          scrollIntoView: true,
          userEvent: "input",
        }),
      );
      return true;
    }
    // Delete the spaces after the caret first, so the new item doesn't begin with one.
    if (to === head) return continueMarkup(target);
    const spaces = state.changes({ from: head, to });
    const trimmed = state.update({ changes: spaces }).state;
    return continueMarkup({
      state: trimmed,
      dispatch: (tr) =>
        dispatch(
          state.update({
            changes: spaces.compose(tr.changes),
            selection: tr.selection,
            // Mapped in two steps, so a ghost that began with those spaces starts in the new item.
            effects: setLayers.of(mapLayers(layersOf(trimmed), tr.changes)),
            scrollIntoView: true,
            userEvent: "input",
          }),
        ),
    });
  }

  if (!line.text.trim()) return insertNewline(target);

  // Don't carry spaces around the caret into either paragraph.
  let from = range.from;
  let to = range.to;
  while (from > line.from && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from--;
  while (to < state.doc.lineAt(range.to).to && /[ \t]/.test(state.doc.sliceString(to, to + 1))) to++;

  const changes = state.changes({ from, to, insert: "\n\n" });
  let layers = mapLayers(layersOf(state), changes);
  // Enter at the start of a paragraph with versions: the versions go down with its text.
  if (from === line.from && isBlockStart(state.doc, from)) {
    layers = { ...layers, versions: layers.versions.map((v) => (v.at === from ? { ...v, at: from + 2 } : v)) };
  }
  dispatch(
    state.update({
      changes,
      effects: setLayers.of(layers),
      selection: EditorSelection.cursor(from + 2),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/** Backspace at the start of a paragraph joins it to the one above. */
export const backspace: Command = (view) => {
  if (deleteMarkupBackward(view)) return true;
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return deleteCharBackward(view);
  const pos = range.head;
  if (pos === 0 || !isBlockStart(state.doc, pos)) return deleteCharBackward(view);
  let prev = state.doc.lineAt(pos).number - 1;
  while (prev > 1 && !state.doc.line(prev).text.trim()) prev--;
  const end = state.doc.line(prev).text.trim() ? state.doc.line(prev).to : 0;
  view.dispatch({ changes: { from: end, to: pos }, scrollIntoView: true, userEvent: "delete.backward" });
  return true;
};

// ---------------------------------------------------------------------------
// Formatting: ⌘B, ⌘I, ⌘E, strikethrough, links

/**
 * Toggles inline formatting. With a selection, wraps it, or unwraps it if
 * it is already formatted. With the cursor in formatted text, unwraps it. On
 * a word, wraps the word. Otherwise inserts the pair with the cursor between.
 */
export function toggleInline(marker: string, nodeName: string): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const node = nodeAt(state, range.from, [nodeName]);
    if (node && node.from <= range.from && node.to >= range.to) {
      const open = node.firstChild;
      const close = node.lastChild;
      if (!open || !close || open === close) return false;
      dispatch(
        state.update({
          changes: [
            { from: open.from, to: open.to },
            { from: close.from, to: close.to },
          ],
          userEvent: "input.format",
        }),
      );
      return true;
    }

    let { from, to } = range;
    if (range.empty) {
      const word = wordRangeAt(state, range.head);
      if (!word) {
        dispatch(
          state.update({
            changes: { from, insert: marker + marker },
            selection: EditorSelection.cursor(from + marker.length),
            userEvent: "input.format",
          }),
        );
        return true;
      }
      ({ from, to } = word);
    }
    // Markdown needs the markers right next to the text.
    const text = state.doc.sliceString(from, to);
    from += text.length - text.trimStart().length;
    to -= text.length - text.trimEnd().length;
    if (from >= to) return false;
    dispatch(
      state.update({
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        selection: range.empty
          ? EditorSelection.cursor(range.head + marker.length)
          : EditorSelection.range(from + marker.length, to + marker.length),
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

export const toggleBold = toggleInline("**", "StrongEmphasis");
export const toggleItalic = toggleInline("*", "Emphasis");
export const toggleCode = toggleInline("`", "InlineCode");
export const toggleStrike = toggleInline("~~", "Strikethrough");

/** ⌘⇧K: wraps the selection as `[text]()` with the cursor in the parentheses. In a link, unwraps it. */
export const toggleLink: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const node = nodeAt(state, range.from, ["Link"]);
  if (node) {
    const marks = node.getChildren("LinkMark");
    const close = marks.find((m) => state.doc.sliceString(m.from, m.to) === "]");
    if (!marks.length || !close) return false;
    dispatch(
      state.update({
        changes: [
          { from: marks[0].from, to: marks[0].to },
          { from: close.from, to: node.to },
        ],
        userEvent: "input.format",
      }),
    );
    return true;
  }
  const { from, to } = range;
  dispatch(
    state.update({
      changes: [
        { from, insert: "[" },
        { from: to, insert: "]()" },
      ],
      selection: EditorSelection.cursor(range.empty ? from + 1 : to + 3),
      userEvent: "input.format",
    }),
  );
  return true;
};

// ---------------------------------------------------------------------------
// Headings and lists: ⌥⌘1–3, ⌥⌘0, ⌘⇧7, ⌘⇧8, ⌘⇧9

/** A heading or list marker after the indent, task box included. */
const BLOCK_MARKER = /^(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;
const LIST_KINDS = {
  bullet: /^[-*+][ \t]+(?!\[[ xX]\])/,
  ordered: /^\d+[.)][ \t]+/,
  task: /^[-*+][ \t]+\[[ xX]\][ \t]+/,
};
export type ListKind = keyof typeof LIST_KINDS;

/** The lines the selection touches. Blank ones count only for a bare cursor. */
function selectedLines(state: EditorState) {
  const lines = new Map<number, ReturnType<EditorState["doc"]["line"]>>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      const line = state.doc.line(n);
      if (line.text.trim() || r.empty) lines.set(n, line);
    }
  }
  return [...lines.values()];
}

/** Replaces each line's heading or list marker. `marker(i)` gives the new one for the i-th line. */
function setMarkers(state: EditorState, keepIndent: boolean, marker: (i: number) => string) {
  return selectedLines(state).map((line, i) => {
    const indent = /^[ \t]*/.exec(line.text)![0].length;
    const old = BLOCK_MARKER.exec(line.text.slice(indent))?.[0].length ?? 0;
    return { from: line.from + (keepIndent ? indent : 0), to: line.from + indent + old, insert: marker(i) };
  });
}

/** Applies marker changes. A cursor right at a new marker moves after it. */
function applyMarkers(state: EditorState, dispatch: (tr: Transaction) => void, specs: ChangeSpec[]) {
  const changes = state.changes(specs);
  dispatch(
    state.update({ changes, selection: state.selection.map(changes, 1), scrollIntoView: true, userEvent: "input.format" }),
  );
}

/** Makes the lines a heading of `level`, or plain text with 0. The same level again makes them plain. */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state);
    if (!lines.length) return false;
    const same = level > 0 && lines.every((l) => new RegExp(`^#{${level}}[ \\t]`).test(l.text.trimStart()));
    const marker = level > 0 && !same ? `${"#".repeat(level)} ` : "";
    applyMarkers(state, dispatch, setMarkers(state, false, () => marker));
    return true;
  };
}

/** Makes the lines a list of `kind`, numbered from 1. If they already are one, makes them plain. */
export function toggleList(kind: ListKind): StateCommand {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state);
    if (!lines.length) return false;
    const already = lines.every((l) => LIST_KINDS[kind].test(l.text.trimStart()));
    const marker = (i: number) => (already ? "" : kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : `${i + 1}. `);
    applyMarkers(state, dispatch, setMarkers(state, true, marker));
    return true;
  };
}

/** Runs a state command from a key handler, keeping focus in the editor. */
export const runCommand = (view: EditorView, cmd: StateCommand) =>
  cmd({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
