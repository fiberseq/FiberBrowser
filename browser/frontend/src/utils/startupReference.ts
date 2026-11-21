/**
 * Which reference a page opens with, and which reference a restored session may put back.
 *
 * The order (owner report, 3.1.0 RC, 20 Nov):
 * 1. the server's reference: `--fasta` given on the command line, or one already loaded (by this session's
 *    user, another tab, a session file the user opened);
 * 2. the registry genome the loaded datasets were aligned to (their BAM headers);
 * 3. the reference this browser remembers (the last FASTA path or registry genome).
 *
 * A remembered reference of another assembly than the loaded data never wins silently: the data's genome is
 * loaded and the page says in one line that the saved reference was not restored. Session files the user opens
 * keep their own reference (with the mismatch banner); they don't come through here.
 */
import { genomeFromChroms, pickAutoloadGenome } from './genomeAutoload';

const SPECIES: Record<string, string> = {
  hg38: 'human', hg19: 'human', mm39: 'mouse', mm10: 'mouse',
  dm6: 'fly', sacCer3: 'yeast', ce11: 'worm', danRer11: 'zebrafish', rn7: 'rat',
};

export interface StartupReferenceInput {
  /** The server's reference now (/api/status). */
  server: { hasFasta: boolean; currentGenome: string | null };
  /** What this browser remembers (localStorage). `fastaAssembly`: the remembered FASTA's assembly, from its index
   *  (null: no known assembly, or not asked). */
  remembered: { fastaPath: string | null; fastaAssembly?: string | null; genomeId: string | null };
  /** The loaded datasets: their registry genome when their headers say it plainly (/api/genome/check), and their
   *  contig names. */
  data: { genome: string | null; chroms: string[] };
  /** The registry's genome ids. */
  registryIds: string[];
  /** Loaded when nothing else says what to load. */
  defaultGenome?: string;
}

export type StartupReferenceDecision =
  | { action: 'keep-server' }
  | { action: 'load-fasta'; path: string }
  | { action: 'load-genome'; genomeId: string; notRestored?: string }
  | { action: 'none'; notRestored?: string };

/** A remembered path that is not a local file (a registry download's URL the status reported). */
export function isRemoteReference(path: string | null | undefined): boolean {
  return !!path && /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The registry genome the data points to: its headers' plain assembly, else its contig names' species. */
export function dataGenome(data: StartupReferenceInput['data'], registryIds: string[]): string | null {
  if (data.genome && registryIds.includes(data.genome)) return data.genome;
  const inferred = genomeFromChroms(data.chroms);
  if (!inferred) return null;
  if (registryIds.includes(inferred)) return inferred;
  const species = SPECIES[inferred] ?? inferred;
  return registryIds.find(id => (SPECIES[id] ?? id) === species) ?? null;
}

/** The registry genome a FASTA's file name is (dm6.fa, hg38.fa.gz), else null. */
function stemGenome(path: string, registryIds: string[]): string | null {
  const stem = baseName(path).replace(/\.(fa|fasta|fna)(\.gz)?$/i, '');
  return registryIds.includes(stem) ? stem : null;
}

function sameGenome(a: string | null | undefined, b: string | null | undefined, exact: boolean): boolean {
  if (!a || !b) return false;
  return exact ? a === b : (SPECIES[a] ?? a) === (SPECIES[b] ?? b);
}

/** The start-up decision (App.tsx). */
export function decideStartupReference(input: StartupReferenceInput): StartupReferenceDecision {
  const { server, remembered, data, registryIds } = input;
  // 1. The server's reference stays, whatever this browser remembers.
  if (server.hasFasta || server.currentGenome) return { action: 'keep-server' };
  const wanted = dataGenome(data, registryIds);
  // The data's assembly is known exactly from its headers; from its contig names only the species.
  const exact = !!data.genome && data.genome === wanted;
  const fastaPath = remembered.fastaPath && !isRemoteReference(remembered.fastaPath) ? remembered.fastaPath : null;
  // 3 (unless it contradicts 2). The remembered FASTA, unless it is known to be another assembly than the data's
  // (its index's contig lengths, else its name: dm6.fa). One of no known assembly is restored: the mismatch banner
  // says so if the data is not on it.
  if (fastaPath) {
    const fastaGenome = remembered.fastaAssembly ?? stemGenome(fastaPath, registryIds);
    if (!wanted || !fastaGenome || sameGenome(fastaGenome, wanted, exact)) return { action: 'load-fasta', path: fastaPath };
    return { action: 'load-genome', genomeId: wanted, notRestored: notRestoredText(baseName(fastaPath), wanted) };
  }
  const rememberedGenome = remembered.genomeId && registryIds.includes(remembered.genomeId) ? remembered.genomeId : null;
  // 2. The data's genome; the remembered one when it is that genome (or nothing says what the data is).
  if (wanted) {
    if (rememberedGenome && sameGenome(rememberedGenome, wanted, exact)) return { action: 'load-genome', genomeId: rememberedGenome };
    return rememberedGenome
      ? { action: 'load-genome', genomeId: wanted, notRestored: notRestoredText(rememberedGenome, wanted) }
      : { action: 'load-genome', genomeId: wanted };
  }
  const target = rememberedGenome ?? input.defaultGenome ?? 'hg38';
  // Contig names of a species the registry lacks: nothing to load (not hg38 under a fly BAM).
  const picked = pickAutoloadGenome(target, data.chroms, registryIds);
  if (!picked || !registryIds.includes(picked)) {
    return rememberedGenome ? { action: 'none', notRestored: `The saved reference (${rememberedGenome}) was not restored: the loaded data is on another genome.` } : { action: 'none' };
  }
  return { action: 'load-genome', genomeId: picked };
}

function notRestoredText(saved: string, wanted: string): string {
  return `The saved reference (${saved}) was not restored: the loaded data is ${wanted}.`;
}

/**
 * Restoring a saved session (crash recovery, Reopen last session): its reference is put back unless the server
 * was started with a reference of its own (`--fasta`) that is not the saved one. Returns the one line to show
 * when the saved reference is kept out, else null (restore it).
 */
export function restoredReferenceConflict(
  saved: { currentGenome?: string | null; fastaPath?: string | null },
  server: { startupReference?: boolean; currentGenome: string | null; fastaPath: string | null },
): string | null {
  if (!server.startupReference) return null;
  const savedLabel = saved.currentGenome || (saved.fastaPath ? baseName(saved.fastaPath) : null);
  if (!savedLabel) return null;
  if (saved.currentGenome && saved.currentGenome === server.currentGenome) return null;
  if (!saved.currentGenome && saved.fastaPath && saved.fastaPath === server.fastaPath) return null;
  const serverLabel = server.currentGenome || (server.fastaPath ? baseName(server.fastaPath) : 'its own reference');
  return `The saved reference (${savedLabel}) was not restored: this server was started with ${serverLabel}.`;
}
