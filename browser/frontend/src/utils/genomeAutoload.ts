/**
 * Start-up reference auto-load helpers (App.tsx).
 *
 * The browser restores the last registry genome (or hg38) on start-up when the
 * server has no reference. Two things went wrong on a fresh launch with a BAM
 * and no --fasta:
 * - A genome load that only fetched the annotation (FASTA download failed) was
 *   reported as a loaded reference, so the sequence track asked for bases and
 *   got 404 "No FASTA loaded".
 * - The hg38 default was loaded under a fly (or yeast, ...) BAM: its FASTA
 *   replaced the chromosome list and the sequence track asked hg38 for chr2R
 *   (404 "Chromosome chr2R not found in FASTA").
 */

import { getStatus, type StatusResponse } from '../api/status';
import { isSandboxPage } from './sandbox';

/**
 * Whether this page restores a reference on start-up. Not a tour tab: its
 * sandbox gets the demo's genome from the server (POST /api/sandbox and
 * /api/demo/load, from the local cache only), and a genome load of its own
 * held the sandbox while it waited for a download, so the demo couldn't be
 * added until that was done (the tour sat at its first step).
 */
export function startupGenomeAutoload(): boolean {
  if (typeof window !== 'undefined' && window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD) return false;
  return !isSandboxPage();
}

/**
 * The server's status when it already has this registry genome with a FASTA (its download, or the user's
 * --fasta hg38.fa whose genome id the server inferred), else null. A restore or reopen then must not ask for the
 * genome again: that downloaded the registry FASTA over the user's (3.0.0 audit HIGH-1). The same rule as the
 * start-up auto-load (App.tsx), which leaves a server with a reference alone. Unknown (no answer): null.
 */
export async function serverGenomeLoaded(genomeId: string): Promise<StatusResponse | null> {
  try {
    const status = await getStatus(false);
    return status && status.has_fasta && status.current_genome === genomeId ? status : null;
  } catch {
    return null;
  }
}

/** A /api/load_genome response loaded sequence (not just the annotation). */
export function genomeLoadHasFasta(res: { success: boolean; fasta_loaded?: boolean }): boolean {
  return res.success && (res.fasta_loaded ?? true);
}

/** Assembly family the chromosome names point to (mirrors services/motifs.py genome_from_chroms). */
export function genomeFromChroms(names: Iterable<string>): string | null {
  const base = new Set<string>();
  for (const name of names) base.add(String(name).toLowerCase().replace(/^chr/, ''));
  const has = (...keys: string[]) => keys.every(k => base.has(k));
  if (has('2l', '3r')) return 'dm6';
  if (has('xvi', 'i')) return 'sacCer3';
  if (has('i', 'v', 'x') && !base.has('1')) return 'ce11';
  if (base.has('25')) return 'danRer11';
  if (has('1', '21', '22')) return 'hg38';
  if (has('1', '20')) return 'rn7';
  if (has('1', '19', 'x')) return 'mm10';
  return null;
}

const SPECIES: Record<string, string> = {
  hg38: 'human', hg19: 'human',
  mm39: 'mouse', mm10: 'mouse',
  dm6: 'fly', sacCer3: 'yeast', ce11: 'worm', danRer11: 'zebrafish', rn7: 'rat',
};

/**
 * The registry genome to auto-load: the remembered one (or the hg38 default)
 * unless the loaded data's chromosome names clearly belong to another species;
 * then that species' registry genome, or none (null) when the registry has none.
 */
export function pickAutoloadGenome(
  target: string,
  dataChroms: Iterable<string>,
  registryIds: string[],
): string | null {
  const inferred = genomeFromChroms(dataChroms);
  if (!inferred) return target;
  const species = SPECIES[inferred] ?? inferred;
  if ((SPECIES[target] ?? target) === species) return target;
  return registryIds.find(id => (SPECIES[id] ?? id) === species) ?? null;
}
