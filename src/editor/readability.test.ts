import { describe, expect, it } from "vitest";
import { checkPage, Kind, sentences } from "./readability";

/** Each issue as its kind and the text it covers, in page order. */
const found = (text: string, kinds?: Kind[]) =>
  checkPage(text)
    .issues.filter((i) => !kinds || kinds.includes(i.kind))
    .map((i) => [i.kind, text.slice(i.from, i.to)]);

const split = (text: string) => sentences(text).map((s) => text.slice(s.from, s.to));

// 20 words, 99 letters: 4.71 × 99/20 + 0.5 × 20 − 21.43 = 11.88, grade 12.
const HARD =
  "Writers often build long sentences because each new idea wants another clause before the reader can pause or rest here.";
// 19 words, 167 letters: 4.71 × 167/19 + 0.5 × 19 − 21.43 = 29.47, grade 29.
const VERY_HARD =
  "Organizations underestimate how complicated documentation becomes when several departments contribute overlapping requirements without coordinating their terminology or their priorities.";

describe("sentences", () => {
  it("splits after . ! and ?, but not after an abbreviation, an initial, or a decimal point", () => {
    expect(split("Mr. Smith arrived at 3.5 p.m. on Friday. He left early! Did he?")).toEqual([
      "Mr. Smith arrived at 3.5 p.m. on Friday.",
      "He left early!",
      "Did he?",
    ]);
    expect(split("J. K. Rowling wrote it. Use short words, e.g. this one.")).toEqual([
      "J. K. Rowling wrote it.",
      "Use short words, e.g. this one.",
    ]);
  });

  it("ends a sentence at a word that is also an abbreviation, unless a number follows", () => {
    expect(split("Pick yes or no. Then go on. See No. 5 and fig. 2 for more.")).toEqual([
      "Pick yes or no.",
      "Then go on.",
      "See No. 5 and fig. 2 for more.",
    ]);
  });

  it("keeps closing quotes with their sentence, and ends a sentence at an ellipsis", () => {
    expect(split('She said, "Stop." Then she left.')).toEqual(['She said, "Stop."', "Then she left."]);
    expect(split("Wait... What happened?")).toEqual(["Wait...", "What happened?"]);
  });

  it("counts text with no closing punctuation as a sentence", () => {
    expect(split("Notes: the plan for today")).toEqual(["Notes: the plan for today"]);
  });
});

describe("the grade", () => {
  it("is the Automated Readability Index of the page", () => {
    // 11 words, 55 letters, 2 sentences: 4.71 × 55/11 + 0.5 × 11/2 − 21.43 = 4.87, grade 5.
    const report = checkPage("Readers like short sentences with plain words. Long ones tire them.\n");
    expect(report).toMatchObject({ words: 11, letters: 55, sentences: 2, grade: 5 });
  });

  it("is never below zero, and is null without prose", () => {
    expect(checkPage("The cat sat on the mat.").grade).toBe(0);
    expect(checkPage("# Only a heading\n").grade).toBeNull();
  });
});

describe("hard sentences", () => {
  it("marks a sentence of 14 or more words by its own grade: hard from 10, very hard from 14", () => {
    const text = `Short and plain. ${HARD} ${VERY_HARD}`;
    expect(found(text, ["hard", "veryHard"])).toEqual([
      ["hard", HARD],
      ["veryHard", VERY_HARD],
    ]);
    const notes = checkPage(text).issues.map((i) => i.note);
    expect(notes).toEqual(["Hard to read. 20 words.", "Very hard to read. 19 words."]);
  });

  it("leaves a sentence under 14 words alone, however long its words", () => {
    // 13 words.
    const short =
      "Organizations underestimate how complicated documentation becomes when several departments contribute overlapping requirements today.";
    // 14 words, 125 letters: 4.71 × 125/14 + 0.5 × 14 − 21.43 = 27.62, grade 28.
    const long =
      "Organizations underestimate how complicated documentation becomes when several departments contribute overlapping requirements in projects.";
    expect(found(short)).toEqual([]);
    expect(found(long)).toEqual([["veryHard", long]]);
  });
});

describe("weakeners", () => {
  it("marks adverbs, but not words that only end in -ly", () => {
    expect(found("She quickly and quietly left the family home early. Only one did.")).toEqual([
      ["adverb", "quickly"],
      ["adverb", "quietly"],
    ]);
  });

  it("skips the adverbs Hemingway leaves alone", () => {
    expect(found("It usually works. Finally, we left. It actually works. It recently changed. We left immediately.")).toEqual([]);
  });

  it("says to cut an adverb when the sentence holds without it", () => {
    expect(checkPage("It typically works.").issues).toEqual([
      { from: 3, to: 12, kind: "adverb", note: "Adverb. Cut it if the sentence holds without it." },
    ]);
  });

  it("marks qualifiers, intensifiers, and fillers, and counts an adverb among them as an adverb too", () => {
    expect(found("I think this is really very good, and basically it just works.")).toEqual([
      ["qualifier", "I think"],
      ["intensifier", "really"],
      ["adverb", "really"],
      ["intensifier", "very"],
      ["filler", "basically"],
      ["adverb", "basically"],
      ["qualifier", "just"],
    ]);
  });

  it("counts each mark once in the weakeners' total, as Hemingway does", () => {
    // 3 adverbs, 1 passive, 1 intensifier, 1 weak verb. "Really" and "walked slowly" are one mark
    // each; the adverb in "was quickly closed" is its own. Hemingway says 4 weakeners.
    const report = checkPage("He ran really fast. She walked slowly home. The door was quickly closed.");
    expect(report.issues.filter((i) => i.kind === "adverb")).toHaveLength(3);
    expect(report.weakeners).toBe(4);
  });

  it("leaves the hedges alone that Hemingway doesn't mark", () => {
    expect(found("Use plain words rather than jargon. It is rather slow. It is kind of slow. It is quite slow. You know, it works.")).toEqual([]);
    expect(found("It probably works.")).toEqual([["adverb", "probably"]]);
  });

  it("marks passive voice, and the words inside it too", () => {
    expect(found("The report was written by the team. The bug is fixed. The door was quickly closed.")).toEqual([
      ["passive", "was written"],
      ["passive", "is fixed"],
      ["passive", "was quickly closed"],
      ["adverb", "quickly"],
    ]);
    expect(found("It is red. It was indeed hard. There was a need for speed.")).toEqual([]);
  });
});

// The lists follow what Hemingway's web editor marked on test sentences, in October 2026.
describe("weak verbs, hidden actions, and negatives", () => {
  it("marks a plain verb and adverb that one stronger verb replaces, in the same tense", () => {
    const text = "He walked slowly home. She eats quickly. They are speaking softly. She looked closely. It runs slowly.";
    expect(found(text)).toEqual([
      ["weakVerb", "walked slowly"],
      ["adverb", "slowly"],
      ["weakVerb", "eats quickly"],
      ["adverb", "quickly"],
      ["weakVerb", "speaking softly"],
      ["adverb", "softly"],
      ["adverb", "closely"],
      ["adverb", "slowly"],
    ]);
    expect(checkPage(text).issues.filter((i) => i.kind === "weakVerb").map((i) => i.note)).toEqual([
      "Weak verb. Try “strolled”.",
      "Weak verb. Try “gobbles”.",
      "Weak verb. Try “whispering”.",
    ]);
    // "Run" is also the past participle; the present tense wins.
    expect(checkPage("They run quickly.").issues[0].note).toBe("Weak verb. Try “sprint”.");
  });

  it("leaves get and phrasal verbs alone", () => {
    expect(found("She gets it. Sales got better. We put off the launch. Let us get started. Find out more.")).toEqual([]);
  });

  it("marks the hidden actions on Hemingway's list, in any tense", () => {
    const text =
      "We made a decision. They are reaching an agreement. She gave consideration to it. He is able to swim. We take into consideration the cost.";
    expect(found(text)).toEqual([
      ["hidden", "made a decision"],
      ["hidden", "reaching an agreement"],
      ["hidden", "gave consideration to"],
      ["hidden", "is able to"],
      ["hidden", "take into consideration"],
    ]);
    expect(checkPage(text).issues.map((i) => i.note)).toEqual([
      "Hidden action. Try “decide”.",
      "Hidden action. Try “agree”.",
      "Hidden action. Try “consider”.",
      "Hidden action. Try “can”.",
      "Hidden action. Try “consider”.",
    ]);
  });

  it("leaves a hidden action alone with other words in it", () => {
    expect(found("We made the decision to leave. They make decisions. We made a quick decision. She gave an explanation.")).toEqual([]);
  });

  it("marks a negative that has a positive word, but not every not", () => {
    const text = "The tool does not have a menu. It doesn't include tests. We do not need that.";
    expect(found(text)).toEqual([
      ["negative", "does not have"],
      ["negative", "doesn't include"],
    ]);
    expect(checkPage(text).issues.map((i) => i.note)).toEqual(["Negative. Try “lacks”.", "Negative. Try “excludes”."]);
  });

  it("marks the other negatives on Hemingway's list, and only those", () => {
    const text = "She does not notice. We did not agree. He is not honest. It does not work. It is not clear.";
    expect(found(text)).toEqual([
      ["negative", "does not notice"],
      ["negative", "did not agree"],
      ["negative", "not honest"],
    ]);
    expect(checkPage(text).issues.map((i) => i.note)).toEqual([
      "Negative. Try “overlooks”.",
      "Negative. Try “disagreed”.",
      "Negative. Try “dishonest”.",
    ]);
  });

  it("leaves indirect openings alone, as Hemingway does", () => {
    expect(found("There are many people who agree. It is clear that we won.")).toEqual([]);
  });
});

describe("simpler words", () => {
  it("marks a word or phrase with a plainer one, in any form or case", () => {
    const text = "Utilize it in order to assist users. She utilized it.";
    expect(found(text)).toEqual([
      ["simpler", "Utilize"],
      ["simpler", "in order to"],
      ["simpler", "assist"],
      ["simpler", "utilized"],
    ]);
    expect(checkPage(text).issues.map((i) => i.note)).toEqual([
      "Simpler: use.",
      "Simpler: to.",
      "Simpler: help.",
      "Simpler: use.",
    ]);
  });

  it("prefers the longer phrase where two overlap", () => {
    expect(found("We stopped due to the fact that it rained.")).toEqual([["simpler", "due to the fact that"]]);
  });

  it("marks an adverb with a simpler alternative once, as a simpler word", () => {
    expect(found("We meet frequently.")).toEqual([["simpler", "frequently"]]);
  });

  it("offers one word for a negative phrase", () => {
    const text = "Not many came. We are not often late.";
    expect(found(text)).toEqual([
      ["simpler", "Not many"],
      ["simpler", "not often"],
    ]);
    expect(checkPage(text).issues.map((i) => i.note)).toEqual(["Simpler: few.", "Simpler: rarely."]);
  });
});

describe("what counts as prose", () => {
  it("skips headings, code, link addresses, and list markers", () => {
    const text = [
      "# A heading that really is very long and would otherwise be very hard to read for sure",
      "",
      "Some text with `code that really is very long` here.",
      "",
      "- A list item that really matters.",
      "- Read [the docs](https://example.com/really-very-long-url) today.",
      "",
      "```js",
      "const x = really();",
      "```",
      "",
    ].join("\n");
    const report = checkPage(text);
    const item = text.indexOf("really matters");
    expect(report.issues).toEqual([
      { from: item, to: item + 6, kind: "intensifier", note: "Intensifier. It rarely adds strength." },
      { from: item, to: item + 6, kind: "adverb", note: "Adverb. Cut it if the sentence holds without it." },
    ]);
    // "Some text with here." "A list item that really matters." "Read the docs today."
    expect(report).toMatchObject({ sentences: 3, words: 14 });
  });

  it("never runs a sentence from one list item into the next", () => {
    expect(found(`- ${HARD.slice(0, 60)}\n- ${HARD.slice(60)}`, ["hard", "veryHard"])).toEqual([]);
  });

  it("gives the same answer for a paragraph it has seen before", () => {
    const text = `${HARD}\n\n${HARD}\n`;
    const report = checkPage(text);
    expect(report.issues.map((i) => [i.from, i.to])).toEqual([
      [0, HARD.length],
      [HARD.length + 2, 2 * HARD.length + 2],
    ]);
    expect(checkPage(text)).toEqual(report);
  });
});
