/** Mirrors the staged caller's source grouping: Hia5 sources are pooled. */
export function familyWorkflowMode(chemistries: Array<string | null | undefined>) {
  if (!chemistries.length || chemistries.some(value => !['ddda','dddb','hia5-pacbio','hia5-nanopore'].includes(value ?? ''))) return null;
  const strands = chemistries.some(value => value === 'ddda' || value === 'dddb');
  return chemistries.length > 1 ? (strands ? 'SR/XCR' : 'XCR') : (strands ? 'SR' : 'CR');
}
