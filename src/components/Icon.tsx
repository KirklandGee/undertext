const PATHS = {
  open: "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  save: "M8 2.5v7m0 0L5 6.5m3 3 3-3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2",
  alts: "M3 5h10M3 8h6M3 11h8",
  overflow: "M2.5 3.5h11v9h-11zM10 3.5v9",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  eyeOff: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM2.5 13.5l11-11",
} as const;

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={PATHS[name]} stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
