import { Mark, Node } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import {
  altInSelection,
  cycleAlt,
  cycleAtCaret,
  cycleParagraph,
  cycleParagraphAtCaret,
  findParagraphByVid,
  jumpToItem,
  paragraphAt,
  setAltActive,
  setParagraphActive,
} from "./commands";
import { jumpToLabSpan } from "./lab";
import { newId, schema } from "./schema";

const { alt } = schema.marks;

// ---------------------------------------------------------------------------
// Decorations: paragraph gutters and light Markdown styling

const decoKey = new PluginKey<DecorationSet>("undertext-decorations");

export const decorationsPlugin = new Plugin<DecorationSet>({
  key: decoKey,
  state: {
    init: (_, state) => buildDecorations(state.doc),
    apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
  },
  props: {
    decorations: (state) => decoKey.getState(state),
  },
});

function buildDecorations(doc: Node): DecorationSet {
  const decos: Decoration[] = [];

  doc.forEach((para, offset) => {
    const start = offset + 1;
    const end = offset + para.nodeSize;

    const variants: string[] | null = para.attrs.variants;
    if (variants && variants.length > 1) {
      const active: number = para.attrs.active;
      decos.push(
        Decoration.node(offset, end, {
          class: `has-versions${active !== 0 ? " modified" : ""}`,
          "data-vid": para.attrs.vid,
        }),
        Decoration.widget(start, () => dots("para-dots", variants.length, active, { vid: para.attrs.vid }), {
          side: -1,
          ignoreSelection: true,
          key: `p:${para.attrs.vid}:${variants.length}:${active}`,
        }),
      );
    }

    const text = para.textBetween(0, para.content.size, undefined, "\n");
    const heading = /^(#{1,6})\s/.exec(text);
    if (heading) {
      decos.push(
        Decoration.node(offset, end, { class: `md-h md-h${heading[1].length}` }),
        Decoration.inline(start, start + heading[0].length, { class: "md-marker" }),
      );
    }
    for (const m of text.matchAll(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g)) {
      const a = start + m.index;
      const b = a + m[0].length;
      decos.push(
        Decoration.inline(a, b, { class: "md-strong" }),
        Decoration.inline(a, a + 2, { class: "md-marker" }),
        Decoration.inline(b - 2, b, { class: "md-marker" }),
      );
    }
    for (const m of text.matchAll(/(?<!~)~~(?=[^\s~])(.+?)(?<=[^\s~])~~(?!~)/g)) {
      const a = start + m.index;
      const b = a + m[0].length;
      decos.push(
        Decoration.inline(a, b, { class: "md-del" }),
        Decoration.inline(a, a + 2, { class: "md-marker" }),
        Decoration.inline(b - 2, b, { class: "md-marker" }),
      );
    }
    for (const m of text.matchAll(/(?<![*\p{L}\p{N}])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\p{L}\p{N}])/gu)) {
      const a = start + m.index;
      const b = a + m[0].length;
      decos.push(
        Decoration.inline(a, b, { class: "md-em" }),
        Decoration.inline(a, a + 1, { class: "md-marker" }),
        Decoration.inline(b - 1, b, { class: "md-marker" }),
      );
    }
  });

  return DecorationSet.create(doc, decos);
}

// ---------------------------------------------------------------------------
// Alternative dots, drawn below the text in a layer outside the editor.
// They take no space, so showing or hiding them never re-wraps lines.

export const altDotsPlugin = new Plugin({
  view(editorView) {
    const layer = document.createElement("div");
    layer.className = "dots-layer";
    editorView.dom.parentNode?.appendChild(layer);

    let frame = 0;
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        drawLayer(editorView.dom, layer);
      });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(editorView.dom);
    void document.fonts?.ready.then(schedule);

    layer.addEventListener("mousemove", (e) => {
      trackMouse(e);
      const row = (e.target as HTMLElement).closest?.(".alt-dots") as HTMLElement | null;
      hover.altId = row?.dataset.altId ?? null;
      hover.vid = null;
    });
    layer.addEventListener("mouseleave", () => (hover.altId = null));
    layer.addEventListener("mousedown", (e) => {
      const dot = (e.target as HTMLElement).closest?.(".dot") as HTMLElement | null;
      const id = (dot?.parentElement as HTMLElement | null)?.dataset.altId;
      if (!dot || !id) return;
      e.preventDefault();
      const tr = setAltActive(editorView.state, id, Number(dot.dataset.index));
      if (tr) editorView.dispatch(tr);
    });

    schedule();
    return {
      update(view, prev) {
        // The selection decides which item is highlighted, so redraw on moves too.
        if (view.state.doc !== prev.doc || !view.state.selection.eq(prev.selection)) schedule();
      },
      destroy() {
        cancelAnimationFrame(frame);
        resize.disconnect();
        layer.remove();
      },
    };
  },
});

const DOT = 5;
const GAP = 3;

function drawLayer(editor: HTMLElement, layer: HTMLElement) {
  const base = layer.getBoundingClientRect();
  const ink = document.createElementNS(SVG_NS, "svg");
  ink.setAttribute("class", "ink");
  const out: Element[] = [ink];

  const groups = new Map<string, HTMLElement[]>();
  for (const el of editor.querySelectorAll<HTMLElement>(".alt")) {
    if (Number(el.dataset.count) < 2) continue;
    const id = el.dataset.altId!;
    groups.set(id, [...(groups.get(id) ?? []), el]);
  }

  for (const [id, els] of groups) {
    const rects = els.flatMap((el) => [...el.getClientRects()]).filter((r) => r.width > 0);
    if (!rects.length) continue;
    const first = els[0];
    const target = els.some((el) => el.querySelector(".is-target"));

    // Seed from the original text, so each line keeps its shape while you edit and cycle.
    rects.forEach((r, i) => {
      const y = r.bottom - base.top + 1;
      const d = inkPath(r.left - base.left, y, r.right - base.left, y, 1.5, `${first.dataset.variants}:${i}`);
      ink.appendChild(svgPath(d, target ? "underline target" : "underline"));
    });

    const count = Number(first.dataset.count);
    const width = count * DOT + (count - 1) * GAP;
    const last = rects[rects.length - 1];
    const oneLine = rects.every((r) => Math.abs(r.top - rects[0].top) < 2);
    const isWord = oneLine && !/\s/.test(els.map((el) => el.textContent).join("").trim());

    // A word gets its dots centered below it. A sentence gets them below its end.
    const left = isWord ? last.left + last.width / 2 - width / 2 : last.right - width;
    const row = dots("alt-dots", count, Number(first.dataset.active), { altId: id });
    row.style.left = `${Math.round(left - base.left)}px`;
    row.style.top = `${Math.round(last.bottom - base.top + 4)}px`;
    out.push(row);
  }

  for (const p of editor.querySelectorAll<HTMLElement>(".has-versions")) {
    const r = p.getBoundingClientRect();
    const x = r.left - base.left - 19.5;
    const target = p.classList.contains("is-target");
    const d = inkPath(x, r.top - base.top + 7, x, r.bottom - base.top - 7, target ? 2.2 : 1.2, p.dataset.vid ?? "");
    const cls = `gutter${p.classList.contains("modified") ? " modified" : ""}${target ? " target" : ""}`;
    ink.appendChild(svgPath(d, cls));
  }

  layer.replaceChildren(...out);
}

// ---------------------------------------------------------------------------
// Hand-drawn lines: a slight wobble, a little drift, and tapered ends.
// Keep it subtle. INK_WOBBLE is the peak offset in pixels.

const SVG_NS = "http://www.w3.org/2000/svg";
const INK_WOBBLE = 0.55;

function svgPath(d: string, className: string): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", className);
  return path;
}

function inkPath(x1: number, y1: number, x2: number, y2: number, width: number, seed: string): string {
  const rand = random(seed);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1) return "";
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  // Pens rarely start or stop exactly on the mark.
  const start = (rand() - 0.6) * 1.5;
  const end = len + (rand() - 0.4) * 2;
  const p1 = 70 + rand() * 60;
  const p2 = 24 + rand() * 14;
  const f1 = rand() * Math.PI * 2;
  const f2 = rand() * Math.PI * 2;
  const drift = (rand() - 0.5) * 0.9;

  const steps = Math.max(6, Math.ceil((end - start) / 5));
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = start + (end - start) * t;
    const off =
      INK_WOBBLE * (0.65 * Math.sin((2 * Math.PI * s) / p1 + f1) + 0.35 * Math.sin((2 * Math.PI * s) / p2 + f2)) +
      drift * (t - 0.5);
    const w = (width / 2) * (0.4 + 0.6 * Math.pow(Math.sin(Math.PI * t), 0.4));
    const cx = x1 + ux * s - uy * off;
    const cy = y1 + uy * s + ux * off;
    left.push(`${(cx - uy * w).toFixed(2)} ${(cy + ux * w).toFixed(2)}`);
    right.push(`${(cx + uy * w).toFixed(2)} ${(cy - ux * w).toFixed(2)}`);
  }
  return `M${left.join("L")}L${right.reverse().join("L")}Z`;
}

/** Small seeded PRNG (FNV-1a hash + xorshift), so a seed always draws the same line. */
function random(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
}

function dots(className: string, count: number, active: number, data: Record<string, string>): HTMLElement {
  const el = document.createElement("span");
  el.className = `${className}${active !== 0 ? " modified" : ""}`;
  el.contentEditable = "false";
  Object.assign(el.dataset, data);
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("span");
    dot.className = i === active ? "dot on" : "dot";
    dot.dataset.index = String(i);
    el.appendChild(dot);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Cycling: hover + arrows, Option + J/K/H/L at the caret, click on dots

// "Armed" means the mouse moved since the last click or keystroke.
// Hover cycling only works while armed, so typing never cycles by accident.
const hover = { altId: null as string | null, vid: null as string | null, x: 0, y: 0, armed: false };

function trackMouse(e: MouseEvent) {
  if (Math.hypot(e.clientX - hover.x, e.clientY - hover.y) > 3) hover.armed = true;
  hover.x = e.clientX;
  hover.y = e.clientY;
}

export const cyclingPlugin = (() => {
  let lastJump: number | null = null;

  return new Plugin({
    props: {
      handleDOMEvents: {
        mousemove(_view, e) {
          trackMouse(e);
          const target = e.target as HTMLElement;
          const altEl = target.closest?.(".alt") as HTMLElement | null;
          hover.altId = altEl && altEl.dataset.count !== "1" ? (altEl.dataset.altId ?? null) : null;
          const paraEl = target.closest?.(".has-versions") as HTMLElement | null;
          hover.vid = paraEl?.dataset.vid ?? null;
          return false;
        },
        mouseleave() {
          hover.altId = null;
          hover.vid = null;
          return false;
        },
        mousedown(view, e) {
          hover.armed = false;
          const dot = (e.target as HTMLElement).closest?.(".dot") as HTMLElement | null;
          if (!dot) return false;
          const vid = (dot.parentElement as HTMLElement).dataset.vid;
          const pos = vid ? findParagraphByVid(view.state.doc, vid) : null;
          const tr = pos === null ? null : setParagraphActive(view.state, pos, Number(dot.dataset.index));
          if (tr) view.dispatch(tr);
          e.preventDefault();
          return true;
        },
      },
      handleKeyDown(view, e) {
        const { state } = view;

        // Option + Vim keys. Match the physical key: Option changes e.key (⌥J types ∆).
        // These keys are always consumed, so a stray ∆ never lands in the text.
        if (e.altKey && !e.metaKey && !e.ctrlKey) {
          if (e.code === "KeyJ" || e.code === "KeyK") {
            const dir = e.code === "KeyJ" ? 1 : -1;
            const tr = e.shiftKey ? cycleParagraphAtCaret(state, dir) : cycleAtCaret(state, dir);
            if (tr) view.dispatch(tr.scrollIntoView());
            return true;
          }
          if ((e.code === "KeyL" || e.code === "KeyH") && !e.shiftKey) {
            // While Lab results are showing, move between them instead.
            const labJump = jumpToLabSpan(state, e.code === "KeyL" ? 1 : -1);
            if (labJump) {
              view.dispatch(labJump);
              return true;
            }
            const jump = jumpToItem(state, e.code === "KeyL" ? 1 : -1, lastJump);
            if (jump) {
              view.dispatch(jump.tr);
              lastJump = jump.index;
            }
            return true;
          }
        }

        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
          hover.armed = false;
          return false;
        }
        const dir = e.key === "ArrowUp" ? -1 : 1;

        if (!hover.armed || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false;
        if (hover.altId) {
          const tr = cycleAlt(state, hover.altId, dir);
          if (tr) view.dispatch(tr);
          return true;
        }
        if (hover.vid) {
          const pos = findParagraphByVid(state.doc, hover.vid);
          const tr = pos === null ? null : cycleParagraph(state, pos, dir);
          if (tr) view.dispatch(tr);
          return true;
        }
        return false;
      },
    },
  });
})();

// ---------------------------------------------------------------------------
// Highlight what ⌥J / ⌥K will change: the alternative at the caret, or its paragraph

export const targetPlugin = new Plugin({
  props: {
    decorations(state) {
      const r = altInSelection(state);
      if (r && r.mark.attrs.variants.length > 1) {
        return DecorationSet.create(state.doc, [Decoration.inline(r.from, r.to, { class: "is-target" })]);
      }
      const p = paragraphAt(state);
      if (p && (p.node.attrs.variants?.length ?? 0) > 1) {
        return DecorationSet.create(state.doc, [
          Decoration.node(p.pos, p.pos + p.node.nodeSize, { class: "is-target" }),
        ]);
      }
      return DecorationSet.empty;
    },
  },
});

// ---------------------------------------------------------------------------
// Our own caret. The native one can leave a ghost behind on macOS when a swap
// replaces the text around it, so the editor hides it (caret-color: transparent)
// and this plugin draws one that moves in the same step as the text.

export const caretPlugin = new Plugin({
  view(view) {
    const caret = document.createElement("div");
    caret.className = "caret";
    caret.setAttribute("aria-hidden", "true");
    view.dom.parentNode?.appendChild(caret);

    const place = () => {
      const { selection } = view.state;
      if (!selection.empty || !view.hasFocus() || !document.hasFocus()) {
        caret.style.display = "none";
        return;
      }
      const base = (caret.parentElement as HTMLElement).getBoundingClientRect();
      const c = view.coordsAtPos(selection.head);
      caret.style.display = "block";
      caret.style.transform = `translate(${c.left - base.left - 1}px, ${c.top - base.top}px)`;
      caret.style.height = `${c.bottom - c.top}px`;
      // Restart the blink so the caret stays solid while it moves.
      caret.classList.remove("blink");
      void caret.offsetWidth;
      caret.classList.add("blink");
    };

    const resize = new ResizeObserver(place);
    resize.observe(view.dom);
    view.dom.addEventListener("focus", place);
    view.dom.addEventListener("blur", place);
    window.addEventListener("focus", place);
    window.addEventListener("blur", place);
    void document.fonts?.ready.then(place);
    place();

    return {
      update: place,
      destroy() {
        resize.disconnect();
        view.dom.removeEventListener("focus", place);
        view.dom.removeEventListener("blur", place);
        window.removeEventListener("focus", place);
        window.removeEventListener("blur", place);
        caret.remove();
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Keep ids unique after splits, joins, and pastes

export const dedupePlugin = new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some((t) => t.docChanged)) return null;
    const tr = state.tr;

    const vids = new Set<string>();
    state.doc.forEach((p, offset) => {
      const vid: string | null = p.attrs.vid;
      if (!vid) return;
      if (vids.has(vid)) tr.setNodeMarkup(offset, undefined, { vid: null, variants: null, active: 0 });
      else vids.add(vid);
    });

    const ends = new Map<string, number>();
    const renames: { oldId: string; from: number; to: number; mark: Mark }[] = [];
    state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const mark = alt.isInSet(node.marks);
      if (!mark) return;
      const id: string = mark.attrs.id;
      const last = renames[renames.length - 1];
      if (last && last.oldId === id && last.to === pos) {
        last.to = pos + node.nodeSize;
        return;
      }
      const end = ends.get(id);
      if (end === undefined || end === pos) ends.set(id, pos + node.nodeSize);
      else renames.push({ oldId: id, from: pos, to: pos + node.nodeSize, mark });
    });
    for (const r of renames) {
      tr.removeMark(r.from, r.to, alt);
      tr.addMark(r.from, r.to, alt.create({ ...r.mark.attrs, id: newId() }));
    }

    return tr.docChanged ? tr : null;
  },
});
