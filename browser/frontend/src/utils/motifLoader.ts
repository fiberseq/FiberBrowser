import {
  addMotifJasparTracks,
  addMotifPwmTrack,
  addMotifSequenceTrack,
  searchJasparMotifs,
  type BackendMotifTrack,
  type MotifPwmCounts,
} from '../api/tracks';
import { uploadFile } from '../api/files';
import { useBrowserStore } from '../stores/browserStore';
import { registerBackendMotifTrack, registerMotifFileTracks } from './trackLoader';

/**
 * The single way motifs get added. Every source (JASPAR, a typed sequence,
 * a pasted matrix, a motif file) becomes the same kind of scanned PWM track,
 * at the one shared threshold, so tracks, footprint scans and labeling rules
 * all see every motif.
 */

export const IUPAC_MOTIF_RE = /^[ACGTRYSWKMBDHVN]{4,}$/i;

export interface MotifAddResult {
  success: boolean;
  message: string;
  /** Sources added, e.g. to attach to an existing track. */
  catalogEntryIds?: string[];
}

/** standalone: each motif also gets a track of its own (false: just the source). */
type AddOptions = { standalone?: boolean };

const threshold = () => useBrowserStore.getState().motifThreshold;

/**
 * Re-create a motif track the backend lost (e.g. after a restart) from its
 * catalog path, without touching the catalog entry. JASPAR IDs and typed
 * sequences are recoverable; pasted matrices and file motifs are not.
 */
export async function restoreMotifTrack(
  path: string,
  savedThreshold?: number,
): Promise<{ success: boolean; track_index?: number; message?: string }> {
  const level = savedThreshold ?? threshold();
  if (path.startsWith('motif://jaspar/')) {
    const res = await addMotifJasparTracks([decodeURIComponent(path.slice('motif://jaspar/'.length))], level);
    return { success: res.success, track_index: res.tracks?.[0]?.track_index, message: res.message };
  }
  if (path.startsWith('motif://sequence/')) {
    const res = await addMotifSequenceTrack(decodeURIComponent(path.slice('motif://sequence/'.length)), undefined, level);
    return { success: res.success, track_index: res.track_index, message: res.message };
  }
  return { success: false, message: 'This motif was pasted or loaded from a file; add it again.' };
}

function registerAll(tracks: BackendMotifTrack[] | undefined, options: AddOptions = {}): string[] {
  const ids: string[] = [];
  for (const track of tracks ?? []) {
    const registered = registerBackendMotifTrack({
      ...track, threshold: track.threshold ?? threshold(), autoCreateComposite: options.standalone !== false,
    });
    if (registered.catalogEntryId) ids.push(registered.catalogEntryId);
  }
  if (tracks?.length) useBrowserStore.getState().triggerRefresh();
  return ids;
}

export async function addJasparMotifs(matrixIds: string[], options: AddOptions = {}): Promise<MotifAddResult> {
  const res = await addMotifJasparTracks(matrixIds, threshold());
  const catalogEntryIds = registerAll(res.tracks, options);
  return { success: res.success, message: res.message ?? (res.success ? 'Motif added' : 'Could not add motif'), catalogEntryIds };
}

/**
 * The reference motif searches rank for: the one panel reference the analysed panels (else every dataset
 * panel) share, e.g. an expanded insert's or a panel FASTA's key; null for the main reference or a mix.
 */
export function motifSearchReference(state: { panels: { id: string; datasetId?: string | null; genome?: string | null; contentType?: string }[];
  selectedDatasets?: Set<string> } = useBrowserStore.getState()): string | null {
  const dataPanels = state.panels.filter(p => p.datasetId && (!p.contentType || p.contentType === 'dataset'));
  const picked = dataPanels.filter(p => state.selectedDatasets?.has(p.id));
  const keys = new Set((picked.length ? picked : dataPanels).map(p => p.genome ?? null));
  return keys.size === 1 ? [...keys][0] : null;
}

/** Resolve TF names (e.g. from Copilot) to the best JASPAR match for the analysed reference. */
export async function addJasparMotifsByName(names: string[]): Promise<MotifAddResult> {
  const genome = motifSearchReference();
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const { results } = await searchJasparMotifs(name, genome);
    const wanted = name.trim().toUpperCase();
    const exact = results.find(result => result.name.toUpperCase() === wanted
      || result.matrix_id.toUpperCase() === wanted
      || result.matrix_id.split('.')[0].toUpperCase() === wanted);
    if (exact) ids.push(exact.matrix_id);
    else unknown.push(name);
  }
  if (ids.length === 0) return { success: false, message: `No JASPAR motif named ${unknown.join(', ')}` };
  const result = await addJasparMotifs(ids);
  return unknown.length ? { ...result, message: `${result.message}; not found: ${unknown.join(', ')}` } : result;
}

export async function addSequenceMotif(sequence: string, options: AddOptions = {}): Promise<MotifAddResult> {
  const seq = sequence.trim().toUpperCase();
  if (!IUPAC_MOTIF_RE.test(seq)) return { success: false, message: 'Use A/C/G/T or IUPAC codes, at least 4 bases' };
  const res = await addMotifSequenceTrack(seq, undefined, threshold());
  let catalogEntryIds: string[] = [];
  if (res.success && res.track_index != null && res.path && res.label) {
    catalogEntryIds = registerAll([{ track_index: res.track_index, path: res.path, label: res.label, motif_name: res.motif_name, motif_type: res.motif_type }], options);
  }
  return { success: res.success, message: res.message ?? (res.success ? `Added ${seq}` : 'Could not add motif'), catalogEntryIds };
}

export async function addPwmMotif(name: string, counts: MotifPwmCounts, options: AddOptions = {}): Promise<MotifAddResult> {
  const res = await addMotifPwmTrack(name, counts, undefined, threshold());
  let catalogEntryIds: string[] = [];
  if (res.success && res.track_index != null && res.path && res.label) {
    catalogEntryIds = registerAll([{ track_index: res.track_index, path: res.path, label: res.label, motif_name: res.motif_name,
      motif_type: res.motif_type, motif_source: res.motif_source }], options);
  }
  return { success: res.success, message: res.message ?? (res.success ? `Added ${name}` : 'Could not add matrix'), catalogEntryIds };
}

/** A motif database file already on the server (.jaspar/.meme/.pfm/.homer/.motif/.txt). */
export async function addMotifFile(path: string, options: AddOptions = {}): Promise<MotifAddResult> {
  const res = await registerMotifFileTracks(path, threshold(), options.standalone !== false);
  if (res.success) useBrowserStore.getState().triggerRefresh();
  return { success: res.success, message: res.message ?? (res.success ? 'Motifs loaded' : 'Could not read motif file'),
    catalogEntryIds: res.catalogEntryIds };
}

/** A motif file chosen in the browser: upload it, then load it like any other. */
export async function addMotifUpload(file: File, options: AddOptions = {}): Promise<MotifAddResult> {
  const uploaded = await uploadFile(file);
  if (!uploaded.success) return { success: false, message: 'Upload failed' };
  return addMotifFile(uploaded.path, options);
}

const PWM_NUMBER_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** Parse a pasted count/probability matrix: JSON {A:[..],..} or one "A ..." row per base. */
export function parsePwmText(input: string): { counts?: MotifPwmCounts; name?: string; error?: string } {
  const text = input.trim();
  if (!text) return { error: 'Paste a matrix' };
  let rows: Record<string, unknown> = {};
  let name: string | undefined;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      rows = (parsed.counts && typeof parsed.counts === 'object' ? parsed.counts : parsed) as Record<string, unknown>;
      if (typeof parsed.name === 'string') name = parsed.name;
    } catch (error) {
      return { error: error instanceof Error ? `Invalid JSON: ${error.message}` : 'Invalid JSON' };
    }
  } else {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('>')) { name = line.slice(1).trim() || name; continue; }
      const base = line[0]?.toUpperCase();
      if (base && 'ACGT'.includes(base)) rows[base] = (line.slice(1).match(PWM_NUMBER_RE) ?? []).map(Number);
    }
  }
  const counts = {} as MotifPwmCounts;
  let length: number | null = null;
  for (const base of ['A', 'C', 'G', 'T'] as const) {
    const values = rows[base] ?? rows[base.toLowerCase()];
    if (!Array.isArray(values) || values.length === 0) return { error: `Missing the ${base} row` };
    const numeric = values.map(Number);
    if (numeric.some(value => !Number.isFinite(value))) return { error: `${base} row has a non-number` };
    if (length !== null && numeric.length !== length) return { error: 'Rows must be the same length' };
    length = numeric.length;
    counts[base] = numeric;
  }
  return { counts, name };
}
