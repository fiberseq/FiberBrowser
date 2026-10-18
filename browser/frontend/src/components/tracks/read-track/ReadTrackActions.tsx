import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSplitPanelStore } from '../../../stores/splitPanelStore';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { seedHistoryBaseline } from '../../../stores/historySlice';
import { useReadActionsStore } from '../../../stores/readActionsStore';
import { READ_ACTIONS_HINT } from '../../../utils/shortcuts';
import { copyText } from '../../../utils/clipboard';
import { formatReadNameList } from '../../../utils/readNames';
import { beginReadPanelIntent, locateReads, readWindow } from '../../../utils/readLocate';
import { findChromInfo } from '../../../utils/chromAliases';
import { formatCoordinates } from '../../../utils/coordinates';
import { X } from '../../ui/Icons';
import { ReadContextMenu } from './ReadContextMenu';
import { TRACK_MENU_PREFIX, commonTrackMenuEntries, runTrackMenuAction } from '../TrackContextMenuHost';
import { SPLIT_IN_SPLIT, buildReadMenu, runReadMenuContribution, type ReadMenuAction } from './readMenuModel';
import { stripSegmentSuffix } from './readFilter';
import type { ReadTrackLayout } from './layout';
import type { CompactRead, SvCluster, SvSummary } from './types';
import { clusterAtCursor, clusterForEvent, clusterSupportLabel, readSvEventAt, supportingReadIds, svAlleleLabel } from './svDrawing';
import { clearSvSplit, splitBySv, splitIntoPanelsBySv } from '../../../utils/svAlleleSplit';
import { copyInsertedSequence } from '../../../utils/svInsertedSequence';
import type { ReadContextTarget } from './useReadTrackMouse';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const HINT_MS = 12_000;
const NOTICE_MS = 2_500;

export interface ReadTrackActionsProps {
  stateKey: string;
  datasetId: string;
  chrom: string;
  start: number;
  end: number;
  /** Linked-session reads are relative to the session's bounds. */
  linkedBoundsStart?: number;
  /** A panel at its own locus moves itself; otherwise the main view moves. */
  onViewportChange?: (start: number, end: number) => void;
  /** A linked (DAF-C pair) panel: its reads come from the pair, read-ID filters don't apply. */
  linked?: boolean;
  /** The reads drawn (empty while they are another view's). */
  reads: CompactRead[];
  layout: ReadTrackLayout;
  /** Header + coverage histogram above the first row. */
  rowsTop: number;
  width: number;
  sidebarWidth: number;
  regionWidth: number;
  isReversed: boolean;
  contextTarget: ReadContextTarget | null;
  closeContextMenu: () => void;
  selectFootprintAt: (x: number, y: number) => boolean;
  selectReadById: (readId: string, openStats?: boolean) => void;
  /** SV display (fb-n9-sv): the band's clusters and the read events' threshold. */
  svSummary?: SvSummary | null;
  svEnabled?: boolean;
  svMinLen?: number;
}

/** A read's drawn extent (view-relative bp) from its intervals. */
function readExtent(read: CompactRead): { lo: number; hi: number } | null {
  if (read.intervals.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const iv of read.intervals) {
    lo = Math.min(lo, iv[0]);
    hi = Math.max(hi, iv[1]);
  }
  return { lo, hi };
}

/**
 * "Exclude selected" as one undo step (saved with the session too): a
 * checkpoint, the reads hidden in this panel and the selection cleared, then
 * the step itself.
 */
export function excludeReadsUndoably(stateKey: string, ids: string[]): void {
  if (ids.length === 0) return;
  seedHistoryBaseline(useBrowserStore.getState(), 'Before excluding reads', 'analysis');
  useReadActionsStore.getState().excludeReads(stateKey, ids);
  useBrowserStore.getState().clearReadSelection(stateKey);
  const n = new Set(ids).size;
  useBrowserStore.getState().pushSnapshot?.(`Exclude ${n.toLocaleString()} selected read${n === 1 ? '' : 's'}`, { kind: 'analysis' });
}

/** Show this panel's excluded reads again, as one undo step. */
export function showExcludedUndoably(stateKey: string): void {
  if (!useReadActionsStore.getState().excludedReadIds[stateKey]) return;
  seedHistoryBaseline(useBrowserStore.getState(), 'Before showing excluded reads', 'analysis');
  useReadActionsStore.getState().clearExcluded(stateKey);
  useBrowserStore.getState().pushSnapshot?.('Show excluded reads', { kind: 'analysis' });
}

const isHighlighted = (ids: Set<string> | undefined, id: string) =>
  Boolean(ids && (ids.has(id) || ids.has(stripSegmentSuffix(id))));

/**
 * What a read panel adds for read actions (fb-r4-clicks): the right-click
 * menu and what its items do, the pulse on a read gone to by name (and
 * bringing it into view in the stack), the one-time click hint, and short
 * confirmations ("Read name copied").
 */
export function ReadTrackActions(props: ReadTrackActionsProps) {
  const {
    stateKey, datasetId, chrom, start, end, linkedBoundsStart, onViewportChange, linked = false,
    reads, layout, rowsTop, width, sidebarWidth, regionWidth, isReversed,
    contextTarget, closeContextMenu, selectFootprintAt, selectReadById,
    svSummary = null, svEnabled = false, svMinLen = 50,
  } = props;
  const { highlight, excluded, hintHere, notice } = useReadActionsStore(useShallow(s => ({
    highlight: s.highlight,
    excluded: s.excludedReadIds[stateKey],
    hintHere: s.hintStateKey === stateKey,
    notice: s.notice?.stateKey === stateKey ? s.notice : null,
  })));
  const isBam = useBrowserStore(s => s.datasets.find(d => d.id === datasetId)?.data_type === 'bam');
  const { selected, hasReadFilter, svSplitActive, inSplitPanel } = useBrowserStore(useShallow(s => ({
    selected: s.selectedReadIds[stateKey],
    hasReadFilter: Boolean(s.filteredReadIds[stateKey]),
    svSplitActive: Boolean(s.svSplits[stateKey]),
    inSplitPanel: s.panels.some(p => p.readSubset && (p.stateKey ?? p.datasetId) === stateKey),
  })));
  const origin = linkedBoundsStart ?? start;

  const navigate = useCallback((s: number, e: number) => {
    const store = useBrowserStore.getState();
    const info = findChromInfo(store.chroms, chrom);
    const lo = info?.circular ? Math.round(s) : Math.max(0, Math.round(s));
    const hi = Math.max(lo + 1, Math.round(e));
    if (onViewportChange) onViewportChange(lo, hi);
    else store.setViewport(chrom, lo, hi);
  }, [chrom, onViewportChange]);

  const say = useCallback((text: string) => useReadActionsStore.getState().showNotice(stateKey, text), [stateKey]);

  // --- the menu -------------------------------------------------------------
  const target = contextTarget;
  // SVs under the pointer (fb-n9-sv): the read's own event, the cluster at the cursor.
  const svTarget = useMemo(() => {
    if (!target || !svEnabled) return null;
    const bpPerPx = regionWidth / Math.max(1, width - sidebarWidth);
    const readEvent = target.read ? readSvEventAt(target.read, target.genomePos, 5 * bpPerPx, svMinLen) : null;
    const thisCluster: SvCluster | null = readEvent ? clusterForEvent(svSummary, readEvent) : null;
    const atCursor = clusterAtCursor(svSummary, target.genomePos, bpPerPx);
    return { readEvent, thisCluster, atCursor };
  }, [target, svEnabled, svSummary, svMinLen, regionWidth, width, sidebarWidth]);
  const describe = (c: SvCluster) => `${svAlleleLabel(c.t, c.ref, c.len, chrom).split(' @ ')[0]}, ${clusterSupportLabel(c)}`;
  const entries = useMemo(() => {
    if (!target) return [];
    const fp = target.footprint;
    const sv = svEnabled ? {
      thisEvent: svTarget?.readEvent ? svAlleleLabel(svTarget.readEvent.t, svTarget.readEvent.ref, svTarget.readEvent.len, chrom).split(' @ ')[0] : null,
      thisInsertion: svTarget?.readEvent?.t === 'I',
      atCursor: svTarget?.atCursor ? describe(svTarget.atCursor) : null,
      splitActive: svSplitActive,
      ...(inSplitPanel ? { splitPanelsBlocked: SPLIT_IN_SPLIT } : {}),
    } : undefined;
    return buildReadMenu({
      readId: target.read?.id ?? null,
      footprint: fp ? { label: `${Math.abs(fp.interval[2] ?? (fp.interval[1] - fp.interval[0])).toLocaleString()} bp${fp.layer ? `, ${fp.layer}` : ''}` } : null,
      readSelected: Boolean(target.read && selected?.has(target.read.id)),
      selectedCount: selected?.size ?? 0,
      hasReadFilter,
      excludedCount: excluded?.size ?? 0,
      readHighlighted: Boolean(target.read && isHighlighted(highlight?.ids, target.read.id)),
      anyHighlight: Boolean(highlight && highlight.ids.size > 0),
      isMac: IS_MAC,
      filtersUnavailable: linked ? 'Not in a linked pair panel: its reads are the pair\'s' : undefined,
      sv,
      bamReads: isBam && !linked,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, selected, hasReadFilter, excluded, highlight, linked, isBam, svEnabled, svTarget, svSplitActive, inSplitPanel, chrom]);

  const readLocus = useCallback(async (read: CompactRead): Promise<string> => {
    // The read's whole alignment (its drawn intervals stop at the view's edges).
    try {
      const res = await locateReads([read.id], {
        viewport: { chrom, start, end }, datasetIds: [datasetId], budgetS: 5,
      });
      const hit = res.found[0];
      if (hit) return formatCoordinates(hit.chrom, hit.start, hit.end);
    } catch { /* the drawn extent then */ }
    const ext = readExtent(read);
    if (!ext) return formatCoordinates(chrom, start, end);
    // As the locus box writes and reads them, so a copied locus pastes back exactly.
    return formatCoordinates(chrom, origin + ext.lo, origin + ext.hi);
  }, [chrom, start, end, datasetId, origin]);

  const runAction = useCallback(async (action: ReadMenuAction, t: ReadContextTarget) => {
    const store = useBrowserStore.getState();
    const actions = useReadActionsStore.getState();
    const read = t.read;
    const selectedIds = [...(store.selectedReadIds[stateKey] ?? [])];
    switch (action) {
      case 'select-read':
        if (read) selectReadById(read.id, !store.selectedReadIds[stateKey]?.has(read.id));
        break;
      case 'select-footprint':
        selectFootprintAt(t.x, t.y);
        break;
      case 'open-read-stats':
        if (read && !store.selectedReadIds[stateKey]?.has(read.id)) store.toggleReadSelection(stateKey, read.id);
        store.openAnalysisPanel('read-stats');
        break;
      case 'copy-read-name':
        if (read) say(await copyText(read.id) ? 'Read name copied' : 'Could not copy');
        break;
      case 'copy-read-locus':
        if (read) say(await copyText(await readLocus(read)) ? 'Locus of read copied' : 'Could not copy');
        break;
      case 'highlight-read':
        if (read) actions.highlightReads([read.id]);
        break;
      case 'clear-highlight':
        actions.clearHighlight();
        break;
      case 'zoom-to-read': {
        if (!read) break;
        // Taken before the lookup: a pan, another Go to or another session meanwhile makes the answer stale.
        const intent = beginReadPanelIntent(stateKey);
        const res = await locateReads([read.id], {
          viewport: { chrom, start, end }, datasetIds: [datasetId], budgetS: 5,
        }).catch(() => null);
        if (!intent.isCurrent()) break;
        const hit = res?.found[0];
        const ext = readExtent(read);
        const span = hit && hit.chrom === chrom ? hit : ext ? { start: origin + ext.lo, end: origin + ext.hi } : null;
        if (!span) break;
        actions.pulseReads([read.id]);
        const win = readWindow(span, store.spanningOnly);
        navigate(win.start, win.end);
        break;
      }
      case 'copy-selected-names': {
        const names = selectedIds;
        if (names.length) say(await copyText(formatReadNameList(names)) ? `${new Set(names).size.toLocaleString()} read names copied` : 'Could not copy');
        break;
      }
      case 'keep-selected':
        if (selectedIds.length) {
          seedHistoryBaseline(store, 'Before keeping only the selected reads', 'analysis');
          store.setFilteredReadIds(stateKey, new Set(selectedIds));
          useBrowserStore.getState().pushSnapshot?.('Keep only selected reads', { kind: 'analysis' });
        }
        break;
      case 'exclude-selected':
        if (selectedIds.length) {
          excludeReadsUndoably(stateKey, selectedIds);
          say(`${selectedIds.length.toLocaleString()} reads excluded from this panel`);
        }
        break;
      case 'clear-read-filter':
        seedHistoryBaseline(store, 'Before showing all reads', 'analysis');
        store.setFilteredReadIds(stateKey, null);
        useBrowserStore.getState().pushSnapshot?.('Show all reads', { kind: 'analysis' });
        break;
      case 'show-excluded':
        showExcludedUndoably(stateKey);
        break;
      case 'clear-selection':
        store.clearReadSelection(stateKey);
        break;
      case 'find-read-by-name': {
        const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-testid="location-search-input"], [data-testid="panel-location-input"]')];
        const box = boxes.find(b => !b.disabled);
        if (box) {
          box.focus();
          box.select();
        }
        say('Paste a read name (or several, comma separated) and press Enter');
        break;
      }
      case 'zoom-in-here': {
        const half = Math.max(50, (end - start) / 4);
        navigate(t.genomePos - half, t.genomePos + half);
        break;
      }
      case 'zoom-out': {
        const center = (start + end) / 2;
        const half = (end - start) * 0.75;
        navigate(center - half, center + half);
        break;
      }
      case 'copy-view-locus':
        say(await copyText(formatCoordinates(chrom, start, end)) ? 'Locus copied' : 'Could not copy');
        break;
      case 'copy-position':
        say(await copyText(`${chrom}:${t.genomePos.toLocaleString()}`) ? 'Position copied' : 'Could not copy');
        break;
      case 'sv-split-this':
      case 'sv-split-at-cursor': {
        const cluster = action === 'sv-split-at-cursor' ? svTarget?.atCursor : svTarget?.thisCluster;
        if (!cluster) break;
        try {
          const def = await splitBySv({ stateKey, datasetId, chrom, viewStart: start, viewEnd: end }, cluster);
          say(`Split by ${def.label}: ${def.counts[0]} carriers, ${def.counts[1]} reference, ${def.counts[2]} not informative`);
        } catch {
          say('Could not split the reads by this SV');
        }
        break;
      }
      case 'sv-split-this-panels':
      case 'sv-split-at-cursor-panels': {
        const cluster = action === 'sv-split-at-cursor-panels' ? svTarget?.atCursor : svTarget?.thisCluster;
        const panel = store.panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === stateKey);
        if (!cluster || !panel) break;
        try {
          await splitIntoPanelsBySv({ stateKey, datasetId, chrom, viewStart: start, viewEnd: end }, cluster, panel.id);
        } catch {
          say('Could not split the reads by this SV');
        }
        break;
      }
      case 'sv-highlight-supporting':
      case 'sv-highlight-putative':
      case 'sv-highlight-ambiguous': {
        const cluster = svTarget?.thisCluster;
        if (!cluster) break;
        const level = action === 'sv-highlight-putative' ? 'putative' : action === 'sv-highlight-ambiguous' ? 'ambiguous' : 'confirmed';
        const ids = supportingReadIds(reads, cluster, chrom, level, svSummary?.evidence_targets ?? svSummary?.clusters);
        if (ids.length) actions.highlightReads(ids);
        else actions.clearHighlight();
        store.setSvSelectedCluster(stateKey, cluster.id);
        break;
      }
      case 'sv-copy-inserted': {
        const ev = svTarget?.readEvent;
        if (read && ev && ev.t === 'I') await copyInsertedSequence({ datasetId, chrom, readId: read.id, event: ev, stateKey });
        break;
      }
      case 'sv-clear-split':
        clearSvSplit(stateKey);
        break;
      case 'sv-split-panels': {
        // The allele groups this panel shows, one panel each (their read names: SV groups belong to this view).
        const panel = store.panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === stateKey);
        if (panel) useSplitPanelStore.getState().request({ kind: 'frozen', panelId: panel.id, title: store.svSplits[stateKey]?.label ?? 'SV alleles' }, [panel.id]);
        break;
      }
      default: {
        // A plugin pack's item (readMenuModel.registerReadMenuContribution).
        const panelId = store.panels.find(p => (p.stateKey ?? p.datasetId) === stateKey)?.id;
        runReadMenuContribution(action, {
          datasetId, chrom, stateKey, panelId, genomePos: t.genomePos,
          svClusters: [svTarget?.thisCluster, svTarget?.atCursor], say,
        });
      }
    }
  }, [stateKey, chrom, start, end, datasetId, origin, navigate, say, readLocus, selectFootprintAt, selectReadById, svTarget, reads]);

  // --- the pulse and bringing the read into view ------------------------------
  const stride = layout.rowHeight + layout.rowGap;
  const pulseIndex = useMemo(() => {
    if (!highlight?.scrollTo) return -1;
    const want = highlight.scrollTo;
    return reads.findIndex(r => r.id === want || stripSegmentSuffix(r.id) === want);
  }, [highlight, reads]);

  useEffect(() => {
    if (!highlight?.scrollTo || pulseIndex < 0 || highlight.scrolled.has(stateKey)) return;
    if (layout.needsScroll) {
      const centered = pulseIndex * stride - layout.trackHeight / 2 + layout.rowHeight / 2;
      useBrowserStore.getState().setReadScrollOffset(stateKey, Math.max(0, Math.min(layout.maxScrollOffset, centered)));
    }
    useReadActionsStore.getState().markScrolled(stateKey);
  }, [highlight, pulseIndex, stateKey, layout.needsScroll, layout.trackHeight, layout.rowHeight, layout.maxScrollOffset, stride]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!highlight?.pulseUntil) return;
    setNow(Date.now());
    const left = highlight.pulseUntil - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), left + 20);
    return () => window.clearTimeout(timer);
  }, [highlight]);
  const pulsing = Boolean(highlight?.pulseUntil && highlight.pulseUntil > now);

  const pulseBoxes = useMemo(() => {
    if (!pulsing || !highlight) return [];
    const trackWidth = width - sidebarWidth;
    const scale = trackWidth / Math.max(1, regionWidth);
    const linkedOffset = linkedBoundsStart !== undefined ? linkedBoundsStart - start : 0;
    const boxes: { id: string; left: number; top: number; width: number; height: number }[] = [];
    reads.forEach((read, i) => {
      if (!isHighlighted(highlight.ids, read.id)) return;
      const ext = readExtent(read);
      if (!ext) return;
      const lo = ext.lo + linkedOffset;
      const hi = ext.hi + linkedOffset;
      const x0 = isReversed ? sidebarWidth + (regionWidth - hi) * scale : sidebarWidth + lo * scale;
      const top = rowsTop + i * stride - layout.scrollAdjust;
      if (top + layout.rowHeight < rowsTop || top > rowsTop + layout.trackHeight) return;
      // At a pixel or two per row the ring is still a band one can see.
      const rowH = Math.max(1, layout.rowHeight - layout.rowGap);
      const height = Math.max(10, rowH) + 6;
      boxes.push({
        id: read.id,
        left: Math.max(sidebarWidth, x0) - 3,
        top: top + rowH / 2 - height / 2,
        width: Math.min(width, x0 + (hi - lo) * scale) - Math.max(sidebarWidth, x0) + 6,
        height,
      });
    });
    return boxes;
  }, [pulsing, highlight, reads, width, sidebarWidth, regionWidth, linkedBoundsStart, start, isReversed, rowsTop, stride, layout]);

  // --- the hint and notices -----------------------------------------------------
  useEffect(() => {
    if (!hintHere) return;
    const timer = window.setTimeout(() => useReadActionsStore.getState().dismissHint(), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hintHere]);
  useEffect(() => {
    if (!notice) return;
    const n = notice.nonce;
    const timer = window.setTimeout(() => useReadActionsStore.getState().clearNotice(n), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <>
      {pulseBoxes.map(box => (
        <div
          key={`${box.id}-${highlight?.nonce}`}
          data-testid="read-highlight-pulse"
          data-read-id={box.id}
          data-render-hide="true"
          aria-hidden="true"
          className="pointer-events-none absolute z-10 animate-pulse rounded-sm ring-2 ring-yellow-500 ring-offset-1 ring-offset-white/70"
          style={{ left: box.left, top: box.top, width: Math.max(4, box.width), height: box.height }}
        />
      ))}
      {excluded && excluded.size > 0 && (
        // Left of the track's corner buttons (Minimize, Remove: hidden until hover, they would take the click on Show).
        <div className="absolute right-14 top-1 z-20 flex items-center gap-1 rounded bg-white/90 px-1.5 py-0.5 text-[11px] text-gray-600 shadow-sm dark:bg-gray-900/90 dark:text-gray-300" data-render-hide="true" data-testid={`excluded-reads-${stateKey}`}>
          {excluded.size.toLocaleString()} excluded
          <button type="button" className="underline hover:text-gray-900 dark:hover:text-white" onClick={() => showExcludedUndoably(stateKey)}>Show</button>
        </div>
      )}
      {notice && (
        <div role="status" className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded bg-gray-900/85 px-2 py-0.5 text-[11px] text-white shadow" data-render-hide="true" data-testid="read-action-notice">
          {notice.text}
        </div>
      )}
      {hintHere && (
        <div
          role="note"
          data-testid="read-actions-hint"
          data-render-hide="true"
          className="absolute bottom-2 left-1/2 z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 rounded-fb border border-line bg-white px-2.5 py-1 text-[12px] text-gray-700 shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:text-gray-200"
        >
          <span className="truncate">{READ_ACTIONS_HINT}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="rounded p-0.5 text-ink-muted hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"
            onClick={() => useReadActionsStore.getState().dismissHint()}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {target && entries.length > 0 && (
        <ReadContextMenu<string>
          x={target.clientX}
          y={target.clientY}
          entries={[...entries, { kind: 'separator' }, ...commonTrackMenuEntries('reads')]}
          title={target.read ? target.read.id : `${chrom}:${target.genomePos.toLocaleString()}`}
          onClose={closeContextMenu}
          onAction={(action) => {
            if (action.startsWith(TRACK_MENU_PREFIX)) {
              // The common track items (Tracks in this panel…, Track settings): this panel's.
              const panel = useBrowserStore.getState().panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === stateKey);
              if (panel) runTrackMenuAction(action, panel.id, 'reads', { x: target.clientX, y: target.clientY });
              return;
            }
            void runAction(action as ReadMenuAction, target);
          }}
        />
      )}
    </>
  );
}
