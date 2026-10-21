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

/** Saved with the panel (sessions, history): identities and revisions, never geometry or in-flight state. */
export interface GraphViewState {
  schema: 1;
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
}

export interface GraphRead {
  /** `${dataset}|${library}|${QNAME}|${record}`: one record of one molecule. */
  k: string;
  d: string;
  lib: number;
  q: string;
  rec: string;
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
  m6a?: number[];
  /** m6A as counts per bin when the request's mark budget was spent: [start, end, count]. */
  m6a_density?: [number, number, number][];
  calls_omitted?: boolean;
}

export interface GraphReadBinding {
  dataset_id: string;
  label: string;
  kind: 'lifted' | 'native';
  revision: string;
  /** Package binding key -> BAM contig. */
  paths: Record<string, string>;
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
}

export interface GraphReadsResponse {
  reads: GraphRead[];
  report: GraphReadsReport;
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
