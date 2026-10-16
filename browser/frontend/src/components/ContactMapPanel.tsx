import { useRef, useEffect, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ContactMatrixTrack } from './tracks/dafc/ContactMatrixTrack';
import { useDafcStore } from '../stores/dafcStore';
import { useBrowserStore } from '../stores/browserStore';
import { getGenes, searchGene } from '../api/reference';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisRunSummary, AnalysisSettingsSection, AnalysisStatus } from './controls/shared';
import { HaplotypeComparisonSettings } from './controls/sidebar/haplotype/HaplotypeComparisonSettings';

type Tab = 'map' | 'compare' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'map', label: 'Map' },
  { key: 'compare', label: 'Compare regions' },
  { key: 'settings', label: 'Settings' },
];

const NO_MAP_TABS: { key: Tab; label: string }[] = [
  { key: 'map', label: 'Compare loci' },
  { key: 'compare', label: 'Compare haplotypes' },
];

interface Props {
  isFullView?: boolean;
}

export function ContactMapPanel({ isFullView }: Props) {
  // A callback ref (held in state): the map container is re-created when the Map
  // tab is shown again or the data first loads, and the observer must follow it.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const manualResolveSeqRef = useRef(0);
  const manualResolveAbortRef = useRef<AbortController | null>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 });
  const [tab, setTab] = useState<Tab>('map');
  const dafcLoaded = useDafcStore(s => s.dafcLoaded);
  const dafcFollowBrowser = useDafcStore(s => s.dafcFollowBrowser);
  const setDafcViewport = useDafcStore(s => s.setDafcViewport);
  const dafcChrom = useDafcStore(s => s.dafcChrom);
  const dafcStart = useDafcStore(s => s.dafcStart);
  const dafcEnd = useDafcStore(s => s.dafcEnd);
  const setDafcGenes = useDafcStore(s => s.setDafcGenes);
  const openContactRegions = useBrowserStore(s => s.openContactRegions);
  const browserChrom = useBrowserStore(s => s.chrom);
  const browserStart = useBrowserStore(s => s.start);
  const browserEnd = useBrowserStore(s => s.end);
  const selectedPeaks = useBrowserStore(s => s.selectedPeaks);
  const peaksLocked = useBrowserStore(s => s.peaksLocked);
  const analysisSampleSeed = useBrowserStore(s => s.analysisSampleSeed);
  const analysisSampleCount = useBrowserStore(s => s.analysisSampleCount);
  const filterByPeaks = useDafcStore(s => s.filterByPeaks);
  const microcTrackMode = useDafcStore(s => s.microcTrackMode);

  // Viewport sync: when following browser, mirror its viewport
  useEffect(() => {
    if (!dafcFollowBrowser || !dafcLoaded) return;
    // Only sync if browser viewport differs from current dafc viewport
    if (browserChrom !== dafcChrom || browserStart !== dafcStart || browserEnd !== dafcEnd) {
      setDafcViewport(browserChrom, browserStart, browserEnd);
    }
  }, [dafcFollowBrowser, dafcLoaded, browserChrom, browserStart, browserEnd]);

  // Fetch genes when dafc viewport changes (debounced)
  useEffect(() => {
    if (!dafcLoaded) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const resp = await getGenes(dafcChrom, dafcStart, dafcEnd, { signal: controller.signal });
        if (!controller.signal.aborted) setDafcGenes(resp.genes || []);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        // Gene fetch failure is non-critical.
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [dafcLoaded, dafcChrom, dafcStart, dafcEnd, setDafcGenes]);

  // Responsive sizing via ResizeObserver
  useEffect(() => {
    const el = containerEl;
    if (!el) return;

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    observer.observe(el);

    // Initial measurement
    setDimensions({
      width: Math.floor(el.clientWidth),
      height: Math.floor(el.clientHeight),
    });

    return () => observer.disconnect();
  }, [containerEl]);

  const handleOpenRegions = useCallback((selection: {
    chrom: string;
    x_start: number;
    x_end: number;
    y_start: number;
    y_end: number;
    contacts: number;
    n_ligated_reads: number;
    read_ids: string[];
    contact_mode?: string;
  }) => {
    openContactRegions({
      chrom: selection.chrom,
      x_start: selection.x_start,
      x_end: selection.x_end,
      y_start: selection.y_start,
      y_end: selection.y_end,
      contact_mode: (selection.contact_mode as 'dafc' | 'microc') || undefined,
      read_ids: selection.read_ids,
    });
  }, [openContactRegions]);

  // Manual split-view creation when no contact data is loaded
  const [manualX, setManualX] = useState('');
  const [manualY, setManualY] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => () => {
    manualResolveSeqRef.current += 1;
    manualResolveAbortRef.current?.abort();
  }, []);

  const abortManualResolve = () => {
    manualResolveSeqRef.current += 1;
    manualResolveAbortRef.current?.abort();
    manualResolveAbortRef.current = null;
    setResolving(false);
  };

  const beginManualResolve = () => {
    manualResolveAbortRef.current?.abort();
    const controller = new AbortController();
    manualResolveAbortRef.current = controller;
    const resolveSeq = manualResolveSeqRef.current + 1;
    manualResolveSeqRef.current = resolveSeq;
    setResolving(true);
    return { controller, resolveSeq };
  };

  const isCurrentManualResolve = (resolveSeq: number, controller: AbortController) => (
    manualResolveSeqRef.current === resolveSeq && manualResolveAbortRef.current === controller && !controller.signal.aborted
  );

  const parseRegion = (s: string): { chrom: string; start: number; end: number } | null => {
    const m = s.trim().match(/^(\S+)[:\s]+([0-9,]+)\s*[-\s]+\s*([0-9,]+)$/);
    if (!m) return null;
    return { chrom: m[1], start: parseInt(m[2].replace(/,/g, '')), end: parseInt(m[3].replace(/,/g, '')) };
  };

  /** Resolve a string as either a coordinate region or a gene name. */
  const resolveRegion = async (s: string, padding = 5000, signal?: AbortSignal): Promise<{ chrom: string; start: number; end: number } | null> => {
    // Try coordinate format first
    const coord = parseRegion(s);
    if (coord) return coord;
    // Try as gene name
    const res = await searchGene(s.trim(), { signal });
    if (res.found && res.chrom && res.start !== undefined && res.end !== undefined) {
      return { chrom: res.chrom, start: Math.max(0, res.start - padding), end: res.end + padding };
    }
    return null;
  };

  const handleManualSplitView = async () => {
    if (!manualX.trim() || !manualY.trim()) {
      setManualError('Enter both loci before creating a split view');
      return;
    }
    setManualError(null);
    const { controller, resolveSeq } = beginManualResolve();
    try {
      const [xr, yr] = await Promise.all([
        resolveRegion(manualX, 5000, controller.signal),
        resolveRegion(manualY, 5000, controller.signal),
      ]);
      if (!isCurrentManualResolve(resolveSeq, controller)) return;
      if (!xr) { setManualError(`Could not resolve Locus X: "${manualX}"`); return; }
      if (!yr) { setManualError(`Could not resolve Locus Y: "${manualY}"`); return; }
      // Cross-chromosome split view: pass y_chrom when chroms differ
      openContactRegions({
        chrom: xr.chrom, x_start: xr.start, x_end: xr.end,
        y_start: yr.start, y_end: yr.end,
        ...(xr.chrom !== yr.chrom ? { y_chrom: yr.chrom } : {}),
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || !isCurrentManualResolve(resolveSeq, controller)) return;
      setManualError('Failed to resolve regions');
    } finally {
      if (isCurrentManualResolve(resolveSeq, controller)) {
        manualResolveAbortRef.current = null;
        setResolving(false);
      }
    }
  };

  const handleQuickSplit = () => {
    const mid = Math.round((browserStart + browserEnd) / 2);
    openContactRegions({ chrom: browserChrom, x_start: browserStart, x_end: mid, y_start: mid, y_end: browserEnd });
  };

  if (!dafcLoaded) {
    return (
      <AnalysisPanelShell
        isFullView={isFullView}
        tabs={NO_MAP_TABS}
        activeTab={tab === 'settings' ? 'map' : tab}
        onTabChange={setTab}
        theme="red"
        className="flex h-full flex-col"
        bodyMode="fill"
        bodyClassName="p-3 space-y-3 text-sm"
        header={
          <AnalysisPanelHeader
            theme="red"
            title="Region comparisons"
            detail={tab === 'compare'
              ? 'Compare matched coordinates across detected haplotype chromosomes.'
              : 'Compare two loci for contact-aware browsing and 3C primer design.'}
            className="px-3 pt-2"
          />
        }
      >
        {tab === 'compare' ? (
          <HaplotypeComparisonSettings embedded />
        ) : (
          <>
            <AnalysisStatus kind="info" compact>
              Resolve loci by gene name or coordinate. The resulting Locus X/Y panels are saved with the session.
            </AnalysisStatus>
            <div className="space-y-1.5">
              <label className="text-xs text-gray-500">Locus X <span className="text-gray-400">(gene name or chr:start-end)</span></label>
              <input
                data-tour="contacts-locus-inputs"
                type="text" className="input-tool w-full text-xs" placeholder="e.g. sog, or chr2L:1000000-1020000"
                value={manualX} onChange={e => { abortManualResolve(); setManualError(null); setManualX(e.target.value); }}
                onKeyDown={e => { if (e.key === 'Enter') handleManualSplitView(); }}
              />
              <label className="text-xs text-gray-500">Locus Y <span className="text-gray-400">(gene name or chr:start-end)</span></label>
              <input
                type="text" className="input-tool w-full text-xs" placeholder="e.g. brk, or chr2L:1050000-1070000"
                value={manualY} onChange={e => { abortManualResolve(); setManualError(null); setManualY(e.target.value); }}
                onKeyDown={e => { if (e.key === 'Enter') handleManualSplitView(); }}
              />
            </div>
            {manualError && <AnalysisStatus kind="error" compact>{manualError}</AnalysisStatus>}
            <div className="flex gap-2">
              <AnalysisButton
                onClick={handleManualSplitView}
                disabled={resolving || !manualX.trim() || !manualY.trim()}
                theme="cyan"
                variant="primary"
                size="sm"
                className="px-3"
                data-tour="contacts-create-split"
              >
                {resolving ? 'Resolving...' : 'Create Split View'}
              </AnalysisButton>
              <AnalysisButton onClick={handleQuickSplit} variant="neutral" size="sm" className="px-3" data-tour="contacts-split-current">
                Split Current View
              </AnalysisButton>
            </div>
          </>
        )}
      </AnalysisPanelShell>
    );
  }

  return (
    <AnalysisPanelShell
      isFullView={isFullView}
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      theme="red"
      className="flex h-full flex-col"
      bodyMode="fill"
      bodyClassName="flex min-h-0 flex-col"
      header={
        <AnalysisPanelHeader
          theme="red"
          title="Contact map"
          detail={`${dafcChrom}:${dafcStart.toLocaleString()}-${dafcEnd.toLocaleString()}`}
          meta={dafcFollowBrowser ? 'follows browser' : 'manual viewport'}
          className="px-2 pt-2 pb-1"
        />
      }
      summary={
        <div className="px-2 pb-1">
          <AnalysisRunSummary
            seed={analysisSampleSeed}
            analysisCap={analysisSampleCount}
            showAnalysisCap
            filterActive={filterByPeaks && selectedPeaks.size > 0}
            filterLabel={`Peak filter: ${selectedPeaks.size}`}
            filterSource="peak-detection"
            filterSourceLabel="Peak Detection"
            peaksLocked={peaksLocked}
            inputs={[`${dafcChrom}:${dafcStart.toLocaleString()}-${dafcEnd.toLocaleString()}`]}
            outputs={[microcTrackMode ? `${microcTrackMode} mode` : 'matrix loaded']}
          />
        </div>
      }
    >
      {tab === 'map' && (
        <div ref={setContainerEl} className="flex-1 min-h-[300px]">
          <ContactMatrixTrack
            width={dimensions.width}
            height={dimensions.height}
            onOpenRegions={handleOpenRegions}
          />
        </div>
      )}
      {tab === 'settings' && <ContactSettings />}
      {tab === 'compare' && (
        <div className="p-3">
          <HaplotypeComparisonSettings embedded />
        </div>
      )}
    </AnalysisPanelShell>
  );
}

function ContactSettings() {
  const {
    microcTrackMode, toggleMicrocTrackMode,
    microcMinDistance, setMicrocMinDistance,
    microcMaxDistance, setMicrocMaxDistance,
    microcResolution, setMicrocResolution,
    arcStrengthFilter, setArcStrengthFilter,
    arcStrengthFilterMax, setArcStrengthFilterMax,
    dafcResolutions,
    filterByPeaks, toggleFilterByPeaks,
    matrixScaling, setMatrixScaling,
    matrixColormap, setMatrixColormap,
    matrixNormalization, setMatrixNormalization,
    arcDisplayMode, setArcDisplayMode,
    arcMergeBinSize, setArcMergeBinSize,
    arcNormalization, setArcNormalization,
    arcMinCount, setArcMinCount,
    v4cNormalization, setV4cNormalization,
    v4cSmoothing, setV4cSmoothing,
    v4cMinCount, setV4cMinCount,
    arcOEFloor, setArcOEFloor,
    arcAccCorrect, setArcAccCorrect,
    arcAccLog, setArcAccLog,
  } = useDafcStore(useShallow(s => ({
    microcTrackMode: s.microcTrackMode,
    toggleMicrocTrackMode: s.toggleMicrocTrackMode,
    microcMinDistance: s.microcMinDistance,
    setMicrocMinDistance: s.setMicrocMinDistance,
    microcMaxDistance: s.microcMaxDistance,
    setMicrocMaxDistance: s.setMicrocMaxDistance,
    microcResolution: s.microcResolution,
    setMicrocResolution: s.setMicrocResolution,
    arcStrengthFilter: s.arcStrengthFilter,
    setArcStrengthFilter: s.setArcStrengthFilter,
    arcStrengthFilterMax: s.arcStrengthFilterMax,
    setArcStrengthFilterMax: s.setArcStrengthFilterMax,
    dafcResolutions: s.dafcResolutions,
    filterByPeaks: s.filterByPeaks,
    toggleFilterByPeaks: s.toggleFilterByPeaks,
    matrixScaling: s.matrixScaling,
    setMatrixScaling: s.setMatrixScaling,
    matrixColormap: s.matrixColormap,
    setMatrixColormap: s.setMatrixColormap,
    matrixNormalization: s.matrixNormalization,
    setMatrixNormalization: s.setMatrixNormalization,
    arcDisplayMode: s.arcDisplayMode,
    setArcDisplayMode: s.setArcDisplayMode,
    arcMergeBinSize: s.arcMergeBinSize,
    setArcMergeBinSize: s.setArcMergeBinSize,
    arcNormalization: s.arcNormalization,
    setArcNormalization: s.setArcNormalization,
    arcMinCount: s.arcMinCount,
    setArcMinCount: s.setArcMinCount,
    v4cNormalization: s.v4cNormalization,
    setV4cNormalization: s.setV4cNormalization,
    v4cSmoothing: s.v4cSmoothing,
    setV4cSmoothing: s.setV4cSmoothing,
    v4cMinCount: s.v4cMinCount,
    setV4cMinCount: s.setV4cMinCount,
    arcOEFloor: s.arcOEFloor,
    setArcOEFloor: s.setArcOEFloor,
    arcAccCorrect: s.arcAccCorrect,
    setArcAccCorrect: s.setArcAccCorrect,
    arcAccLog: s.arcAccLog,
    setArcAccLog: s.setArcAccLog,
  })));

  const selectedPeaks = useBrowserStore(s => s.selectedPeaks);
  const [trackOpen, setTrackOpen] = useState(true);
  const [matrixOpen, setMatrixOpen] = useState(microcTrackMode === 'matrix');
  const [arcOpen, setArcOpen] = useState(microcTrackMode === 'arc');
  const [v4cOpen, setV4cOpen] = useState(microcTrackMode === 'virtual4c');

  const handleModeButtonClick = (
    mode: 'matrix' | 'arc' | 'virtual4c',
  ) => {
    const enablingMode = microcTrackMode !== mode;
    toggleMicrocTrackMode(mode);
    if (!enablingMode) return;
    setTrackOpen(true);
    if (mode === 'matrix') setMatrixOpen(true);
    if (mode === 'arc') setArcOpen(true);
    if (mode === 'virtual4c') setV4cOpen(true);
  };

  const modeButton = (
    mode: 'matrix' | 'arc' | 'virtual4c',
    label: string,
    detail: string,
    accent: string,
  ) => (
    <button
      type="button"
      onClick={() => handleModeButtonClick(mode)}
      className={`rounded-md border px-2 py-1 text-left transition-colors ${
        microcTrackMode === mode
          ? 'border-red-300 bg-white text-gray-900 shadow-sm dark:border-red-700 dark:bg-gray-900 dark:text-gray-100'
          : 'border-gray-200 bg-white/60 text-gray-500 hover:border-gray-300 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <span className={`h-2 w-2 rounded-full ${accent}`} />
        {label}
      </div>
      <div className="mt-0.5 text-[11px] leading-snug text-gray-400">{detail}</div>
    </button>
  );

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-xs">
      <AnalysisSettingsSection
        open={trackOpen}
        onOpenChange={setTrackOpen}
        theme="red"
        title="Track overlay"
        tourId="contacts-track-overlay"
        summary={microcTrackMode ? microcTrackMode : 'off'}
      >
        <div className="grid grid-cols-1 gap-1.5">
          {modeButton('matrix', 'Matrix strip', 'Local contact heatmap under reads', 'bg-red-500')}
          {modeButton('arc', 'Arcs', 'Peak-aware long-range contacts', 'bg-blue-500')}
          {modeButton('virtual4c', 'Virtual 4C', 'One viewpoint against the viewport', 'bg-violet-500')}
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1.5">
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Max distance</span>
            <select value={microcMaxDistance} onChange={e => setMicrocMaxDistance(parseInt(e.target.value))} className="input-tool w-full text-xs">
              <option value={50000}>50kb</option>
              <option value={100000}>100kb</option>
              <option value={200000}>200kb</option>
              <option value={500000}>500kb</option>
              <option value={1000000}>1Mb</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Resolution</span>
            <select
              value={microcResolution ?? 'auto'}
              onChange={e => setMicrocResolution(e.target.value === 'auto' ? null : parseInt(e.target.value))}
              className="input-tool w-full text-xs"
            >
              <option value="auto">Auto</option>
              {dafcResolutions.map(res => (
                <option key={res} value={res}>{res >= 1000 ? `${res / 1000}kb` : `${res}bp`}</option>
              ))}
            </select>
          </label>
        </div>
        {!microcTrackMode && (
          <AnalysisStatus kind="info" compact>
            Pick a track overlay to show contact data under the normal read panels.
          </AnalysisStatus>
        )}
      </AnalysisSettingsSection>

      <AnalysisSettingsSection
        open={matrixOpen}
        onOpenChange={setMatrixOpen}
        theme="red"
        title="Matrix strip"
        tourId="contacts-matrix-settings"
        summary={`${matrixNormalization}, ${matrixScaling}`}
      >
        {microcTrackMode !== 'matrix' && <AnalysisStatus kind="info" compact>Enable Matrix strip above to display these settings.</AnalysisStatus>}
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Scale</span>
            <select value={matrixScaling} onChange={e => setMatrixScaling(e.target.value as any)} className="input-tool w-full text-xs">
              <option value="log">Log</option>
              <option value="sqrt">Sqrt</option>
              <option value="linear">Linear</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Colors</span>
            <select value={matrixColormap} onChange={e => setMatrixColormap(e.target.value as any)} className="input-tool w-full text-xs">
              <option value="fall">Fall</option>
              <option value="red">Red</option>
              <option value="hot">Hot</option>
              <option value="viridis">Viridis</option>
              <option value="blues">Blues</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Norm</span>
            <select value={matrixNormalization} onChange={e => setMatrixNormalization(e.target.value as any)} className="input-tool w-full text-xs">
              <option value="none">Raw</option>
              <option value="balanced">Balanced</option>
              <option value="oe">O/E local</option>
              <option value="oe_global">O/E global</option>
            </select>
          </label>
        </div>
      </AnalysisSettingsSection>

      <AnalysisSettingsSection
        open={arcOpen}
        onOpenChange={setArcOpen}
        theme="red"
        title="Arcs"
        tourId="contacts-arcs-settings"
        summary={`${arcNormalization}, ${arcDisplayMode}`}
      >
        {microcTrackMode !== 'arc' && <AnalysisStatus kind="info" compact>Enable Arcs above to display these settings.</AnalysisStatus>}
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Min distance</span>
            <select value={microcMinDistance} onChange={e => setMicrocMinDistance(parseInt(e.target.value))} className="input-tool w-full text-xs">
              <option value={0}>Off</option>
              <option value={500}>500bp</option>
              <option value={1000}>1kb</option>
              <option value={2000}>2kb</option>
              <option value={5000}>5kb</option>
              <option value={10000}>10kb</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Normalization</span>
            <select value={arcNormalization} onChange={e => setArcNormalization(e.target.value as any)} className="input-tool w-full text-xs">
              <option value="none">Raw</option>
              <option value="oe">O/E local</option>
              <option value="oe_global">O/E global</option>
            </select>
          </label>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500">Strength</span>
          <input type="number" min="0" max="1" step="0.05" value={arcStrengthFilter} onChange={e => setArcStrengthFilter(Math.min(parseFloat(e.target.value) || 0, arcStrengthFilterMax))} className="input-tool w-14 text-xs" />
          <span className="text-gray-400">to</span>
          <input type="number" min="0" max="1" step="0.05" value={arcStrengthFilterMax} onChange={e => setArcStrengthFilterMax(Math.max(parseFloat(e.target.value) || 1, arcStrengthFilter))} className="input-tool w-14 text-xs" />
          <AnalysisButton
            type="button"
            onClick={() => { setArcStrengthFilter(0); setArcStrengthFilterMax(1); }}
            theme="red"
            variant="outline"
            className="px-1.5 py-0"
          >
            reset
          </AnalysisButton>
        </div>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={filterByPeaks} onChange={toggleFilterByPeaks} className="rounded border-gray-300 dark:border-white/20" disabled={selectedPeaks.size === 0} />
          <span className={selectedPeaks.size === 0 ? 'text-gray-400' : 'text-gray-600 dark:text-gray-400'}>
            Filter arcs by selected peaks {selectedPeaks.size > 0 && `(${selectedPeaks.size})`}
          </span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Min raw count</span>
            <input type="number" min="0" step="1" value={arcMinCount} onChange={e => setArcMinCount(Math.max(0, parseInt(e.target.value) || 0))} className="input-tool w-full text-xs" />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Display</span>
            <select value={arcDisplayMode} onChange={e => setArcDisplayMode(e.target.value as any)} className="input-tool w-full text-xs">
              <option value="individual">Individual</option>
              <option value="merged">Merged</option>
              <option value="opacity">Opacity</option>
            </select>
          </label>
        </div>
        {arcNormalization !== 'none' && (
          <div className="rounded border border-white/60 bg-white/50 p-2 space-y-1.5 dark:border-white/10 dark:bg-white/5">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">O/E floor</span>
              <input type="number" min="0" step="0.1" value={arcOEFloor} onChange={e => setArcOEFloor(Math.max(0, parseFloat(e.target.value) || 0))} className="input-tool w-16 text-xs" />
              {arcOEFloor > 0 && (
                <AnalysisButton
                  type="button"
                  onClick={() => setArcOEFloor(0)}
                  theme="red"
                  variant="outline"
                  className="px-1.5 py-0"
                >
                  reset
                </AnalysisButton>
              )}
            </div>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={arcAccCorrect} onChange={e => setArcAccCorrect(e.target.checked)} className="rounded border-gray-300 dark:border-white/20" />
              <span className="text-gray-600 dark:text-gray-400">Accessibility correction</span>
            </label>
            {arcAccCorrect && (
              <label className="flex items-center gap-1.5 pl-4">
                <input type="checkbox" checked={arcAccLog} onChange={e => setArcAccLog(e.target.checked)} className="rounded border-gray-300 dark:border-white/20" />
                <span className="text-gray-400">Use log-space correction</span>
              </label>
            )}
          </div>
        )}
        {arcDisplayMode === 'merged' && (
          <label className="flex items-center gap-2">
            <span className="text-gray-500">Merge bin</span>
            <select value={arcMergeBinSize} onChange={e => setArcMergeBinSize(parseInt(e.target.value))} className="input-tool text-xs">
              <option value={500}>500bp</option>
              <option value={1000}>1kb</option>
              <option value={2000}>2kb</option>
              <option value={5000}>5kb</option>
              <option value={10000}>10kb</option>
            </select>
          </label>
        )}
      </AnalysisSettingsSection>

      <AnalysisSettingsSection
        open={v4cOpen}
        onOpenChange={setV4cOpen}
        theme="red"
        title="Virtual 4C"
        tourId="contacts-v4c-settings"
        summary={`${v4cNormalization}, ${v4cSmoothing || 'no'} smooth`}
      >
        {microcTrackMode !== 'virtual4c' && <AnalysisStatus kind="info" compact>Enable Virtual 4C above to display these settings.</AnalysisStatus>}
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Norm</span>
            <select value={v4cNormalization} onChange={e => setV4cNormalization(e.target.value as any)} className="input-tool w-full text-xs">
              <option value="none">Raw</option>
              <option value="oe">O/E</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Smooth</span>
            <select value={v4cSmoothing} onChange={e => setV4cSmoothing(parseInt(e.target.value))} className="input-tool w-full text-xs">
              <option value={0}>Off</option>
              <option value={3}>3 bins</option>
              <option value={5}>5 bins</option>
              <option value={7}>7 bins</option>
              <option value={11}>11 bins</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-gray-400">Min count</span>
            <input type="number" min="0" step="1" value={v4cMinCount} onChange={e => setV4cMinCount(Math.max(0, parseInt(e.target.value) || 0))} className="input-tool w-full text-xs" />
          </label>
        </div>
      </AnalysisSettingsSection>
    </div>
  );
}
