/**
 * How well a name matches what was typed (region labels, category names):
 * 0 not at all; exact 100, prefix 80, a word start 60, inside 40, the letters
 * in order (fuzzy) up to 20. (The palette ranks its commands and settings with
 * ./fuzzy instead, which weighs titles, synonyms and places.)
 */
export function textMatchScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const at = t.indexOf(q);
  if (at > 0) return /[\s_\-.:·/()|,]/.test(t[at - 1]) ? 60 : 40;
  if (q.length < 3) return 0;
  // Letters in order: tighter spans score higher.
  let i = 0;
  let first = -1;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      if (first < 0) first = j;
      last = j;
      i += 1;
    }
  }
  if (i < q.length) return 0;
  const span = last - first + 1;
  return Math.max(1, Math.round(20 * (q.length / span)));
}
