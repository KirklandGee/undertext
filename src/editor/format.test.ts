import { describe, expect, it } from "vitest";
import { WELCOME } from "../welcome";
import { inlineText, Page, parsePage, serializePage } from "./format";

const roundTrip = (md: string) => serializePage(parsePage(md));
const page = (text: string, layers: Partial<Page> = {}): Page => ({
  text,
  alts: [],
  ghosts: [],
  versions: [],
  overflow: "",
  ...layers,
});

describe("format round trip", () => {
  it.each([
    "# The Title\n\nA plain paragraph.\n",
    "Much of the {{tension|pressure|>struggle}} comes from here.\n",
    "Keep this. {-Maybe cut this.-} Keep that.\n",
    ":::alt\nFirst version.\n:::or*\nSecond {{word|term}} version.\n:::\n",
    "Before.\n\n:::alt*\nFirst.\n:::or\nSecond.\n:::\n\nAfter.\n",
    "Line one\nline two\n\n- a list\n- stays as text\n",
    "Body.\n\n<!-- overflow -->\n\nExtra notes\n\nmore notes\n",
    "{-ghost {{a|>b}} inside-} after\n",
    "Escapes: \\{ and \\~ and **bold** and *em* and ~~strike~~ and ~5.\n",
    "{{a\\|b|c\\}d}}\n",
    "{-ends in a dash--} and {-has -\\} inside-}\n",
    "{-{{a|b-}} first-}\n",
    "\\{-not a ghost-}\n",
    "a\n\n\n\nb stays apart\n",
    "Use `{{x|y}}` and `{-z-}` as code.\n",
    "```\n{{a|b}}\n:::alt\n```\n",
    "{{calls|~judgments}} and {{one|>~two}}\n",
    WELCOME,
  ])("keeps %j", (md) => {
    expect(roundTrip(md)).toBe(md);
  });

  it("drops trailing blank lines", () => {
    expect(roundTrip("Hello\n\n\n")).toBe("Hello\n");
    expect(roundTrip("")).toBe("\n");
  });
});

describe("reading", () => {
  it("keeps only the active text in the page", () => {
    const p = parsePage("the {{tension|>struggle}} here\n");
    expect(p.text).toBe("the struggle here");
    expect(p.alts).toMatchObject([{ from: 4, to: 12, variants: ["tension", "struggle"], active: 1 }]);
  });

  it("maps ghosts and versions to page positions", () => {
    const p = parsePage("One {-two-} three.\n\n:::alt\nOld.\n:::or*\nNew {-x-}.\n:::\n");
    expect(p.text).toBe("One two three.\n\nNew x.");
    expect(p.ghosts).toEqual([
      { from: 4, to: 7 },
      { from: 20, to: 21 },
    ]);
    expect(p.versions).toMatchObject([{ at: 16, variants: ["Old.", "New {-x-}."], active: 1 }]);
  });

  it("treats unmatched syntax as literal text", () => {
    expect(parsePage("open {{ never closed and {- too\n").text).toBe("open {{ never closed and {- too");
  });

  it("reads strikethrough as text, not a ghost", () => {
    const p = parsePage("a ~~struck~~ word\n");
    expect(p.text).toBe("a ~~struck~~ word");
    expect(p.ghosts).toEqual([]);
  });

  it("doesn't read a ghost across a blank line", () => {
    expect(parsePage("{-a\n\nb-}\n").ghosts).toEqual([]);
  });

  it("doesn't read extensions in code", () => {
    const p = parsePage("```\n{{a|b}} {-c-}\n```\n\n`{{d|e}}`\n");
    expect(p.alts).toEqual([]);
    expect(p.ghosts).toEqual([]);
  });

  it("turns inline Markdown into display text", () => {
    expect(inlineText("Use {{word|>term}} {-maybe-} \\{x ~~y~~")).toBe("Use term maybe \\{x ~~y~~");
  });
});

describe("writing", () => {
  it("escapes text that would read as an extension", () => {
    const md = serializePage(page("a {{b}} {-c-} d\n:::alt\n<!-- overflow -->"));
    expect(md).toBe("a \\{{b}} \\{-c-} d\n\\:::alt\n\\<!-- overflow -->\n");
    expect(parsePage(md).alts).toEqual([]);
    expect(parsePage(md).overflow).toBe("");
  });

  it("doesn't escape inside code", () => {
    expect(serializePage(page("`{{b}}`"))).toBe("`{{b}}`\n");
  });

  it("escapes what would end a ghost early", () => {
    const md = serializePage(page("one -} two", { ghosts: [{ from: 0, to: 10 }] }));
    expect(md).toBe("{-one -\\} two-}\n");
    expect(parsePage(md).ghosts).toEqual([{ from: 0, to: 11 }]);
  });

  it("keeps a backslash from eating the syntax after it", () => {
    const alt = { from: 2, to: 3, id: "x", variants: ["b", "c"], active: 0, ai: [] };
    const md = serializePage(page("a\\b", { alts: [alt] }));
    expect(md).toBe("a\\\\{{b|c}}\n");
    expect(parsePage(md).alts).toHaveLength(1);
  });

  it("splits a ghost at blank lines", () => {
    expect(serializePage(page("a\n\nb", { ghosts: [{ from: 0, to: 4 }] }))).toBe("{-a-}\n\n{-b-}\n");
  });

  it("drops the part of a ghost over part of an alternative", () => {
    const alt = { from: 2, to: 7, id: "x", variants: ["hello", "hi"], active: 0, ai: [] };
    const md = serializePage(page("a hello b", { alts: [alt], ghosts: [{ from: 0, to: 4 }] }));
    expect(md).toBe("{-a -}{{hello|hi}} b\n");
  });

  it("writes a version for the paragraph it starts", () => {
    const md = serializePage(
      page("Intro.\n\nNew text.\n\nOutro.", { versions: [{ at: 8, vid: "v", variants: ["Old text.", ""], active: 1 }] }),
    );
    expect(md).toBe("Intro.\n\n:::alt\nOld text.\n:::or*\nNew text.\n:::\n\nOutro.\n");
  });
});
