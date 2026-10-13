import { KeyboardEvent, RefObject, useEffect, useState } from "react";
import { EditorInfo } from "../editor/setup";

export type AltTab = "inline" | "paragraph";

interface Props {
  info: EditorInfo;
  tab: AltTab;
  /** Changes whenever the input should take focus. */
  focusKey: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onTab(tab: AltTab): void;
  onActivate(index: number): void;
  onAdd(text: string): void;
  onRemove(index: number): void;
  onParaActivate(index: number): void;
  onParaRemove(index: number): void;
  onFork(): void;
  onClose(): void;
  /** Ask Claude for alternatives (⌘⇧G). */
  onAi(): void;
  aiBusy: boolean;
}

export function AltPanel(props: Props) {
  const { info, tab } = props;
  const inlineText = info.alt ? info.alt.variants[info.alt.active] : (info.candidate?.text ?? "");
  const isSentence = /\s/.test(inlineText.trim());
  const paraCount = info.para?.variants.length ?? 0;

  return (
    <aside
      className="side side-left"
      aria-label="Alternatives"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <nav className="tabs">
        <button className={tab === "inline" && !isSentence ? "on" : ""} onClick={() => props.onTab("inline")}>
          Word
        </button>
        <button className={tab === "inline" && isSentence ? "on" : ""} onClick={() => props.onTab("inline")}>
          Sentence
        </button>
        <button className={tab === "paragraph" ? "on" : ""} onClick={() => props.onTab("paragraph")}>
          Paragraph{paraCount > 1 ? ` ${paraCount}` : ""}
        </button>
      </nav>

      {tab === "inline" ? <InlineList {...props} /> : <ParagraphList {...props} />}

      <footer className="side-hint">
        {tab === "inline" ? "return adds · ↑↓ cycles · esc closes" : "⌘⇧D new version · ⌥⇧J ⌥⇧K cycles · esc closes"}
      </footer>
    </aside>
  );
}

function InlineList({ info, focusKey, inputRef, onActivate, onAdd, onRemove, onClose, onAi, aiBusy }: Props) {
  const [value, setValue] = useState("");
  useEffect(() => inputRef.current?.focus(), [focusKey, inputRef]);
  const alt = info.alt;
  const variants = alt ? alt.variants : info.candidate ? [info.candidate.text] : [];
  const active = alt?.active ?? 0;
  const fromAi = (v: string) => Boolean(alt?.ai.includes(v));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && value.trim()) {
      e.preventDefault();
      onAdd(value);
      setValue("");
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && alt && alt.variants.length > 1) {
      e.preventDefault();
      const n = alt.variants.length;
      onActivate((active + (e.key === "ArrowUp" ? -1 : 1) + n) % n);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="side-body">
      {variants.length === 0 ? (
        <p className="side-empty">Click a word or select some text. Then type an alternative here and press Return.</p>
      ) : (
        <ul className="variants">
          {variants.map((v, i) => (
            <li key={i} className={i === active ? "on" : ""}>
              <button
                className="variant"
                onClick={() => onActivate(i)}
                title={i === 0 ? "Original" : fromAi(v) ? "Suggested by AI" : undefined}
              >
                <span className={`bullet${fromAi(v) ? " ai" : ""}`}>{fromAi(v) ? "○" : i === active ? "•" : "·"}</span>
                <span className="variant-text">{v}</span>
              </button>
              {alt && variants.length > 1 && (
                <button className="remove" onClick={() => onRemove(i)} aria-label={`Remove ${v}`}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        className="variant-input"
        placeholder={variants.length ? "another way to say it…" : ""}
        value={value}
        disabled={!variants.length}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck
      />
      {variants.length > 0 &&
        (aiBusy ? (
          <p className="ai-busy" aria-live="polite">
            <span className="spinner" aria-hidden="true" /> Asking Claude…
          </p>
        ) : (
          <button className="fork" onClick={onAi}>
            ✦ Suggest with AI <kbd>⌘⇧G</kbd>
          </button>
        ))}
    </div>
  );
}

function ParagraphList({ info, onParaActivate, onParaRemove, onFork }: Props) {
  const para = info.para;
  if (!para) return <div className="side-body" />;
  const many = para.variants.length > 1;
  return (
    <div className="side-body">
      {many ? (
        <ul className="variants paragraphs">
          {para.variants.map((v, i) => (
            <li key={i} className={i === para.active ? "on" : ""}>
              <button className="variant" onClick={() => onParaActivate(i)}>
                <span className="bullet">{i + 1}</span>
                <span className="variant-text clamp">{v.replace(/~~|\{\{|\}\}/g, "") || "(empty)"}</span>
              </button>
              <button className="remove" onClick={() => onParaRemove(i)} aria-label={`Remove version ${i + 1}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="side-empty">This paragraph has one version.</p>
      )}
      <button className="fork" onClick={onFork}>
        + New version from this one
      </button>
    </div>
  );
}
