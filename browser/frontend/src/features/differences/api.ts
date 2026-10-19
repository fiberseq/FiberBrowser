import { useBrowserStore } from '../../stores/browserStore';
import { fetchJson } from '../../api/sharedFetch';
import type { MoleculeEnvelope, MoleculeCall } from './contracts';
import type { LiveLiftInsertion, CompactRead } from '../../components/tracks/read-track/types';
import type { DifferenceExpansion } from './axis';

export interface FrozenTarget {
  target_id: string; revision: number; target_type: 'geometry' | 'exact'; chrom: string;
  ref_start: number; ref_end: number; alt_bp: number;
  candidates?: Record<string, string | null>; competition_complete?: boolean;
}
export interface EvidencePolicy { include_duplicates: boolean; include_putative: boolean; include_conflicting: boolean; include_ambiguous: boolean }
export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = { include_duplicates: false, include_putative: true, include_conflicting: false, include_ambiguous: false };
export interface WorkspaceQuery {
  dataset_id: string; chrom: string; start: number; end: number; target: FrozenTarget;
  layer_options?: {min_fp_quality?:number;ml_threshold?:number;infer_legacy_layers?:boolean;legacy_nuc_min_size?:number};
  analysis_scope?: 'native_only' | 'lifted_only' | 'combined'; native_dataset_id?: string;
}
export interface WorkspaceCalls {
  schema_version: 'differences:v1'; membership: MoleculeEnvelope['membership'];
  analysis_scope: 'native_only' | 'lifted_only' | 'combined';
  targets: { target: FrozenTarget; calls_by_molecule: Record<string, MoleculeCall>; counts: number[]; geometry_counts: number[]; sequence_unresolved_count: number }[];
  evidence_policy: EvidencePolicy; policy?: unknown; scope: Record<string, unknown>;
  status?: string; reason?: string;
}
export interface AlternateBlock extends LiveLiftInsertion {
  column_id: string; target_revision: number; row_id: string; record_id: string;
  read_bases: string; read_bases_length: number; coverage: 'full' | 'partial';
}
export interface BlocksResponse { blocks?: AlternateBlock[]; complete?: boolean; status?: string; reason?: string }
export function inspectDifference(q: WorkspaceQuery, policy: EvidencePolicy, signal?: AbortSignal): Promise<WorkspaceCalls> {
  return fetchJson('/api/differences/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...q, ...policy }), signal });
}
export function getAlternateBlocks(q: WorkspaceQuery, rowIds: string[] | undefined, layers: string[], includeDuplicates: boolean, signal?: AbortSignal, observations=false): Promise<BlocksResponse> {
  return fetchJson(observations ? '/api/differences/observations' : '/api/differences/alternate-blocks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...q, row_ids: rowIds, layers, include_duplicates: includeDuplicates }), signal });
}

/** Enrichment is separate from reference rows and their coverage/caches. */
export async function enrichNativeRows(reads: CompactRead[], q: Omit<WorkspaceQuery, 'target'>,
  columns: DifferenceExpansion[], layers: string[], includeDuplicates: boolean, signal?: AbortSignal, layerOptions: WorkspaceQuery['layer_options']={}): Promise<CompactRead[]> {
  let result = reads;
  for (const c of columns) {
    if (signal?.aborted) return reads;
    const target: FrozenTarget = { target_id: c.ins_id, revision: c.targetRevision ?? 1, target_type: 'geometry', chrom: q.chrom,
      ref_start: c.ref_start ?? c.pos, ref_end: c.t_end ?? c.pos, alt_bp: c.selected_length ?? c.length };
    const ids = [...new Set(reads.map(r => r.id))].slice(0, 500);
    const response = await getAlternateBlocks({ ...q, target, layer_options:layerOptions }, ids, layers, includeDuplicates, signal);
    if (signal?.aborted || !response.complete) continue;
    const state = useBrowserStore.getState();
    const view = Object.keys(state.liveLiftExpansions).find(key => state.liveLiftExpansions[key]?.includes(c));
    const fullLength = Math.max(c.length, ...(response.blocks ?? []).map(b => b.length));
    if (view && fullLength <= 50_000 && fullLength > c.length) state.expandLiveLift(view, { ...c, selected_length: c.selected_length ?? c.length, length: fullLength });
    result = result.map(r => {
      const matching = response.blocks?.filter(b => b.row_id === r.id && b.record_id === r.record_sha256) ?? [];
      return matching.length === 1 ? { ...r, alternate_blocks: { ...r.alternate_blocks, [c.ins_id]: matching[0] } } : r;
    });
  }
  return result;
}
