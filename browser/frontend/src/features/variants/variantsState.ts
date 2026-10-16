/**
 * The Variants panel's state.
 *
 * What it shows and found lives on its PanelConfig (`variants`), so undo, autosave and session files carry it: the
 * tab, the scan settings, the selected SNPs, and the last scan and combination results (trimmed: no read names; the
 * server re-reads those from its cache or the BAM). The full results of this session's scans are kept here too
 * (`useVariantsStore`), by scan key, for the SNP channel above the reads and the tabs.
 */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import {
  DEFAULT_SNP_PARAMS, type AlleleGrouping, type AlleleSource, type Snp, type SnpParams, type SnpScan,
} from './api';

export const VARIANTS_PANEL = 'variants';

export type VariantsTab = 'snps' | 'combos' | 'svs';
/** ('lens' was a tab until the insertion lens became its own panel: such a panel is migrated, insertion/register.) */
export const VARIANTS_TABS: VariantsTab[] = ['snps', 'combos', 'svs'];

export interface ComboOptions {
  source: AlleleSource;
  partial: boolean;
  /** Combinations below this fraction of the placed reads (and 3 reads) merge into "Other". */
  minFraction: number;
  autoPhase: boolean;
}

export const DEFAULT_COMBO_OPTIONS: ComboOptions = { source: 'selected', partial: false, minFraction: 0.02, autoPhase: true };

/** A combination result as a session keeps it: the groups, not the reads. */
export type SavedGrouping = Omit<AlleleGrouping, 'assignments'> & { request: ComboOptions & { snps: string[] } };

export interface VariantsPanelState {
  tab?: VariantsTab;
  /** The dataset scanned ('' or unset: the first BAM dataset shown). */
  datasetId?: string;
  params?: SnpParams;
  /** Scan the view when it changes (debounced, the previous scan cancelled). */
  autoScan?: boolean;
  /** Table: only calls that pass every filter (both strands, DAF-safe). */
  passingOnly?: boolean;
  selected?: string[];
  combo?: ComboOptions;
  /** Ask before a split opens more panels than this (default 8; never more than 16). */
  splitSoftLimit?: number;
  scan?: SnpScan;
  grouping?: SavedGrouping;
}

const MAX_SAVED_SNPS = 500;

/** A scan as the panel (and so the session) keeps it: at most 500 calls, those that pass first. */
export function trimScan(scan: SnpScan): SnpScan {
  if (scan.snps.length <= MAX_SAVED_SNPS) return scan;
  const passing = scan.snps.filter(s => s.passes);
  const kept = (passing.length >= MAX_SAVED_SNPS ? passing.slice(0, MAX_SAVED_SNPS)
    : [...passing, ...scan.snps.filter(s => !s.passes).slice(0, MAX_SAVED_SNPS - passing.length)])
    .sort((a, b) => a.pos - b.pos);
  return { ...scan, snps: kept };
}

export function saveGrouping(grouping: AlleleGrouping, request: ComboOptions & { snps: string[] }): SavedGrouping {
  const { assignments: _reads, ...rest } = grouping;
  return { ...rest, request };
}

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

export type NormalizedVariantsState = Required<Pick<VariantsPanelState, 'tab' | 'params' | 'autoScan' | 'passingOnly' | 'selected' | 'combo' | 'splitSoftLimit'>> & VariantsPanelState;

/** Panel state from a session or snapshot (any shape), with defaults. */
export function normalizeVariantsState(raw: unknown): NormalizedVariantsState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const p = (s.params && typeof s.params === 'object' ? s.params : {}) as Record<string, unknown>;
  const c = (s.combo && typeof s.combo === 'object' ? s.combo : {}) as Record<string, unknown>;
  const mode = p.mode === 'daf' || p.mode === 'basecall' ? p.mode : 'auto';
  const source = c.source === 'informative' || c.source === 'hp' ? c.source : 'selected';
  const scan = s.scan && typeof s.scan === 'object' && Array.isArray((s.scan as SnpScan).snps) ? s.scan as SnpScan : undefined;
  const grouping = s.grouping && typeof s.grouping === 'object' && Array.isArray((s.grouping as SavedGrouping).groups)
    ? s.grouping as SavedGrouping : undefined;
  return {
    tab: VARIANTS_TABS.includes(s.tab as VariantsTab) ? s.tab as VariantsTab : 'snps',
    datasetId: typeof s.datasetId === 'string' ? s.datasetId : undefined,
    params: {
      min_maf: num(p.min_maf, DEFAULT_SNP_PARAMS.min_maf, 0, 0.5),
      min_depth: Math.round(num(p.min_depth, DEFAULT_SNP_PARAMS.min_depth, 1, 1_000_000)),
      both_strands: typeof p.both_strands === 'boolean' ? p.both_strands : DEFAULT_SNP_PARAMS.both_strands,
      min_bq: Math.round(num(p.min_bq, DEFAULT_SNP_PARAMS.min_bq, 0, 93)),
      min_mapq: Math.round(num(p.min_mapq, DEFAULT_SNP_PARAMS.min_mapq, 0, 255)),
      mode,
    },
    autoScan: typeof s.autoScan === 'boolean' ? s.autoScan : true,
    passingOnly: typeof s.passingOnly === 'boolean' ? s.passingOnly : true,
    selected: Array.isArray(s.selected) ? s.selected.filter((x): x is string => typeof x === 'string') : [],
    combo: {
      source,
      partial: typeof c.partial === 'boolean' ? c.partial : DEFAULT_COMBO_OPTIONS.partial,
      minFraction: num(c.minFraction, DEFAULT_COMBO_OPTIONS.minFraction, 0, 0.5),
      autoPhase: typeof c.autoPhase === 'boolean' ? c.autoPhase : DEFAULT_COMBO_OPTIONS.autoPhase,
    },
    splitSoftLimit: Math.round(num(s.splitSoftLimit, 8, 1, 16)),
    ...(scan ? { scan } : {}),
    ...(grouping ? { grouping } : {}),
  };
}

export function variantsPanelState(): VariantsPanelState | undefined {
  return useBrowserStore.getState().panels.find(p => p.contentType === VARIANTS_PANEL)?.variants;
}

export function useVariantsPanelState(): VariantsPanelState | undefined {
  return useBrowserStore(s => s.panels.find(p => p.contentType === VARIANTS_PANEL)?.variants);
}

/** Merge into the Variants panel's state (no undo step of its own: a scan is not an edit). */
export function updateVariantsState(patch: Partial<VariantsPanelState>): void {
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.contentType === VARIANTS_PANEL ? { ...p, variants: { ...(p.variants ?? {}), ...patch } } : p)),
  }));
}

/** Plain click: this SNP alone (again: none); shift / ctrl / cmd: toggle it in the selection. */
export function nextSnpSelection(selected: readonly string[], id: string, additive: boolean): string[] {
  if (additive) return selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
  return selected.length === 1 && selected[0] === id ? [] : [id];
}

/**
 * The SNP table's click (audit VAR-5): plain = this one alone (again: none), Cmd/Ctrl = add or remove it, Shift = the
 * range from the last clicked row (`anchor`) to this one, in the table's order, added to the selection.
 */
export function tableSnpSelection(selected: readonly string[], id: string, mode: 'single' | 'add' | 'range',
  order: readonly string[], anchor: string | null): string[] {
  if (mode === 'add') return nextSnpSelection(selected, id, true);
  if (mode === 'range') {
    const a = anchor ? order.indexOf(anchor) : -1;
    const b = order.indexOf(id);
    if (a < 0 || b < 0) return nextSnpSelection(selected, id, true);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return [...selected, ...range.filter(x => !selected.includes(x))];
  }
  return nextSnpSelection(selected, id, false);
}

export function selectSnp(id: string, additive: boolean): void {
  const state = variantsPanelState();
  if (!state && !useBrowserStore.getState().panels.some(p => p.contentType === VARIANTS_PANEL)) {
    useBrowserStore.getState().openAnalysisPanel(VARIANTS_PANEL);
  }
  updateVariantsState({ selected: nextSnpSelection(variantsPanelState()?.selected ?? [], id, additive) });
}

// ---------------------------------------------------------------------------- this session's scans

interface VariantsStore {
  /** Full scans by scan key (the panel keeps a trimmed copy). */
  scans: Record<string, SnpScan>;
  /**
   * The latest scan per dataset (the SNP channel draws it). A scan of a panel's subset of the reads (a split panel's,
   * a filtered one's) is that panel's, under "<dataset>|<panel state key>": it does not hide the dataset's scan in the
   * other panels (a split panel's scan has no SNP at the SNP it was split by).
   */
  latest: Record<string, string>;
  /** A scan running for a dataset (its view), for the channel's and panel's status. */
  scanning: Record<string, boolean>;
  hovered: string | null;
  putScan: (scan: SnpScan) => void;
  setScanning: (datasetId: string, on: boolean) => void;
  setHovered: (id: string | null) => void;
}

const MAX_SCANS = 8;

export const useVariantsStore = create<VariantsStore>(set => ({
  scans: {},
  latest: {},
  scanning: {},
  hovered: null,
  putScan: scan => set(s => {
    const scans = { ...s.scans, [scan.scan_key]: scan };
    const keys = Object.keys(scans);
    if (keys.length > MAX_SCANS) for (const k of keys.slice(0, keys.length - MAX_SCANS)) delete scans[k];
    return { scans, latest: { ...s.latest, [latestKey(scan.dataset_id, scan.target?.readIds ? scan.target.panelKey : undefined)]: scan.scan_key } };
  }),
  setScanning: (datasetId, on) => set(s => ({ scanning: { ...s.scanning, [datasetId]: on } })),
  setHovered: id => set(s => (s.hovered === id ? s : { hovered: id })),
}));

/** The `latest` key of a dataset's scan, or of a panel's scan of some of its reads. */
export function latestKey(datasetId: string, panelKey?: string): string {
  return panelKey ? `${datasetId}|${panelKey}` : datasetId;
}

/**
 * The scan the channel and the tabs show for a dataset: this session's latest, else the one the panel kept. A
 * channel passes its panel's state key: that panel's own subset scan first, and another panel's subset scan never.
 */
export function scanFor(datasetId: string | null | undefined, store: Pick<VariantsStore, 'scans' | 'latest'>,
  panel: VariantsPanelState | undefined, panelKey?: string): SnpScan | null {
  if (!datasetId) return null;
  const own = panelKey ? store.latest[latestKey(datasetId, panelKey)] : undefined;
  if (own && store.scans[own]) return store.scans[own];
  const key = store.latest[datasetId];
  if (key && store.scans[key]) return store.scans[key];
  const kept = panel?.scan && panel.scan.dataset_id === datasetId ? panel.scan : null;
  if (kept && panelKey !== undefined && kept.target?.readIds && kept.target.panelKey !== panelKey) return null;
  return kept;
}

/** The SNPs a table or channel shows: passing ones (both strands, DAF-safe) unless all are asked for. */
export function shownSnps(scan: SnpScan | null, passingOnly: boolean): Snp[] {
  if (!scan) return [];
  return passingOnly ? scan.snps.filter(s => s.passes) : scan.snps;
}

/** "chr2L:9,463,438 A>G" (1-based, as the browser shows positions). */
export function snpLabel(snp: Pick<Snp, 'pos' | 'kind' | 'ref' | 'alleles' | 'alt' | 'length'>, chrom?: string): string {
  const where = `${chrom ? `${chrom}:` : ''}${(snp.pos + 1).toLocaleString()}`;
  return `${where} ${snpChange(snp)}`;
}

export function snpChange(snp: Pick<Snp, 'kind' | 'ref' | 'alleles' | 'alt' | 'length'>): string {
  if (snp.kind === 'ins') return `ins ${snp.length} bp`;
  if (snp.kind === 'del') return `del ${snp.length} bp`;
  if (snp.ref && snp.alleles.includes(snp.ref)) return `${snp.ref}>${snp.alt}`;
  if (snp.ref) return `${snp.ref}>${snp.alleles[0]}/${snp.alleles[1]}`;
  return `${snp.alleles[0]}/${snp.alleles[1]}`;
}
