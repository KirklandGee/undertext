import { describe, expect, it } from "vitest";
import { pageStyle, savedAppearance, themeFor, zoom, zoomKey } from "./appearance";

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean } = { meta: true }) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
});

describe("text size keys", () => {
  it("reads ⌘= and ⌘+ as bigger, ⌘- as smaller, and ⌘0 as the default", () => {
    expect(zoomKey(press("="))).toBe(1);
    expect(zoomKey(press("+"))).toBe(1);
    expect(zoomKey(press("-"))).toBe(-1);
    expect(zoomKey(press("0"))).toBe(0);
    expect(zoomKey(press("=", { ctrl: true }))).toBe(1);
  });

  it("leaves other keys alone, and ⌥⌘0, which makes a plain paragraph", () => {
    expect(zoomKey(press("0", { meta: true, alt: true }))).toBeNull();
    expect(zoomKey(press("+", {}))).toBeNull();
    expect(zoomKey(press("1"))).toBeNull();
  });
});

describe("text size steps", () => {
  it("steps up and down through the sizes", () => {
    expect(zoom(15, 1)).toEqual({ size: 16, notice: "Text size 16" });
    expect(zoom(18, 1)).toEqual({ size: 20, notice: "Text size 20" });
    expect(zoom(20, -1)).toEqual({ size: 18, notice: "Text size 18" });
    expect(zoom(13, -1)).toEqual({ size: 12, notice: "Text size 12" });
  });

  it("goes back to 15 on ⌘0", () => {
    expect(zoom(24, 0)).toEqual({ size: 15, notice: "Text size 15" });
  });

  it("stops at either end, and says so", () => {
    expect(zoom(28, 1)).toEqual({ size: 28, notice: "28 is the largest text size" });
    expect(zoom(12, -1)).toEqual({ size: 12, notice: "12 is the smallest text size" });
  });
});

describe("saved appearance", () => {
  it("starts at 15, the system theme, and medium lines", () => {
    expect(savedAppearance({})).toEqual({ textSize: 15, theme: "system", lineWidth: "medium" });
  });

  it("keeps what was saved", () => {
    expect(savedAppearance({ textSize: 22, theme: "light", lineWidth: "wide" })).toEqual({ textSize: 22, theme: "light", lineWidth: "wide" });
  });

  it("drops values it doesn't know", () => {
    expect(savedAppearance({ textSize: 19, theme: "blue", lineWidth: 64 })).toEqual({ textSize: 15, theme: "system", lineWidth: "medium" });
    expect(savedAppearance({ textSize: "22" })).toEqual({ textSize: 15, theme: "system", lineWidth: "medium" });
  });
});

describe("the page's style", () => {
  it("sets the text size and the characters per line", () => {
    expect(pageStyle({ textSize: 18, theme: "system", lineWidth: "narrow" })).toEqual({ "--text-size": "18px", "--line-width": "44" });
    expect(pageStyle({ textSize: 15, theme: "dark", lineWidth: "medium" })).toEqual({ "--text-size": "15px", "--line-width": "52" });
    expect(pageStyle({ textSize: 28, theme: "light", lineWidth: "wide" })).toEqual({ "--text-size": "28px", "--line-width": "64" });
  });

  it("follows the system unless a theme is chosen", () => {
    expect(themeFor("system", true)).toBe("light");
    expect(themeFor("system", false)).toBe("dark");
    expect(themeFor("light", false)).toBe("light");
    expect(themeFor("dark", true)).toBe("dark");
  });
});
