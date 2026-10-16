import type { ChromInfo } from '../types';

function chromAliasKeys(name: string): Set<string> {
  const lower = String(name || '').toLowerCase();
  // No name has no aliases (it must not match a contig named "chr").
  if (!lower) return new Set();
  const strippedChr = lower.startsWith('chr') ? lower.slice(3) : lower;
  const keys = new Set([lower]);
  if (strippedChr) {
    keys.add(strippedChr);
    keys.add(`chr${strippedChr}`);
  }
  if (strippedChr === 'm' || strippedChr === 'mt') {
    keys.add('m');
    keys.add('mt');
    keys.add('chrm');
    keys.add('chrmt');
  }
  return keys;
}

export function findChromInfo(chroms: ChromInfo[], chrom: string): ChromInfo | undefined {
  const exact = chroms.find(c => c.name === chrom);
  if (exact) return exact;
  const queryKeys = chromAliasKeys(chrom);
  return chroms.find(c => {
    for (const key of chromAliasKeys(c.name)) {
      if (queryKeys.has(key)) return true;
    }
    return false;
  });
}

/** Whether two chromosome names mean the same contig ('chr1' / '1', 'chrM' / 'MT'). */
export function sameChrom(a: string, b: string): boolean {
  if (a === b) return true;
  const keys = chromAliasKeys(a);
  for (const key of chromAliasKeys(b)) if (keys.has(key)) return true;
  return false;
}
