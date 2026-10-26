import { KeyboardEvent, RefObject, useEffect, useRef } from "react";
import { CHECKS, CheckId, TRIMS, TrimId } from "../ai/tasks";
import { RightTab } from "./panels";

interface Props {
  tab: RightTab;
  panelRef: RefObject<HTMLElement | null>;
  overflow: string;
  busy: string | null;
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
 * The right panel, about the whole page: Review (typo fixes, checks, trims) and Overflow, one tab
 * at a time. The element marked `data-focus` takes the focus when the tab opens from its key.
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
function Review({ busy, onFix, onCheck, onTrim, onCancel, onPage }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // A run replaces the buttons, and its end removes the spinner. Keep the focus in the panel then.
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
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!delta || !buttons.length) return;
    e.preventDefault();
    buttons[(i + delta + buttons.length) % buttons.length].focus();
  };

  return (
    <>
      <div className="side-body review" ref={ref} onKeyDown={onKeyDown}>
        {busy ? (
          <p className="lab-busy" tabIndex={-1} data-focus aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {busy}…
          </p>
        ) : (
          <>
            <button className="lab-item" data-focus onClick={onFix}>
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
