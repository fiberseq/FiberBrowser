/**
 * The Library's table logic, kept free of React so it is tested directly:
 * search and filters, sorting, facet values, and suggested experiments
 * (one per folder of BAMs, one per multi-sample DAF-seq run).
 */
import type { LibraryEntry, LibraryGroup, LibraryKind } from '../api/library';

export interface LibraryFilters {
  text: string;
  kind: LibraryKind | '';
  chemistry: string;
  reference: string;
  qc: string;
  tag: string;
  folder: string;
  group: string;
  rerunOnly: boolean;
  showAligned: boolean;
  showUnavailable: boolean;
}

export const DEFAULT_FILTERS: LibraryFilters = {
  text: '', kind: '', chemistry: '', reference: '', qc: '', tag: '', folder: '', group: '',
  rerunOnly: false, showAligned: false, showUnavailable: true,
};

export type SortKey = 'label' | 'sample' | 'kind' | 'chemistry' | 'reference' | 'reads' | 'qc' | 'date' | 'folder' | 'size';
export interface SortState { key: SortKey; dir: 'asc' | 'desc' }

const CHEMISTRY_LABELS: Record<string, string> = {
  dddb: 'DddB', ddda: 'DddA', 'hia5-pacbio': 'Hia5 PacBio', 'hia5-nanopore': 'Hia5 Nanopore',
  unknown: 'unknown', conflict: 'conflicting',
};

export const KIND_LABELS: Record<LibraryKind, string> = {
  bam: 'BAM', bigbed: 'BigBed', plasmid_map: 'Plasmid map', reference: 'Reference', track: 'Track',
};

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function chemistryKey(entry: LibraryEntry): string {
  if (entry.kind === 'plasmid_map') return '';
  return entry.chemistry?.key || 'unknown';
}

export function chemistryLabel(entry: LibraryEntry): string {
  const key = chemistryKey(entry);
  if (!key) return '';
  const label = CHEMISTRY_LABELS[key] ?? key;
  return entry.chemistry?.inferred ? `${label} (inferred)` : label;
}

/** 'genome:dm6', 'plasmid', or 'unknown' (the reference filter's values). */
export function referenceKey(entry: LibraryEntry): string {
  const ref = entry.reference;
  if (entry.kind === 'plasmid_map' || ref?.plasmid) return 'plasmid';
  if (ref?.genome) return `genome:${ref.genome}`;
  return 'unknown';
}

export function referenceLabel(entry: LibraryEntry): string {
  const ref = entry.reference;
  if (entry.kind === 'plasmid_map') {
    const contig = ref?.contigs?.[0];
    return contig ? `${contig.name} (${formatBp(contig.length)})` : 'plasmid';
  }
  if (ref?.plasmid) {
    const maps = ref.plasmid_maps?.map(m => m.name).filter(Boolean) ?? [];
    const circular = ref.contigs?.filter(c => c.circular).map(c => c.name) ?? [];
    const names = maps.length ? maps : circular;
    return names.length ? `plasmid ${names.slice(0, 2).join(', ')}` : 'plasmid';
  }
  if (ref?.genome) return ref.genome;
  if (ref?.n_contigs) return `${ref.n_contigs.toLocaleString()} contig${ref.n_contigs === 1 ? '' : 's'}`;
  return '—';
}

export function qcVerdict(entry: LibraryEntry): string {
  const verdict = entry.qc?.verdicts?.overall;
  return typeof verdict === 'string' && verdict ? verdict.toUpperCase() : '';
}

export function formatBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '—';
  if (bp >= 1e6) return `${(bp / 1e6).toFixed(bp >= 1e7 ? 0 : 1)} Mb`;
  if (bp >= 1e3) return `${(bp / 1e3).toFixed(bp >= 1e4 ? 0 : 1)} kb`;
  return `${bp} bp`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function entryDate(entry: LibraryEntry): string {
  return entry.date ? entry.date.slice(0, 10) : '';
}

function searchText(entry: LibraryEntry): string {
  return [
    entry.label, entry.label_override, entry.sample, entry.path, entry.notes, ...(entry.tags ?? []),
    chemistryLabel(entry), referenceLabel(entry), qcVerdict(entry),
  ].filter(Boolean).join('\n').toLowerCase();
}

function inFolder(entry: LibraryEntry, folder: string): boolean {
  if (!folder) return true;
  const f = folder.replace(/[\\/]+$/, '');
  return entry.folder === f || entry.folder.startsWith(`${f}/`) || entry.folder.startsWith(`${f}\\`);
}

export function filterEntries(entries: LibraryEntry[], filters: LibraryFilters, groups: LibraryGroup[] = []): LibraryEntry[] {
  const words = filters.text.toLowerCase().split(/\s+/).filter(Boolean);
  const group = filters.group ? groups.find(g => g.id === filters.group) : null;
  const members = group ? new Set(group.entry_ids) : null;
  return entries.filter(entry => {
    if (members && !members.has(entry.id)) return false;
    if (filters.kind && entry.kind !== filters.kind) return false;
    if (!filters.showAligned && entry.role === 'aligned') return false;
    if (!filters.showUnavailable && !entry.available) return false;
    if (filters.rerunOnly && !entry.rerun) return false;
    if (filters.chemistry && chemistryKey(entry) !== filters.chemistry) return false;
    if (filters.reference && referenceKey(entry) !== filters.reference) return false;
    if (filters.qc) {
      const verdict = qcVerdict(entry);
      if (filters.qc === 'none' ? verdict !== '' : verdict !== filters.qc) return false;
    }
    if (filters.tag && !(entry.tags ?? []).includes(filters.tag)) return false;
    if (!inFolder(entry, filters.folder)) return false;
    if (words.length) {
      const text = searchText(entry);
      if (!words.every(word => text.includes(word))) return false;
    }
    return true;
  });
}

const QC_ORDER: Record<string, number> = { FAIL: 0, WARN: 1, INSUFFICIENT: 2, PASS: 3 };

function sortValue(entry: LibraryEntry, key: SortKey): string | number {
  switch (key) {
    case 'label': return (entry.label || '').toLowerCase();
    case 'sample': return (entry.sample || '').toLowerCase();
    case 'kind': return entry.kind;
    case 'chemistry': return chemistryLabel(entry).toLowerCase();
    case 'reference': return referenceLabel(entry).toLowerCase();
    case 'reads': return entry.reads ?? -1;
    case 'qc': {
      const verdict = qcVerdict(entry);
      return verdict ? (QC_ORDER[verdict] ?? 2.5) : -1;
    }
    case 'date': return entry.date || '';
    case 'folder': return (entry.folder || '').toLowerCase();
    case 'size': return entry.identity?.size ?? -1;
    default: return '';
  }
}

export function sortEntries(entries: LibraryEntry[], sort: SortState): LibraryEntry[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return (a.label || '').localeCompare(b.label || '');
  });
}

export function toggleSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'date' || key === 'reads' || key === 'size' ? 'desc' : 'asc' };
}

export interface Facets {
  chemistries: string[];
  references: string[];
  verdicts: string[];
  tags: string[];
  folders: string[];
  kinds: LibraryKind[];
}

export function facetValues(entries: LibraryEntry[]): Facets {
  const chemistries = new Set<string>();
  const references = new Set<string>();
  const verdicts = new Set<string>();
  const tags = new Set<string>();
  const folders = new Set<string>();
  const kinds = new Set<LibraryKind>();
  for (const entry of entries) {
    const chem = chemistryKey(entry);
    if (chem) chemistries.add(chem);
    references.add(referenceKey(entry));
    const verdict = qcVerdict(entry);
    if (verdict) verdicts.add(verdict);
    for (const tag of entry.tags ?? []) tags.add(tag);
    if (entry.folder) folders.add(entry.folder);
    kinds.add(entry.kind);
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return {
    chemistries: sorted(chemistries), references: sorted(references), verdicts: sorted(verdicts),
    tags: sorted(tags), folders: sorted(folders), kinds: [...kinds].sort(),
  };
}

export function referenceFilterLabel(key: string): string {
  if (key === 'plasmid') return 'Plasmids';
  if (key === 'unknown') return 'Other / unknown';
  return key.replace(/^genome:/, '');
}

export function chemistryFilterLabel(key: string): string {
  return CHEMISTRY_LABELS[key] ?? key;
}

export interface SuggestedGroup {
  key: string;
  name: string;
  description: string;
  entryIds: string[];
  source: 'folder' | 'run';
  /** A folder suggestion's folder (scanned on demand before Open / Save as group). */
  folder?: string;
  /** The folder was scanned: entryIds are every file it holds that the Library lists. */
  scanned?: boolean;
}

/**
 * Experiments the user may want to keep: each folder of BAMs, and each multi-sample run.
 * `scanned` (folder -> entry ids) is what an on-demand scan of a suggested folder found;
 * that folder's suggestion then covers those files too (BigBeds and maps included).
 */
export function suggestedGroups(
  entries: LibraryEntry[], groups: LibraryGroup[] = [], scanned: Record<string, string[]> = {},
): SuggestedGroup[] {
  const saved = new Set(groups.map(g => [...g.entry_ids].sort().join('|')));
  const byFolder = new Map<string, LibraryEntry[]>();
  const byRun = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== 'bam' || entry.role === 'aligned') continue;
    if (entry.job?.group) {
      const list = byRun.get(entry.job.group) ?? [];
      list.push(entry);
      byRun.set(entry.job.group, list);
    }
    const folder = entry.pipeline?.outdir && entry.job ? '' : entry.folder;
    if (folder) {
      const list = byFolder.get(folder) ?? [];
      list.push(entry);
      byFolder.set(folder, list);
    }
  }
  const out: SuggestedGroup[] = [];
  for (const [group, list] of byRun) {
    if (list.length < 2) continue;
    const finished = list.map(e => e.job?.finished_at ?? 0).filter(Boolean).sort()[0];
    const when = finished ? new Date(finished * 1000).toISOString().slice(0, 10) : '';
    out.push({
      key: `run:${group}`, source: 'run', entryIds: list.map(e => e.id),
      name: `DAF-seq run${when ? ` ${when}` : ''} (${list.length} samples)`,
      description: list.map(e => e.sample || e.label).join(', '),
    });
  }
  const listed = new Set(entries.map(e => e.id));
  for (const [folder, list] of byFolder) {
    const parts = folder.split(/[\\/]/).filter(Boolean);
    const found = (scanned[folder] ?? []).filter(id => listed.has(id));
    out.push({
      key: `folder:${folder}`, source: 'folder', entryIds: [...new Set([...found, ...list.map(e => e.id)])],
      name: parts.slice(-2).join('/') || folder,
      description: folder,
      folder,
      scanned: folder in scanned,
    });
  }
  return out
    .filter(s => !saved.has([...s.entryIds].sort().join('|')))
    .sort((a, b) => (a.source === b.source ? b.entryIds.length - a.entryIds.length || a.name.localeCompare(b.name) : a.source === 'run' ? -1 : 1));
}

/** Plasmid map entries a BAM entry is linked to (by sequence, header declaration or run). */
export function linkedMaps(entry: LibraryEntry, byId: Map<string, LibraryEntry>): LibraryEntry[] {
  return (entry.linked_maps ?? []).map(id => byId.get(id)).filter((e): e is LibraryEntry => Boolean(e && e.available));
}

export type OpenBlocker = 'unavailable' | 'cloud' | 'kind' | null;

export function openBlocker(entry: LibraryEntry): OpenBlocker {
  if (!entry.available) return 'unavailable';
  if (entry.cloud_only) return 'cloud';
  if (!['bam', 'bigbed', 'plasmid_map'].includes(entry.kind)) return 'kind';
  return null;
}

/** What the Library lists, in one sentence (the help text and the empty Library). */
export const LIBRARY_SCOPE_TEXT =
  'every BAM, BigBed or plasmid map you open from this computer or a connected cluster '
  + '(not the bundled demo, files dropped onto the window, or web links), the results of your '
  + 'DAF-seq runs, and the files in folders you watch';

/**
 * Why a file carries a re-run badge, in words: each FiberHMM advisory that
 * affects it (what went wrong, and the fix), so the badge explains itself.
 */
export function rerunExplanation(entry: LibraryEntry): string {
  if (!entry.rerun) return '';
  const items = (entry.advisories?.items ?? [])
    .filter(a => !a.severity || String(a.severity).startsWith('rerun') || entry.rerun === 'possible');
  const version = entry.advisories?.fiberhmm_version;
  const head = entry.rerun === 'rerun-required'
    ? 'Made by a FiberHMM version with a known problem that changes its results'
    : entry.rerun === 'possible'
      ? 'Possibly made by a FiberHMM version with a known problem'
      : 'Made by a FiberHMM version with a known problem fixed since';
  const lines = [`${head}${version ? ` (checked against FiberHMM ${version})` : ''}.`];
  for (const a of items) {
    const title = a.title || a.id;
    if (title) lines.push(`• ${title}${a.reason ? `: ${a.reason}` : ''}`);
    const fix = a.fix || a.fix_action;
    if (fix) lines.push(`  Fix: ${String(fix)}`);
  }
  lines.push('Open the Library for details and a one-click re-call.');
  return lines.join('\n');
}

/**
 * What a re-run advisory means for the user, in one line (usability round 3, R15: the Library's details pane led with
 * the long FiberHMM advisory text). Empty when there is nothing to re-run.
 */
export function rerunConsequence(entry: LibraryEntry): string {
  if (entry.rerun === 'rerun-required') return 'Opens as called, but a known FiberHMM problem changes its calls: re-call it before comparing results.';
  if (entry.rerun === 'rerun-recommended') return 'Opens as called; a re-call with the current FiberHMM is recommended (a known problem was fixed since).';
  if (entry.rerun === 'possible') return 'Opens as called; it may have been made by a FiberHMM version with a known problem.';
  return '';
}

/** The re-run reason in a few words (the sidebar's inline note). */
export function rerunSummary(entry: LibraryEntry): string {
  if (!entry.rerun) return '';
  const titles = (entry.advisories?.items ?? []).map(a => a.title || a.id).filter(Boolean) as string[];
  if (!titles.length) return 'made by an older FiberHMM';
  return titles.length === 1 ? titles[0] : `${titles[0]} (+${titles.length - 1} more)`;
}
