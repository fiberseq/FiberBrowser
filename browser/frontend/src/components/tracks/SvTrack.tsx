/**
 * The SV track (fb-n9-sv summary; its own row since fb-n11-tracks): the SV
 * clusters of the panel's reads in view, as deletion arcs, insertion flags and
 * clip pile ticks scaled to the row's height. Resized, deleted and restored
 * like every other track. Every glyph, faint (weak) ones included, has a hit
 * box at least SV_MIN_HIT_PX wide, a tooltip saying what it is, and the same
 * click (highlight its reads) and right-click actions (split; plugin packs add their own).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { feedHasSv, useTrackFeedStore } from '../../stores/trackFeedStore';
import { useTrackMenuStore } from '../../stores/trackMenuStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import type { PanelConfig } from '../../types';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { usePanOffsetTransform } from '../../hooks/usePanOffsetTransform';
import { clearSvSplit, splitBySv, splitIntoPanelsBySv } from '../../utils/svAlleleSplit';
import { svRowSelection } from './svRowSelection';
import { useInsertedBases } from '../../utils/svInsertedSequence';
import { drawSvBand } from './read-track/svCanvas';
import {
  clipPileAtBandX, clusterAtBandX, clusterSupportLabel, describeSvCluster, svAlleleLabel, svBandMetrics, supportingReadIds,
} from './read-track/svDrawing';
import { runReadMenuContribution, SPLIT_IN_SPLIT, svClusterHints, svClusterMenu } from './read-track/readMenuModel';
import type { SvCluster, SvSummary } from './read-track/types';
import { TRACK_BACKGROUND } from './TrackContainerConstants';

/** x/y: track px; cx/cy: client px (the tooltip is fixed, over the reads below). */
type Hover =
  | { kind: 'cluster'; cluster: SvCluster; x: number; y: number; cx?: number; cy?: number }
  | { kind: 'clips'; pile: SvSummary['clips'][number]; x: number; y: number; cx?: number; cy?: number };

const NO_FEATURES: never[] = [];

export function SvTrack({ width, height, panel, sidebarWidth = 0 }: {
  width: number; height: number; panel: PanelConfig; sidebarWidth?: number;
}) {
  const stateKey = panel.stateKey ?? panel.datasetId ?? '';
  const datasetId = panel.datasetId ?? '';
  const feed = useTrackFeedStore(s => s.byStateKey[stateKey]);
  const { selectedId, splitActive, exportInProgress, isBam } = useBrowserStore(useShallow(s => ({
    selectedId: s.svSelectedCluster[stateKey] ?? null,
    splitActive: Boolean(s.svSplits[stateKey]),
    exportInProgress: s.exportInProgress,
    isBam: s.datasets.find(d => d.id === datasetId)?.data_type === 'bam',
  })));
  // SVs in the feature selection (shift-click, when a plugin pack provides it: svRowSelection): drawn as selected.
  const svSelection = svRowSelection();
  const selectedSvs = useBrowserStore(useShallow(s => (svSelection ? svSelection.selected(s.selectedFeatures, datasetId) : NO_FEATURES)));
  const canvasRenderVersion = useCanvasRenderVersion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const summary = feedHasSv(feed) ? feed!.sv : null;
  const metrics = svBandMetrics(height);
  // The view the panel shows now (clusters are absolute positions).
  const viewStart = feed?.start ?? 0;
  const regionWidth = Math.max(1, (feed?.end ?? 1) - viewStart);
  const isReversed = Boolean(feed?.isReversed);
  const toX = useCallback((rel: number) => {
    const scale = (width - sidebarWidth) / regionWidth;
    return isReversed ? sidebarWidth + (regionWidth - rel) * scale : sidebarWidth + rel * scale;
  }, [width, sidebarWidth, regionWidth, isReversed]);
  usePanOffsetTransform(canvasRef, { scope: feed?.panScope ?? 'main' });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;
    ctx.fillStyle = TRACK_BACKGROUND.signal;
    ctx.fillRect(0, 0, width, height);
    if (!summary) return;
    drawSvBand(ctx, summary, {
      top: 0, height, width, sidebarWidth, viewStart, toX, isReversed,
      selectedId: exportInProgress ? null : selectedId,
      isFeatureSelected: exportInProgress || !selectedSvs.length || !svSelection ? undefined
        : c => selectedSvs.some(f => svSelection.matches(f, c, datasetId, feed?.chrom ?? '')),
      hoverId: exportInProgress || hover?.kind !== 'cluster' ? null : hover.cluster.id,
      backgroundColor: TRACK_BACKGROUND.signal,
    });
  }, [summary, width, height, sidebarWidth, viewStart, toX, isReversed, selectedId, selectedSvs, feed?.chrom, datasetId, hover, exportInProgress, canvasRenderVersion]);

  const hitAt = useCallback((x: number): Hover | null => {
    if (!summary || x < sidebarWidth) return null;
    const cluster = clusterAtBandX(summary, x, viewStart, toX, metrics.flagW, isReversed);
    if (cluster) return { kind: 'cluster', cluster, x, y: 0 };
    const pile = clipPileAtBandX(summary, x, viewStart, toX);
    return pile ? { kind: 'clips', pile, x, y: 0 } : null;
  }, [summary, sidebarWidth, viewStart, toX, metrics.flagW, isReversed]);

  const local = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * e.currentTarget.clientWidth / Math.max(1, rect.width),
      y: (e.clientY - rect.top) * e.currentTarget.clientHeight / Math.max(1, rect.height),
    };
  };

  const highlight = (cluster: SvCluster | null) => {
    const store = useBrowserStore.getState();
    const actions = useReadActionsStore.getState();
    if (!cluster || store.svSelectedCluster[stateKey] === cluster.id) {
      const had = Boolean(store.svSelectedCluster[stateKey]);
      store.setSvSelectedCluster(stateKey, null);
      if (had) actions.clearHighlight();
      return;
    }
    store.setSvSelectedCluster(stateKey, cluster.id);
    // Its supporting reads among those drawn: the read highlight (all panels).
    const ids = supportingReadIds(feed?.reads ?? [], cluster, feed?.chrom, 'carriers', feed?.sv?.evidence_targets ?? feed?.sv?.clusters, feed?.sv?.conflict_options);
    if (ids.length > 0) actions.highlightReads(ids, { uncertainIds: supportingReadIds(feed?.reads ?? [], cluster, feed?.chrom, 'putative', feed?.sv?.evidence_targets ?? feed?.sv?.clusters, feed?.sv?.conflict_options) });
    else actions.clearHighlight();
  };

  const say = (text: string) => useReadActionsStore.getState().showNotice(stateKey, text);
  const runOwn = async (action: string, cluster: SvCluster | null) => {
    if (!feed) return;
    switch (action) {
      case 'sv-split-this': {
        if (!cluster) return;
        try {
          const def = await splitBySv({ stateKey, datasetId, chrom: feed.chrom, viewStart: feed.start, viewEnd: feed.end }, cluster);
          say(`Grouped by ${def.label}: ${def.counts[0]} carriers, ${def.counts[1]} reference, ${def.counts[2]} not informative (all reads in view)`);
        } catch {
          say('Could not split the reads by this SV');
        }
        return;
      }
      case 'sv-split-this-panels': {
        if (!cluster) return;
        try {
          await splitIntoPanelsBySv({ stateKey, datasetId, chrom: feed.chrom, viewStart: feed.start, viewEnd: feed.end }, cluster, panel.id);
        } catch {
          say('Could not split the reads by this SV');
        }
        return;
      }
      case 'sv-highlight-supporting':
      case 'sv-highlight-confirmed':
      case 'sv-highlight-putative':
      case 'sv-highlight-conflicting':
      case 'sv-highlight-ambiguous': {
        if (!cluster) return;
        const level = action === 'sv-highlight-conflicting' ? 'conflicting' : action === 'sv-highlight-putative' ? 'putative' : action === 'sv-highlight-ambiguous' ? 'ambiguous' : action === 'sv-highlight-confirmed' ? 'confirmed' : 'carriers';
        const ids = supportingReadIds(feed.reads, cluster, feed.chrom, level, feed.sv?.evidence_targets ?? feed.sv?.clusters, feed.sv?.conflict_options);
        if (ids.length) useReadActionsStore.getState().highlightReads(ids, { uncertainIds: level === 'confirmed' ? [] : level === 'carriers'
          ? supportingReadIds(feed.reads, cluster, feed.chrom, 'putative', feed.sv?.evidence_targets ?? feed.sv?.clusters, feed.sv?.conflict_options) : ids });
        else useReadActionsStore.getState().clearHighlight();
        useBrowserStore.getState().setSvSelectedCluster(stateKey, cluster.id);
        return;
      }
      case 'sv-clear-split': clearSvSplit(stateKey); return;
      case 'sv-split-panels':
        // The allele groups this panel shows, one panel each (fb-n11-features' Split into panels).
        useSplitPanelStore.getState().request({ kind: 'frozen', panelId: panel.id, title: useBrowserStore.getState().svSplits[stateKey]?.label ?? 'SV alleles' }, [panel.id]);
        return;
      default:
        // A plugin pack's item (readMenuModel.registerReadMenuContribution).
        runReadMenuContribution(action, { datasetId, chrom: feed.chrom, stateKey, panelId: panel.id, svClusters: [cluster], say });
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x } = local(e);
    const hit = hitAt(x);
    openMenuAt(hit?.kind === 'cluster' ? hit.cluster : null, e.clientX, e.clientY);
  };

  // The track's menu for a cluster (or the row), at a client position; the hover card hides under it (SV-5).
  const openMenuAt = (cluster: SvCluster | null, clientX: number, clientY: number) => {
    setHover(null);
    const own = svClusterMenu({
      cluster: cluster ? `${svAlleleLabel(cluster.t, cluster.ref, cluster.len, feed?.chrom ?? '').split(' @ ')[0]}, ${clusterSupportLabel(cluster)}` : null,
      insertion: cluster?.t === 'I',
      splitActive,
      splitAllowed: !feed?.linked,
      ...(panel.readSubset ? { splitPanelsBlocked: SPLIT_IN_SPLIT } : {}),
      bamReads: isBam && !feed?.linked,
    });
    useTrackMenuStore.getState().openMenu({
      panelId: panel.id, type: 'sv', x: clientX, y: clientY, own, title: 'SV track',
      onOwn: action => { void runOwn(action, cluster); },
    });
  };

  // ---- the keyboard path (audit SV-10): focus the row, arrows move between the SVs in view (the glyph lights up and
  // its card shows), Enter highlights its reads, Shift+Enter selects it, Shift+F10 / the Menu key opens its actions.
  const menuOpen = useTrackMenuStore(s => s.menu?.panelId === panel.id && s.menu?.type === 'sv');
  const inView = useMemo(() => (summary?.clusters ?? [])
    .filter(c => c.ref + (c.t === 'D' ? c.len : 0) >= viewStart && c.ref <= viewStart + regionWidth)
    .sort((a, b) => a.ref - b.ref), [summary, viewStart, regionWidth]);
  const [keyIndex, setKeyIndex] = useState<number | null>(null);
  const focusCluster = (i: number) => {
    const c = inView[i];
    const canvas = canvasRef.current;
    if (!c || !canvas) return;
    setKeyIndex(i);
    const rel = (c.t === 'D' ? c.ref + c.len / 2 : c.ref) - viewStart;
    const x = toX(rel);
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / Math.max(1, canvas.clientWidth);
    setHover({ kind: 'cluster', cluster: c, x, y: height / 2, cx: rect.left + x * scale, cy: rect.top + rect.height / 2 });
  };
  const keyCluster = keyIndex != null ? inView[keyIndex] ?? null : null;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!inView.length) return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    const at = keyIndex ?? -1;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': handled(); focusCluster(Math.min(inView.length - 1, at + 1)); break;
      case 'ArrowLeft': case 'ArrowUp': handled(); focusCluster(Math.max(0, at < 0 ? 0 : at - 1)); break;
      case 'Home': handled(); focusCluster(0); break;
      case 'End': handled(); focusCluster(inView.length - 1); break;
      case 'Enter': case ' ':
        if (!keyCluster) return;
        handled();
        if ((e.shiftKey || e.key === ' ') && svSelection && feed) svSelection.toggle(keyCluster, datasetId, feed.chrom);
        else highlight(keyCluster);
        break;
      case 'ContextMenu': case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return;
        handled();
        const c = keyCluster ?? inView[0];
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect || !c) return;
        const x = rect.left + toX((c.t === 'D' ? c.ref + c.len / 2 : c.ref) - viewStart) * (rect.width / Math.max(1, canvasRef.current!.clientWidth));
        openMenuAt(c, x, rect.top + rect.height / 2);
        break;
      }
      case 'Escape': if (keyIndex != null) { handled(); setKeyIndex(null); setHover(null); } break;
      default: break;
    }
  };

  return (
    <div className="relative focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500" style={{ width, height }}
      data-copilot-track="sv" data-testid={`sv-track-${datasetId}`}
      data-sv-clusters={summary?.clusters.length ?? 0} data-figure-fill={TRACK_BACKGROUND.signal}
      tabIndex={inView.length ? 0 : -1} role="group" onKeyDown={onKeyDown}
      onBlur={e => { if (keyIndex != null && !e.currentTarget.contains(e.relatedTarget as Node)) { setKeyIndex(null); if (!menuOpen) setHover(null); } }}
      aria-label={`SV row: ${inView.length} SV${inView.length === 1 ? '' : 's'} in view. Arrow keys move between them, Enter highlights its reads, Shift+Enter selects it, Shift+F10 opens its actions.`}
      data-sv-key-index={keyIndex ?? undefined}>
      {keyCluster && (
        <span className="sr-only" aria-live="polite" data-testid="sv-track-key-focus">
          {svAlleleLabel(keyCluster.t, keyCluster.ref, keyCluster.len, feed?.chrom ?? '')}, {keyCluster.support.toLocaleString()} of {keyCluster.informative.toLocaleString()} informative reads carry it
        </span>
      )}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className={`block ${hover ? 'cursor-pointer' : 'cursor-default'}`}
        style={{ userSelect: 'none' }}
        data-testid={`sv-track-canvas-${datasetId}`}
        onMouseMove={e => {
          const { x, y } = local(e);
          const hit = hitAt(x);
          setHover(prev => {
            if (!hit) return null;
            const same = prev && prev.kind === hit.kind && (hit.kind === 'cluster'
              ? prev.kind === 'cluster' && prev.cluster.id === hit.cluster.id
              : prev.kind === 'clips' && prev.pile === hit.pile);
            return same && Math.abs(prev!.x - x) < 24 ? prev : { ...hit, y, cx: e.clientX, cy: e.clientY };
          });
        }}
        onMouseLeave={() => setHover(null)}
        // A click acts on the SV; it doesn't take the keyboard focus (the arrow keys keep panning the view).
        onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
        onClick={e => {
          const hit = hitAt(local(e).x);
          // Shift-click: the SV joins (or leaves) the feature selection (when a plugin pack provides it).
          if ((e.shiftKey || e.metaKey || e.ctrlKey) && hit?.kind === 'cluster' && feed && svSelection) {
            svSelection.toggle(hit.cluster, datasetId, feed.chrom);
            return;
          }
          highlight(hit?.kind === 'cluster' ? hit.cluster : null);
        }}
        onContextMenu={onContextMenu}
      />
      {hover && !menuOpen && !exportInProgress && feed && (
        <SvHoverTip hover={hover} summary={summary} datasetId={datasetId} feedReads={feed.reads} chrom={feed.chrom} />
      )}
    </div>
  );
}

function SvHoverTip({ hover, summary, datasetId, feedReads, chrom }: {
  hover: Hover; summary: SvSummary | null; datasetId: string;
  feedReads: import('./read-track/types').CompactRead[]; chrom: string;
}) {
  const description = useMemo(
    () => (hover.kind === 'cluster' ? describeSvCluster(hover.cluster, summary, feedReads, chrom) : null),
    [hover, summary, feedReads, chrom],
  );
  const example = description?.example;
  const insertion = example && example.event.t === 'I' ? { datasetId, chrom, readId: example.readId, event: example.event } : null;
  const bases = useInsertedBases(insertion, 30);
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const style = { left: Math.max(4, Math.min((hover.cx ?? hover.x) + 14, vw - 310)), top: (hover.cy ?? hover.y) + 14 };
  const tipClass = 'fixed pointer-events-none z-[150] max-w-[300px] rounded bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg';
  if (hover.kind === 'clips') {
    const p = hover.pile;
    return createPortal(
      <div className={tipClass} style={style} data-testid="sv-clip-tooltip" data-fb-hover-tip="">
        <div className="font-medium">Clip pile · {p.n.toLocaleString()} read{p.n === 1 ? '' : 's'}</div>
        <div className="text-[11px] text-gray-300">
          Soft-clipped on the {p.side === 'L' ? 'left' : 'right'} at {chrom}:{(p.ref + 1).toLocaleString()} (clips at least the min SV size)
        </div>
        <div className="text-[11px] text-gray-400">A breakpoint the aligner could not place as a deletion or insertion; split reads may continue elsewhere.</div>
      </div>,
      document.body,
    );
  }
  const d = description!;
  return createPortal(
    <div className={tipClass} style={style} data-testid="sv-cluster-tooltip" data-fb-hover-tip="">
      <div className="font-medium">{d.title} · {d.where}</div>
      {d.sizes && <div className="text-[11px] text-gray-300">{d.sizes}</div>}
      <div className="text-[11px] text-gray-300">{d.support}</div>
      {d.cigar && <div className="text-[11px] text-gray-300" data-testid="sv-cluster-tooltip-cigar">{d.cigar}</div>}
      {hover.cluster.t === 'I' && example && (
        <div className="font-mono text-[11px] text-purple-200">
          {bases ? `${bases}${example.event.len > bases.length ? '…' : ''}` : 'loading bases…'}
        </div>
      )}
      {d.faint && <div className="text-[11px] text-amber-200" data-testid="sv-cluster-tooltip-faint">{d.faint}</div>}
      {d.jitter && <div className="text-[11px] text-amber-200" data-testid="sv-cluster-tooltip-jitter">{d.jitter}</div>}
      <div className="text-[11px] text-gray-400">Click: highlight its reads · Right-click: {['group or split the reads by it', ...svClusterHints(hover.cluster)].join(', ')}</div>
    </div>,
    document.body,
  );
}
