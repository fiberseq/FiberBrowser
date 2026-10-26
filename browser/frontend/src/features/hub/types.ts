/**
 * The feature hub's data model (native/feature_hub/DESIGN.md §5.2): one registry of feature types and sets that
 * every producer feeds — fiberhmm-scan modules (opened or run live), and the browser's own providers (Find classes
 * runs, NFR runs, SVs, peaks, live-lift Differences, graph bubbles). Mirrored by the scan manifest's
 * `feature_types` (FiberHMM `fiberhmm.scan.types.FeatureTypeDecl`) and the backend's `services/scan`.
 *
 * `FeatureRef` (stores/featureStore.ts) stays the selection token; a hit becomes a ref through its type's `kind`
 * (features/hub/kinds.ts).
 */

export type Granularity = 'mark' | 'scalar' | 'label' | 'hit' | 'state';

export interface ScoreDecl {
  name: string;
  label: string;
  kind: 'fraction' | 'count' | 'nats' | 'log2or' | 'q' | 'bp' | 'z' | 'code';
  better: 'high' | 'low' | 'none';
  perGroup: boolean;
}

/** What a feature type is: declared by a scan module (the manifest) or a browser provider. */
export interface FeatureTypeDecl {
  /** 'fp.class', 'nfr.region', 'nfr.variant', 'peaks.peak', 'var.sv', 'var.diff', 'graph.bubble', … */
  typeId: string;
  /** 'fp' | 'nfr' | 'nuc' | 'peaks' | 'browser:sv' | 'browser:diff' | 'browser:graph' | 'browser:peaks' | … */
  module: string;
  label: string;
  plural: string;
  provides: Granularity[];
  anchor: 'centre' | 'summit' | 'start' | 'boundary' | 'none';
  /** Insertion boundaries: `start === end` is the true interval. */
  zeroWidth: boolean;
  scores: ScoreDecl[];
  /** What 1 / 0 / . mean (shown in the hub). */
  stateRule?: string;
  transferableState?: boolean;
  /** The canonical score roles (§5.5): the score that is prevalence, and the one that is strength. */
  roles?: { prevalence?: string; strength?: string; q?: string };
}

export type Frame =
  | { kind: 'linear'; genome?: string; chrom: string }
  | { kind: 'source'; assembly: string; contig: string; hap?: string }
  | { kind: 'lifted'; liftKey: string; hap: string; chrom: string }
  | { kind: 'graph'; registration: string; revision: string; binding: string };

export interface Provenance {
  producer: 'fiberhmm-scan' | 'browser-scan' | 'browser';
  scanId?: string;
  module: string;
  moduleVersion?: string;
  settingsHash?: string;
  fiberhmmVersion?: string;
  /** content ids of the inputs (scans), or the browser dataset ids (browser providers). */
  inputs: string[];
  units: 'grid' | 'bed' | 'view' | 'regions' | 'none';
  createdAt?: string;
  /** "fiberhmm-scan 3.0.2 · fp 1.0 · 50/25 kb grid", for the provenance tooltip. */
  summary?: string;
}

/** A comparison column: a dataset (or the pool), a channel, a haplotype or a cluster. */
export interface GroupDecl {
  id: string;
  /** The browser dataset this column is about (absent: the pool, or a scan dataset no loaded dataset matches). */
  datasetId?: string;
  kind: 'all' | 'dataset' | 'channel' | 'haplotype' | 'cluster';
  label: string;
  panelStateKeys?: string[];
}

export type SetStatus = 'loading' | 'partial' | 'complete' | 'stale' | 'error';

/** One hub row group: a type from one producer run. */
export interface FeatureSet {
  /** `hub:<16 hex>` for scan sets (hash of type and provenance); `browser:<provider>:<…>` for browser providers. */
  setId: string;
  typeId: string;
  type: FeatureTypeDecl;
  provenance: Provenance;
  frame: Frame;
  /** Browser datasets the set is about. */
  datasets: string[];
  groups: GroupDecl[];
  /** Where absence means absence ("—" outside it: not scanned). */
  coverage: { territory: 'callable' | 'view' | 'regions' | 'units'; ref?: string };
  count?: number;
  status: SetStatus;
  /** Why the set is stale / read-only ("scan of other files", "the BAM changed since the scan"). */
  note?: string;
  source: { kind: 'scan'; scanId: string; module: string } | { kind: 'inline'; hits: FeatureHit[] } | { kind: 'provider'; provider: string };
}

export interface HitValue { v: number | null; lo?: number | null; hi?: number | null; n?: number | null; nCallable?: number | null }

export interface FeatureHit {
  hitId: string;
  setId: string;
  typeId: string;
  frame: Frame;
  chrom: string;
  start: number;
  end: number;
  anchor: number;
  strand?: '+' | '-';
  label?: string;
  /** Pooled scores by declared name (prevalence, support_gain_nats, score, tier, …). */
  scores: Record<string, number | null>;
  /** Per comparison column (group id) and score role (prevalence, strength): the value with its interval and counts. */
  values?: Record<string, Record<string, HitValue>>;
  /** Per-type detail for the row's expansion (module columns, raw per-group values). */
  detail?: Record<string, unknown>;
  flags?: string[];
  /**
   * The legacy selection identity, for sets backed by a legacy run (fp-class job/family per dataset, nfr run/element,
   * sv per dataset): what /api/features/states resolves for them, and what sessions keep (DESIGN §5.3).
   */
  legacyRefs?: import('../../stores/featureStore').FeatureRef[];
  /** Open in the owning panel. */
  link?: { panel: string; payload: unknown };
  aliases?: Array<{ frame: Frame; start: number; end: number; status: 'exact' | 'split' | 'partial' | 'unmapped' | 'absent' | 'unresolved' }>;
}

/** An anchor set ("Use as → anchors"): positions with strand and label, saved with the session. */
export interface AnchorSet {
  id: string;
  label: string;
  /** The sets the anchors came from. */
  sources: string[];
  createdAt: string;
  anchors: Array<{ chrom: string; pos: number; strand?: '+' | '-'; label?: string; hitId?: string; start?: number; end?: number }>;
}
