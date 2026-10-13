import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { GROUPS, PaletteCommand } from "../palette/commands";
import { rank } from "../palette/match";

interface Props {
  commands: PaletteCommand[];
  recent: string[];
  onRun(command: PaletteCommand): void;
  onClose(): void;
}

type Row = { kind: "header"; label: string } | { kind: "command"; command: PaletteCommand; index: number };

export function CommandPalette({ commands, recent, onRun, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { rows, ordered } = useMemo(() => buildRows(commands, recent, query), [commands, recent, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const move = (delta: number) => {
    if (!ordered.length) return;
    setActive((i) => (i + delta + ordered.length) % ordered.length);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const ctrl = e.ctrlKey && !e.metaKey;
    if (e.key === "ArrowDown" || (ctrl && e.key === "n")) {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || (ctrl && e.key === "p")) {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (ordered[active]) onRun(ordered[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };

  const activeId = ordered[active] ? `cmd-${active}` : undefined;

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Commands" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={activeId}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {rows.map((row) =>
            row.kind === "header" ? (
              <div key={`h-${row.label}`} className="palette-group" role="presentation">
                {row.label}
              </div>
            ) : (
              <div
                key={`${row.command.id}-${row.index}`}
                id={`cmd-${row.index}`}
                data-index={row.index}
                role="option"
                aria-selected={row.index === active}
                className={`palette-item${row.index === active ? " on" : ""}`}
                onMouseMove={() => row.index !== active && setActive(row.index)}
                onClick={() => onRun(row.command)}
              >
                <span className="palette-title">{row.command.title}</span>
                {query && <span className="palette-meta">{row.command.group}</span>}
                {row.command.shortcut && <Keys combo={row.command.shortcut} />}
              </div>
            ),
          )}
          {!ordered.length && <div className="palette-empty">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}

function Keys({ combo }: { combo: string }) {
  const keys = combo === "esc" ? ["esc"] : [...combo];
  return (
    <span className="keys" aria-label={combo}>
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

/** Empty query: Recent first, then groups in a fixed order. Otherwise: one ranked list. */
function buildRows(commands: PaletteCommand[], recent: string[], query: string) {
  const rows: Row[] = [];
  const ordered: PaletteCommand[] = [];
  const push = (command: PaletteCommand) => {
    rows.push({ kind: "command", command, index: ordered.length });
    ordered.push(command);
  };

  if (query.trim()) {
    rank(commands, query).forEach(push);
    return { rows, ordered };
  }

  const recentCommands = recent
    .map((id) => commands.find((c) => c.id === id))
    .filter((c): c is PaletteCommand => Boolean(c))
    .slice(0, 3);
  if (recentCommands.length) {
    rows.push({ kind: "header", label: "Recent" });
    recentCommands.forEach(push);
  }
  for (const group of GROUPS) {
    const inGroup = commands.filter((c) => c.group === group && !recentCommands.includes(c));
    if (!inGroup.length) continue;
    rows.push({ kind: "header", label: group });
    inGroup.forEach(push);
  }
  return { rows, ordered };
}
