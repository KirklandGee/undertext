const isWordChar = (c: string | undefined) => Boolean(c && /[\p{L}\p{N}]/u.test(c));

/**
 * Scores how well `query` matches `text`. Higher is better, null means no match.
 * Every query word must match: as a prefix, at a word start, inside a word,
 * or as a loose subsequence ("nw" matches "new").
 */
export function matchScore(query: string, text: string): number | null {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const t = text.toLowerCase();
  let total = 0;
  for (const word of words) {
    const i = t.indexOf(word);
    if (i === 0) total += 100;
    else if (i > 0 && !isWordChar(t[i - 1])) total += 80;
    else if (i > 0) total += 40;
    else {
      const loose = subsequenceScore(word, t);
      if (loose === null) return null;
      total += loose;
    }
  }
  // Prefer shorter titles when everything else is equal.
  return total - t.length / 100;
}

function subsequenceScore(word: string, text: string): number | null {
  let j = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < text.length && j < word.length; i++) {
    if (text[i] !== word[j]) continue;
    score += prev === i - 1 ? 3 : !isWordChar(text[i - 1]) ? 2 : 1;
    prev = i;
    j++;
  }
  return j === word.length ? Math.min(score, 30) : null;
}

/** Sorts items by match. Title matches beat keyword matches. */
export function rank<T extends { title: string; group: string; keywords?: string }>(items: T[], query: string): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const title = matchScore(query, item.title);
    const extra = matchScore(query, `${item.title} ${item.group} ${item.keywords ?? ""}`);
    const score = title ?? (extra === null ? null : extra * 0.6);
    if (score !== null) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
}
