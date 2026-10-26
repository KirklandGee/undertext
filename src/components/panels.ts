/** The right panel's tabs. The panel shows one at a time. */
export type RightTab = "review" | "overflow";

/**
 * ⌘⇧E (Review) or ⌘⇧O (Overflow). Pressed inside that tab, it closes the panel and goes back
 * to the page. Anywhere else, it shows the tab and focuses it.
 */
export function pressPanelKey(tab: RightTab, focusedIn: RightTab | null): { panel: RightTab | null; focus: "panel" | "page" } {
  return focusedIn === tab ? { panel: null, focus: "page" } : { panel: tab, focus: "panel" };
}

/** A click on a tab's button: show the tab, or close the panel when it already shows. */
export function clickPanel(panel: RightTab | null, tab: RightTab): RightTab | null {
  return panel === tab ? null : tab;
}

/** The tab open last time. Older prefs only kept whether Overflow was open. */
export function savedPanel(prefs: { panel?: unknown; overflowOpen?: boolean }): RightTab | null {
  if (prefs.panel === "review" || prefs.panel === "overflow") return prefs.panel;
  if (prefs.panel === undefined && prefs.overflowOpen) return "overflow";
  return null;
}
