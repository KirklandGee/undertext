import { KeyboardEvent, useEffect, useRef } from "react";
import { CHECKS, CheckId, TRIMS, TrimId } from "../ai/tasks";

interface Props {
  busy: string | null;
  onFix(): void;
  onCheck(id: CheckId): void;
  onTrim(id: TrimId): void;
  onCancel(): void;
  onClose(): void;
}

/** The Lab: checks that mark text, typo fixes, and trims. Arrow keys move, Return runs, Esc closes. */
export function LabMenu({ busy, onFix, onCheck, onTrim, onCancel, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!busy) ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [busy]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (busy) onCancel();
      else onClose();
      return;
    }
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!delta || !buttons.length) return;
    e.preventDefault();
    buttons[(i + delta + buttons.length) % buttons.length].focus();
  };

  return (
    <div className="lab" role="dialog" aria-label="The Lab" ref={ref} onKeyDown={onKeyDown}>
      <header className="lab-title">
        <span>The Lab</span>
        <span className="lab-hint">{busy ? "esc cancels" : "↑↓ choose · return runs · esc closes"}</span>
      </header>
      {busy ? (
        <div className="lab-busy" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {busy}…
        </div>
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
  );
}
