// Core geometry types
export interface Region {
  chrom: string;
  start: number;
  end: number;
}

export interface Interval {
  start: number;
  end: number;
  name?: string;
  strand?: string;
  score?: number;
  blocks?: { start: number; size: number }[];
  cdsStart?: number;
  cdsEnd?: number;
}

export interface ChromInfo {
  name: string;
  size: number;
  circular?: boolean;
  circular_source?: string | null;
  plasmid?: boolean;  // a loaded plasmid map (circular or linear)
}

export interface Gene {
  id: string;
  name: string | null;
  chrom: string;
  start: number;
  end: number;
  strand: string;
  biotype: string;
  exons: Interval[];
}

export interface MatchedRegionInfo {
  correspondenceId?: string;
  memberSpecific?: boolean;
  template?: boolean;
  groupId: string;
  wrapsOrigin?: boolean;
  sourceRegion?: { chrom: string; genome?: string; start: number; end: number };
  label: string;
  reversed: boolean;
  length: number;
  blocks: { frame: [number, number]; genomic: [number, number] }[];
  panelId?: string;
  datasetId?: string;
  copy?: string;
}

export interface FirePeak {
  /** Stable hub identity; legacy index is dual-written for older builds. */
  hitId?: string;
  graph?: Record<string, unknown>;
  /** The accepted map used to call a pooled peak, before projecting its copies. */
  correspondenceId?: string;
  memberPanelId?: string;
  featureIndex?: number;
  featureMode?: string;
  match?: MatchedRegionInfo;
  /** Absolute genomic coordinates. Backend cluster inputs convert these to viewport-relative coordinates. */
  start: number;
  end: number;
  index: number;
  layer?: number;
  score?: number;  // Max accessibility at peak
  threshold?: number;  // Threshold level used to detect this peak
  width?: number;  // Peak width in bp
  isCustom?: boolean;  // User-drawn peak
  chrom?: string;  // Chromosome this peak belongs to (for cross-chrom split view)
  sourceLabel?: string;  // Signal source label (e.g. "H3K27ac", "Nuc profile")
  sourceColor?: string;  // Display color for signal-detected peaks
  ruleId?: string;       // Which PeakRule detected this peak
  /** Scanned in a panel on another assembly (its reference's key, PanelConfig.genome): shown only there. */
  genome?: string;
}

// API response types
export interface MetaResponse {
  nucleosome_profile: number[];
  subnuc_profile: number[];
}

export interface GenesResponse {
  genes: Gene[];
}

export interface FireResponse {
  peaks: FirePeak[];
  signal: number[];
  type?: 'fire' | 'accessibility' | 'none';
}

export interface ClusterPreparationSample {
  dataset_id?: string;
  result_key?: string;
  sample_seed: string;
  method: string;
  chrom: string;
  start: number;
  end: number;
  target_names: number;
  selected_names: number;
  total_alignments: number;
  prepared_reads: number;
  used: number;
  fingerprint: string;
}

export interface ClusterResponse {
  cohort?: { records: number; supplementary_rows: number; folded: boolean; excluded_alt: number; alternative_rows: number; hap?: string | null; rows: number; scope?: string };
  assignments: Record<string, number>;
  cluster_counts: Record<number, number>;
  filtered_read_ids: string[];
  performance_sampling?: { used: number; total: number };
  preparation_sampling?: ClusterPreparationSample;
}

export interface GeneSearchResponse {
  found: boolean;
  chrom?: string;
  start?: number;
  end?: number;
  gene_name?: string;
  /** Transcription start site (search results). */
  tss?: number;
  strand?: string;
  suggestions?: string[];
  message?: string;
}

export type SortMode = 'position' | 'cluster' | 'length';
export type FilterMode = 'either' | 'open' | 'closed';

// Per-peak clustering modes
// - accessibility: Binary open/closed based on thresholds (works with combinatorial and other methods)
// - tf: Cluster on actual subnucleosomal footprint sizes for TF binding patterns (k-means only)
// - modification: Binary m6A methylation density (works with all methods)
// Click: toggle on/off. Shift+click: cycle modes (accessibility -> tf -> modification)
/** Clustering feature extraction mode per peak.
 * Legacy modes operate on primary intervals with size heuristics.
 * v3 layer modes (fire, tf_layer, nuc_layer) read from named annotation layers.
 */
/** Clustering/sorting feature-extraction mode.
 *
 * Well-known modes map to canonical data sources in the backend with a
 * layer-first / legacy-fallback policy (see extract_features_from_compact):
 *   mod/modification — methylation
 *   accessibility/fire — layers.fire ∪ legacy layers.msp ∪ read.fire ∪ inverted-nuc gaps
 *   tf/tf_layer      — layers.tf ∪ small primary footprints
 *   nuc/nuc_layer    — layers.nuc ∪ large primary footprints
 *   annotation       — external annotation tracks
 *   <custom layer>   — layers[name] for arbitrary MA-declared types
 */
export type PeakMode =
  | 'accessibility' | 'tf' | 'modification' | 'mod' | 'fire' | 'annotation'
  | 'msp' | 'tf_layer' | 'nuc_layer' | 'nuc'
  | (string & {});

// --- Colormap types ---

export interface OverlapCondition {
  target: 'gene' | 'peak' | 'track' | 'motif' | 'region';
  geneId?: string;          // Optional transcript/gene id for a specific gene condition
  geneName?: string | null; // Display/cache fallback for exported rule JSON
  minPeakLayer?: number;    // 0=Strong, 1=Medium, 2=Weak, 3=Rare
  trackId?: string;         // ID of loaded orthogonal track
  trackThreshold?: number;  // Coverage/percentile threshold
  regionChrom?: string;     // Fixed genomic region condition, used by command/planned labeling rules
  regionStart?: number;
  regionEnd?: number;
  regionLabel?: string;
  negate?: boolean;         // true = "NOT overlapping"
}

/** Rule gate on a quality dimension carried by the layer (aq, tq, nq, lq, rq, mq).
 *  Values are stored byte-encoded (0-255) matching the BAM tags. A threshold
 *  of 230 corresponds to the published FIRE precision cutoff of ~0.9. */
export interface QualityGate {
  /** Quality dimension name as it appears in the layer's `quality_names`
   *  (e.g. 'aq' for FIRE accessibility, 'tq' for TF significance,
   *  'lq'/'rq' for nucleosome left/right edge confidence, 'nq' for nucleosome
   *  call confidence, 'mq' for modification probability). */
  qualityName: string;
  /** Minimum byte-scale value the quality must meet (inclusive). */
  minValue: number;
  /** Optional maximum (inclusive). Rare — useful for band-pass gates like
   *  "only medium-confidence calls". Null = no upper cap. */
  maxValue?: number | null;
}

export type ColorRuleColorMode = 'solid' | 'size_gradient';
export type ColorRuleGradientScale = 'linear' | 'sqrt' | 'log' | 'square';

export interface ColorRuleGradient {
  startColor: string;
  endColor: string;
  /** Size where the gradient starts. Smaller matching footprints clamp to startColor. */
  sizeMin?: number | null;
  /** Size where the gradient ends. Larger matching footprints clamp to endColor. */
  sizeMax?: number | null;
  scale: ColorRuleGradientScale;
}

export interface ColorRule {
  id: string;               // UUID for drag reorder stability
  name: string;             // User-visible name ("Nucleosome", "TF", etc.)
  color: string;            // Hex color "#33a040"
  colorMode?: ColorRuleColorMode;
  gradient?: ColorRuleGradient;
  opacity?: number;          // Visual opacity, 0-1. 0 hides matching footprints without disabling the rule.
  sizeMin: number;          // Min footprint size (inclusive)
  sizeMax: number | null;   // Max footprint size (inclusive), null = no limit
  targetLayers: string[];   // Annotation layers this rule applies to (e.g. ['tf']). Empty = all layers.
  conditions: OverlapCondition[];  // AND logic — all must match
  /** Optional per-interval quality gates. ALL gates must pass for the rule
   *  to match. Evaluated against the layer's quality_names/qualities arrays
   *  at the interval's position. Primary use: FIRE where aq >= 230. */
  qualityGates?: QualityGate[];
  /** If true, match only layer intervals carrying a non-empty AN name. */
  requireAnnotationName?: boolean;
  /**
   * Nucleosome size conditions (native/nucleosome_panel/DESIGN.md §5.4, §7.1): a nuc/tf item matches through the
   * read's `nucsz` mark for it (CONTRACTS §11.3). All set conditions must hold; an item without a mark never matches
   * a rule that sets one.
   * - `nucCoarse`: coarse codes (nucsz Q1 low 4 bits: 0 can't tell, 1 short, 2 mono, 3 long, 4 multi(2),
   *   5 multi(3+), 6 edge-truncated); empty or absent: any.
   * - `nucNamed`: named codes (nucsz Q2: 1 small, 2 hexasome, 3 octasome, 4 chromatosome; absolute calibration only).
   * - `zMin` / `zMax`: the density-matched z range (Q4 = 20 z + 128; 255 = missing, which never matches).
   * - `nucTf`: true only TF calls (or footprints overlapping one: Q1 bit 16), false only nucleosome calls.
   */
  nucCoarse?: number[];
  nucNamed?: number[];
  zMin?: number | null;
  zMax?: number | null;
  nucTf?: boolean | null;
  enabled: boolean;
}

export const CLUSTER_RULE_MODE_PREFIX = 'cluster_rule:';

export type ClusterFeatureRuleTermSource = 'layer' | 'label_rule' | 'footprint_group' | 'footprint_class' | 'transcription_state'
  | 'molecule_metric' | 'feature_hub';
export type TranscriptionStateRuleKind = 'pause' | 'pic' | 'elongating';

export type AnalysisRulePeakScope = 'selectedPeaks' | 'allPeaks';
export type AnalysisRuleGenePart = 'full' | 'tss' | 'geneBody' | 'exon' | 'intron';
export type AnalysisRuleScopeKind =
  | AnalysisRulePeakScope
  | 'currentWindow'
  | 'gene'
  | 'transcript'
  | 'customRegion';

export interface AnalysisRuleScope {
  kind: AnalysisRuleScopeKind;
  /** Optional score/level gates for discretized peak layers. 0=strong, 3=rare. */
  peakLevelMin?: number | null;
  peakLevelMax?: number | null;
  geneId?: string | null;
  geneName?: string | null;
  genePart?: AnalysisRuleGenePart;
  transcriptId?: string | null;
  transcriptName?: string | null;
  region?: Region | null;
  regionLabel?: string | null;
}

export interface ClusterFeatureRuleTerm {
  id: string;
  source: ClusterFeatureRuleTermSource;
  /** Direct layer source. null means primary footprint intervals. */
  layer?: string | null;
  sizeMin?: number;
  sizeMax?: number | null;
  qualityGates?: QualityGate[];
  /** Snapshot reference to a labeling rule. The snapshot keeps clustering
   * reproducible even if the labeling preset changes later. */
  labelRuleId?: string;
  labelRuleName?: string;
  rule?: ColorRule;
  /** Snapshot reference to a Footprint Analysis cart entry. */
  footprintGroupId?: string;
  footprintGroupName?: string;
  group?: FootprintGroup;
  /** Built-in Pol II state source, matching the Transcription panel definitions. */
  transcriptionState?: TranscriptionStateRuleKind;
  /** `molecule_metric`: a per-molecule scalar ('nuc.nrl', 'nuc.regularity', 'nfr.openness', ...: the scan
   * modules' scalar groups nucmol / nfrmol, browser/services/nuc/scalars.py). Missing values never pass. */
  moleculeMetric?: string;
  /** `feature_hub`: the hub hits the term reads per-read states at (a snapshot of the selection), and the state
   * that counts ('1' member / open, '0' not; '.' never counts). */
  hubHits?: Array<{ setId: string; hitId: string; chrom: string; start: number; end: number; label?: string }>;
  hubState?: '1' | '0';
}

export interface ClusterFeatureRule {
  id: string;
  name: string;
  /** Suggested short dropdown label. Used until the user edits `name`. */
  autoName?: string;
  /** False keeps `name` synced to `autoName` as source/scope changes. */
  nameEdited?: boolean;
  enabled: boolean;
  /** Region/peak scope where this feature rule is evaluated for clustering. */
  scope?: AnalysisRuleScope;
  /** Terms are combined with OR logic: any matching term contributes signal. */
  terms: ClusterFeatureRuleTerm[];
}

export interface ClusterFeatureRuleSet {
  name: string;
  rules: ClusterFeatureRule[];
  savedAt?: number;
}

/** `value`: a molecule_metric term's scalar itself (missing values sort last and never pass a filter). */
export type AnalysisSortMetric = 'count' | 'occupancy' | 'rate' | 'accessibility' | 'value';

export interface AnalysisSortRule {
  id: string;
  name: string;
  autoName?: string;
  nameEdited?: boolean;
  enabled: boolean;
  scope?: AnalysisRuleScope;
  /** Current UI/backend execution uses one source term; keep as an array for preset compatibility. */
  terms: ClusterFeatureRuleTerm[];
  metric: AnalysisSortMetric;
  descending: boolean;
}

export interface AnalysisSortRuleSet {
  name: string;
  rules: AnalysisSortRule[];
  savedAt?: number;
}

export type AnalysisFilterMetric = AnalysisSortMetric;
/** `between`: threshold <= value <= thresholdMax (both inclusive). */
export type AnalysisFilterOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'between';

export interface AnalysisFilterRule {
  id: string;
  name: string;
  autoName?: string;
  nameEdited?: boolean;
  enabled: boolean;
  scope?: AnalysisRuleScope;
  /** Current UI/backend execution uses one source term; keep as an array for preset compatibility. */
  terms: ClusterFeatureRuleTerm[];
  metric: AnalysisFilterMetric;
  operator: AnalysisFilterOperator;
  threshold: number;
  /** The upper bound of `between`. */
  thresholdMax?: number | null;
  /** 'and': keep only reads that also pass the panel's current filter (rules combined with AND). */
  combine?: 'replace' | 'and';
}

export interface AnalysisFilterRuleSet {
  name: string;
  rules: AnalysisFilterRule[];
  savedAt?: number;
}

export interface ColormapQualityShading {
  enabled: boolean;
  mode: 'quality' | 'overlap_count';
  vizMode: 'opacity' | 'border' | 'both';
  invert: boolean;          // true = highlight weak/low-quality
  minOpacity: number;       // e.g. 0.2
  maxOpacity: number;       // e.g. 1.0
}

/** TF footprint overlay rendering */
export interface TfOverlayConfig {
  enabled: boolean;
  color: string;            // base TF color
  minOpacity: number;       // tq=0 opacity
  maxOpacity: number;       // tq=255 opacity
  minTq: number;            // hide TFs below this tq
}

export type LayerOpacityMap = Record<string, number>;

/** Global edge-ambiguity rendering for footprints carrying edge-sharpness
 *  scores (el/er for TF, lq/rq for nuc). The MA interval is the conservative
 *  span; the true boundary may extend outward by `maxGapBp·(1 − edge/255)` bp.
 *  - soft:   draw conservative span, feather each end by its edge confidence
 *  - strict: draw conservative span with crisp edges (ignore el/er geometry)
 *  - loose:  extend each edge outward to the liberal boundary, crisp at the end
 *  edge==0 is the "edge unknown / ≥maxGapBp" sentinel (legacy/HMM-only). */
export interface EdgeAmbiguityConfig {
  mode: 'soft' | 'strict' | 'loose';
  applyNuc: boolean;        // apply to nucleosome edges
  applyTf: boolean;         // apply to TF footprint edges
  maxGapBp: number;         // bp window el/er encode; default 30
}

export interface DisplaySmoothingConfig {
  enabled: boolean;
  sigmaX: number;            // horizontal Gaussian sigma in screen pixels
  sigmaY: number;            // vertical Gaussian sigma in screen pixels
}

/** Per-layer quality filter — applied at working-set level, affects all analytics */
export interface LayerQualityFilter {
  layer: string;            // 'nuc', 'tf', 'fire', '*' for all
  qualityName: string;      // 'nq', 'tq', etc.
  minValue: number;         // 0-255 threshold
  enabled: boolean;
}

export interface Colormap {
  name: string;
  rules: ColorRule[];
  /** @deprecated use noReadBackgroundColor. Kept so older saved sessions/presets migrate cleanly. */
  backgroundColor?: string;
  readBackgroundColor?: string;
  noReadBackgroundColor?: string;
  qualityShading: ColormapQualityShading;
  tfOverlay: TfOverlayConfig;
  layerOpacities: LayerOpacityMap;
  /** Opacity for intervals that do not match a labeling/cart rule. Set a layer
   *  to 0 to show only rule-matched intervals for that layer. */
  layerBackgroundOpacities: LayerOpacityMap;
  displaySmoothing: DisplaySmoothingConfig;
  qualityFilters: LayerQualityFilter[];
  edgeAmbiguity: EdgeAmbiguityConfig;
}

export const DEFAULT_COLORMAP: Colormap = {
  name: 'Default',
  backgroundColor: '#ffffff',
  readBackgroundColor: '#f1f5f9',
  noReadBackgroundColor: '#ffffff',
  rules: [
    {
      id: 'pol2',
      name: 'Pol II',
      color: '#ff69b4',
      opacity: 1,
      sizeMin: 35,
      sizeMax: 65,
      targetLayers: [],
      conditions: [{ target: 'gene' }],
      enabled: true,
    },
    {
      id: 'tf',
      name: 'TF',
      color: '#87ceeb',
      opacity: 1,
      sizeMin: 1,
      sizeMax: 89,
      targetLayers: [],
      conditions: [{ target: 'peak', minPeakLayer: 1 }, { target: 'gene', negate: true }],
      enabled: true,
    },
    {
      id: 'subnuc',
      name: 'Subnucleosome',
      color: '#9ca3af',
      opacity: 1,
      sizeMin: 1,
      sizeMax: 89,
      targetLayers: ['tf'],
      conditions: [],
      enabled: true,
    },
    {
      // FIRE intervals whose `aq` precision score clears the published ~0.9
      // threshold. Older files store these under the internal `msp` key; the
      // rule matcher aliases FIRE -> msp so the UI never has to expose MSP.
      id: 'fire',
      name: 'Accessibility',
      color: '#ea580c',        // orange (existing FIRE color)
      opacity: 1,
      sizeMin: 1,
      sizeMax: null,
      targetLayers: ['fire'],
      conditions: [],
      qualityGates: [{ qualityName: 'aq', minValue: 230 }],  // 0.9 × 255
      enabled: true,
    },
    {
      id: 'nuc',
      name: 'Nucleosome',
      color: '#33a040',
      opacity: 1,
      sizeMin: 90,
      sizeMax: null,
      targetLayers: [],
      conditions: [],
      enabled: true,
    },
  ],
  qualityShading: {
    enabled: false,
    mode: 'quality',
    vizMode: 'opacity',
    invert: false,
    minOpacity: 0.2,
    maxOpacity: 1.0,
  },
  tfOverlay: {
    enabled: true,
    color: '#e040fb',            // fuchsia (HMM-called TF footprints)
    minOpacity: 0.2,
    maxOpacity: 0.85,
    minTq: 0,                    // show all TFs by default
  },
  layerOpacities: {
    nuc: 1.0,
    tf: 0.9,
    nuc_sr: 0.9,
    tf_sr: 0.9,
    fire: 0.55,
  },
  layerBackgroundOpacities: {
    nuc: 1.0,
    tf: 1.0,
    nuc_sr: 1.0,
    tf_sr: 1.0,
    fire: 1.0,
  },
  displaySmoothing: {
    enabled: false,
    sigmaX: 0,
    sigmaY: 0,
  },
  qualityFilters: [
    { layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true },
  ],
  edgeAmbiguity: {
    mode: 'strict',
    applyNuc: true,
    applyTf: true,
    maxGapBp: 30,
  },
};

// --- Panel types ---

export type SubTrackType =
  | 'axis' | 'meta' | 'fire' | 'reads' | 'sequence' | 'gene'
  | 'microc' | 'coacc' | 'capture' | 'primer' | 'consensus'
  /** The SV summary (fb-n9-sv) and the coverage histogram: their own rows above the reads (fb-n11-tracks). */
  | 'sv' | 'coverage'
  /** Rows plugin packs add (components/tracks/trackRenderers.ts): a pack augments PackSubTrackTypes with its types. */
  | Extract<keyof PackSubTrackTypes, string>
  | `ortho-${number}` | `composite-${string}`;

/** Row types plugin packs add: a pack augments this interface (`declare module`) with its types as keys. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PackSubTrackTypes {}

export interface SubTrackConfig {
  type: SubTrackType;
  visible: boolean;
  heightOverride?: number;  // overrides default height constant (clamped to the kind's limits, components/tracks/trackRegistry)
  /** Deleted from this panel (keeps its place; "Tracks in this panel" restores it). `visible: false` is minimized. */
  removed?: boolean;
  /** Folded to its header (rows that offer it: a plugin pack's channels). */
  collapsed?: boolean;
}

export type PanelLayout = 'row' | 'column';  // DEPRECATED: use layoutRow instead

export type BuiltinPanelContentType = 'dataset' | 'dataset-layout' | 'colormap' | 'cluster-detail' | 'cluster-features' | 'transcription-state' | 'footprint-analysis' | 'contact-map' | 'read-stats' | 'primer-design' | 'history' | 'track-browser' | 'co-accessibility' | 'annotations' | 'capture' | 'peak-detection';
export type PanelContentType = BuiltinPanelContentType | (string & {});

export interface SelectedFootprint {
  readId: string;
  datasetId: string;
  intervalIndex: number;
  relStart: number;       // region-relative
  relEnd: number;
  size: number;           // footprint size (always > 0)
  absStart: number;       // absolute genomic
  absEnd: number;
  chrom: string;
  /** State key of the panel it was picked in (a copy at another locus has its own). */
  stateKey?: string;
  /** Reference and display direction at the point of selection. */
  genome?: string | null;
  reversed?: boolean;
  /** Source layer: 'nuc' / 'tf' / 'fire' / custom layer name, or null when
   *  the click landed on a primary-intervals footprint without a v3 layer. */
  layer?: string | null;
  /** Local consensus-state slot (`tf_consensus`, or producer-native `tf_sr`, quality dimension `fi`). */
  familyId?: number | null;
  familyAnnotationName?: string | null;
  /** Producer-declared family score on [0,1] (`fq/255`, or `xq/255` for XCR). */
  familyConfidence?: number | null;
  /** Calibration of `familyConfidence`; XCR support and named latent support are distinct from local assignment confidence. */
  familyConfidenceKind?: 'assignment' | 'cross-support' | 'latent-support' | 'unavailable' | null;
}

/** A saved lattice-recaller class: its own id, the run it came from and that run's numbers for it. */
export interface SavedClassInfo {
  id: string;                       // 'S3'
  family: string;                   // the class in its run ('class_011')
  className: string;                // its name there ('Class 11')
  runLabel: string;                 // 'run 2 · stringency 0.90'
  /** The region its run analysed ('chr19:47,518,060–47,518,500 · 440 bp · the selected peak'); absent for older saves. */
  analysedRegion?: string;
  start: number; end: number;
  /** Every channel the class was quantified on in its run, and the ones picked for this definition. */
  channels: { source?: NonNullable<import('../api/consensusWorkflow').ConsensusCatalog['region_sources']>[string]; key: string; datasetId: string; strand: string; label: string; daf: boolean }[];
  stats: Record<string, import('../api/consensusWorkflow').RecallerStrand>;
  picked: string[];
}

/** A persistent "cart" entry that defines a footprint pattern. Drives:
 *   - read-track coloring (via the same render path as ColorRule)
 *   - cluster-style read filtering by occupancy
 *   - co-occupancy + per-group metaprofile / V-plot in the analysis panel
 *
 *  Persists across viewport changes and saves with the session.
 */
export interface FootprintGroup {
  id: string;             // UUID
  name: string;           // user-editable, e.g. "TF footprints", "Pol II"
  /** Name was generated from the size range; it follows edits until the user renames it. */
  autoName?: boolean;
  color: string;          // user-editable hex color for canvas highlighting + rendering
  /** Layer the group's footprints come from (e.g. 'tf', 'nuc', 'fire', custom).
   *  null = primary intervals (legacy size-based behavior). */
  layer?: string | null;
  /** Exact local TF-family slot. Genomic reference bounds disambiguate reused IDs. */
  familyId?: number | null;
  /** Stable string identity for a population-state workflow result. */
  consensusStateId?: string | null;
  consensusJobId?: string | null;
  /** The stage the class was found in; its reads come from that stage, whichever is being looked at. */
  consensusStage?: string | null;
  /** A lattice-recaller class saved for one DAF strand only ('CT' or 'GA'); null = every molecule of the dataset. */
  consensusStrand?: 'CT' | 'GA' | null;
  /** A lattice-recaller class saved at a looser tier: + one edge ('edge') or any overlapping shape ('loose'); null = strict. */
  consensusTier?: string | null;
  /** A lattice-recaller class saved as its own definition (S1, S2, ...): one entry per picked dataset/strand, all
   *  sharing this record, which keeps the class's numbers from its run so runs can be compared. */
  savedClass?: SavedClassInfo | null;
  familyAnnotationName?: string | null;
  /** Optional minimum conditional assignment confidence on [0,1]. Latent
   *  identity scores are deliberately excluded from this gate. */
  minFamilyConfidence?: number;
  /** How family calls are drawn. `both` paints the assigned molecular call
   * and outlines the shared frozen family boundary. */
  familyBoundaryMode?: 'molecule' | 'both' | 'family';
  /** Robust family-model boundary inferred from assigned calls in this view.
   *  Kept separate from referenceAbs* (the full observation hull used to
   *  disambiguate a reused uint8 family ID). */
  familyModelAbsStart?: number | null;
  familyModelAbsEnd?: number | null;
  /** Browser-generated family-in-view entries are replaced as their viewport changes. */
  autoGeneratedFamily?: boolean;
  sourceDatasetId?: string | null;
  consensusDatasetId?: string | null;
  /** Per-panel source key; prevents duplicate views of one dataset replacing each other. */
  sourceViewKey?: string | null;
  sizeMin: number;        // Min footprint size (inclusive), 0 = no lower bound
  sizeMax: number | null; // Max footprint size (inclusive), null = no upper bound
  /** Optional reference footprint used for the original group definition
   *  (clicked footprint that seeded this group). null means "match anywhere".
   *  Coords are absolute genomic. */
  referenceAbsStart?: number | null;
  referenceAbsEnd?: number | null;
  /** Chromosome of the reference position (absent in older saved rules). */
  referenceChrom?: string | null;
  referenceGenome?: string | null;
  referenceReversed?: boolean;
  /** Two independent coverage thresholds, both 0..1.
   *   minFpCoverage     = fraction of the read's footprint that must lie
   *                       inside the target (1.0 → footprint fully inside).
   *   minTargetCoverage = fraction of the target covered by the footprint
   *                       (1.0 → target fully covered by footprint).
   *   Both 0 → any overlap counts. Both 1.0 → exact match.
   *   Replaces the legacy overlapMode enum + reciprocal overlapFraction;
   *   backend maps old sessions forward. */
  minFpCoverage?: number;
  minTargetCoverage?: number;
  /** @deprecated — legacy fields kept on the type so loaded sessions
   *   round-trip. Use minFpCoverage / minTargetCoverage instead. */
  overlapMode?: 'any' | 'contains_target' | 'contained_by_target' | 'fraction';
  overlapFraction: number;
  /** Multi-condition matching adopted from ColorRule — gene/peak/track/motif
   *  overlap conditions. Empty means no extra conditions (size + layer only). */
  conditions?: OverlapCondition[];
  enabled: boolean;
  /** Index into selectedFootprints when the group was seeded from a click.
   *  Set to -1 for groups defined without a current selection (cart entries
   *  loaded from storage / created manually). */
  sourceIndex: number;
}

/**
 * How a "Split into panels" panel's reads are chosen (utils/splitPanels.ts): a membership rule (a grouping and the
 * groups this panel shows), resolved again on a session reopen; `frozen` keeps the read names (an SV allele split,
 * whose groups belong to one view). Plugin packs' sources add their own fields (ReadSubsetRule is augmented).
 */
export interface ReadSubsetRule {
  liftHap?: string;
  svEvidenceLevels?: Record<string, 'confirmed' | 'putative' | 'conflicting' | 'ambiguous'>;
  /** patterns, frozen, or a plugin pack's split source (utils/splitPanels.ts registerSplitSourceKind). */
  kind: 'patterns' | 'frozen' | (string & {});
  /** The dataset whose reads the panel shows. */
  datasetId: string;
  /** patterns: the features (their per-read states, api/features.ts). */
  features?: import('../stores/featureStore').FeatureRef[];
  /** The grouping's group keys this panel shows (configuration labels, pattern keys, SV group ids). */
  groupKeys: string[];
  /** frozen: the read names. */
  readIds?: string[];
}

export interface ReadSubset {
  /** The split set: its panels close together. */
  groupId: string;
  /** "N5 · V2", "Other variants", "Carriers". */
  label: string;
  colour: string;
  /** Reads when the panel was made. */
  count: number;
  /** The panel it was split from (shown again when the set closes). */
  sourcePanelId: string;
  rule: ReadSubsetRule;
  /**
   * Where the split was made (the view its reads were classified in) and what it is for ("INS 9.2 kb @
   * chr2L:9,467,038", a feature's name): away from it the panel says its reads here aren't
   * classified (components/tracks/read-track/SplitAwayBanner.tsx). Absent in older sessions.
   */
  locus?: { chrom: string; start: number; end: number; label: string };
  /** Away from its locus, show every read here (unfiltered, said in the header) instead of the banner. */
  showAllAway?: boolean;
}

export interface PanelConfig {
  reversed?: boolean;
  regionPanelGroup?: {
    id: string; label: string; color: string; regionLabel: string;
    previous?: { panels: PanelConfig[]; navigationMode: 'linked' | 'perPanel'; selectedDatasets: string[]; fullViewPanelId?: string | null; collapsedRows?: number[] };
  };
  id: string;                    // unique panel ID ("panel-abc123")
  contentType: PanelContentType; // what this panel renders
  datasetId: string | null;      // which dataset this panel shows (null for analysis panels)
  subTracks: SubTrackConfig[];   // ordered sub-tracks (only used when contentType === 'dataset')
  collapsed: boolean;            // hidden/collapsed
  heightFraction?: number;       // relative height when stacked (default: equal)
  widthFraction?: number;        // fraction of row width (0-1), default = 1/N
  stateKey?: string;             // key for per-panel state (clusters, filters, sort). Defaults to datasetId. Set on duplicate for independent state.
  linkGroup: string | null;      // link group ID, null = independent
  layoutRow: number;              // 0 = top row, 1 = second row, etc.
  layoutColumn?: number;          // column index within row — panels with same (row,col) stack vertically
  layoutPosition?: PanelLayout;   // DEPRECATED: kept for session migration
  viewportOverride?: { chrom: string; start: number; end: number };  // Override global viewport for this panel
  regionLabel?: string;          // "Locus X" or "Locus Y" label for contact-map split panels
  /** A title of its own, shown first in the header before the dataset's name ("roo copy 2 (chr3L)": utils/panelTitle.ts). */
  title?: string;
  /** Said after the title in the header and its tooltip ("− strand, 98.9% identity"). */
  titleDetail?: string;
  contactRegionGroupId?: string; // Region-panel group created from a contact-map selection
  contactRegionRole?: 'x' | 'y'; // Locus role within a contact-region group
  collapsedByContactRegionGroup?: string; // Original panel hidden while a contact-region group is open
  collapsedByHaplotypeGroup?: string; // Original panel hidden while a haplotype comparison is open
  /** A panel of a "Split into panels" set: a subset of its dataset's reads (utils/splitPanels.ts). */
  readSubset?: ReadSubset;
  collapsedBySplitGroup?: string; // Original panel hidden while its split panels are open
  genomeRegionGroupId?: string; // Region-panel group created from Genome Navigator
  linkedSessionId?: string;      // For DAF-C linked reads
  linkedRegion?: 'x' | 'y';     // For DAF-C linked reads
  haplotypeGroup?: string;       // Panels opened together by a haplotype comparison (closed together)
  haplotypeSide?: 1 | 2;         // Which view of a haplotype comparison this panel belongs to (View 1 = chrom1)
  strand?: 'CT' | 'GA';          // DAF-seq: show only this strand's reads (server-filtered)
  /** Live lift: show only this haplotype's rows ('MAT'/'PAT'; server-filtered, a rule that follows the view). */
  liftHap?: string;
  /** Live lift: the panel's saved layout choice, independent of the dataset's default for newly opened panels. */
  liftHaplotypeMode?: 'split' | 'pooled';
  /** Opened with "Open in graph mode" (a per-dataset display preference saved with the session; features/graphPanel/openAsGraph). */
  openAs?: 'graph';
  /** Live lift: the haplotype panels one Split by haplotype made share this id (graph features): a graph host's split
   * siblings are its group's, never another copy's. Absent on panels split before it existed (matched by dataset and view). */
  liftSplitGroup?: string;
  siteLocked?: boolean;          // own-view panel that pans/zooms with the main view and other locked panels (stores/siteLock.ts)
  /** Its dataset is on another assembly with a reference of its own (its key: `dm6`, `fasta:…`, `contigs:…`); always navigates on its own. */
  genome?: string;
  /** Given its own locus by "Each panel navigates" (utils/panelNavigation.ts); "Linked navigation" puts it back in its reference's link group. */
  navOwn?: boolean;
  /**
   * A copy the user made at a locus of its own ("Copy panel to another locus"): it never joins its
   * reference's link group. Other panels on another assembly are linked to each other in "Linked
   * navigation" (one locus per reference, utils/panelNavigation.ts).
   */
  ownLocus?: boolean;
  /**
   * Analysis panels (utils/panelRowLayout.ts): 'side' = pinned as a drawer that slides over the reads;
   * 'beside' = docked beside the reads on purpose (keeps its column down to tighter minimums);
   * unset = beside the reads while they have room, else in the drawer.
   */
  dock?: 'side' | 'beside';
  /** Dataset panels: Clean view off — track labels stay drawn over the data (and in exported figures). Unset = Clean view. */
  showTrackLabels?: boolean;
}

// --- Re-exports from sub-files ---
export * from './dataset';
export * from './jupyter';
export * from './primer';
export * from './clustering';
export * from './navigation';
export * from './dafc';
export * from './capture';
export * from './peak';
