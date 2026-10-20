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
  maps: { target: string; source: string }[];
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
  layoutSettings: { contextBp: number; laneHeight: number; compression?: 'log' | 'linear' };
}

declare module '../../types' {
  interface PanelConfig {
    /** A graph-view panel's registration, paths, target viewport and link (features/graphPanel). */
    graphView?: GraphViewState;
  }
}
