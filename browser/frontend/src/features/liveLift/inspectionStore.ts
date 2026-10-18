import { create } from 'zustand';
import type { Difference } from './differenceTypes';
import type { CompactRead } from '../../components/tracks/read-track/types';
import type { LiveLiftBadge } from '../../components/tracks/read-track/liveLiftCanvas';
import { useBrowserStore } from '../../stores/browserStore';
import { useLiveLiftStore } from './store';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { liveLiftViewKey } from './persistence';
import { getDifferences } from './api';
import { findLoadedDifference, rememberDifferences } from './differenceCache';
import './persistence';
import { equivalentInsertions } from './equivalentInsertions';

export interface DifferenceSelection { datasetId: string; panelId: string; viewKey: string; chrom: string; difference: Difference; action?: 'identify' }
let selectionVersion = 0;
export const useDifferenceSelection = create<{
  selection: DifferenceSelection | null; select: (selection: DifferenceSelection | null) => void;
}>(set => ({ selection: null, select: selection => { selectionVersion++; set({ selection }); } }));

export function expandDifference(s: DifferenceSelection): boolean {
  const d = s.difference;
  const panel = useBrowserStore.getState().panels.find(p => p.id === s.panelId);
  const stateKey = panel?.stateKey ?? panel?.datasetId ?? s.panelId;
  if (d.kind !== 'insertion') return false;
  if (d.alt_bp < 50) {
    // Small indels remain inspectable, but the compact-row contract carries
    // insertion-local chromatin only from 50 bp. Do not open an empty fake carrier.
    useReadActionsStore.getState().showNotice(stateKey, 'In-place read payloads are available for insertions of at least 50 bp.');
    return false;
  }
  if (d.alt_bp > 50_000) {
    useReadActionsStore.getState().showNotice(stateKey, 'Insertions over 50 kb cannot be expanded (payload too large).');
    useBrowserStore.getState().setError('Insertions over 50 kb cannot be expanded (payload too large).');
    return false;
  }
  useBrowserStore.getState().expandLiveLift(s.viewKey, { chrom: s.chrom, pos: d.t_start, ins_id: d.id,
    length: d.alt_bp, label: `HG002 ${d.hap_label} +${d.alt_bp.toLocaleString()} bp`, hap_label: d.hap_label,
    src: d.src, datasetId: s.datasetId, strand: d.strand });
  // Resolve both parents from map evidence even when a split strip has only
  // loaded its own lane. A collapsed/superseded block cannot be reopened by
  // this asynchronous enrichment.
  const liftKey = useBrowserStore.getState().datasets.find(ds => ds.id === s.datasetId)?.live_lift?.key ?? '';
  void getDifferences({ datasetId: s.datasetId, liftKey, chrom: s.chrom,
    start: d.t_start, end: d.t_start + 1, minBp: 0 }).then(response => {
    const state = useBrowserStore.getState();
    if (state.datasets.find(ds => ds.id === s.datasetId)?.live_lift?.key !== liftKey) return;
    const current = state.liveLiftExpansions[s.viewKey]?.find(e => e.ins_id === d.id);
    if (!current) return;
    rememberDifferences(response);
    const group = equivalentInsertions(d, response.items);
    const alleles = group.map(g => ({ ins_id: g.id, hap_label: g.hap_label, length: g.alt_bp, src: g.src, strand: g.strand }));
    const differs = group.some(g => g.alt_bp !== d.alt_bp);
    const label = `HG002 ${d.hap_label} +${d.alt_bp.toLocaleString()} bp` + (group.length > 1 ? ` · ${group.slice(1).map(g => `${g.hap_label} +${g.alt_bp.toLocaleString()} bp`).join(' · ')}${differs ? ' (lengths differ; boundary aligned)' : ''}` : '');
    state.expandLiveLift(s.viewKey, { ...current, length: Math.max(...group.map(g => g.alt_bp)), selected_length: d.alt_bp, alleles, label });
  }).catch(() => { /* The selected insertion remains usable if enrichment fails. */ });
  return true;
}
/** The parallel badge_ids array is the authority: partial carriers share the
 * full insertion's ID. Never reconstruct it from a rounded badge label. */
export function selectReadDifference(read: CompactRead, badge: LiveLiftBadge | undefined, pos: number,
  context: { datasetId: string; stateKey: string; chrom: string; start: number }, action: 'primary' | 'inspect' = 'primary'): boolean {
  if (!useLiveLiftStore.getState().enabled || !read.live_lift) return false;
  const st = useBrowserStore.getState();
  const panel = st.panels.find(p => p.datasetId === context.datasetId && (p.stateKey ?? p.datasetId) === context.stateKey);
  if (!panel) return false;
  const ll = read.live_lift;
  const index = badge ? ll.badges?.indexOf(badge) ?? -1 : -1;
  const id = ll.badge_ids?.[index] ?? undefined;
  // Unresolved/replacement/elsewhere badges are not insertion evidence.
  if (badge && !id) return false;
  const payload = id ? ll.insertions?.[id] : undefined;
  const event = read.cigar?.find(e => e.type === 'X' && e.pos + context.start === pos);
  if (!id && !event && !badge) return false;
  const hap = ll.hap_label ?? ll.hap ?? '';
  const fallback: Difference = { id: id ?? `${hap}:site:${pos}`, hap: ll.hap ?? hap, hap_label: hap,
    kind: badge ? 'insertion' : 'snv', reason: badge?.[1] ?? (event?.source === 'reads' && !event.allele ? 'read_mismatch' : 'substitution'),
    source: 'reads',
    t_start: badge ? context.start + badge[0] : context.start + event!.pos,
    t_end: badge ? context.start + badge[0] : context.start + event!.pos + 1,
    ref_bp: badge ? 0 : 1, alt_bp: payload?.length ?? badge?.[3] ?? 1, chain: null,
    strand: payload && !('too_large' in payload) ? payload.orientation : null,
    src: payload && !('too_large' in payload) ? { contig: payload.src[0], start: payload.src[1], end: payload.src[2] }
      : { contig: ll.source?.contig ?? null, start: null, end: null }, grch38: event?.ref ?? null, alt: null };
  const liftKey = st.datasets.find(d => d.id === context.datasetId)?.live_lift?.key ?? '';
  const query = { id, hap, pos: fallback.t_start, kind: badge ? 'insertion' as const : 'snv' as const };
  // A new click or strip selection while fetching supersedes the old
  // request. Never flash a synthetic assembly allele while map I/O is pending.
  useDifferenceSelection.getState().select(null);
  const version = selectionVersion;
  const finish = (difference: Difference) => {
    if (version !== selectionVersion || useBrowserStore.getState().datasets.find(d => d.id === context.datasetId)?.live_lift?.key !== liftKey) return;
    const selection = { datasetId: context.datasetId, panelId: panel.id, viewKey: liveLiftViewKey(panel), chrom: context.chrom, difference };
    if (action === 'primary' && badge && payload && difference.kind === 'insertion') expandDifference(selection);
    else useDifferenceSelection.getState().select(selection);
  };
  const canonical = findLoadedDifference(context.datasetId, liftKey, context.chrom, query);
  if (canonical) finish(canonical);
  else void getDifferences({ datasetId: context.datasetId, liftKey, chrom: context.chrom,
    start: Math.max(0, fallback.t_start - 2), end: fallback.t_start + 3, liftHap: hap, minBp: 0 }).then(response => {
    rememberDifferences(response);
    finish(findLoadedDifference(context.datasetId, liftKey, context.chrom, query) ?? fallback);
  }).catch(e => {
    if (version === selectionVersion) useReadActionsStore.getState().showNotice(context.stateKey, `Could not load assembly difference: ${String(e.message ?? e)}`);
  });
  return true;
}
