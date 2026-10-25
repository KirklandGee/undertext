import { Extension, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { altInSelection, cycleAlt, cycleVersion, setAltActive, setVersionActive, versionAt } from "./commands";
import { layersField, layersOf } from "./layers";

// The layers' ink: underlines under alternatives, a gutter line beside
// paragraph versions, and the dots that show which version is on. They are
// drawn in a layer outside the editor and take no space, so showing or hiding
// them never re-wraps lines. What ⌥J / ⌥K will change (the alternative at the
// caret, or else its paragraph) is drawn darker.

// ---------------------------------------------------------------------------
// Cycling with the mouse: hover + ↑ ↓, or click a dot

// "Armed" means the mouse moved since the last click or keystroke.
// Hover cycling only works while armed, so typing never cycles by accident.
const hover = { altId: null as string | null, vid: null as string | null, x: 0, y: 0, armed: false };

function trackMouse(e: MouseEvent) {
  if (Math.hypot(e.clientX - hover.x, e.clientY - hover.y) > 3) hover.armed = true;
  hover.x = e.clientX;
  hover.y = e.clientY;
}

function cycleHovered(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  if (hover.altId) {
    const spec = cycleAlt(state, hover.altId, dir);
    if (spec) view.dispatch(spec);
    return true;
  }
  if (hover.vid) {
    const v = layersOf(state).versions.find((x) => x.vid === hover.vid);
    const spec = v ? cycleVersion(state, v.at, dir) : null;
    if (spec) view.dispatch(spec);
    return true;
  }
  return false;
}

const hoverCycling = Prec.highest(
  EditorView.domEventHandlers({
    mousemove(e) {
      trackMouse(e);
      const el = e.target as HTMLElement;
      const altEl = el.closest?.(".alt") as HTMLElement | null;
      hover.altId = altEl && altEl.dataset.count !== "1" ? (altEl.dataset.altId ?? null) : null;
      hover.vid = (el.closest?.(".has-versions") as HTMLElement | null)?.dataset.vid ?? null;
      return false;
    },
    mouseleave() {
      hover.altId = null;
      hover.vid = null;
      return false;
    },
    mousedown() {
      hover.armed = false;
      return false;
    },
    keydown(e, view) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
        hover.armed = false;
        return false;
      }
      if (!hover.armed || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false;
      if (!cycleHovered(view, e.key === "ArrowUp" ? -1 : 1)) return false;
      e.preventDefault();
      return true;
    },
  }),
);

// ---------------------------------------------------------------------------
// The ink layer

const inkLayer = ViewPlugin.fromClass(
  class {
    layer: HTMLElement;
    frame = 0;
    resize: ResizeObserver;

    constructor(readonly view: EditorView) {
      this.layer = document.createElement("div");
      this.layer.className = "dots-layer";
      view.dom.parentNode?.appendChild(this.layer);
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(view.dom);
      void document.fonts?.ready.then(() => this.schedule());

      this.layer.addEventListener("mousemove", (e) => {
        trackMouse(e);
        const row = (e.target as HTMLElement).closest?.(".alt-dots, .para-dots") as HTMLElement | null;
        hover.altId = row?.dataset.altId ?? null;
        hover.vid = row?.dataset.vid ?? null;
      });
      this.layer.addEventListener("mouseleave", () => {
        hover.altId = null;
        hover.vid = null;
      });
      this.layer.addEventListener("mousedown", (e) => {
        const dot = (e.target as HTMLElement).closest?.(".dot") as HTMLElement | null;
        const row = dot?.parentElement;
        if (!dot || !row) return;
        e.preventDefault();
        const index = Number(dot.dataset.index);
        const { state } = this.view;
        const v = row.dataset.vid ? layersOf(state).versions.find((x) => x.vid === row.dataset.vid) : null;
        const spec = row.dataset.altId
          ? setAltActive(state, row.dataset.altId, index)
          : v
            ? setVersionActive(state, v.at, index)
            : null;
        if (spec) this.view.dispatch(spec);
      });
      this.schedule();
    }

    schedule() {
      this.frame ||= requestAnimationFrame(() => {
        this.frame = 0;
        drawLayer(this.view, this.layer);
      });
    }

    update(u: ViewUpdate) {
      // The selection decides which item is highlighted, so redraw on moves too.
      const layersChanged = u.startState.field(layersField) !== u.state.field(layersField);
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || layersChanged) this.schedule();
    }

    destroy() {
      cancelAnimationFrame(this.frame);
      this.resize.disconnect();
      this.layer.remove();
    }
  },
);

const DOT = 5;
const GAP = 3;

function drawLayer(view: EditorView, layer: HTMLElement) {
  const { state } = view;
  const base = layer.getBoundingClientRect();
  const ink = document.createElementNS(SVG_NS, "svg");
  ink.setAttribute("class", "ink");
  const out: Element[] = [ink];
  const targetAlt = altInSelection(state);
  const targetVersion = versionAt(state);

  const groups = new Map<string, HTMLElement[]>();
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(".alt")) {
    if (Number(el.dataset.count) < 2) continue;
    const id = el.dataset.altId!;
    groups.set(id, [...(groups.get(id) ?? []), el]);
  }

  for (const [id, els] of groups) {
    const rects = els.flatMap((el) => [...el.getClientRects()]).filter((r) => r.width > 0);
    if (!rects.length) continue;
    const first = els[0];
    const isTarget = targetAlt?.id === id;

    // Seed from the original text, so each line keeps its shape while you edit and cycle.
    rects.forEach((r, i) => {
      const y = r.bottom - base.top + 1;
      const d = inkPath(r.left - base.left, y, r.right - base.left, y, 1.5, `${first.dataset.variants}:${i}`);
      ink.appendChild(svgPath(d, isTarget ? "underline target" : "underline"));
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

  for (const v of layersOf(state).versions) {
    const lines = view.contentDOM.querySelectorAll<HTMLElement>(`.has-versions[data-vid="${CSS.escape(v.vid)}"]`);
    if (!lines.length) continue;
    const top = lines[0].getBoundingClientRect().top;
    const bottom = lines[lines.length - 1].getBoundingClientRect().bottom;
    const left = lines[0].getBoundingClientRect().left;
    const isTarget = targetVersion?.vid === v.vid;
    const x = left - base.left - 19.5;
    const d = inkPath(x, top - base.top + 7, x, bottom - base.top - 7, isTarget ? 2.2 : 1.2, v.vid);
    ink.appendChild(svgPath(d, `gutter${v.active !== 0 ? " modified" : ""}${isTarget ? " target" : ""}`));

    const row = dots("para-dots", v.variants.length, v.active, { vid: v.vid });
    row.style.left = `${Math.round(left - base.left - 35)}px`;
    row.style.top = `${Math.round((top + bottom) / 2 - base.top)}px`;
    out.push(row);
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
  Object.assign(el.dataset, data);
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("span");
    dot.className = i === active ? "dot on" : "dot";
    dot.dataset.index = String(i);
    el.appendChild(dot);
  }
  return el;
}

export const inkLayers: Extension = [hoverCycling, inkLayer];
