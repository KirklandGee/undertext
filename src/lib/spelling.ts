import { invoke } from "@tauri-apps/api/core";
import type { Checked, Speller } from "../editor/spelling";
import { isTauri } from "./files";

/** The Mac's spell checker, through src-tauri/src/spelling.rs. */
const macSpeller: Speller = {
  check: (texts, sample) => invoke<Checked[]>("check_spelling", { texts, sample }),
  guesses: (word, language) => invoke<string[]>("spelling_guesses", { word, language }),
  learn: (word) => void invoke("learn_spelling", { word }).catch((err) => console.warn("Learning a word failed:", err)),
};

// In a plain browser during development, a few common typos stand in for the Mac's checker.
const TYPOS: Record<string, string[]> = {
  teh: ["the", "ten", "tea"],
  recieve: ["receive", "relieve"],
  wrod: ["word", "wood"],
  seperate: ["separate"],
  definately: ["definitely", "defiantly"],
  occured: ["occurred", "occur"],
  untill: ["until", "unfill"],
  thier: ["their", "thief"],
};
const learned = new Set<string>();

const browserSpeller: Speller = {
  check: async (texts) =>
    texts.map((text) => ({
      language: "en",
      words: [...text.matchAll(/\p{L}+/gu)]
        .filter((m) => TYPOS[m[0].toLowerCase()] && !learned.has(m[0].toLowerCase()))
        .map((m): [number, number] => [m.index, m.index + m[0].length]),
    })),
  guesses: async (word) => {
    const guesses = TYPOS[word.toLowerCase()] ?? [];
    return word[0] === word[0].toUpperCase() ? guesses.map((g) => g[0].toUpperCase() + g.slice(1)) : guesses;
  },
  learn: (word) => void learned.add(word.toLowerCase()),
};

export const speller: Speller = isTauri ? macSpeller : browserSpeller;
