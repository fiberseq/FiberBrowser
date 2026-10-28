/**
 * The graph panel's types (DESIGN_GRAPH_PANEL.md §§1, 3, 6): the helper's status, registered graph packages, the
 * topology the native helper returns (graphlift GRAPH_HELPER.md, protocol 1), and the panel's saved state.
 * Coordinates are zero-based, half-open, forward assembly coordinates.
 */

export interface Span { start: number; end: number }

export interface GraphRevisions { package: string; graph: string; db: string; maps: string }

export interface PathIdentity { sample: string; haplotype: string; contig: string }

export interface GraphBinding {
  key: string;
  path: PathIdentity;
  assembly: string;
  reference: string;
  /** Known assembly size, or the inferred lower bound (size_inferred). */
  size: number | null;
  size_inferred: boolean;
  fragments: { origin: number; end: number; indexed: boolean }[];
  uncovered: { start: number; end: number | null; kind: string }[];
}

export interface GraphRegistration {
  id: string;
  label: string;
  revisions: GraphRevisions;
  producer: string;
  build_target: string;
  bindings: GraphBinding[];
  /** manifest_sha256: the map manifest's digest (a live-lift dataset on the very same map reuses its differences). */
  maps: { target: string; source: string; manifest_sha256?: string | null }[];
}

export interface GraphHelperInfo {
  available: boolean;
  source: 'env' | 'bundled' | 'companion' | null;
  producer?: string | null;
  build_target?: string | null;
  error?: string | null;
  hint?: string | null;
  limits?: Record<string, number> | null;
}

export interface GraphStatus {
  helper: GraphHelperInfo;
  registrations: GraphRegistration[];
  registration_errors: { package: string; error: string }[];
  limits: { target_bp: number; paths: number; context_bp: number };
}

export interface GraphOccurrence {
  id: string;
  fragment: string;
  node: string;
  handle: string;
  reverse: boolean;
  /** The whole visit on its path. */
  path_span: Span;
  /** The part inside the requested window, in the node's oriented traversal (0 .. node length). */
  clip: Span;
}

export interface GraphCoverage {
  span: Span;
  kind: string;            // covered | gap | unavailable | unknown_tail | ...
  fragment?: string | null;
  left_end?: string;
  right_end?: string;
}

export interface GraphPlanCandidate {
  target: Span;
  source: Span;
  chain_ids: string[];
  strands: string[];
  kind: string;            // map_block | source_insertion | transition | ...
  correspondence: 'map_anchor' | 'inferred_fill' | 'unresolved' | string;
  owned: boolean;
}

export interface GraphPathResult {
  binding: string;
  windows: Span[];
  coverage: GraphCoverage[];
  occurrences: GraphOccurrence[];
  plan: { windows: Span[]; candidates: GraphPlanCandidate[]; summaries: GraphSummary[] } | null;
  complete: boolean;
}

export interface GraphSummary { reason?: string; kind?: string; span?: Span; binding?: string; message?: string; [k: string]: unknown }

export interface GraphDirectMatch {
  target_occurrence: string;
  source_occurrence: string;
  source_binding: string;
  reverse: boolean;
  provenance: string;
}

export interface GraphTopology {
  target: string;
  interval: Span;
  nodes: { id: string; length: number; selected: boolean; context: boolean }[];
  edges: { from: string; to: string }[];
  paths: GraphPathResult[];
  direct_matches: GraphDirectMatch[];
  /** The same matches by position, when the helper's frame budget needed it: [path index, source occurrence index,
   * target occurrence index, reverse 0/1] (graphlift GRAPH_HELPER.md). */
  direct_match_index?: [number, number, number, number][];
  target_queries: unknown[];
  summaries: GraphSummary[];
  complete: boolean;
  correspondence_complete: boolean;
  timings: Record<string, number>;
}

export interface GraphSubgraphResponse {
  request_id: string;
  panel_id: string;
  generation: number;
  status: 'ok';
  cached: boolean;
  result: GraphTopology;
  registration_id: string;
  revisions: GraphRevisions;
  timings: { queue_ms?: number; startup_ms?: number | null; dispatch_ms?: number; total_ms?: number; frame_bytes?: number; worker_epoch?: number };
}

export interface GraphApiError {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
  [k: string]: unknown;
}

/** How the panel picks its target viewport: its own, or following a linear panel (DESIGN §6). */
export type GraphLinkMode = 'independent' | 'follow';

/** A host's member (DESIGN_GRAPH_PRIMARY §1.1): a dataset panel by id, and the package path it binds to (null: every
 * path its dataset binds, a pooled lifted panel or a native panel on the target). */
export interface GraphMember { panelId: string; binding: string | null }

/** Saved with the panel (sessions, history): identities and revisions, never geometry or in-flight state.
 * Schema 2 (DESIGN_GRAPH_PRIMARY §5.4) adds the role: `standalone` (the graph-view panel; schema 1 states are
 * standalone) or `host` (a dataset panel in graph mode, whose own viewport is the only authority: `linkMode` and
 * `targetViewport` are unused there). */
export interface GraphViewState {
  schema: 1 | 2;
  role?: 'host' | 'standalone';
  /** Host: its members in band order, itself first. */
  members?: GraphMember[];
  /** Host: the zoom-out hand-off (§7): "Stay linear" pinned, and the mode last drawn (hysteresis across reloads). */
  handoff?: { pinnedLinear?: boolean; shown?: 'graph' | 'linear';
    /** Why it is drawn linear: the width rule (also a pin or a view with no graph) or the complexity rule (§7.2). */
    reason?: 'width' | 'complexity' };
  /** Host: how each sub-band orders rows without a sort or clusters ('position': first carried graph column in canonical walk order, 'length'). */
  bandSort?: 'position' | 'length';
  /** Host: selection changes mirror to the host's other members showing the same record (D14, default on). */
  syncSelection?: boolean;
  /** Host: what a pop-out shows (§4.2, §5.1, D7): the member panel ('lifted', also when absent), the P3 linked
   * source panel on the haplotype's assembly ('source'), or both. */
  popOutKind?: 'lifted' | 'source' | 'both';
  registrationId: string | null;
  packageRevision: string | null;
  graphRevision: string | null;
  mapRevision: string | null;
  targetBinding: string | null;
  /** The target binding's reference identity (manifest), checked before following a linear panel. */
  targetReferenceId: string | null;
  /** The linear panel it follows: a panel ID, or null for the main view. */
  initiatingPanelId: string | null;
  initiatingReferenceId: string | null;
  selectedPathKeys: string[];
  targetViewport: { contig: string; start: number; end: number } | null;
  linkMode: GraphLinkMode;
  /** compression: `log` (schematic, DESIGN §4 g(L)) or `linear` (true bp; insertions still get their slot). */
  layoutSettings: { contextBp: number; laneHeight: number; compression?: 'log' | 'linear';
    /** smallDifferences: `marks` (default: SNPs and short indels as marks on the shared tube, scaled with zoom) or
     * `bubbles` (every difference branches). */
    smallDifferences?: 'marks' | 'bubbles';
    /** Insertions expanded with a plain click (layout group IDs): drawn at true bp in the schematic view. */
    expanded?: string[] };
  /** Reads drawn along the paths (Gate E); absent: shown, every binding dataset. */
  reads?: GraphReadSettings;
}

// ---------------------------------------------------------------------------------------------------- reads (Gate E)

/** A composed call layer of a read, in absolute source coordinates of its path (services/graph_panel/reads.py). */
export interface GraphReadLayer {
  /** [start, end, whole call size]. */
  iv: [number, number, number][];
  /** The call's record-local identity (null: an inferred mark, e.g. a legacy MSP). */
  id: (string | null)[];
  /** Logical identity across the decoder's pieces: [molecular start, group]. */
  part: ([number, number] | null)[];
  nq?: number[]; lq?: number[]; rq?: number[]; aq?: number[]; tq?: number[]; el?: number[]; er?: number[]; q0?: number[];
  inferred?: boolean;
  /** nuc/tf: the footprint's nucsz class byte (low 4 bits the coarse code, +16 for a TF call or one overlapping it),
   * named byte (nucsz Q2: 0 unnamed, 1 small, 2 hexasome, 3 octasome, 4 chromatosome; wire version 10, absent in
   * older payloads: no named evidence) and z byte (20 z + 128, 255 missing), parallel to `iv`; null where the call
   * has no mark (or, for `nb`, its mark no named byte). */
  cls?: (number | null)[];
  nb?: (number | null)[];
  zb?: (number | null)[];
}

/** The nucleosome segment lane (nucseg rows), in absolute source coordinates like the call layers. */
export interface GraphReadSegLane {
  /** [start, end, molecular length]. */
  iv: [number, number, number][];
  /** < 16 a segment state (1 regular, 2 disordered, 3 low information, 4 undetermined); 16 an undersized run,
   * 17 a missing nucleosome. */
  code?: number[];
  /** Segments: the posterior byte; events: 10 x LLR capped at 255. */
  p?: number[];
  /** Regular segments: q-hat - 100; events: the count. */
  q3?: number[];
}

export interface GraphRead {
  /** `${dataset}|${library}|${QNAME}|${record}`: one record of one molecule. */
  k: string;
  d: string;
  lib: number;
  q: string;
  rec: string;
  /** Lifted rows (graph primary G0, DESIGN_GRAPH_PRIMARY §3.1): the standard cohort identity (`analysis_id`, the
   * graph's piece recorded as the primary placement), its record key (no row index, no placement) and the map
   * haplotype's label, as the linear rows of the same record carry them. Native rows: absent (QNAME is the key). */
  aid?: string;
  rk?: string | null;
  hap?: string | null;
  /** A supplementary's primary record's haplotype label, when the server found its primary (wire version 11): the
   * haplotype its lifted rows are shown on. `hap` stays its own path's (its band). */
  ph?: string | null;
  /** The package path (binding key) it is aligned to, and the BAM contig. */
  b: string;
  c: string;
  /** Molecular strand of the record (never changes under reversal). */
  st: '+' | '-';
  sup: boolean;
  s: number;
  e: number;
  /** Aligned coverage slices [start, end, molecular start, step]: holes between them are CIGAR deletions/skips. */
  cov: [number, number, number, number][];
  /** Read insertions (CIGAR I): [source boundary, length, molecular start]; no path bp. */
  ins: [number, number, number][];
  /** CIGAR deletions [source start, length]: a coverage hole with one is a deletion, without one a skip (N). */
  dl?: [number, number][];
  /** Soft clips [source boundary, length, side]. */
  clips?: [number, number, string][];
  nuc?: GraphReadLayer;
  tf?: GraphReadLayer;
  msp?: GraphReadLayer;
  /** The nucleosome segment lane (wire version 9). */
  nseg?: GraphReadSegLane;
  m6a?: number[];
  /** m6A as counts per bin when the request's mark budget was spent: [start, end, count]. */
  m6a_density?: [number, number, number][];
  calls_omitted?: boolean;
  /** A DAF-seq record's strand (CT / GA: its st:Z tag, else its deamination marks); absent: none (G8). */
  ds?: 'CT' | 'GA';
}

export interface GraphReadBinding {
  dataset_id: string;
  label: string;
  kind: 'lifted' | 'native';
  revision: string;
  /** Package binding key -> BAM contig. */
  paths: Record<string, string>;
  /** Lifted datasets: package binding key -> the map haplotype's label (MAT, PAT, a strain's haplotype). */
  haps?: Record<string, string>;
  problems: string[];
  libraries: number;
}

export interface GraphReadsReport {
  molecules: number;
  records: number;
  marks: number;
  sampling: { level: number; fraction: number; estimated: number | null; molecules_capped: number; max_molecules: number };
  m6a_density_reads: number;
  m6a_density_bp?: number | null;
  calls_omitted_reads: number;
  decoded_bytes?: number;
  truncated: boolean;
  omitted: Record<string, number>;
  shared_qnames: number;
  /** Per sub-band (dataset, path): its molecules in the windows, share, sampling level and what it kept (G7). */
  bands?: import('./densityStrip').GraphBandReport[];
  budgets?: { profile: string | null; molecules: number; decoded_bytes: number; concurrent_loads: number; marks: number };
}

export interface GraphReadsResponse {
  reads: GraphRead[];
  report: GraphReadsReport;
  /** Density strips per (dataset, path) (G7, §6.2 L2): counts at bin centres over every row decoded for the band. */
  strips?: import('./densityStrip').GraphStrip[];
  cached: boolean;
  bindings: { dataset_id: string; binding: string; contig: string; windows: Span[] }[];
  /** list_ms: the windows' record headers; decode_ms/records_decoded: the records not cached yet. */
  timings: { total_ms: number; list_ms?: number; decode_ms?: number; records_decoded?: number };
  request_id: string;
  generation: number;
}

/** A panel's reads settings: which bound datasets (null: every one that binds), the layers drawn, row height. */
export interface GraphReadSettings {
  show: boolean;
  datasets: string[] | null;
  layers?: { nuc?: boolean; msp?: boolean; m6a?: boolean; tf?: boolean };
  rowHeight?: number;
  /** Rows per path (standalone) or sub-band (host): absent in a host means fill height (§6.1). */
  maxRowsPerLane?: number;
  /** The datasets (and their revisions) whose reads this view drew: saved with the session, checked on restore. */
  bound?: { dataset_id: string; revision: string }[];
}

declare module '../../types' {
  interface PanelConfig {
    /** A graph-view panel's registration, paths, target viewport and link (features/graphPanel). */
    graphView?: GraphViewState;
  }
}
