import { describe, expect, it } from "vitest";
import { clickPanel, pressPanelKey, savedHidden, savedPanel, toggleKinds } from "./panels";

describe("the right panel", () => {
  it("opens a tab from its key and focuses it, from the page or the other tab", () => {
    expect(pressPanelKey("review", null)).toEqual({ panel: "review", focus: "panel" });
    expect(pressPanelKey("overflow", null)).toEqual({ panel: "overflow", focus: "panel" });
    expect(pressPanelKey("review", "overflow")).toEqual({ panel: "review", focus: "panel" });
    expect(pressPanelKey("overflow", "review")).toEqual({ panel: "overflow", focus: "panel" });
  });

  it("closes from inside the tab its key opens, and goes back to the page", () => {
    expect(pressPanelKey("review", "review")).toEqual({ panel: null, focus: "page" });
    expect(pressPanelKey("overflow", "overflow")).toEqual({ panel: null, focus: "page" });
  });

  it("toggles a tab from its button", () => {
    expect(clickPanel(null, "review")).toBe("review");
    expect(clickPanel("review", "review")).toBe(null);
    expect(clickPanel("overflow", "review")).toBe("review");
    expect(clickPanel("review", "overflow")).toBe("overflow");
  });

  it("reopens the tab from last time, and reads older prefs", () => {
    expect(savedPanel({ panel: "review" })).toBe("review");
    expect(savedPanel({ panel: "overflow" })).toBe("overflow");
    expect(savedPanel({ panel: null, overflowOpen: true })).toBe(null);
    expect(savedPanel({ overflowOpen: true })).toBe("overflow");
    expect(savedPanel({ overflowOpen: false })).toBe(null);
    expect(savedPanel({ panel: "lab" })).toBe(null);
    expect(savedPanel({})).toBe(null);
  });
});

describe("Review's eye toggles", () => {
  it("hide a kind, or show it again", () => {
    expect(toggleKinds([], ["adverb"])).toEqual(["adverb"]);
    expect(toggleKinds(["adverb", "hard"], ["adverb"])).toEqual(["hard"]);
  });

  it("hide a whole group unless all of it is hidden, then show it all", () => {
    const group = ["adverb", "passive", "filler"] as const;
    expect(toggleKinds(["adverb", "hard"], group)).toEqual(["adverb", "hard", "passive", "filler"]);
    expect(toggleKinds(["adverb", "hard", "passive", "filler"], group)).toEqual(["hard"]);
  });

  it("come back from prefs, without kinds this version doesn't know", () => {
    expect(savedHidden({ hidden: ["adverb", "weasel", 3, "simpler"] })).toEqual(["adverb", "simpler"]);
    expect(savedHidden({ hidden: "adverb" })).toEqual([]);
    expect(savedHidden({})).toEqual([]);
  });
});
