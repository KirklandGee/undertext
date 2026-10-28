/** How the page looks: its text size, theme, and line width. Saved with the other prefs. */

/** Page text sizes in px. ⌘+ and ⌘− step through them. */
export const TEXT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28];
export const DEFAULT_TEXT_SIZE = 15;

export type Theme = "system" | "light" | "dark";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

export type LineWidth = "narrow" | "medium" | "wide";
/** Characters per line of page text. The column grows with the text, up to the window. */
export const LINE_WIDTHS: Record<LineWidth, number> = { narrow: 44, medium: 52, wide: 64 };

export interface Appearance {
  textSize: number;
  theme: Theme;
  lineWidth: LineWidth;
}

/** ⌘+ is 1, ⌘− is -1, ⌘0 is 0. Null for any other key, and for ⌥⌘0, which makes a plain paragraph. */
export function zoomKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): 1 | -1 | 0 | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+") return 1;
  if (e.key === "-") return -1;
  if (e.key === "0") return 0;
  return null;
}

/** The next size up or down, or the default for 0. At either end it stays, and says so. */
export function zoom(size: number, step: 1 | -1 | 0): { size: number; notice: string } {
  if (step === 0) return { size: DEFAULT_TEXT_SIZE, notice: `Text size ${DEFAULT_TEXT_SIZE}` };
  const next = step > 0 ? TEXT_SIZES.find((s) => s > size) : TEXT_SIZES.findLast((s) => s < size);
  if (next === undefined) return { size, notice: `${size} is the ${step > 0 ? "largest" : "smallest"} text size` };
  return { size: next, notice: `Text size ${next}` };
}

/** What was saved last time. Values it doesn't know fall back to the defaults. */
export function savedAppearance(prefs: { textSize?: unknown; theme?: unknown; lineWidth?: unknown }): Appearance {
  const known = (list: readonly unknown[], value: unknown) => list.includes(value);
  return {
    textSize: typeof prefs.textSize === "number" && TEXT_SIZES.includes(prefs.textSize) ? prefs.textSize : DEFAULT_TEXT_SIZE,
    theme: known(THEMES, prefs.theme) ? (prefs.theme as Theme) : "system",
    lineWidth: known(Object.keys(LINE_WIDTHS), prefs.lineWidth) ? (prefs.lineWidth as LineWidth) : "medium",
  };
}

/** The CSS variables for the page's text size and characters per line. */
export function pageStyle(a: Appearance): Record<"--text-size" | "--line-width", string> {
  return { "--text-size": `${a.textSize}px`, "--line-width": String(LINE_WIDTHS[a.lineWidth]) };
}

/** The colors to draw: the chosen theme, or the system's. */
export function themeFor(theme: Theme, systemLight: boolean): "light" | "dark" {
  if (theme === "system") return systemLight ? "light" : "dark";
  return theme;
}
