/** Plain-language text for the difference inspectors' molecule calls (the API's codes stay in titles and details). */

/** Action buttons in the inspectors: the shared secondary button, compact. */
export const INSPECTOR_BUTTON = 'fb-btn-secondary h-6 px-2 py-0 text-[11px]';

const ASSIGNMENT: Record<string, string> = {
  target: 'carries the allele', reference: 'reference allele', other_allele: 'another allele', ambiguous: 'ambiguous', unknown: '',
};
const GEOMETRY = ['Carrier', 'Reference', 'Not informative'];

const REASON: Record<string, string> = {
  sequence_not_assessed: 'sequence not checked',
  ambiguous_bases: 'ambiguous bases in the read',
  uncalibrated_likelihood_profile: 'likelihood not calibrated',
  competing_diagnostics: 'competing alleles look alike here',
  exact_sequence: 'exact sequence match',
  not_spanning: 'read does not span the difference',
  partial_coverage: 'read covers it only partly',
};

/** "Carrier · carries the allele (confirmed)" from a molecule's call; never a bare "unknown · unknown". */
export function callText(call: { assignment: string; level?: string | null }, geometryGroup?: number): string {
  const parts: string[] = [];
  if (geometryGroup !== undefined && GEOMETRY[geometryGroup]) parts.push(`${GEOMETRY[geometryGroup]} by geometry`);
  const a = call.assignment in ASSIGNMENT ? ASSIGNMENT[call.assignment] : call.assignment.replace(/_/g, ' ');
  if (a) parts.push(`${a}${call.level ? ` (${call.level})` : ''}`);
  return parts.join(' · ') || 'not called';
}

/** A molecule call's reasons (or method) in words. */
export function reasonText(codes: string[]): string {
  return codes.map(c => REASON[c] ?? c.replace(/_/g, ' ')).join('; ');
}
