import type { UcscTrack } from '../api/externalTracks';

export const ENCODE_GENOMES = new Set(['hg38', 'hg19', 'mm10', 'dm6']);

export function supportsEncodeGenome(genome: string | null | undefined): genome is string {
  return !!genome && ENCODE_GENOMES.has(genome);
}

export function getDefaultExpandedUcscGroups(groups: Record<string, UcscTrack[]>): Set<string> {
  const loadableGroups = new Set<string>();
  for (const [group, tracks] of Object.entries(groups)) {
    if (tracks.some(track => track.loadable)) loadableGroups.add(group);
  }
  return loadableGroups;
}

export function filterUcscTrackGroups(
  groups: Record<string, UcscTrack[]> | undefined,
  query: string,
): Record<string, UcscTrack[]> {
  if (!groups) return {};
  const q = query.toLowerCase().trim();
  if (!q) return groups;

  const result: Record<string, UcscTrack[]> = {};
  for (const [group, tracks] of Object.entries(groups)) {
    const filtered = tracks.filter(track =>
      track.label.toLowerCase().includes(q) ||
      track.description?.toLowerCase().includes(q) ||
      track.id.toLowerCase().includes(q) ||
      track.type?.toLowerCase().includes(q) ||
      group.toLowerCase().includes(q)
    );
    if (filtered.length > 0) result[group] = filtered;
  }
  return result;
}
