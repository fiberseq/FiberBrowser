import { ReferenceAxisSurface } from '../../features/differences/ReferenceAxisSurface';
import { logicalOffset } from '../../utils/scaledCoordinates';
import { HighlightBands } from './HighlightBands';
import { useCallback, useMemo, useRef } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useDafcStore } from '../../stores/dafcStore';
import { useCoaccStore } from '../../stores/coaccStore';
import type { PanelConfig, SubTrackConfig, SubTrackType } from '../../types';
import { DEFAULT_METAPROFILE_ID } from '../../types';
import { MetaTrack } from './MetaTrack';
import { FireTrack } from './FireTrack';
import { GeneTrack } from './GeneTrack';
import { SequenceTrack } from './SequenceTrack';
import { ReadTrack } from './ReadTrack';
import { AxisTrack } from './AxisTrack';
import { TrackGutter } from './TrackGutter';
import { SIDEBAR_WIDTH } from './read-track/constants';
import { OrthogonalTrack, OrthogonalAnnotationTrack, OwnViewAnnotationTrack } from './OrthogonalTrack';
import { CompositeTrack } from './CompositeTrack';
import { CaptureTrack } from './CaptureTrack';
import { PrimerTrack } from './PrimerTrack';
import { ConsensusFamilyTrack, consensusJobId } from './ConsensusFamilyTrack';
import { useConsensusViewStore } from '../../stores/consensusViewStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { MicroCTrack } from './MicroCTrack';
import { CoAccTrack } from './CoAccTrack';
import { useShallow } from 'zustand/react/shallow';
import { PANEL_HEADER_HEIGHT } from './PanelHeader';
import { AnnotationFilterInput } from './TrackContainerAnalysis';
import { getTrackLabel } from './SubTrackMenu';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../utils/datasetLabels';
import { useBrowserPerformanceProfile } from '../../utils/performanceProfile';
import {
  AXIS_HEIGHT,
  META_HEIGHT,
  FIRE_HEIGHT,
  MICROC_HEIGHT,
  COACC_HEIGHT,
  CAPTURE_HEIGHT,
  GENE_HEIGHT,
  ORTHO_HEIGHT,
  ANNOTATION_HEIGHT,
  PRIMER_HEIGHT,
  SEQUENCE_HEIGHT,
  TRACK_COLORS,
} from './TrackContainerConstants';
import { sameChrom } from '../../utils/chromAliases';
import { Minus, X } from '../ui/Icons';
import { isResizableTrack, rowHeight } from './trackRegistry';
import { useTrackMenuStore } from '../../stores/trackMenuStore';
import { feedHasCoverage, feedHasSv, useTrackFeedStore } from '../../stores/trackFeedStore';
import { SvTrack } from './SvTrack';
import { trackRenderers, type PluginTrackArgs } from './trackRenderers';
import { CoverageTrack } from './CoverageTrack';
import { DifferencesStrip, differencesStripHeight } from '../../features/liveLift/DifferencesStrip';
import { useLiveLiftStore } from '../../features/liveLift/store';
import { liveLiftViewKey } from '../../features/liveLift/persistence';


/** How a panel's tracks are laid out where it sits (see TrackContainer). */
export interface PanelTrackLayout {
  /** Leave out the coordinate ruler: the panel above shows the same one. */
  hideAxis?: boolean;
}

interface UseSubTrackDispatchArgs {
  onScanPeaks?: () => void;
  scanning?: boolean;
}

/**
 * Hook that provides the renderSubTrack and calcFixedHeight callbacks
 * for rendering sub-tracks within dataset panels.
 */
export function useSubTrackDispatch({ onScanPeaks, scanning }: UseSubTrackDispatchArgs) {
  const { useContentVisibility } = useBrowserPerformanceProfile();
  const peakRowHeight = useBrowserStore(s => Math.max(FIRE_HEIGHT, 16 + s.peakRules.filter(r => r.enabled).length * 18));
  const datasets = useBrowserStore(s => s.datasets);
  const liftEnabled = useLiveLiftStore(s => s.enabled);
  const liveLiftExpansions = useBrowserStore(s => s.liveLiftExpansions);
  const showConsensusTrack = useConsensusViewStore(s => s.showTrack);
  const orthogonalTracks = useBrowserStore(s => s.orthogonalTracks);
  const compositeTracks = useBrowserStore(s => s.compositeTracks);
  const catalog = useBrowserStore(s => s.catalog);
  const clusterAssignments = useBrowserStore(s => s.clusterAssignments);
  const spanningOnly = useBrowserStore(s => s.spanningOnly);
  const hasFasta = useBrowserStore(s => s.hasFasta);
  const panelGenomes = usePanelGenomeStore(s => s.genomes);
  const storeChrom = useBrowserStore(s => s.chrom);
  const storeStart = useBrowserStore(s => s.start);
  const storeEnd = useBrowserStore(s => s.end);
  const primer = useBrowserStore(s => s.primer);
  const panels = useBrowserStore(s => s.panels);
  const exportFullReadTracks = useBrowserStore(s => s.exportFullReadTracks);
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const toggleSubTrack = useBrowserStore(s => s.toggleSubTrack);
  const microcTrackMode = useDafcStore(s => s.microcTrackMode);
  const coaccTrackMode = useCoaccStore(s => s.coaccTrackMode);
  // Rows of plugin packs (trackRenderers.ts): each one's height rule, a hook called in registration order.
  const pluginRenderers = trackRenderers();
  const pluginHeightRules = pluginRenderers.map(renderer => renderer.useHeight());
  const pluginRow = useCallback((panel: PanelConfig, track: SubTrackConfig) => {
    const at = pluginRenderers.findIndex(r => r.type === track.type);
    if (at < 0) return null;
    const v = panel.viewportOverride;
    const args: PluginTrackArgs = { panel, track, datasetId: panel.datasetId, view: { chrom: v?.chrom ?? storeChrom, start: v?.start ?? storeStart, end: v?.end ?? storeEnd } };
    const height = pluginHeightRules[at](args);
    return { renderer: pluginRenderers[at], args, height };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeChrom, storeStart, storeEnd, ...pluginHeightRules]);
  const fullViewPanelId = useBrowserStore(s => s.fullViewPanelId);
  const collapsedRows = useBrowserStore(s => s.collapsedRows);
  const readTrackStatus = useBrowserStore(s => s.readTrackStatus);
  const svDisplayEnabled = useBrowserStore(s => s.svDisplayEnabled);
  const showCoverageHistogram = useBrowserStore(s => s.showCoverageHistogram);
  // Which panels' reads give the SV and coverage rows something to draw (by state key: 1 SV, 2 coverage).
  const feedRows = useTrackFeedStore(useShallow(s => {
    const out: Record<string, number> = {};
    for (const [key, feed] of Object.entries(s.byStateKey)) out[key] = (feedHasSv(feed) ? 1 : 0) | (feedHasCoverage(feed) ? 2 : 0);
    return out;
  }));
  const feedRowShown = useCallback((panel: PanelConfig, bit: 1 | 2) => {
    const key = panel.stateKey ?? panel.datasetId;
    return Boolean(key && ((feedRows[key] ?? 0) & bit));
  }, [feedRows]);

  // A panel with no reads in its view draws no metaprofile row (an empty band
  // between the peaks and the empty-state card). Decided only once the reads
  // have settled, and kept while the next view loads, so rows don't jump on
  // every navigation.
  const settledEmpty = useRef(new Map<string, boolean>());
  const panelHasNoReads = useCallback((panel: PanelConfig) => {
    const key = panel.stateKey ?? panel.datasetId;
    if (!key) return false;
    const status = readTrackStatus[key];
    const previous = settledEmpty.current.get(key) ?? false;
    if (!status || status.loading || status.stale || status.fetchFailed || status.zoomedOut) return previous;
    const empty = status.inScope === 0 && status.displayed === 0;
    settledEmpty.current.set(key, empty);
    return empty;
  }, [readTrackStatus]);

  // Track data fetched for the main view (catalog signal, annotations,
  // co-accessibility) is only right in panels showing exactly that region.
  const showsMainRegion = useCallback((panel: PanelConfig) => {
    const v = panel.viewportOverride;
    return !v || (sameChrom(v.chrom, storeChrom) && v.start === storeStart && v.end === storeEnd);
  }, [storeChrom, storeStart, storeEnd]);
  const hasMetaprofileSource = (composite: { sources?: Array<{ ref: { kind: string } }> } | undefined) =>
    (composite?.sources ?? []).some(src => src.ref.kind === 'metaprofile');

  // The Micro-C map is one shared contact matrix, not per-dataset data. Draw
  // it once per distinct region (main view, Locus X, Locus Y) instead of in
  // every panel, where its fixed height squeezed the read tracks away.
  const microcPanelIds = useMemo(() => {
    const ids = new Set<string>();
    if (!microcTrackMode) return ids;
    if (fullViewPanelId) {
      ids.add(fullViewPanelId);
      return ids;
    }
    const seenRegions = new Set<string>();
    const rowOf = (panel: PanelConfig) => panel.layoutRow ?? (panel.layoutPosition === 'column' ? 1 : 0);
    // Owners must be panels actually on screen, in visual (row) order.
    const onScreen = panels
      .filter(panel => !panel.collapsed && !collapsedRows.has(rowOf(panel)))
      .sort((a, b) => rowOf(a) - rowOf(b));
    for (const panel of onScreen) {
      if (!panel.subTracks.some(track => track.type === 'microc' && track.visible)) continue;
      const region = panel.viewportOverride
        ? `${panel.contactRegionGroupId ?? panel.haplotypeGroup ?? ''}:${panel.contactRegionRole ?? panel.regionLabel ?? panel.id}`
        : 'main';
      if (seenRegions.has(region)) continue;
      seenRegions.add(region);
      ids.add(panel.id);
    }
    return ids;
  }, [panels, microcTrackMode, fullViewPanelId, collapsedRows]);

  // Check if any dataset has cluster assignments (determines sidebar width)
  const hasAnyClusters = Object.keys(clusterAssignments).length > 0 &&
    Object.values(clusterAssignments).some((ca: Record<string, number>) => Object.keys(ca).length > 0);
  const clusterSidebarWidth = hasAnyClusters ? SIDEBAR_WIDTH : 0;

  // Panel-aware visibility: show track only when the analysis panel is open
  const showPrimerTrack = panels.some((p: any) => p.contentType === 'primer-design');
  const showCaptureTrack = panels.some((p: any) => p.contentType === 'capture');
  const regionSize = storeEnd - storeStart;
  // A panel with its own view shows bases by its own size; the layout
  // (calcFixedHeight) and the render use this one rule.
  const sequenceShown = useCallback((panel: PanelConfig) => {
    const v = panel.viewportOverride;
    // A panel on another assembly shows its own reference's bases (if it has a FASTA).
    const fasta = panel.genome ? Boolean(panelGenomes[panel.genome]?.has_fasta) : hasFasta;
    return fasta && (v ? v.end - v.start : regionSize) <= 2000;
  }, [hasFasta, regionSize, panelGenomes]);
  const orthogonalByIndex = useMemo(
    () => new Map(orthogonalTracks.map((track, order) => [track.index, { track, order }])),
    [orthogonalTracks],
  );
  const orthogonalByPath = useMemo(() => {
    // Preserve the prior find()-based first-wins semantic: if two tracks share
    // a path (rare but possible across render modes), the earlier one wins.
    const map = new Map<string, typeof orthogonalTracks[number]>();
    for (const track of orthogonalTracks) {
      if (track.path && !map.has(track.path)) map.set(track.path, track);
    }
    return map;
  }, [orthogonalTracks]);
  const catalogById = useMemo(
    () => new Map(catalog.map(entry => [entry.id, entry])),
    [catalog],
  );
  const compositeById = useMemo(
    () => new Map(compositeTracks.map(track => [track.id, track])),
    [compositeTracks],
  );
  /** The loaded track a one-source annotation composite draws (null: it falls back to the signal renderer). */
  const annotationTrackFor = useCallback((composite: (typeof compositeTracks)[number] | undefined) => {
    if (!composite || composite.kind !== 'annotation' || composite.sources.length !== 1) return null;
    const ref = composite.sources[0].ref;
    if (ref.kind === 'metaprofile') return null;
    const entry = catalogById.get(ref.catalogEntryId);
    const target = entry?.path ?? entry?.url;
    const byIndex = typeof entry?.trackIndex === 'number' ? orthogonalByIndex.get(entry.trackIndex)?.track : null;
    return { entry, ortho: byIndex ?? (target ? orthogonalByPath.get(target) ?? null : null) };
  }, [catalogById, orthogonalByIndex, orthogonalByPath]);

  // A panel with a view of its own (a plugin pack's contig, a split panel at another locus) fetches its
  // annotation tracks for that view and reference itself (OwnViewAnnotationTrack): motif tracks always
  // (they scan the panel's own sequence, an alt contig's insert included), other annotations on the main
  // assembly only.
  const ownViewAnnotation = useCallback((panel: PanelConfig, ortho: { category?: string; format?: string; renderMode?: string } | null | undefined,
    entryKind?: string) => {
    if (!ortho || !panel.viewportOverride || showsMainRegion(panel)) return false;
    const motif = entryKind === 'motif' || ortho.category === 'motif' || ortho.format === 'custom_motif';
    return motif || !panel.genome;
  }, [showsMainRegion]);

  // Sub-track resize state
  const resizeRef = useRef<{
    panelId: string;
    trackType: SubTrackType;
    startY: number;
    startHeight: number;
  } | null>(null);

  const startSubTrackResize = useCallback((e: React.MouseEvent, panelId: string, trackType: SubTrackType, currentHeight: number) => {
    e.preventDefault();
    const resizeRatio = logicalOffset(1, e.currentTarget.clientWidth, e.currentTarget.getBoundingClientRect().width);
    resizeRef.current = { panelId, trackType, startY: e.clientY, startHeight: currentHeight };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = (ev.clientY - resizeRef.current.startY) * resizeRatio;
      const newHeight = resizeRef.current.startHeight + delta;  // the store clamps to the kind's limits
      useBrowserStore.getState().setSubTrackHeight(resizeRef.current.panelId, resizeRef.current.trackType, newHeight);
    };
    const onMouseUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const renderSubTrack = useCallback((
    track: SubTrackConfig,
    trackIdx: number,
    panel: PanelConfig,
    trackWidth: number,
    readHeight: number,
    isFirstPanel: boolean,
    layout?: PanelTrackLayout,
  ) => {
    if (!track.visible || track.removed) return null;
    // The ruler repeats the one of the panel directly above (utils/panelRuler).
    if (track.type === 'axis' && layout?.hideAxis) return null;
    const dsId = panel.datasetId;
    const dataset = dsId ? datasets.find(d => d.id === dsId) : null;
    const orthoIdx = track.type.startsWith('ortho-') ? parseInt(track.type.replace('ortho-', ''), 10) : -1;
    const orthoEntry = orthoIdx >= 0 ? orthogonalByIndex.get(orthoIdx) : undefined;
    const orthoTrack = orthoEntry?.track ?? null;
    const orthoColorIdx = orthoEntry?.order ?? 0;
    const vpo = panel.viewportOverride;

    // For panels with viewportOverride: create a callback that updates the panel's viewport
    const onViewportChange = vpo ? (newStart: number, newEnd: number) => {
      useBrowserStore.getState().setPanelViewport(panel.id, newStart, newEnd);
    } : undefined;

    let content: React.ReactNode = null;
    let trackHeight = 0;

    switch (track.type) {
      case 'consensus': {
        const jobId=consensusJobId(dataset);
        if (!dataset || !dsId || !jobId || !showConsensusTrack) return null;
        trackHeight=rowHeight(track);
        content=<ConsensusFamilyTrack width={trackWidth} height={trackHeight} datasetId={dsId} jobId={jobId}
          sidebarWidth={clusterSidebarWidth} {...(vpo?{overrideChrom:vpo.chrom,overrideStart:vpo.start,overrideEnd:vpo.end}:{})}/>;
        break;
      }
      case 'axis':
        trackHeight = rowHeight(track, AXIS_HEIGHT);
        content = <TrackGutter gutter={clusterSidebarWidth} kind="axis"><AxisTrack width={trackWidth - clusterSidebarWidth} height={trackHeight} genome={panel.genome} {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end, onViewportChange } : {})} /></TrackGutter>;
        break;
      case 'meta':
        if (!dataset || !dsId || panelHasNoReads(panel)) return null;
        trackHeight = rowHeight(track, META_HEIGHT);
        content = (
          <MetaTrack
            width={trackWidth}
            height={trackHeight}
            datasetId={dsId}
            profileKey={panel.stateKey ?? dsId}
            {...(vpo ? { viewport: vpo, onViewportChange } : {})}
            datasetLabel={getDatasetDisplayLabel(dataset, 34)}
            datasetTitle={getDatasetHoverLabel(dataset)}
            datasetColor={dataset.color}
            sidebarWidth={clusterSidebarWidth}
          />
        );
        break;
      case 'fire':
        trackHeight = Math.max(rowHeight(track, FIRE_HEIGHT), peakRowHeight);
        content = (
          <FireTrack
            width={trackWidth}
            height={trackHeight}
            scanning={isFirstPanel ? scanning : undefined}
            spanningOnly={spanningOnly}
            sidebarWidth={clusterSidebarWidth}
            readsKey={panel.datasetId ? (panel.stateKey ?? panel.datasetId) : undefined}
            genome={panel.genome}
            {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end } : {})}
          />
        );
        break;
      case 'microc':
        if (!microcPanelIds.has(panel.id)) return null;
        trackHeight = rowHeight(track, MICROC_HEIGHT);
        content = (
          <MicroCTrack
            width={trackWidth}
            height={trackHeight}
            sidebarWidth={clusterSidebarWidth}
            panelId={panel.id}
            {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end, onViewportChange } : {})}
          />
        );
        break;
      case 'coacc':
        if (!coaccTrackMode) return null;
        trackHeight = rowHeight(track, COACC_HEIGHT);
        content = <CoAccTrack panelId={panel.id} width={trackWidth} height={trackHeight} sidebarWidth={clusterSidebarWidth} />;
        break;
      case 'capture':
        if (!showCaptureTrack) return null;
        trackHeight = rowHeight(track, CAPTURE_HEIGHT);
        content = <TrackGutter gutter={clusterSidebarWidth} kind="capture"><CaptureTrack width={trackWidth - clusterSidebarWidth} height={trackHeight} {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end } : {})} /></TrackGutter>;
        break;
      case 'primer':
        if (!showPrimerTrack) return null;
        trackHeight = rowHeight(track, PRIMER_HEIGHT);
        content = <TrackGutter gutter={clusterSidebarWidth} kind="primer"><PrimerTrack width={trackWidth - clusterSidebarWidth} height={trackHeight} {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end } : {})} /></TrackGutter>;
        break;
      case 'reads':
        if (!dsId) return null;
        trackHeight = readHeight;
        content = (
          <ReadTrack
            width={trackWidth}
            height={readHeight}
            datasetId={dsId}
            stateKey={panel.stateKey}
            readStrand={panel.strand ?? null}
            liftHap={panel.liftHap ?? panel.readSubset?.rule.liftHap ?? null}
            gutterWidth={clusterSidebarWidth}
            publishFeed
            genome={panel.genome}
            {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end, panelLabel: panel.regionLabel, onViewportChange } : {})}
          />
        );
        break;
      // TRACK-KINDS: add cases here (and in calcFixedHeight below); see trackRegistry.ts.
      case 'sv':
        if (!dsId || (dataset?.data_type !== 'bam_livelift' && (!svDisplayEnabled || !feedRowShown(panel, 1)))) return null;
        trackHeight = rowHeight(track);
        content = liftEnabled && dataset?.data_type === 'bam_livelift'
          ? <DifferencesStrip panel={panel} dataset={dataset} width={trackWidth} height={trackHeight} gutter={clusterSidebarWidth} />
          : <SvTrack width={trackWidth} height={trackHeight} panel={panel} sidebarWidth={clusterSidebarWidth} />;
        break;
      case 'coverage':
        if (!dsId || !showCoverageHistogram || !feedRowShown(panel, 2)) return null;
        trackHeight = rowHeight(track);
        content = <CoverageTrack width={trackWidth} height={trackHeight} panel={panel} sidebarWidth={clusterSidebarWidth} />;
        break;
      case 'sequence':
        if (!sequenceShown(panel)) return null;
        trackHeight = rowHeight(track, SEQUENCE_HEIGHT);
        content = <TrackGutter gutter={clusterSidebarWidth} kind="sequence"><SequenceTrack width={trackWidth - clusterSidebarWidth} height={trackHeight} genome={panel.genome} {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end } : {})} /></TrackGutter>;
        break;
      case 'gene':
        trackHeight = rowHeight(track, GENE_HEIGHT);
        content = <TrackGutter gutter={clusterSidebarWidth} kind="gene"><GeneTrack width={trackWidth - clusterSidebarWidth} height={trackHeight} genome={panel.genome} {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end } : {})} /></TrackGutter>;
        break;
      default: {
        // A plugin pack's row (trackRenderers.ts).
        const plugin = pluginRow(panel, track);
        if (plugin) {
          if (plugin.height == null) return null;
          trackHeight = plugin.height;
          content = plugin.renderer.render({ ...plugin.args, width: trackWidth, height: trackHeight, sidebarWidth: clusterSidebarWidth });
          break;
        }
      }
        // Composite tracks (composite-<id>) take precedence over legacy ortho.
        // A panel with its own view draws metaprofile sources from its own
        // reads; catalog signal/annotation sources are fetched for the main
        // view only, so a composite made only of those is hidden there.
        if (track.type.startsWith('composite-')) {
          const compositeId = track.type.slice('composite-'.length);
          const composite = compositeById.get(compositeId);
          // Missing or hidden: no row (calcFixedHeight reserves none).
          if (!composite || !composite.visible) return null;
          const ownAnnotation = (() => { const a = annotationTrackFor(composite); return ownViewAnnotation(panel, a?.ortho, a?.entry?.kind); })();
          if (!showsMainRegion(panel) && !hasMetaprofileSource(composite) && !ownAnnotation) return null;
          if (compositeId === DEFAULT_METAPROFILE_ID && panelHasNoReads(panel)) return null;
          // Annotation composites (motifs / bigBed sites) render as discrete
          // interval boxes via AnnotationTrack — NOT as a signal curve. Without
          // this the JASPAR TFBS track collapses into a meaningless overlay.
          // Annotation composites are 1-source by construction (see Add Source
          // picker filter), so resolve the single source to its catalog entry
          // and look up the matching orthogonalTrack for `intervals` + index.
          if (composite && composite.kind === 'annotation' && composite.sources.length === 1) {
            if (!composite.visible) return null;
            const src = composite.sources[0];
            const ref = src.ref;
            if (ref.kind !== 'metaprofile') {
              const { entry, ortho } = annotationTrackFor(composite) ?? { entry: undefined, ortho: null };
              if (ortho) {
                const annotationTrackType =
                  entry?.kind === 'motif' || ortho.category === 'motif' || ortho.format === 'custom_motif'
                    ? 'motif'
                    : ortho.format;
                trackHeight = rowHeight(track, ANNOTATION_HEIGHT);
                content = (
                  <TrackGutter gutter={clusterSidebarWidth} kind="annotation" height={trackHeight}>
                    {ownAnnotation && vpo ? (
                      <OwnViewAnnotationTrack
                        width={trackWidth - clusterSidebarWidth}
                        height={trackHeight}
                        label={composite.label || ortho.label}
                        trackIndex={ortho.index}
                        color={src.color}
                        trackType={annotationTrackType}
                        annotationStyle={composite.annotationStyle}
                        view={vpo}
                        genome={panel.genome}
                      />
                    ) : (
                      <OrthogonalAnnotationTrack
                        width={trackWidth - clusterSidebarWidth}
                        height={trackHeight}
                        label={composite.label || ortho.label}
                        trackIndex={ortho.index}
                        color={src.color}
                        trackType={annotationTrackType}
                        annotationStyle={composite.annotationStyle}
                      />
                    )}
                    <AnnotationFilterInput trackIndex={ortho.index} />
                  </TrackGutter>
                );
                break;
              }
            }
          }
          trackHeight = rowHeight(track, ORTHO_HEIGHT);
          content = (
            <CompositeTrack
              width={trackWidth}
              height={trackHeight}
              compositeId={compositeId}
              datasetId={dsId ?? undefined}
              stateKey={panel.stateKey}
              ownView={!showsMainRegion(panel)}
              {...(vpo ? { viewport: vpo, onViewportChange } : {})}
              sidebarWidth={clusterSidebarWidth}
            />
          );
          break;
        }
        // Orthogonal tracks (ortho-N) — legacy path
        // Ortho data is fetched for the main view only (annotations of a panel's own view: by the panel).
        const ownOrtho = orthoTrack?.renderMode === 'annotation' && ownViewAnnotation(panel, orthoTrack);
        if (!showsMainRegion(panel) && !ownOrtho) return null;
        if (orthoTrack) {
          const isAnnotation = orthoTrack.renderMode === 'annotation';
          const annotationTrackType =
            orthoTrack.category === 'motif' || orthoTrack.format === 'custom_motif'
              ? 'motif'
              : orthoTrack.format;
          trackHeight = rowHeight(track, isAnnotation ? ANNOTATION_HEIGHT : ORTHO_HEIGHT);
          content = isAnnotation ? (
            <TrackGutter gutter={clusterSidebarWidth} kind="annotation" height={trackHeight}>
              {ownOrtho && vpo ? (
                <OwnViewAnnotationTrack
                  width={trackWidth - clusterSidebarWidth}
                  height={trackHeight}
                  label={orthoTrack.label}
                  trackIndex={orthoTrack.index}
                  color={TRACK_COLORS[orthoColorIdx % TRACK_COLORS.length]}
                  trackType={annotationTrackType}
                  view={vpo}
                  genome={panel.genome}
                />
              ) : <OrthogonalAnnotationTrack
                width={trackWidth - clusterSidebarWidth}
                height={trackHeight}
                label={orthoTrack.label}
                trackIndex={orthoTrack.index}
                color={TRACK_COLORS[orthoColorIdx % TRACK_COLORS.length]}
                trackType={annotationTrackType}
              />}
              <AnnotationFilterInput trackIndex={orthoTrack.index} />
            </TrackGutter>
          ) : (
            <TrackGutter gutter={clusterSidebarWidth} kind="signal"><OrthogonalTrack
              width={trackWidth - clusterSidebarWidth}
              height={trackHeight}
              label={orthoTrack.label}
              trackIndex={orthoTrack.index}
              color={TRACK_COLORS[orthoColorIdx % TRACK_COLORS.length]}
            /></TrackGutter>
          );
        } else {
          return null;
        }
    }

    const isReadsTrack = track.type === 'reads';
    const intrinsicHeight = isReadsTrack ? readHeight : trackHeight;
    // Every kind but the reads and the ruler resizes (trackRegistry).
    const isResizable = !isReadsTrack && isResizableTrack(track.type);
    const hideTrackTitle = `Minimize ${getTrackLabel(track.type)} in all panels (Option/Alt-click: this panel only)`;
    const handleHideTrack = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSubTrack(panel.id, track.type, e.altKey);
    };
    // Right-click: the track's menu (its own items, the panels it relates to, the common section).
    // A track with a menu of its own (reads, SVs) handles the event first.
    const handleContextMenu = (e: React.MouseEvent) => {
      if (e.defaultPrevented || exportInProgress) return;
      e.preventDefault();
      useTrackMenuStore.getState().openMenu({ panelId: panel.id, type: track.type, x: e.clientX, y: e.clientY });
    };

    // Render actual track content; layout-only controls appear as hover chrome.
    // Primer track needs overflow:visible for guide lines that extend into tracks below
    const isPrimer = track.type === 'primer';
    const projectReference = !['reads', 'axis', 'coverage', 'sv'].includes(track.type);
    return (
      <div
        key={track.type}
        className="group/subtrack fb-track-row"
        data-track-type={track.type}
        data-track-panel={panel.id}
        onContextMenu={isReadsTrack ? undefined : handleContextMenu}
        // Track labels show on hover; keyboard users get them by focusing the row.
        tabIndex={isReadsTrack || track.type === 'axis' ? undefined : 0}
        aria-label={isReadsTrack || track.type === 'axis' ? undefined : `${getTrackLabel(track.type)} track`}
        style={{
          height: isReadsTrack ? (exportFullReadTracks ? undefined : readHeight) : trackHeight,
          minHeight: isReadsTrack ? readHeight : trackHeight,
          flex: isReadsTrack && !exportFullReadTracks ? 1 : undefined,
          flexShrink: 0,
          overflow: isReadsTrack ? (exportFullReadTracks ? 'visible' : 'hidden') : undefined,
          position: 'relative',
          contentVisibility: exportInProgress || !useContentVisibility ? undefined : 'auto',
          containIntrinsicSize: exportInProgress || !useContentVisibility ? undefined : `${Math.max(1, Math.round(intrinsicHeight))}px`,
          ...(isPrimer ? { overflow: 'visible', zIndex: 10 } : {}),
        }}
      >
        {projectReference ? <ReferenceAxisSurface width={trackWidth} gutter={clusterSidebarWidth}
          view={{chrom:vpo?.chrom ?? storeChrom,start:vpo?.start ?? storeStart,end:vpo?.end ?? storeEnd}}>{content}</ReferenceAxisSurface> : content}
        <HighlightBands panel={panel} width={trackWidth} gutter={clusterSidebarWidth} labels={track.type === 'axis'} guides={isReadsTrack} />
        {!exportInProgress && (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={handleHideTrack}
            // On the ruler it sits in the bottom-right corner, under the width label (it covered "10.0kb", audit L21).
            className={`absolute z-30 flex items-center justify-center rounded bg-white/85 text-gray-500 opacity-0 shadow-sm ring-1 ring-gray-200/80 transition-opacity hover:bg-gray-50 hover:text-gray-800 group-hover/subtrack:opacity-100 group-focus-within/subtrack:opacity-100 dark:bg-gray-900/85 dark:text-gray-300 dark:ring-white/15 dark:hover:bg-white/10 dark:hover:text-white ${track.type === 'axis' ? 'bottom-0.5 h-4 w-4' : 'top-1 h-5 w-5'} right-1`}
            data-testid={`track-hide-${track.type}`}
            title={hideTrackTitle}
            aria-label={hideTrackTitle}
          >
            {isReadsTrack || track.type === 'axis' ? <Minus size={12} /> : <X size={12} />}
          </button>
        )}
        {isResizable && !exportInProgress && (
          <div
            className="pointer-events-none absolute inset-x-2 bottom-0 z-20 flex h-2.5 cursor-row-resize items-center justify-center opacity-0 transition-opacity group-hover/subtrack:pointer-events-auto group-hover/subtrack:opacity-100 group-focus-within/subtrack:pointer-events-auto group-focus-within/subtrack:opacity-100"
            onMouseDown={(e) => startSubTrackResize(e, panel.id, track.type, trackHeight)}
            title={`Resize ${getTrackLabel(track.type)}`}
            data-testid={`track-resize-${track.type}`}
          >
            <div className="h-[3px] w-12 rounded-full bg-blue-500/70 shadow-[0_0_0_2px_rgba(255,255,255,0.85)] dark:bg-blue-400/75 dark:shadow-[0_0_0_2px_rgba(0,0,0,0.45)]" />
          </div>
        )}
      </div>
    );
  }, [peakRowHeight, datasets, showConsensusTrack, orthogonalByIndex, orthogonalByPath, catalogById, compositeById, annotationTrackFor, ownViewAnnotation, clusterSidebarWidth, onScanPeaks, scanning, spanningOnly,
      showPrimerTrack, showCaptureTrack, sequenceShown, microcPanelIds, coaccTrackMode, storeChrom, exportFullReadTracks, exportInProgress, startSubTrackResize, panelHasNoReads,
      toggleSubTrack, showsMainRegion, svDisplayEnabled, showCoverageHistogram, feedRowShown, pluginRow, useContentVisibility, liftEnabled, liveLiftExpansions, storeStart, storeEnd, panels]);

  const calcFixedHeight = useCallback((panel: PanelConfig, layout?: PanelTrackLayout) => {
    let h = PANEL_HEADER_HEIGHT;
    for (const t of panel.subTracks) {
      if (!t.visible || t.removed) continue;
      if (t.type === 'axis' && layout?.hideAxis) continue;
      switch (t.type) {
        case 'consensus': if (showConsensusTrack && consensusJobId(datasets.find(d=>d.id===panel.datasetId))) h += rowHeight(t); break;
        case 'axis': h += rowHeight(t, AXIS_HEIGHT); break;
        case 'meta': if (!panelHasNoReads(panel)) h += rowHeight(t, META_HEIGHT); break;
        case 'fire': h += Math.max(rowHeight(t, FIRE_HEIGHT), peakRowHeight); break;
        case 'microc': if (microcPanelIds.has(panel.id)) h += rowHeight(t, MICROC_HEIGHT); break;
        case 'coacc': if (coaccTrackMode) h += rowHeight(t, COACC_HEIGHT); break;
        case 'capture': if (showCaptureTrack) h += rowHeight(t, CAPTURE_HEIGHT); break;
        case 'primer': if (showPrimerTrack) h += rowHeight(t, PRIMER_HEIGHT); break;
        case 'sv': if (panel.datasetId && (datasets.find(d => d.id === panel.datasetId)?.data_type === 'bam_livelift' || svDisplayEnabled && feedRowShown(panel, 1))) h += rowHeight(t); break;
        case 'coverage': if (panel.datasetId && showCoverageHistogram && feedRowShown(panel, 2)) h += rowHeight(t); break;
        case 'sequence': if (sequenceShown(panel)) h += rowHeight(t, SEQUENCE_HEIGHT); break;
        case 'gene': h += rowHeight(t, GENE_HEIGHT); break;
        case 'reads': break;  // flex
        default: {
          const plugin = pluginRow(panel, t);
          if (plugin) {
            if (plugin.height != null) h += plugin.height;
            continue;
          }
        }
          if (t.type.startsWith('composite-')) {
            // Composite tracks reserve a fixed slot in the panel so the reads
            // track (flex:1) shrinks to absorb any height the user adds, the
            // same way ortho-* and meta tracks do. Without this, growing a
            // composite pushes the gene track off-screen. Annotation
            // composites use ANNOTATION_HEIGHT to match the legacy motif
            // strip; signal/metaprofile use ORTHO_HEIGHT.
            const id = t.type.slice('composite-'.length);
            const composite = compositeById.get(id);
            if (id === DEFAULT_METAPROFILE_ID && panelHasNoReads(panel)) continue;
            const own = composite ? annotationTrackFor(composite) : null;
            if (composite && composite.visible && (showsMainRegion(panel) || hasMetaprofileSource(composite) || ownViewAnnotation(panel, own?.ortho, own?.entry?.kind))) {
              // As rendered: an annotation composite whose track isn't loaded draws as a signal row.
              const defaultH = annotationTrackFor(composite)?.ortho ? ANNOTATION_HEIGHT : ORTHO_HEIGHT;
              h += rowHeight(t, defaultH);
            }
          } else if (t.type.startsWith('ortho-')) {
            const idx = parseInt(t.type.replace('ortho-', ''), 10);
            const ot = orthogonalByIndex.get(idx)?.track;
            if (ot && (showsMainRegion(panel) || (ot.renderMode === 'annotation' && ownViewAnnotation(panel, ot)))) h += rowHeight(t, ot.renderMode === 'annotation' ? ANNOTATION_HEIGHT : ORTHO_HEIGHT);
          }
      }
    }
    return h;
  }, [peakRowHeight, orthogonalByIndex, compositeById, annotationTrackFor, ownViewAnnotation, microcPanelIds, coaccTrackMode, storeChrom, showCaptureTrack, showPrimerTrack, sequenceShown, datasets, showConsensusTrack, showsMainRegion, panelHasNoReads, svDisplayEnabled, showCoverageHistogram, feedRowShown, pluginRow]);

  return { renderSubTrack, calcFixedHeight };
}
