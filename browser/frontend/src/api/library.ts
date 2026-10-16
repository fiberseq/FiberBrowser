import { fetchJson } from './sharedFetch';
import type { PipelineJob, QcPayload } from './pipeline';
import type { BasecallerInfo } from '../utils/basecaller';

export type LibraryKind = 'bam' | 'bigbed' | 'plasmid_map' | 'reference' | 'track';
export type RerunLevel = 'rerun-required' | 'rerun-recommended' | 'possible';

export interface LibraryContig {
  name: string;
  length: number;
  md5?: string | null;
  circular?: boolean;
}

export interface LibraryAdvisory {
  id?: string;
  severity?: string;
  title?: string;
  reason?: string;
  affected?: string;
  fix?: string;
  fix_action?: string;
  confidence?: string | number;
  evidence?: unknown;
  [key: string]: unknown;
}

export interface LibraryEntry {
  id: string;
  kind: LibraryKind;
  path: string;
  folder: string;
  label: string;
  label_override?: string;
  sample?: string | null;
  role?: 'called' | 'aligned' | null;
  available: boolean;
  /** On a cluster (an ssh:// reference); `connected` says whether its host is connected now. */
  remote?: boolean;
  connected?: boolean;
  changed?: boolean;
  cloud_only?: boolean;
  error?: string;
  /** Problems reading the QC / outputs.json files beside it (the entry itself is fine). */
  sidecar_errors?: string[];
  /** QC / index files beside it that are online-only (not read, so not downloaded). */
  sidecars_online_only?: string[];
  date?: string | null;
  date_source?: string;
  added?: number;
  last_opened?: number;
  inspected?: number;
  reads?: number | null;
  identity?: { size?: number; mtime_ns?: number; inode?: number; header_sha256?: string | null; content_sha256?: string | null };
  chemistry?: {
    key: string;
    declared: boolean;
    inferred?: boolean;
    source?: string;
    assay?: string;
    enzyme?: string;
    platform?: string;
    mode?: string;
    fields?: Record<string, string>;
  } | null;
  /** The basecaller the file (or its run's outputs.json) records; ``available`` false: unknown. */
  basecaller?: BasecallerInfo | null;
  fiberhmm?: {
    fiberhmm_version?: string;
    fiberhmm_commit?: string;
    apply_sha256?: string;
    recall_sha256?: string;
    version_source?: string;
    programs?: { name: string; version?: string | null }[];
  };
  reference?: {
    n_contigs?: number;
    contigs?: LibraryContig[];
    digest?: string | null;
    genome?: string | null;
    plasmid?: boolean;
    total_length?: number;
    plasmid_maps?: { name: string; path: string | null; contig?: string; md5?: string }[];
  };
  qc?: {
    verdicts: Record<string, string | number | null>;
    numbers?: Record<string, string | number | null>;
    json?: string | null;
    curves?: string | null;
    report?: string | null;
    source?: string | null;
  };
  pipeline?: {
    outputs_json: string;
    outdir: string;
    role: 'called' | 'aligned';
    sample?: string | null;
    enzyme?: string | null;
    aligned_bam?: string | null;
    called_bam?: string | null;
    reference_fasta?: string | null;
    plasmid_map?: string | null;
    region?: string | null;
    open_fasta?: string | null;
    open_plasmid_maps?: string[];
    /** A run from raw POD5: dorado's unaligned BAM (a re-call starts from it, never from the POD5). */
    basecalled_bam?: string | null;
  };
  job?: {
    id: string;
    group?: string | null;
    sample?: string | null;
    enzyme?: string | null;
    outdir?: string | null;
    reference?: { path?: string; kind?: string; label?: string; genome_id?: string };
    finished_at?: number | null;
    recall_of?: string | null;
    regions?: string[] | null;
    options?: Record<string, unknown> | null;
  };
  advisories?: { key: string; fiberhmm_version?: string | null; items: LibraryAdvisory[] };
  rerun?: RerunLevel | null;
  /** The header gives no frame evidence over frame-dependent footprints (FiberHMM 3.0.1's warning). */
  frame_unverifiable?: boolean;
  linked_maps?: string[];
  tags: string[];
  notes: string;
  sources?: string[];
  previous_paths?: string[];
}

export interface LibraryGroup {
  id: string;
  name: string;
  description?: string;
  entry_ids: string[];
  created?: number;
}

export interface ScanResult {
  started?: number;
  finished?: number;
  elapsed_s?: number;
  files_seen?: number;
  candidates?: number;
  inspected?: number;
  unchanged?: number;
  added?: number;
  updated?: number;
  relocated?: number;
  cloud_only?: number;
  errors?: number;
  bam_without_index?: number;
  truncated?: string | null;
  big_dirs?: number;
  big_dir_examples?: string[];
  error?: string;
}

export interface WatchedFolder {
  id: string;
  path: string;
  max_depth: number;
  added?: number;
  last_scan?: ScanResult;
}

export interface ScanStatus {
  running: { folder_id: string; started: number; progress: { dirs?: number; files?: number; candidates?: number; inspected?: number; current?: string } } | null;
  queued: string[];
  last_error: string | null;
}

export interface LibraryPayload {
  schema: string;
  library_file: string;
  unreadable: boolean;
  entries: LibraryEntry[];
  groups: LibraryGroup[];
  watched: WatchedFolder[];
  scan: ScanStatus;
  jobs: { imported: number; available: boolean };
  fiberhmm_version: string | null;
  /** Catalog genomes of the entries that are downloaded here (Open loads only these). */
  genomes_downloaded: string[];
  advisories_available: boolean;
  platform: string;
}

export interface CatalogExport {
  success: boolean;
  catalog: {
    name: string;
    genome?: string;
    groups: { name: string; description: string; merge: boolean; datasets: { path: string; label: string }[] }[];
    tracks: unknown[];
  };
  base_dir: string | null;
  skipped: { id: string; path: string; reason: string }[];
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  return fetchJson<T>(url, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
}

const enc = encodeURIComponent;

export function getLibrary(): Promise<LibraryPayload> {
  return fetchJson('/api/library');
}

export function getLibraryEntry(id: string): Promise<{ entry: LibraryEntry }> {
  return fetchJson(`/api/library/entries/${enc(id)}`);
}

export function addLibraryFiles(paths: string[]): Promise<{ success: boolean; ids: string[]; errors: string[] }> {
  return send('/api/library/entries', 'POST', { paths });
}

export function editLibraryEntry(id: string, changes: { tags?: string[]; notes?: string; label?: string }): Promise<{ success: boolean; entry: LibraryEntry }> {
  return send(`/api/library/entries/${enc(id)}`, 'PATCH', changes);
}

export function removeLibraryEntries(ids: string[]): Promise<{ success: boolean; removed: number }> {
  return send('/api/library/entries/remove', 'POST', { ids });
}

export function rescanLibraryEntry(id: string): Promise<{ success: boolean; error?: string; entry?: LibraryEntry }> {
  return send(`/api/library/entries/${enc(id)}/rescan`, 'POST');
}

/** Point a moved entry at its new file. An entry without a content fingerprint answers
 *  `needs_confirmation` (with why in `error`); `confirm` then relocates it anyway. */
export function locateLibraryEntry(
  id: string, path: string, confirm = false,
): Promise<{ success: boolean; error?: string; needs_confirmation?: boolean; entry?: LibraryEntry }> {
  return send(`/api/library/entries/${enc(id)}/locate`, 'POST', confirm ? { path, confirm: true } : { path });
}

export function revealLibraryEntry(id: string): Promise<{ success: boolean; error?: string }> {
  return send(`/api/library/entries/${enc(id)}/reveal`, 'POST');
}

export function getLibraryEntryQc(id: string): Promise<QcPayload & { verdicts?: Record<string, unknown> }> {
  return fetchJson(`/api/library/entries/${enc(id)}/qc`);
}

/** What "Re-call" would run (the dry-run answer); Start sends its plan_id back. */
export interface RecallPlan {
  entry_id: string;
  plan_id: string;
  tool: string;
  sample: string;
  enzyme: string;
  cores: number;
  reads: string[];
  outdir: string;
  regions: string[];
  reference?: { path: string; kind?: string; label?: string } | null;
  display_command: string;
  settings: {
    source: string | null; labels: string[]; regions_recorded: boolean;
    /** Re-calls from outputs.json or a run record: 3.0 defaults the run predates, and the ids kept old. */
    changed_defaults?: RecallDefaultChange[];
    keep_old?: string[];
    /** Recorded options left out (a retired fiberhmm-call option in call_args). */
    rewrites?: RecallRewrite[];
    /** The basecaller the original run's reads record (outputs.json, else the BAM header). */
    basecaller?: BasecallerInfo | null;
  };
  advisories_fixed: string[];
  version?: string;
  /** Settings from the BAM header: the recorded command and every change made to it. */
  header?: RecallHeader | null;
  output_bam?: string | null;
}

/** A change to the original command; ``to`` null: the option is left out (e.g. retired in FiberHMM 3.0). */
export interface RecallRewrite { flag: string; from: string | null; to: string | null; why: string }

export interface RecallDefaultChange {
  id: string;
  text: string;
  /** The flags that keep the original behaviour; null when no option restores it. */
  restore: string[] | null;
  kept_old: boolean;
}

export interface RecallHeader {
  program: string;
  version?: string | null;
  command_line: string;
  rewrites: RecallRewrite[];
  changed_defaults: RecallDefaultChange[];
  input: { flag: string; recorded: string; path: string; how: string; cloud_only?: boolean };
  warnings: string[];
  not_fixed: { id: string; title: string; reason: string; fix?: string | null }[];
  keep_old: string[];
}

/** The input a BAM header names, when the Library could not find it (the user can point at it). */
export interface RecallNeedsInput { flag: string; recorded: string; reason?: string }

export interface RecallOptions {
  dry_run?: boolean; outdir?: string; cores?: number; plan_id?: string;
  /** The header's input, located by the user. */
  input?: string;
  /** 3.0 default changes for which the original behaviour is kept. */
  keep_old?: string[];
}

export function recallLibraryEntry(
  id: string, options: RecallOptions = {},
): Promise<{ success: boolean; error?: string; job?: PipelineJob; plan?: RecallPlan;
  needs_input?: RecallNeedsInput; start_new_run?: boolean }> {
  return send(`/api/library/entries/${enc(id)}/recall`, 'POST', options);
}

export function createLibraryGroup(name: string, entryIds: string[], description = ''): Promise<{ success: boolean; error?: string; group?: LibraryGroup }> {
  return send('/api/library/groups', 'POST', { name, entry_ids: entryIds, description });
}

export function editLibraryGroup(id: string, changes: { name?: string; description?: string; add?: string[]; remove?: string[] }): Promise<{ success: boolean; error?: string; group?: LibraryGroup }> {
  return send(`/api/library/groups/${enc(id)}`, 'PATCH', changes);
}

export function deleteLibraryGroup(id: string): Promise<{ success: boolean }> {
  return send(`/api/library/groups/${enc(id)}`, 'DELETE');
}

export function exportLibraryCatalog(groupIds: string[], relative: boolean, name?: string): Promise<CatalogExport> {
  return send('/api/library/catalog', 'POST', { group_ids: groupIds, relative, name });
}

export function addWatchedFolder(path: string, maxDepth = 6): Promise<{ success: boolean; watched: WatchedFolder }> {
  return send('/api/library/watched', 'POST', { path, max_depth: maxDepth, scan: true });
}

export function removeWatchedFolder(id: string): Promise<{ success: boolean }> {
  return send(`/api/library/watched/${enc(id)}`, 'DELETE');
}

export function scanWatchedFolders(folderIds: string[] = []): Promise<{ success: boolean; queued: string[]; requested: string[] }> {
  return send('/api/library/scan', 'POST', { folder_ids: folderIds });
}

/** Library > Suggested experiments: one folder scanned on demand (watched-folder rules, not watched). */
export type FolderScanMode = 'folder' | 'deep';

export interface FolderScanFile {
  path: string;
  /** Path inside the scanned folder. */
  name: string;
  kind: LibraryKind;
  size: number;
  cloud_only: boolean;
  /** Its Library entry when it is already listed. */
  entry_id: string | null;
}

export interface FolderScanPreview {
  success: boolean;
  error?: string;
  folder: string;
  mode?: FolderScanMode;
  /** The run-output sub-folders scanned ('folder' mode); null: every sub-folder to max_depth. */
  subdirs?: string[] | null;
  max_depth?: number;
  files: FolderScanFile[];
  kinds: Partial<Record<LibraryKind, number>>;
  new: number;
  cloud_only: number;
  left_out: {
    aligned: number; no_index: number; outside: number; other_files: number;
    skipped_dirs: number; big_dirs: number; unreadable: number;
  };
  big_dir_examples?: string[];
  truncated: string | null;
  /** The folder is (inside) a watched folder already. */
  watched: boolean;
}

export interface FolderScanAdded {
  success: boolean;
  error?: string;
  ids: string[];
  added: number;
  updated: number;
  relocated: number;
  unchanged: number;
  aligned: number;
  not_found: string[];
  errors: string[];
  truncated: string | null;
}

export function previewLibraryFolder(path: string, mode: FolderScanMode = 'folder'): Promise<FolderScanPreview> {
  return send('/api/library/folder/preview', 'POST', { path, mode });
}

export function addLibraryFolderFiles(path: string, paths: string[], mode: FolderScanMode = 'folder'): Promise<FolderScanAdded> {
  return send('/api/library/folder/add', 'POST', { path, paths, mode });
}
