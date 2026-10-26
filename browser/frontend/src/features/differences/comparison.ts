/** Assembly comparison (POST /api/differences/compare): exact IDs, typed links,
 * the design's labels, novelty, exact targets for enrichment, and the session
 * identity ledger with its merge/split lineage. Labels never carry votes. */
import { create } from 'zustand';
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import type { Difference } from '../liveLift/differenceTypes';
import type { FrozenTarget } from './api';

export type ComparisonLabel = 'confirmed_by_assembly' | 'assembly_supported_approximate' | 'assembly_candidate'
  | 'novel_relative_to_assembly' | 'unassessed' | 'reads_only';
export interface ComparisonLink {
  assembly_item_ids: string[]; hap_labels: string[]; relation: 'exact' | 'approximate' | 'candidate';
  rule: string | null; compound: boolean; scores: Record<string, number | boolean>; reasons: string[];
}
export interface ReadComparison {
  read_id: string; difference_id: string | null; identity_state?: string; exact_allele_id?: string;
  label: ComparisonLabel; label_text: string; novelty: { status: string; reasons: string[] };
  links: ComparisonLink[]; sequence_status: string; sequence_source: string | null;
}
export interface ExactTarget extends FrozenTarget {
  diagnostic_start: number; diagnostic_end: number; source: 'assembly'; source_item_id: string;
  candidate_labels: Record<string, string>;
}
export interface AssemblyComparison {
  item_id: string; difference_id: string; hap_label: string; kind: string; exact_allele_id: string | null;
  identity_state: string; sequence_status: string; shared_with: string[];
  read_links: { read_id: string; relation: ComparisonLink['relation']; rule: string | null; scores: Record<string, number | boolean> }[];
  exact_target: ExactTarget | null; t_start: number; t_end: number; ref_bp: number; alt_bp: number;
}
export interface ComparisonResponse {
  dataset_id: string; chrom: string; start: number; end: number; search_complete: boolean; reasons: string[];
  assembly: Record<string, AssemblyComparison>; reads: Record<string, ReadComparison>;
  lineage_events: { reason: string; parents: string[]; descendants: string[] }[];
  ledger: Record<string, any>; policy: Record<string, unknown>;
  status?: string; reason?: string; _received?: number;
}
export interface ReadDifferenceInput { id: string; ref_start: number; ref_end: number; alt_bp: number; geometry_members?: number[][] }

export const LABEL_TEXT: Record<ComparisonLabel, string> = {
  confirmed_by_assembly: 'Confirmed by assembly',
  assembly_supported_approximate: 'assembly-supported (approximate)',
  assembly_candidate: 'Assembly candidate (geometry only)',
  novel_relative_to_assembly: 'Not in the compared assembly haplotypes',
  unassessed: 'Assembly comparison unassessed',
  reads_only: 'Reads only (no assembly)',
};
/** The row's small mark beside a read difference: exact, approximate, candidate. */
export const LABEL_MARK: Partial<Record<ComparisonLabel, string>> = {
  confirmed_by_assembly: '✓', assembly_supported_approximate: '≈', assembly_candidate: '?',
};

/** Ledgers from concurrent comparisons are unioned; a retired record or a higher revision wins. */
export function mergeLedger(a: Record<string, any> | undefined, b: Record<string, any>): Record<string, any> {
  if (!a?.records) return b;
  const records = { ...a.records };
  for (const [id, r] of Object.entries<any>(b.records ?? {})) {
    const old = records[id];
    if (!old || r.identity_state === 'retired' || (old.identity_state !== 'retired' && (r.revision ?? 0) >= (old.revision ?? 0))) records[id] = r;
  }
  return { ...a, ...b, records, seeds: { ...a.seeds, ...b.seeds }, lineage: { ...a.lineage, ...b.lineage }, snapshots: { ...a.snapshots, ...b.snapshots } };
}

interface Store { byKey: Record<string, ComparisonResponse>; put: (key: string, r: ComparisonResponse) => void }
let received = 0;
/** The newest comparison covering a difference wins (a consensus re-compare supersedes the row's). */
export const useComparisonStore = create<Store>(set => ({ byKey: {}, put: (key, r) => set(s => ({ byKey: { ...s.byKey, [key]: { ...r, _received: ++received } } })) }));

export const comparisonKey = (datasetId: string, chrom: string, scope: string) => `${datasetId}|${chrom}|${scope}`;

export async function compareWithAssembly(body: { dataset_id: string; chrom: string; start: number; end: number;
  reads?: ReadDifferenceInput[]; read_sequences?: Record<string, string>; read_scope?: Record<string, unknown> }, signal?: AbortSignal): Promise<ComparisonResponse> {
  const session = useBrowserStore.getState().differencesSession;
  const options = session?.options as (typeof session.options & { comparisonPolicy?: Record<string, unknown> }) | undefined;
  const response = await fetchJson<ComparisonResponse>('/api/differences/compare', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, start: Math.max(0, Math.floor(body.start)), end: Math.ceil(body.end),
      ledger: session?.ledger, matching_policy: options?.matchingPolicy, comparison_policy: options?.comparisonPolicy }) });
  if (!signal?.aborted && !response.status && response.ledger) {
    // The ledger (provisional and exact identities, merge/split lineage) is saved with the session.
    useBrowserStore.setState(s => ({ differencesSession: { ...s.differencesSession,
      ledger: mergeLedger(s.differencesSession.ledger, response.ledger) as typeof s.differencesSession.ledger } }));
  }
  return response;
}

/** The comparison entry for a selected difference, from whichever stored response covers it. */
export function comparisonFor(byKey: Record<string, ComparisonResponse>, prefix: string, d: Difference):
  { kind: 'reads'; value: ReadComparison; response: ComparisonResponse } | { kind: 'assembly'; value: AssemblyComparison; response: ComparisonResponse } | null {
  let best: ReturnType<typeof comparisonFor> = null;
  for (const [key, response] of Object.entries(byKey)) {
    if (!key.startsWith(prefix) || (best && (best.response._received ?? 0) > (response._received ?? 0))) continue;
    if (d.source === 'assembly' && response.assembly?.[d.id]) best = { kind: 'assembly', value: response.assembly[d.id], response };
    else if (d.source === 'reads' && response.reads?.[d.id]) best = { kind: 'reads', value: response.reads[d.id], response };
  }
  return best;
}

/** Exact assembly alleles a user can test reads against for this difference. */
export function exactTargetsFor(entry: ReturnType<typeof comparisonFor>): ExactTarget[] {
  if (!entry) return [];
  if (entry.kind === 'assembly') return entry.value.exact_target ? [entry.value.exact_target] : [];
  const out = new Map<string, ExactTarget>();
  for (const link of entry.value.links) for (const id of link.assembly_item_ids) {
    const t = entry.response.assembly[id]?.exact_target;
    if (t && !out.has(t.target_id)) out.set(t.target_id, t);
  }
  return [...out.values()];
}

export function linkText(link: ComparisonLink): string {
  const who = link.hap_labels.join(' / ') || 'assembly';
  const score = typeof link.scores.identity === 'number' ? ` · identity ${(100 * Number(link.scores.identity)).toFixed(1)}%` : '';
  if (link.relation === 'exact') return `${who}: exact (full changed haplotypes equal)${link.compound ? ' · compound representation' : ''}`;
  if (link.relation === 'approximate') return `${who}: approximate${score}`;
  return `${who}: candidate (${(link.rule ?? 'geometry').replace(/_/g, ' ')} geometry), sequence ${score ? `not close enough${score}` : 'unassessed'}`;
}
