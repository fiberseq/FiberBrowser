/**
 * One haplotype palette for the header, tooltip, pooled rows, differences strip and ribbon. Orange/blue remain
 * distinct with common colour-vision deficiencies; lighter inks keep the same identities on a dark ground.
 *
 * MAT and PAT keep their fixed colours. Any other haplotype (a map with more than two, or a single lab-strain
 * haplotype) gets a colour of its own from a small categorical palette, chosen by the order haplotypes are first
 * seen: the lifted datasets' haplotypes in their map order (`registerHaplotypeLabels`), else the first draw. Once
 * given, a haplotype keeps its colour for the session. Only a missing haplotype is neutral.
 */
export const LIVE_LIFT_HAPLOTYPE_PALETTE = {
  MAT: { light: '#c2410c', dark: '#fdba74' },
  PAT: { light: '#1d4ed8', dark: '#93c5fd' },
  neutral: { light: '#475569', dark: '#cbd5e1' },
} as const;

/** Further haplotypes, in order: teal, magenta, olive, rose, brown (none near MAT orange, PAT blue or the ribbon's '−' violet). */
export const LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE = [
  { light: '#0f766e', dark: '#5eead4' },
  { light: '#a21caf', dark: '#f0abfc' },
  { light: '#4d7c0f', dark: '#bef264' },
  { light: '#be123c', dark: '#fda4af' },
  { light: '#854d0e', dark: '#fde68a' },
] as const;

const assigned = new Map<string, number>();

const fixed = (hap: string) => hap === 'MAT' || hap === 'PAT';

/** Give these haplotypes (a lifted dataset's labels, in map order) their colours, if they have none yet. */
export function registerHaplotypeLabels(labels: readonly string[]): void {
  for (const label of labels) if (label && !fixed(label) && !assigned.has(label)) assigned.set(label, assigned.size);
}

/** Tests start from no assignments. */
export function resetHaplotypeColours(): void { assigned.clear(); }

export function liveLiftHaplotypeColor(hap: string | null | undefined, dark = false): string {
  if (!hap) return LIVE_LIFT_HAPLOTYPE_PALETTE.neutral[dark ? 'dark' : 'light'];
  if (fixed(hap)) return LIVE_LIFT_HAPLOTYPE_PALETTE[hap as 'MAT' | 'PAT'][dark ? 'dark' : 'light'];
  registerHaplotypeLabels([hap]);
  const entry = LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE[assigned.get(hap)! % LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE.length];
  return entry[dark ? 'dark' : 'light'];
}
