/**
 * What a click or the right-click menu does on a difference (the live-lift Differences row and the native SV row
 * alike; owner direction 19 Oct):
 *
 * - plain click on an insertion: expand it in place across the panels, or collapse it again (no inspector);
 * - plain click on any other difference: highlight its carrier reads (no inspector);
 * - Shift-click: select it only (multi-select where the row has it);
 * - ⌘/Ctrl-click, or "Inspect…" in its menu: the inspector (its observations load within the auto-load bound).
 *
 * Its menu also offers expand/collapse, split by carrier (in the inspector), the source view, and copying its
 * sequence.
 */
import { copyText } from '../../utils/clipboard';
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import type { ContextMenuEntry } from '../../components/tracks/read-track/ReadContextMenu';
import type { Difference } from '../liveLift/differenceTypes';
import { getDifferenceReads } from '../liveLift/api';
import { expandDifference, useDifferenceSelection, type DifferenceSelection } from './selectionStore';
import { expandableAltBlock } from './capabilities';
import { AUTO_LOAD_MAX_READS } from './autoLoad';

export const DIFFERENCE_CLICK_HINT = 'click: expand · ⌘-click / right-click: inspect';
export const DIFFERENCE_SELECT_HINT = 'click: highlight carriers · ⌘-click / right-click: inspect';

/** The marker's tooltip: its description and what clicks do. */
export function differenceHint(d: Pick<Difference, 'kind' | 'alt_bp' | 'ref_bp'>): string {
  return isExpandable(d) ? DIFFERENCE_CLICK_HINT : DIFFERENCE_SELECT_HINT;
}

export function isExpandable(d: Pick<Difference, 'kind' | 'alt_bp' | 'ref_bp'>): boolean {
  return (d.kind === 'insertion' || d.kind === 'replacement') && expandableAltBlock(d);
}

/** Whether a difference is expanded in its view now. */
export function isExpanded(s: Pick<DifferenceSelection, 'viewKey' | 'difference'>): boolean {
  const open = useBrowserStore.getState().liveLiftExpansions?.[s.viewKey] ?? [];
  return open.some(e => e.ins_id === s.difference.id || e.alleles?.some(a => a.ins_id === s.difference.id));
}

/** Expand an insertion in place across the panels, or collapse it when it is open. */
export function toggleExpansion(s: DifferenceSelection): boolean {
  const st = useBrowserStore.getState();
  const open = (st.liveLiftExpansions?.[s.viewKey] ?? []).find(e => e.ins_id === s.difference.id || e.alleles?.some(a => a.ins_id === s.difference.id));
  if (open) { st.collapseLiveLift(s.viewKey, open.ins_id); return true; }
  return expandDifference(s);
}

/** Open the inspector (observations load by themselves within the bound). */
export function inspectDifference(s: DifferenceSelection): void {
  useDifferenceSelection.getState().select({ ...s, inspect: true });
}

let highlightRequest: AbortController | null = null;

/** Highlight a difference's carrier reads in every panel (lightweight: no inspector). Above the auto-load bound only
 * its guide line shows. */
export async function highlightCarriers(s: DifferenceSelection, readsInView: number): Promise<void> {
  useDifferenceSelection.getState().select({ ...s, inspect: false });
  highlightRequest?.abort();
  const actions = useReadActionsStore.getState();
  const dataset = useBrowserStore.getState().datasets.find(x => x.id === s.datasetId);
  if (dataset?.data_type !== 'bam_livelift' || readsInView > AUTO_LOAD_MAX_READS) return;
  const controller = new AbortController();
  highlightRequest = controller;
  const d = s.difference;
  try {
    const r = await getDifferenceReads({ datasetId: s.datasetId, liftKey: dataset.live_lift?.key ?? '', chrom: s.chrom,
      pos: d.t_start, end: Math.max(d.t_start, d.t_end), liftHap: d.hap_label || undefined, itemId: d.id }, controller.signal);
    if (controller.signal.aborted) return;
    const ids = r.rows.filter(row => row.allele === 'hg002' || row.carries_insertion || row.carries_deletion).map(row => row.id);
    if (ids.length) actions.highlightReads([...new Set(ids)]);
    else actions.clearHighlight();
  } catch { /* the selection's guide line remains */ }
}

/** The plain/⌘/Shift click on a difference marker. `select`: Shift-click (the row's own selection). */
export function clickDifference(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, s: DifferenceSelection,
  readsInView: number, select?: () => void): void {
  if (e.metaKey || e.ctrlKey) { inspectDifference(s); return; }
  if (e.shiftKey) { if (select) select(); else useDifferenceSelection.getState().select({ ...s, inspect: false }); return; }
  if (isExpandable(s.difference)) { toggleExpansion(s); return; }
  void highlightCarriers(s, readsInView);
}

export type DifferenceMenuAction = 'diff:inspect' | 'diff:expand' | 'diff:split' | 'diff:source' | 'diff:copy' | 'diff:highlight';

/** A difference's own menu items (the strip's options follow them). */
export function differenceMenuEntries(s: DifferenceSelection, opts: { sourceView?: boolean } = {}): ContextMenuEntry[] {
  const d = s.difference;
  const entries: ContextMenuEntry[] = [
    { kind: 'heading', label: `${d.hap_label ? `${d.hap_label} ` : ''}${d.kind.replace(/_/g, ' ')} · ${Math.max(d.alt_bp, d.ref_bp).toLocaleString()} bp` },
    { kind: 'item', action: 'diff:inspect', label: 'Inspect…', icon: 'search', shortcut: '⌘-click', title: 'The inspector: alleles, observed bases and chromatin per read' },
  ];
  if (isExpandable(d)) entries.push({ kind: 'item', action: 'diff:expand', label: isExpanded(s) ? 'Collapse insertion' : 'Expand insertion', icon: 'layers', shortcut: 'click',
    title: 'Show the inserted bases in place across the panels' });
  else entries.push({ kind: 'item', action: 'diff:highlight', label: 'Highlight carrier reads', icon: 'reads', shortcut: 'click' });
  entries.push({ kind: 'item', action: 'diff:split', label: 'Split by carrier…', icon: 'split', title: 'Opens the inspector, where its carriers split the reads into groups or panels' });
  if (opts.sourceView !== false && d.src?.contig && d.src.start != null) entries.push({ kind: 'item', action: 'diff:source', label: 'Show in the source view', icon: 'target', title: 'The source haplotype view at this difference (linked through the map when one is open)' });
  entries.push({ kind: 'item', action: 'diff:copy', label: 'Copy sequence', icon: 'download', title: 'The alternate allele\'s bases (needs the source assembly FASTA for map differences)' });
  return entries;
}

export async function runDifferenceMenuAction(action: string, s: DifferenceSelection, readsInView: number): Promise<boolean> {
  switch (action) {
    case 'diff:inspect': inspectDifference(s); return true;
    case 'diff:expand': toggleExpansion(s); return true;
    case 'diff:highlight': void highlightCarriers(s, readsInView); return true;
    case 'diff:split': useDifferenceSelection.getState().select({ ...s, inspect: true, action: undefined }); return true;
    case 'diff:source': {
      const { showInSourceView } = await import('../liveLift/linking/sourceJump');
      await showInSourceView(s);
      return true;
    }
    case 'diff:copy': {
      const panel = useBrowserStore.getState().panels.find(p => p.id === s.panelId);
      const key = panel?.stateKey ?? panel?.datasetId ?? s.panelId;
      try {
        const p = new URLSearchParams({ dataset_id: s.datasetId, chrom: s.chrom, item_id: s.difference.id,
          pos: String(s.difference.t_start), allele: 'alternate' });
        const r = await fetchJson<{ sequence: string; total: number }>(`/api/lift/difference_sequence?${p}`);
        const ok = await copyText(r.sequence);
        useReadActionsStore.getState().showNotice(key, ok ? `Copied ${r.sequence.length.toLocaleString()} bases${r.total > r.sequence.length ? ` of ${r.total.toLocaleString()}` : ''}` : 'Could not copy to the clipboard');
      } catch (e) {
        useReadActionsStore.getState().showNotice(key, `No sequence to copy: ${String((e as Error).message ?? e)}`);
      }
      return true;
    }
    default: return false;
  }
}
