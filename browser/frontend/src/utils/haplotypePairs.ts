export interface HaplotypePair {
  base: string;
  chrom1: string;
  chrom2: string;
}

export function detectHaplotypePairs(chromNames: string[]): HaplotypePair[] {
  const pairs: HaplotypePair[] = [];
  const seen = new Set<string>();
  const hapRegex = /^(.+?)[-_](hap[12]|paternal|maternal|h[12]|pat|mat)$/i;
  const grouped = new Map<string, string[]>();

  for (const name of chromNames) {
    const match = name.match(hapRegex);
    if (match) {
      const base = match[1];
      if (!grouped.has(base)) grouped.set(base, []);
      grouped.get(base)!.push(name);
    }
  }

  for (const [base, chroms] of grouped) {
    if (chroms.length === 2 && !seen.has(base)) {
      seen.add(base);
      pairs.push({ base, chrom1: chroms[0], chrom2: chroms[1] });
    }
  }

  return pairs;
}
