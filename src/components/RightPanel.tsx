import { KeyboardEvent, RefObject, useEffect, useRef } from "react";
import { CHECKS, CheckId, TRIMS, TrimId } from "../ai/tasks";
import { Kind } from "../editor/readability";
import { EditorInfo } from "../editor/setup";
import { Icon } from "./Icon";
import { RightTab } from "./panels";

interface Props {
  tab: RightTab;
  panelRef: RefObject<HTMLElement | null>;
  overflow: string;
  busy: string | null;
  /** Live highlights. Null until Review turns them on. */
  checks: EditorInfo["checks"];
  words: number;
  hidden: readonly Kind[];
  onToggle(kinds: readonly Kind[]): void;
  onJump(kinds: readonly Kind[]): void;
  onTab(tab: RightTab): void;
  onOverflow(text: string): void;
  onFix(): void;
  onCheck(id: CheckId): void;
  onTrim(id: TrimId): void;
  onCancel(): void;
  /** Esc: back to the page. The panel stays open. */
  onPage(): void;
}

/**
 * The right panel, about the whole page: Review (readability, highlights, AI checks, trims) and
 * Overflow, one tab at a time. The element marked `data-focus` takes the focus when the tab opens from its key.
 */
export function RightPanel(props: Props) {
  const { tab } = props;
  return (
    <aside className="side side-right" aria-label={tab === "review" ? "Review" : "Overflow"} ref={props.panelRef}>
      <nav className="tabs">
        <button className={tab === "review" ? "on" : ""} onClick={() => props.onTab("review")} title="Review (⌘⇧E)">
          Review
        </button>
        <button className={tab === "overflow" ? "on" : ""} onClick={() => props.onTab("overflow")} title="Overflow (⌘⇧O)">
          Overflow
        </button>
      </nav>
      {tab === "review" ? <Review {...props} /> : <Overflow {...props} />}
    </aside>
  );
}

/** Arrow keys move, Return runs, Esc cancels a run or goes back to the page. */
function Review(props: Props) {
  const { busy, onFix, onCheck, onTrim, onCancel, onPage } = props;
  const ref = useRef<HTMLDivElement>(null);

  // A run replaces the buttons, and its end removes the spinner. Keep the focus in the panel then,
  // so Esc still cancels.
  useEffect(() => {
    const lost = document.activeElement === document.body || ref.current?.contains(document.activeElement);
    if (lost) ref.current?.querySelector<HTMLElement>("[data-focus]")?.focus();
  }, [busy]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (busy) onCancel();
      else onPage();
      return;
    }
    // The eye toggles are a Tab away, so the arrows walk the rows and the actions.
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(.hl-eye):not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!delta || !buttons.length) return;
    e.preventDefault();
    const next = i < 0 ? (delta > 0 ? 0 : buttons.length - 1) : (i + delta + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <>
      <div className="side-body review" ref={ref} onKeyDown={onKeyDown}>
        <Readability {...props} />
        <h3 className="review-label">Run a check</h3>
        {busy ? (
          <p className="lab-busy" tabIndex={-1} aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {busy}…
          </p>
        ) : (
          <>
            <button className="lab-item" onClick={onFix}>
              Fix punctuation and typos
            </button>
            {CHECKS.map((c) => (
              <button key={c.id} className="lab-item" onClick={() => onCheck(c.id)}>
                {c.title}
                {!c.ai && <span className="lab-note">instant</span>}
              </button>
            ))}
            <div className="lab-trims" role="group" aria-label="Trim">
              {TRIMS.map((t) => (
                <button key={t.id} className="lab-trim" onClick={() => onTrim(t.id)}>
                  {t.label}
                  <span>−{t.percent}%</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <footer className="side-hint">{busy ? "esc cancels" : "↑↓ choose · return runs · esc back to the page"}</footer>
    </>
  );
}

const WEAKENERS: { kind: Kind; one: string; many: string }[] = [
  { kind: "adverb", one: "adverb", many: "adverbs" },
  { kind: "passive", one: "use of passive voice", many: "uses of passive voice" },
  { kind: "qualifier", one: "qualifier", many: "qualifiers" },
  { kind: "intensifier", one: "intensifier", many: "intensifiers" },
  { kind: "filler", one: "filler", many: "fillers" },
];

/**
 * The grade, then one row per kind of highlight: its count, a click to the next one, and an eye.
 * It takes the focus when Review opens from its key, before the first count arrives.
 */
function Readability({ checks, words, hidden, onToggle, onJump }: Props) {
  if (!checks) return <div className="readability" tabIndex={-1} data-focus />;
  const { counts, sentences: total } = checks;
  const sentences = (n: number, what: string) =>
    `of ${total} ${total === 1 ? "sentence" : "sentences"} ${n === 1 ? "is" : "are"} ${what}`;
  const weak = WEAKENERS.map((w) => w.kind);
  const weakCount = weak.reduce((sum, k) => sum + counts[k], 0);
  const row = (kinds: readonly Kind[], tone: string, count: number, label: string, sub = false) => {
    const off = kinds.every((k) => hidden.includes(k));
    return (
      <div className={`hl-row${sub ? " sub" : ""}${off ? " off" : ""}`} key={kinds.join()}>
        <button className="hl-jump" disabled={!count} onClick={() => onJump(kinds)} title="Go to the next one">
          <span className={`hl-count hl-${tone}`}>{count}</span>
          {label}
        </button>
        <button className="hl-eye" onClick={() => onToggle(kinds)} aria-pressed={!off} title={off ? "Show them" : "Hide them"}>
          <Icon name={off ? "eyeOff" : "eye"} />
        </button>
      </div>
    );
  };
  return (
    <>
      <div className="readability" tabIndex={-1} data-focus>
        <div className="grade">{checks.grade === null ? "No sentences yet" : `Grade ${checks.grade}`}</div>
        <div className="grade-sub">
          {words} {words === 1 ? "word" : "words"} · {total} {total === 1 ? "sentence" : "sentences"}
          {words > 0 && ` · ${Math.max(1, Math.round(words / 250))} min`}
        </div>
        <p className="hl-here" aria-live="polite">
          {checks.here ?? "Put the caret on a highlight to see why it's marked."}
        </p>
      </div>
      {row(["veryHard"], "veryHard", counts.veryHard, sentences(counts.veryHard, "very hard to read"))}
      {row(["hard"], "hard", counts.hard, sentences(counts.hard, "hard to read"))}
      {row(weak, "weak", weakCount, weakCount === 1 ? "weakener" : "weakeners")}
      {WEAKENERS.map((w) => row([w.kind], "weak", counts[w.kind], counts[w.kind] === 1 ? w.one : w.many, true))}
      {row(
        ["simpler"],
        "simpler",
        counts.simpler,
        counts.simpler === 1 ? "word with a simpler alternative" : "words with a simpler alternative",
      )}
    </>
  );
}

function Overflow({ overflow, onOverflow, onPage }: Props) {
  return (
    <>
      <textarea
        className="overflow"
        data-focus
        value={overflow}
        onChange={(e) => onOverflow(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onPage();
          }
        }}
        placeholder="Extra writing, notes, leftovers…"
        spellCheck
      />
      <footer className="side-hint">⌘⇧X stashes selection · esc back to the page · ⌘⇧O closes</footer>
    </>
  );
}
