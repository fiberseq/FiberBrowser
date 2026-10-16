/**
 * The matching shared by the command palette and the settings search: every
 * word typed must be found (as a word, the start of a word, inside a word, or
 * for longer words as letters in order in the title); the title counts most,
 * then the synonyms, then where it lives (section names).
 */

export interface MatchFields {
  title: string;
  keywords?: readonly string[];
  /** Where it lives: "Reads & Display › Read Filters", "Panel", ... */
  context?: string;
}

/** Lower case, accents off, punctuation as spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return text ? text.split(' ') : [];
}

type TokenMatch = 'word' | 'prefix' | 'inside' | null;

/** How one typed word fits one text: as a word, the start of a word, inside a word, or not at all. */
function tokenMatch(token: string, text: string): TokenMatch {
  if (!text) return null;
  let prefix = false;
  for (const w of words(text)) {
    if (w === token) return 'word';
    if (w.startsWith(token)) prefix = true;
  }
  if (prefix) return 'prefix';
  return text.includes(token) ? 'inside' : null;
}

/** How well one typed word fits one text (0: not at all). */
function tokenScore(token: string, text: string, weight: { word: number; prefix: number; inside: number }): number {
  const how = tokenMatch(token, text);
  return how ? weight[how] : 0;
}

/** The letters of `token` in order in `text`, not too spread out (typos of a few letters). */
function subsequence(token: string, text: string): boolean {
  if (token.length < 3) return false;
  let at = 0;
  let first = -1;
  for (const ch of token) {
    const found = text.indexOf(ch, at);
    if (found < 0) return false;
    if (first < 0) first = found;
    at = found + 1;
  }
  return at - first <= token.length * 2;
}

export interface MatchResult {
  /** 0: no match; higher is better. */
  score: number;
  /**
   * A typed word was found only weakly: inside another word of the synonyms
   * or the place ("eve" in "revert", "level"), inside a title word when it is
   * shorter than 4 letters ("eve" in "several"), or as scattered letters. The
   * palette drops such matches when anything matches well (audit M7).
   */
  weak: boolean;
}

/** Below this many letters, a word found inside another word of a title is a weak match. */
const INSIDE_MIN = 4;

/**
 * How well `query` matches, and whether only weakly (see MatchResult). An
 * empty query matches everything with score 1.
 */
export function matchDetail(query: string, fields: MatchFields): MatchResult {
  const q = normalizeText(query);
  if (!q) return { score: 1, weak: false };
  const title = normalizeText(fields.title);
  const keywords = (fields.keywords ?? []).map(normalizeText).filter(Boolean);
  const keywordText = keywords.join(' ');
  const context = normalizeText(fields.context ?? '');

  let total = 0;
  let weak = false;
  for (const token of words(q)) {
    const inTitle = tokenMatch(token, title);
    const inKeywords = tokenMatch(token, keywordText);
    const inContext = tokenMatch(token, context);
    const score = Math.max(
      tokenScore(token, title, { word: 100, prefix: 80, inside: 45 }),
      tokenScore(token, keywordText, { word: 70, prefix: 55, inside: 30 }),
      tokenScore(token, context, { word: 35, prefix: 28, inside: 12 }),
      subsequence(token, title) ? 10 : 0,
    );
    if (score === 0) return { score: 0, weak: false };
    const strong = inTitle === 'word' || inTitle === 'prefix' || (inTitle === 'inside' && token.length >= INSIDE_MIN)
      || inKeywords === 'word' || inKeywords === 'prefix'
      || inContext === 'word' || inContext === 'prefix';
    if (!strong) weak = true;
    total += score;
  }
  // The whole phrase together counts extra.
  if (title === q) total += 200;
  else if (title.startsWith(q)) total += 90;
  else if (title.includes(q)) total += 50;
  if (keywords.includes(q)) total += 60;
  else if (keywords.some(k => k.includes(q))) total += 25;
  return { score: total, weak };
}

/** How well `query` matches (0: no match; higher is better); see matchDetail. */
export function matchScore(query: string, fields: MatchFields): number {
  return matchDetail(query, fields).score;
}

export interface Ranked<T> {
  item: T;
  score: number;
  /** Matched only weakly (MatchResult.weak). */
  weak: boolean;
}

/** The items that match, best first (stable for ties); `boost` adds to an item's score (e.g. recently picked). */
export function rankItems<T>(
  query: string,
  items: readonly T[],
  fields: (item: T) => MatchFields,
  boost: (item: T) => number = () => 0,
): Ranked<T>[] {
  const out: Array<Ranked<T> & { index: number }> = [];
  items.forEach((item, index) => {
    const { score, weak } = matchDetail(query, fields(item));
    if (score > 0) out.push({ item, score: score + boost(item), weak, index });
  });
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out.map(({ item, score, weak }) => ({ item, score, weak }));
}
