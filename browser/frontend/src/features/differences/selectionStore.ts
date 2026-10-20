import type { FrozenTarget, EvidencePolicy } from './api';
import { create } from 'zustand';
import type { Difference } from '../liveLift/differenceTypes';
import type { CompactRead } from '../../components/tracks/read-track/types';
import type { LiveLiftBadge } from '../../components/tracks/read-track/liveLiftCanvas';
import { useBrowserStore } from '../../stores/browserStore';
import { useLiveLiftStore } from '../liveLift/store';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { liveLiftViewKey } from './persistence';
import { getDifferences } from '../liveLift/api';
import { findLoadedDifference, rememberDifferences } from '../liveLift/differenceCache';
import './persistence';
import { expandableAltBlock } from './capabilities';
import { equivalentInsertions } from '../liveLift/equivalentInsertions';

export interface DifferenceSelection { datasetId: string; panelId: string; viewKey: string; chrom: string; difference: Difference; action?: 'identify'; inspect?: boolean; target?: FrozenTarget; evidencePolicy?: EvidencePolicy; alternateHit?: {readId:string;layer:string|null;start:number;end:number;offset:number} }
let selectionVersion = 0;
export const useDifferenceSelection = create<{
  selection: DifferenceSelection | null; select: (selection: DifferenceSelection | null) => void;
}>(set => ({ selection: null, select: selection => {
  selectionVersion++; set({ selection });
  useBrowserStore.setState(s => ({ differencesSession: { ...s.differencesSession,
    selectionSnapshot: selection ? JSON.parse(JSON.stringify(selection)) : null } }));
} }));

/** Restore the frozen selection, including unavailable sources and exact target
 * revisions. Never resolve an ID by the nearest visible geometry or dataset. */
export function restoreDifferenceSelection() {
  const saved = useBrowserStore.getState().differencesSession.selectionSnapshot;
  const valid = saved && typeof saved.datasetId === 'string' && typeof saved.panelId === 'string'
    && typeof saved.chrom === 'string' && typeof saved.viewKey === 'string' && typeof saved.difference?.id === 'string'
    && Number.isFinite(saved.difference.t_start) && Number.isFinite(saved.difference.t_end)
    && Number.isFinite(saved.difference.ref_bp) && Number.isFinite(saved.difference.alt_bp);
  selectionVersion++;
  useDifferenceSelection.setState({ selection: valid ? JSON.parse(JSON.stringify(saved)) as DifferenceSelection : null });
}
useBrowserStore.subscribe((state, previous) => {
  if (state.differencesSession.selectionSnapshot !== previous.differencesSession.selectionSnapshot) restoreDifferenceSelection();
});

/** A map marker carries its exact map link and both spans, including a
 * replacement's one-base alternate. It never opens a native SV action. */
export function selectMapGap(read: CompactRead, id: string | undefined,
  context: { datasetId: string; stateKey: string; chrom: string }): boolean {
  if (!useLiveLiftStore.getState().enabled || !id) return false;
  const gap = read.live_lift?.gap_observations?.find(g => g.id === id);
  const panel = useBrowserStore.getState().panels.find(p => p.datasetId === context.datasetId && (p.stateKey ?? p.datasetId) === context.stateKey);
  if (!gap || !panel) return false;
  const liftKey = useBrowserStore.getState().datasets.find(d => d.id === context.datasetId)?.live_lift?.key ?? '';
  const query = { id, hap: gap.hap_label, pos: gap.t_start, kind: 'insertion' as const };
  const canonical = findLoadedDifference(context.datasetId, liftKey, context.chrom, query);
  useDifferenceSelection.getState().select({ datasetId: context.datasetId, panelId: panel.id,
    chrom: context.chrom, viewKey: liveLiftViewKey(panel), difference: canonical ?? { ...gap, grch38: null, alt: null } });
  const version = selectionVersion;
  if (!canonical) void getDifferences({ datasetId: context.datasetId, liftKey, chrom: context.chrom,
    start: gap.t_start, end: gap.t_start + 1, minBp: 0, liftHap: gap.hap_label }).then(response => {
    if (version !== selectionVersion || useBrowserStore.getState().datasets.find(d => d.id === context.datasetId)?.live_lift?.key !== liftKey) return;
    rememberDifferences(response);
    const difference = findLoadedDifference(context.datasetId, liftKey, context.chrom, query);
    const current = useDifferenceSelection.getState().selection;
    if (difference && current) useDifferenceSelection.getState().select({ ...current, difference });
  }).catch(() => { /* Geometry inspection remains available without sequence. */ });
  return true;
}

/** "+2.4 kb", "−1.2 kb", "+80 bp": the net change in length, short enough for a column header. */
export function formatNetBp(net: number): string {
  const size = Math.abs(net);
  const text = size >= 10_000 ? `${Math.round(size / 1000)} kb` : size >= 1000 ? `${(size / 1000).toFixed(1)} kb` : `${size} bp`;
  return net > 0 ? `+${text}` : net < 0 ? `−${text}` : `±${text}`;
}
/** An expanded column's label: its parent (or "Reads") and net size. */
export function expansionLabel(d: Pick<Difference, 'source' | 'hap_label' | 'ref_bp' | 'alt_bp'>): string {
  return `${d.source === 'reads' ? 'Reads' : d.hap_label} ${formatNetBp(d.alt_bp - d.ref_bp)}`;
}
/** The column's full description (tooltip and inspector): source and both allele spans. */
export function expansionDetail(d: Pick<Difference, 'source' | 'hap_label' | 'ref_bp' | 'alt_bp'>): string {
  return `${d.source === 'reads' ? 'Read geometry (estimated)' : `Assembly ${d.hap_label}`} · ref ${d.ref_bp.toLocaleString()} → alt ${d.alt_bp.toLocaleString()} bp`;
}

export function expandDifference(s: DifferenceSelection): boolean {
  const d = s.difference;
  const panel = useBrowserStore.getState().panels.find(p => p.id === s.panelId);
  const stateKey = panel?.stateKey ?? panel?.datasetId ?? s.panelId;
  if (d.kind !== 'insertion' && d.kind !== 'replacement') return false;
  const dataset=useBrowserStore.getState().datasets.find(ds=>ds.id===s.datasetId);
  if(dataset?.data_type==='bam_livelift'&&d.source==='reads'&&d.src.start===null){
    useReadActionsStore.getState().showNotice(stateKey,'This read edit has no validated alternate-block mapping yet. Geometry and scoped calls remain inspectable.');return false;
  }
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
  if (!expandableAltBlock(d)) return false;
  useBrowserStore.getState().expandLiveLift(s.viewKey, { chrom: s.chrom, pos: d.t_end, ins_id: d.id,
    estimated: d.source === 'reads', source: d.source, referenceScope: panel?.genome ?? 'main-reference', targetRevision: 1, ref_start: d.t_start, anchor_convention: 'ref_end',
    length: d.alt_bp, label: expansionLabel(d), detail: expansionDetail(d), hap_label: d.hap_label,
    src: d.src, datasetId: s.datasetId, strand: d.strand, kind: d.kind, t_end: d.t_end, ref_bp: d.ref_bp });
  if (d.source === 'reads') return true;
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
    const alleles = group.map(g => ({ ins_id: g.id, hap_label: g.hap_label, length: g.alt_bp, src: g.src, strand: g.strand,
      kind: g.kind as 'insertion' | 'replacement', t_end: g.t_end, ref_bp: g.ref_bp }));
    const differs = group.some(g => g.alt_bp !== d.alt_bp);
    const others = group.slice(1);
    const label = [expansionLabel(d), ...others.map(expansionLabel)].join(' · ');
    const detail = [expansionDetail(d), ...others.map(g => `${g.hap_label} ref ${g.ref_bp.toLocaleString()} → alt ${g.alt_bp.toLocaleString()} bp`)].join(' · ')
      + (differs ? ' (lengths differ; boundary aligned)' : '');
    state.expandLiveLift(s.viewKey, { ...current, length: Math.max(...group.map(g => g.alt_bp)), selected_length: d.alt_bp, alleles, label, detail });
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
  // Unresolved/elsewhere badges cannot establish an alternate block.
  if (badge && !id) return false;
  const payload = id ? ll.insertions?.[id] : undefined;
  const event = read.cigar?.find(e => e.type === 'X' && e.pos + context.start === pos);
  if (!id && !event && !badge) return false;
  const hap = ll.hap_label ?? ll.hap ?? '';
  const gap = ll.gap_observations?.find(g => g.id === id);
  const fallback: Difference = gap ? { ...gap, grch38: null, alt: null } : { id: id ?? `${hap}:site:${pos}`, hap: ll.hap ?? hap, hap_label: hap,
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
    // A click on a difference opens its inspector (observations load within the auto-load bound);
    // an assembly insertion's badge also opens the insertion across the view.
    useDifferenceSelection.getState().select(selection);
    if (action === 'primary' && badge && difference.source === 'assembly'
      && (difference.kind === 'insertion' || difference.kind === 'replacement') && difference.alt_bp >= 50) expandDifference(selection);
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
