import { create } from 'zustand';
import type { Difference } from './differenceTypes';
import type { CompactRead } from '../../components/tracks/read-track/types';
import type { LiveLiftBadge } from '../../components/tracks/read-track/liveLiftCanvas';
import { useBrowserStore } from '../../stores/browserStore';
import { useLiveLiftStore } from './store';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { liveLiftViewKey } from './persistence';
import './persistence';

export interface DifferenceSelection { datasetId: string; panelId: string; viewKey: string; chrom: string; difference: Difference; action?: 'identify' }
export const useDifferenceSelection = create<{
  selection: DifferenceSelection | null; select: (selection: DifferenceSelection | null) => void;
}>(set => ({ selection: null, select: selection => set({ selection }) }));

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
  return true;
}
/** The parallel badge_ids array is the authority: partial carriers share the
 * full insertion's ID. Never reconstruct it from a rounded badge label. */
export function selectReadDifference(read: CompactRead, badge: LiveLiftBadge | undefined, pos: number,
  context: { datasetId: string; stateKey: string; chrom: string; start: number }): boolean {
  if (!useLiveLiftStore.getState().enabled || !read.live_lift) return false;
  const st = useBrowserStore.getState();
  const panel = st.panels.find(p => p.datasetId === context.datasetId && (p.stateKey ?? p.datasetId) === context.stateKey);
  if (!panel) return false;
  const ll = read.live_lift;
  const index = badge ? ll.badges?.indexOf(badge) ?? -1 : -1;
  const id = ll.badge_ids?.[index];
  const payload = id ? ll.insertions?.[id] : undefined;
  const event = read.cigar?.find(e => e.type === 'X' && Math.abs(e.pos + context.start - pos) <= 2);
  if (!id && !event && !badge) return false;
  const hap = ll.hap_label ?? ll.hap ?? '';
  const d: Difference = { id: id ?? `${hap}:site:${pos}`, hap: ll.hap ?? hap, hap_label: hap,
    kind: badge ? 'insertion' : 'snv', reason: badge?.[1] ?? (event?.source === 'reads' && !event.allele ? 'read_mismatch' : 'substitution'),
    source: !badge && event?.source === 'reads' && !event.allele ? 'reads' : 'assembly',
    t_start: badge ? context.start + badge[0] : context.start + event!.pos,
    t_end: badge ? context.start + badge[0] : context.start + event!.pos + 1,
    ref_bp: badge ? 0 : 1, alt_bp: payload?.length ?? badge?.[3] ?? 1, chain: null,
    strand: payload && !('too_large' in payload) ? payload.orientation : null,
    src: payload && !('too_large' in payload) ? { contig: payload.src[0], start: payload.src[1], end: payload.src[2] }
      : { contig: ll.source?.contig ?? null, start: null, end: null }, grch38: event?.ref ?? null, alt: null };
  const selection = { datasetId: context.datasetId, panelId: panel.id, viewKey: liveLiftViewKey(panel), chrom: context.chrom, difference: d };
  useDifferenceSelection.getState().select(selection);
  if (id) expandDifference(selection);
  return true;
}
