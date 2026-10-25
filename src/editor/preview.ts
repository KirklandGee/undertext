import { syntaxTree } from "@codemirror/language";
import { EditorState, Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { SyntaxNode } from "@lezer/common";
import { openUrl } from "../lib/links";

// Live preview: Markdown renders in place, and its syntax shows when you
// touch it. Inline syntax shows when the selection touches the element, edges
// included. Line syntax (#, >, list markers) shows when the cursor is on the line.

const hide = Decoration.replace({});
const marker = Decoration.mark({ class: "md-marker" });
const MARKS: Record<string, Decoration> = {
  Emphasis: Decoration.mark({ class: "md-em" }),
  StrongEmphasis: Decoration.mark({ class: "md-strong" }),
  Strikethrough: Decoration.mark({ class: "md-del" }),
  InlineCode: Decoration.mark({ class: "md-code" }),
};
const INLINE_MARKS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark"]);
const link = Decoration.mark({ class: "md-link", attributes: { title: "⌘-click to open" } });
const blank = Decoration.line({ class: "md-blank" });
const quoteLine = Decoration.line({ class: "md-quote" });
const codeLine = Decoration.line({ class: "md-codeblock" });
const hrLine = Decoration.line({ class: "md-hr" });

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-bullet";
    el.textContent = "•";
    return el;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.className = "md-task";
    el.checked = this.checked;
    el.tabIndex = -1;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });

export function buildPreview(state: EditorState, visible: readonly { from: number; to: number }[]): DecorationSet {
  const { doc, selection } = state;
  const out: Range<Decoration>[] = [];
  const touches = (from: number, to: number) => selection.ranges.some((r) => r.from <= to && r.to >= from);
  const onActiveLine = (pos: number) => {
    const line = doc.lineAt(pos);
    return touches(line.from, line.to);
  };
  const eachLine = (from: number, to: number, deco: Decoration) => {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) out.push(deco.range(doc.line(n).from));
  };
  /** Hides `from..to`, plus the space after it. */
  const hideWithSpace = (from: number, to: number) => {
    const end = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
    out.push(hide.range(from, end));
  };

  for (const { from, to } of visible) {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
      const line = doc.line(n);
      if (!line.text.trim()) out.push(blank.range(line.from));
    }

    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        const { name } = ref;
        const node = ref.node;

        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(Decoration.line({ class: `md-h md-h${heading[1]}` }).range(doc.lineAt(node.from).from));
          return;
        }
        if (name === "HeaderMark" && node.parent?.name.startsWith("ATXHeading")) {
          if (onActiveLine(node.from)) out.push(marker.range(node.from, node.to));
          else if (node.from === node.parent.from) hideWithSpace(node.from, node.to);
          // A closing `#` run: hide it with the space before it.
          else out.push(hide.range(doc.sliceString(node.from - 1, node.from) === " " ? node.from - 1 : node.from, node.to));
          return;
        }

        const mark = MARKS[name];
        if (mark) {
          out.push(mark.range(node.from, node.to));
          return;
        }
        if (INLINE_MARKS.has(name) && node.parent) {
          if (touches(node.parent.from, node.parent.to)) out.push(marker.range(node.from, node.to));
          else out.push(hide.range(node.from, node.to));
          return;
        }

        if (name === "Link") {
          // Then descend, so emphasis in the link text still renders.
          previewLink(node);
          return;
        }
        if (name === "Autolink") {
          const url = node.getChild("URL");
          if (url) out.push(link.range(url.from, url.to));
          for (const m of node.getChildren("LinkMark")) {
            out.push((touches(node.from, node.to) ? marker : hide).range(m.from, m.to));
          }
          return false;
        }
        if (name === "URL" && node.parent?.name !== "Link" && node.parent?.name !== "Image") {
          out.push(link.range(node.from, node.to));
          return;
        }
        if (name === "Image" || name === "LinkReference" || name.startsWith("HTML") || name.startsWith("Comment")) {
          out.push(marker.range(node.from, node.to));
          return false;
        }

        if (name === "Escape") {
          if (!touches(node.from, node.to)) out.push(hide.range(node.from, node.from + 1));
          return;
        }

        if (name === "Blockquote") {
          eachLine(node.from, node.to, quoteLine);
          return;
        }
        if (name === "QuoteMark") {
          if (onActiveLine(node.from)) out.push(marker.range(node.from, node.to));
          else hideWithSpace(node.from, node.to);
          return;
        }

        if (name === "ListMark" && node.parent?.name === "ListItem") {
          previewListMark(node);
          return;
        }
        if (name === "TaskMarker") {
          if (touches(node.from, node.to)) out.push(marker.range(node.from, node.to));
          else {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(node.from, node.to));
          }
          return;
        }

        if (name === "HorizontalRule") {
          if (!onActiveLine(node.from)) {
            out.push(hrLine.range(doc.lineAt(node.from).from), hide.range(node.from, node.to));
          }
          return false;
        }

        if (name === "FencedCode" || name === "CodeBlock") {
          eachLine(node.from, node.to, codeLine);
          for (const m of [...node.getChildren("CodeMark"), ...node.getChildren("CodeInfo")]) {
            out.push(marker.range(m.from, m.to));
          }
          return false;
        }
        return;
      },
    });
  }

  function previewLink(node: SyntaxNode) {
    const marks = node.getChildren("LinkMark");
    const open = marks[0];
    const close = marks.find((m) => doc.sliceString(m.from, m.to) === "]");
    if (!open || !close) return;
    if (close.from > open.to) out.push(link.range(open.to, close.from));
    if (touches(node.from, node.to)) {
      out.push(marker.range(open.from, open.to), marker.range(close.from, node.to));
    } else {
      out.push(hide.range(open.from, open.to));
      if (node.to > close.from) out.push(hide.range(close.from, node.to));
    }
  }

  function previewListMark(node: SyntaxNode) {
    const line = doc.lineAt(node.from);
    const after = /^[ \t]*/.exec(doc.sliceString(node.to, line.to))![0].length;
    const indent = node.to + after - line.from;
    // Wrapped lines start under the text, not under the marker.
    out.push(
      Decoration.line({ attributes: { style: `padding-left: ${indent}ch; text-indent: -${indent}ch` } }).range(line.from),
    );
    const isBullet = node.parent?.parent?.name === "BulletList";
    if (isBullet && !onActiveLine(node.from)) out.push(bullet.range(node.from, node.to));
    else out.push(marker.range(node.from, node.to));
  }

  return Decoration.set(out, true);
}

/** The target of the link at `pos`: a `[text](url)`, an `<autolink>`, or a bare URL. */
export function linkAt(state: EditorState, pos: number): string | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "URL") return state.doc.sliceString(n.from, n.to);
    if (n.name === "Link" || n.name === "Autolink") {
      const url = n.getChild("URL");
      return url ? state.doc.sliceString(url.from, url.to) : null;
    }
  }
  return null;
}

/** Toggles `[ ]` and `[x]` when you click a task's checkbox. */
function toggleTask(view: EditorView, target: HTMLElement): boolean {
  if (!target.classList.contains("md-task")) return false;
  const pos = view.posAtDOM(target);
  const text = view.state.doc.sliceString(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(text)) return false;
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " } });
  return true;
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildPreview(view.state, view.visibleRanges);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildPreview(u.state, u.view.visibleRanges);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        if (toggleTask(view, e.target as HTMLElement)) {
          e.preventDefault();
          return true;
        }
        // ⌘-click opens a link.
        if (e.metaKey && !e.altKey && !e.shiftKey) {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          const url = pos === null ? null : linkAt(view.state, pos);
          if (url) {
            e.preventDefault();
            void openUrl(url);
            return true;
          }
        }
        return false;
      },
    },
  },
);
