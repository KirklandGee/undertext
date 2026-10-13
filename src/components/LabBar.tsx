import { EditorInfo } from "../editor/setup";

interface Props {
  lab: NonNullable<EditorInfo["lab"]>;
  words: number;
  cutWords: number;
  onWalk(): void;
  onCut(): void;
  onGhost(): void;
  onClear(): void;
}

/** Shows Lab results under the page: a trim proposal or a set of marks, with what you can do next. */
export function LabBar({ lab, words, cutWords, onWalk, onCut, onGhost, onClear }: Props) {
  if (lab.kind === "cuts") {
    const after = Math.max(0, words - cutWords);
    const pct = words ? Math.round((cutWords / words) * 100) : 0;
    return (
      <div className="lab-bar" role="region" aria-label="Trim proposal">
        <div className="lab-bar-text">
          <strong>{lab.label}</strong> {words} → {after} words · −{pct}%
          <span className="lab-bar-sub">
            {" "}
            · Faded text would go. Click it or press ⌘/ to keep it. ⌥L next.
          </span>
        </div>
        <div className="lab-bar-actions">
          <button onClick={onWalk}>Walk through</button>
          <button onClick={onCut}>Make the cuts</button>
          <button onClick={onGhost}>Keep as ghosts</button>
          <button onClick={onClear}>Original</button>
        </div>
      </div>
    );
  }
  return (
    <div className="lab-bar" role="region" aria-label="Marks">
      <div className="lab-bar-text">
        <strong>{lab.label}</strong> {lab.count} marked
        <span className="lab-bar-sub"> · {lab.here ?? "⌥L next · esc clears"}</span>
      </div>
      <div className="lab-bar-actions">
        <button onClick={onWalk}>Next</button>
        <button onClick={onGhost}>Ghost them</button>
        <button onClick={onClear}>Clear</button>
      </div>
    </div>
  );
}
