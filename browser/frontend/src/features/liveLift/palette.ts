/**
 * One haplotype palette for the header, tooltip, pooled rows and future differences strip. Orange/blue remain
 * distinct with common colour-vision deficiencies; lighter inks keep the same identities on a dark ground.
 * Unrecognised haplotypes stay neutral rather than borrowing a parental identity.
 */
export const LIVE_LIFT_HAPLOTYPE_PALETTE = {
  MAT: { light: '#c2410c', dark: '#fdba74' },
  PAT: { light: '#1d4ed8', dark: '#93c5fd' },
  neutral: { light: '#475569', dark: '#cbd5e1' },
} as const;

export function liveLiftHaplotypeColor(hap: string | null | undefined, dark = false): string {
  const palette = hap === 'MAT' || hap === 'PAT' ? LIVE_LIFT_HAPLOTYPE_PALETTE[hap] : LIVE_LIFT_HAPLOTYPE_PALETTE.neutral;
  return palette[dark ? 'dark' : 'light'];
}
