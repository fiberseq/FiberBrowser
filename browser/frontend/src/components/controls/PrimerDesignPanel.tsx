import { activePanelView } from '../../utils/panelScope';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import {
  designPrimers, designDafcPrimers, design4cPrimers, PrimerDesignOptions,
  getPrimerProgress, abortPrimerDesign, PrimerProgressResponse,
} from '../../api/primers';
import { referenceForChrom } from '../../stores/panelGenomeStore';
import { searchGene } from '../../api/reference';
import type { PrimerPair, SavedPrimer, DafcPrimerQuad } from '../../types';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisRunSummary } from './shared';
import { parsePrimerFile, isDuplicateOfSaved } from '../../utils/primerImport';
import { buildPrimerExcludeRegions, buildPrimerExcludeRegionsByChrom } from '../../utils/primerExclusions';
import { formatPrimerOrder, type PrimerOrderFormat } from '../../utils/primerExport';
import { usePrimerBlastConfig } from '../../hooks/usePrimerBlastConfig';
import { DesignParametersSection } from './primer-design/DesignParametersSection';
import { DesignResultsSection } from './primer-design/DesignResultsSection';
import { DesignRunControls } from './primer-design/DesignRunControls';
import { DesignTargetSection } from './primer-design/DesignTargetSection';
import { DesignWarningsSection } from './primer-design/DesignWarningsSection';
import { OrderListTab } from './primer-design/OrderListTab';
import { PrimerStatusChip } from './primer-design/PrimerStatusChip';
import { sameChrom } from '../../utils/chromAliases';
import { CapturePanel } from './CapturePanel';
import { useRememberedState } from '../../hooks/useRememberedState';

const DEFAULT_PARAMS: PrimerDesignOptions = {
  min_product: 5000,
  max_product: 50000,
  min_tm: 55,
  max_tm: 65,
  max_tm_diff: 2.0,
  min_len: 18,
  max_len: 25,
  max_g_count: 2,
  max_run_length: 4,
  max_gc_pct: 70,
  tm_method: 'primer3',
  check_tandem_repeats: true,
  check_three_prime_specificity: true,
  optimize_for: 'closest',
  max_results: 5,
  min_spacing: 50,
};

type Tab = 'design' | 'order' | 'capture';
const PRIMER_DESIGN_TAB_STORAGE_KEY = 'fiberbrowser_primer_design_tab';

function initialPrimerDesignTab(): Tab {
  if (typeof window === 'undefined') return 'design';
  const requested = window.sessionStorage.getItem(PRIMER_DESIGN_TAB_STORAGE_KEY);
  return requested === 'order' || requested === 'capture' ? requested : 'design';
}

const PRIMER_TM_SHORT_LABELS: Record<string, string> = {
  snapgene: 'SnapGene',
  primer3: 'Primer3',
  owczarzy: 'Owczarzy',
  breslauer: 'Breslauer',
  wallace: 'Wallace',
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

interface Props {
  isFullView?: boolean;
}

/** Tag design results with where they were designed (they outlive navigation). */
/** The chromosome of a standard/4C target: its peaks' own (one chromosome only), else the view's. */
export function primerTargetChrom(peaks: Array<{ chrom?: string }>, viewChrom: string): { chroms: string[]; chrom: string; mixed: boolean } {
  const chroms = [...new Set(peaks.map(p => p.chrom ?? viewChrom))];
  return { chroms, chrom: chroms.length === 1 ? chroms[0] : viewChrom, mixed: chroms.length > 1 };
}

export const designedAt = (designChrom: string, targetStart: number | null, targetEnd: number | null) =>
  (pair: PrimerPair): PrimerPair => ({
    ...pair,
    designChrom,
    ...(targetStart != null ? { designTargetStart: targetStart } : {}),
    ...(targetEnd != null ? { designTargetEnd: targetEnd } : {}),
  });

/** Peaks inside a locus, on its chromosome (a peak without one is the main view's). */
export function peaksOnLocus<P extends { chrom?: string; start: number; end: number }>(
  peaks: P[],
  locus: { chrom: string; start: number; end: number },
  viewChrom: string,
): P[] {
  return peaks.filter(p => sameChrom(p.chrom ?? viewChrom, locus.chrom) && p.end > locus.start && p.start < locus.end);
}

export function PrimerDesignPanel({ isFullView }: Props) {
  const {
    chrom, viewGenome, hasFasta: mainHasFasta,
    primer: primerRaw, panels, captureRegionCount,
    selectedPeaks, getAllPeaks, start, end,
    peaksLocked, analysisSampleSeed,
    setPrimerTarget, setPrimerPair,
    setPrimerDesigning, setPrimerError,
    setDesignResults, addSavedPrimer, addSavedPrimers, removeSavedPrimer,
    updateSavedPrimerName, clearSavedPrimers, clearPrimers,
    setPrimerMode, setDafcQuads, openContactRegions, setCartTrackDisplay,
  } = useBrowserStore(useShallow(s => ({
    chrom: activePanelView(s).chrom, viewGenome: activePanelView(s).genome, hasFasta: s.hasFasta,
    primer: s.primer, panels: s.panels, captureRegionCount: s.captureRegions.length,
    selectedPeaks: s.selectedPeaks, getAllPeaks: s.getAllPeaks, start: activePanelView(s).start, end: activePanelView(s).end,
    peaksLocked: s.peaksLocked, analysisSampleSeed: s.analysisSampleSeed,
    setPrimerTarget: s.setPrimerTarget, setPrimerPair: s.setPrimerPair,
    setPrimerDesigning: s.setPrimerDesigning, setPrimerError: s.setPrimerError,
    setDesignResults: s.setDesignResults, addSavedPrimer: s.addSavedPrimer, addSavedPrimers: s.addSavedPrimers, removeSavedPrimer: s.removeSavedPrimer,
    updateSavedPrimerName: s.updateSavedPrimerName, clearSavedPrimers: s.clearSavedPrimers, clearPrimers: s.clearPrimers,
    setPrimerMode: s.setPrimerMode, setDafcQuads: s.setDafcQuads,
    openContactRegions: s.openContactRegions, setCartTrackDisplay: s.setCartTrackDisplay,
  })));

  // Guard against stale state shapes (older IndexedDB autosaves can restore
  // a primer object missing designResults / dafcQuads / savedPrimers /
  // cartTrackDisplay — all of which the render path reads as arrays). We
  // use the normalized view inside this component; writes still target the
  // store via its actions.
  const primer = useMemo(() => ({
    ...primerRaw,
    designResults: primerRaw.designResults ?? [],
    dafcQuads: primerRaw.dafcQuads ?? [],
    savedPrimers: primerRaw.savedPrimers ?? [],
    cartTrackDisplay: primerRaw.cartTrackDisplay ?? 'off',
    mode: primerRaw.mode ?? 'standard',
  }), [primerRaw]);

  // Detect split-view loci from contact map panels
  const splitPanels = panels.filter(p => p.viewportOverride && p.regionLabel);
  const locusX = splitPanels.find(p => p.regionLabel === 'Locus X')?.viewportOverride ?? null;
  const locusY = splitPanels.find(p => p.regionLabel === 'Locus Y')?.viewportOverride ?? null;
  const hasSplitView = locusX !== null && locusY !== null;

  // 3C mode: region input state
  const [locusXInput, setLocusXInput] = useState('');
  const [locusYInput, setLocusYInput] = useState('');
  const [resolvingLoci, setResolvingLoci] = useState(false);

  const [activeTab, setActiveTab] = useRememberedState<Tab>('primer-design:tab', initialPrimerDesignTab);
  const [showParams, setShowParams] = useState(false);
  const [params, setParams] = useState<PrimerDesignOptions>(DEFAULT_PARAMS);
  const [progress, setProgress] = useState<PrimerProgressResponse>({ active: false, stage: '', progress: 0, message: '' });
  const [resultNames, setResultNames] = useState<Record<number, string>>({});
  const [addedIndices, setAddedIndices] = useState<Set<number>>(new Set());
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [includeLoadedInExport, setIncludeLoadedInExport] = useState(false);
  const [orderExportFormat, setOrderExportFormat] = useState<PrimerOrderFormat>('idt');
  // Exclude cart-primer footprints during design (default on). Padding is the
  // ±bp window around each cart primer that's forbidden — small enough that
  // we still hit nearby primers, large enough to reject obvious repeats.
  const [excludeCartPrimers, setExcludeCartPrimers] = useState(true);
  const [excludePadBp, setExcludePadBp] = useState(5);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressPollAbortRef = useRef<AbortController | null>(null);
  const progressPollInFlightRef = useRef(false);
  const designRunSeqRef = useRef(0);
  const designAbortControllerRef = useRef<AbortController | null>(null);
  const locusResolveSeqRef = useRef(0);
  const locusResolveAbortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    blastDbChoices,
    blastSetupBusy,
    blastSetupMessage,
    blastWarning,
    blastTool,
    buildBlastDbFromFasta,
    handlePickBlast,
    selectBlastDb,
    setBlastDbChoices,
    setBlastWarning,
  } = usePrimerBlastConfig();

  // Derive target from selected peaks (both scanned and custom)
  const allPeaks = getAllPeaks();
  const selectedPeaksList = allPeaks.filter(p => selectedPeaks.has(p.index));
  const peakCount = selectedPeaksList.length;
  // The target's chromosome: a peak selected in a panel at another locus
  // carries its own. Standard and 4C designs need all peaks on one chromosome.
  const { chroms: peakChroms, chrom: targetChrom, mixed: mixedTargetChroms } = primerTargetChrom(selectedPeaksList, chrom);
  // The reference the target is on: the selected peaks' panel's (another assembly), else found by chromosome.
  const peakGenomes = [...new Set(selectedPeaksList.map(p => p.genome ?? null))];
  const targetGenome = () => (selectedPeaksList.length > 0 ? peakGenomes[0] ?? null : targetChrom === chrom ? viewGenome : referenceForChrom(targetChrom));
  const reference = targetGenome();
  const ownHasFasta = usePanelGenomeStore(s => reference ? !!s.genomes[reference]?.has_fasta : null);
  const hasFasta = ownHasFasta ?? mainHasFasta;
  const peakTarget = peakCount > 0
    ? {
        start: Math.min(...selectedPeaksList.map(p => p.start)),
        end: Math.max(...selectedPeaksList.map(p => p.end)),
      }
    : null;

  // Sync peak-derived target to store (standard + 4C use it; 3C has independent loci)
  useEffect(() => {
    if ((primer.mode === 'standard' || primer.mode === '4c') && peakTarget) {
      setPrimerTarget(peakTarget.start, peakTarget.end, targetChrom);
    } else if (primer.mode === 'dafc') {
      setPrimerTarget(null, null);
    }
  }, [peakTarget?.start, peakTarget?.end, primer.mode, targetChrom]);

  // Poll progress while designing
  useEffect(() => {
    if (primer.designing) {
      const runSeq = designRunSeqRef.current;
      const pollProgress = async () => {
        if (progressPollInFlightRef.current || designRunSeqRef.current !== runSeq) return;
        progressPollInFlightRef.current = true;
        const controller = new AbortController();
        progressPollAbortRef.current = controller;
        try {
          const prog = await getPrimerProgress({ signal: controller.signal });
          if (designRunSeqRef.current === runSeq && !controller.signal.aborted) {
            setProgress(prog);
          }
        } catch (error) {
          if (!isAbortError(error)) {
            // Progress is advisory; design failures are reported by the design request.
          }
        } finally {
          if (progressPollAbortRef.current === controller) {
            progressPollAbortRef.current = null;
          }
          progressPollInFlightRef.current = false;
        }
      };
      void pollProgress();
      progressIntervalRef.current = setInterval(pollProgress, 500);
    } else {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      progressPollAbortRef.current?.abort();
      progressPollAbortRef.current = null;
      progressPollInFlightRef.current = false;
      setProgress({ active: false, stage: '', progress: 0, message: '' });
    }
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      progressPollAbortRef.current?.abort();
      progressPollAbortRef.current = null;
    };
  }, [primer.designing]);

  useEffect(() => () => {
    const running = designAbortControllerRef.current !== null;
    designRunSeqRef.current += 1;
    designAbortControllerRef.current?.abort();
    designAbortControllerRef.current = null;
    locusResolveSeqRef.current += 1;
    locusResolveAbortControllerRef.current?.abort();
    if (running) {
      // Closing the panel stops its design (the run can't finish without it):
      // stop the server's work too and don't leave the panel busy.
      void abortPrimerDesign().catch(() => { /* already finished */ });
      useBrowserStore.getState().setPrimerDesigning(false);
    }
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      if (tab === 'design' || tab === 'order' || tab === 'capture') setActiveTab(tab);
    };
    window.addEventListener('fiberbrowser:open-primer-design-tab', handler);
    return () => window.removeEventListener('fiberbrowser:open-primer-design-tab', handler);
  }, []);

  const beginDesignRun = () => {
    designAbortControllerRef.current?.abort();
    const controller = new AbortController();
    designAbortControllerRef.current = controller;
    const runSeq = designRunSeqRef.current + 1;
    designRunSeqRef.current = runSeq;
    setDesignResults([]);
    setDafcQuads([]);
    setResultNames({});
    setAddedIndices(new Set());
    setProgress({ active: true, stage: 'queued', progress: 0, message: 'Starting primer design...' });
    setPrimerDesigning(true);
    setPrimerError(null);
    return { runSeq, controller };
  };

  const isCurrentDesignRun = (runSeq: number, controller: AbortController) => (
    designRunSeqRef.current === runSeq && designAbortControllerRef.current === controller && !controller.signal.aborted
  );

  const finishDesignRun = (runSeq: number, controller: AbortController) => {
    if (!isCurrentDesignRun(runSeq, controller)) return;
    designAbortControllerRef.current = null;
    setPrimerDesigning(false);
  };

  const handleDesignPrimers = async () => {
    if (!primer.targetStart || !primer.targetEnd) {
      setPrimerError('Select peaks to define target region');
      return;
    }
    if (mixedTargetChroms || peakGenomes.length > 1) {
      setPrimerError(peakGenomes.length > 1
        ? 'The selected peaks are on different assemblies; select peaks in one panel'
        : 'The selected peaks are on different chromosomes; select peaks on one chromosome');
      return;
    }

    const { runSeq, controller } = beginDesignRun();
    const withContext = designedAt(targetChrom, primer.targetStart, primer.targetEnd);

    try {
      const excludeRegions = buildExcludeRegionsFor(targetChrom);
      const result = await designPrimers(targetChrom, primer.targetStart, primer.targetEnd, {
        ...params,
        ...(excludeRegions.length > 0 ? { exclude_regions: excludeRegions } : {}),
      }, { signal: controller.signal, genome: targetGenome() }) as { success: boolean; message?: string; warning?: string; pairs?: PrimerPair[]; pair?: PrimerPair };

      if (!isCurrentDesignRun(runSeq, controller)) return;
      setBlastWarning(result.warning ?? null);
      if (result.success && result.pairs && result.pairs.length > 0) {
        const pairs = result.pairs.map(withContext);
        setDesignResults(pairs);
        setPrimerPair(pairs[0]);
      } else if (result.success && result.pair) {
        // Backward compat: single pair
        const pair = withContext(result.pair);
        setDesignResults([pair]);
        setPrimerPair(pair);
      } else {
        setPrimerError(result.message || 'Failed to design primers');
      }
    } catch (error) {
      if (isAbortError(error) || !isCurrentDesignRun(runSeq, controller)) return;
      setPrimerError('Failed to design primers');
    } finally {
      finishDesignRun(runSeq, controller);
    }
  };

  /** Resolve a string as coordinate region or gene name. */
  const resolveRegion = async (s: string, padding = 5000): Promise<{ chrom: string; start: number; end: number } | null> => {
    const m = s.trim().match(/^(\S+)[:\s]+([0-9,]+)\s*[-\s]+\s*([0-9,]+)$/);
    if (m) return { chrom: m[1], start: parseInt(m[2].replace(/,/g, '')), end: parseInt(m[3].replace(/,/g, '')) };
    const res = await searchGene(s.trim(), { signal: locusResolveAbortControllerRef.current?.signal });
    if (res.found && res.chrom && res.start !== undefined && res.end !== undefined) {
      return { chrom: res.chrom, start: Math.max(0, res.start - padding), end: res.end + padding };
    }
    return null;
  };

  const handleCreateSplitView = async () => {
    if (!locusXInput.trim() || !locusYInput.trim()) {
      setPrimerError('Enter a gene name or coordinates for both loci');
      return;
    }
    locusResolveAbortControllerRef.current?.abort();
    const controller = new AbortController();
    locusResolveAbortControllerRef.current = controller;
    const resolveSeq = locusResolveSeqRef.current + 1;
    locusResolveSeqRef.current = resolveSeq;
    setResolvingLoci(true);
    setPrimerError(null);
    try {
      const [xr, yr] = await Promise.all([resolveRegion(locusXInput), resolveRegion(locusYInput)]);
      if (locusResolveSeqRef.current !== resolveSeq || locusResolveAbortControllerRef.current !== controller) return;
      if (!xr) { setPrimerError(`Could not resolve Locus X: "${locusXInput}"`); return; }
      if (!yr) { setPrimerError(`Could not resolve Locus Y: "${locusYInput}"`); return; }
      // Cross-chromosome split view: pass y_chrom when chroms differ
      openContactRegions({
        chrom: xr.chrom, x_start: xr.start, x_end: xr.end,
        y_start: yr.start, y_end: yr.end,
        ...(xr.chrom !== yr.chrom ? { y_chrom: yr.chrom } : {}),
      });
    } catch (error) {
      if (isAbortError(error) || locusResolveSeqRef.current !== resolveSeq) return;
      setPrimerError('Failed to resolve regions');
    } finally {
      if (locusResolveSeqRef.current === resolveSeq && locusResolveAbortControllerRef.current === controller) {
        locusResolveAbortControllerRef.current = null;
        setResolvingLoci(false);
      }
    }
  };

  const handleDesignDafc = async () => {
    if (!locusX || !locusY) {
      setPrimerError('Open a contact map split view (Locus X + Y) first');
      return;
    }
    if (!peakTarget) {
      setPrimerError('Select peaks in both loci to define target regions');
      return;
    }

    // Split selected peaks into those overlapping Locus X vs Y
    const xPeaks = peaksOnLocus(selectedPeaksList, locusX, chrom);
    const yPeaks = peaksOnLocus(selectedPeaksList, locusY, chrom);

    if (xPeaks.length === 0 || yPeaks.length === 0) {
      setPrimerError('Select at least one peak in each locus (X and Y)');
      return;
    }

    const xTarget = { start: Math.min(...xPeaks.map(p => p.start)), end: Math.max(...xPeaks.map(p => p.end)) };
    const yTarget = { start: Math.min(...yPeaks.map(p => p.start)), end: Math.max(...yPeaks.map(p => p.end)) };

    const { runSeq, controller } = beginDesignRun();

    // Use per-locus chromosomes for cross-chrom support
    const xChrom = locusX.chrom;
    const yChrom = locusY.chrom;

    try {
      const excludeByChrom = buildExcludeRegionsByChrom();
      const result = await designDafcPrimers(xChrom, xTarget.start, xTarget.end, yTarget.start, yTarget.end, {
        ...params,
        sample_seed: analysisSampleSeed,
        ...(Object.keys(excludeByChrom).length > 0 ? { exclude_regions_by_chrom: excludeByChrom } : {}),
      }, xChrom !== yChrom ? yChrom : undefined, { signal: controller.signal });
      if (!isCurrentDesignRun(runSeq, controller)) return;
      if (result.success && result.quads && result.quads.length > 0) {
        // Each pair keeps its own locus: the split view (and its loci) may be
        // gone by the time a quad is ordered or drawn.
        const xAt = designedAt(xChrom, xTarget.start, xTarget.end);
        const yAt = designedAt(yChrom, yTarget.start, yTarget.end);
        const quads = result.quads.map(q => ({ ...q, x_pair: xAt(q.x_pair), y_pair: yAt(q.y_pair) }));
        setDafcQuads(quads);
        // Highlight the first quad's X pair on the track
        setPrimerPair(quads[0].x_pair);
      } else {
        setPrimerError(result.message || 'No compatible primer quads found');
      }
    } catch (error) {
      if (isAbortError(error) || !isCurrentDesignRun(runSeq, controller)) return;
      setPrimerError('Failed to design 3C primers');
    } finally {
      finishDesignRun(runSeq, controller);
    }
  };

  const handleAddDafcQuadToOrder = (quad: DafcPrimerQuad, index: number) => {
    const baseName = resultNames[index] || `3C_${primer.savedPrimers.length / 2 + 1}`;
    // Where each pair was designed (tagged at design time), else the open split view's loci.
    const savedX: SavedPrimer = {
      name: `${baseName}_X`, pair: quad.x_pair, chrom: quad.x_pair.designChrom ?? locusX?.chrom ?? chrom,
      targetStart: quad.x_pair.designTargetStart ?? locusX?.start ?? 0,
      targetEnd: quad.x_pair.designTargetEnd ?? locusX?.end ?? 0, addedAt: Date.now(),
      source: 'design',
    };
    const savedY: SavedPrimer = {
      name: `${baseName}_Y`, pair: quad.y_pair, chrom: quad.y_pair.designChrom ?? locusY?.chrom ?? chrom,
      targetStart: quad.y_pair.designTargetStart ?? locusY?.start ?? 0,
      targetEnd: quad.y_pair.designTargetEnd ?? locusY?.end ?? 0, addedAt: Date.now(),
      source: 'design',
    };
    addSavedPrimer(savedX);
    addSavedPrimer(savedY);
    setAddedIndices(prev => new Set(prev).add(index));
    setTimeout(() => setAddedIndices(prev => { const next = new Set(prev); next.delete(index); return next; }), 2000);
  };

  const handleDesign4c = async () => {
    if (!primer.targetStart || !primer.targetEnd) {
      setPrimerError('Select peaks to define the viewpoint region');
      return;
    }
    if (mixedTargetChroms) {
      setPrimerError('The selected peaks are on different chromosomes; select peaks on one chromosome');
      return;
    }

    const { runSeq, controller } = beginDesignRun();
    const withContext = designedAt(targetChrom, primer.targetStart, primer.targetEnd);

    try {
      const excludeRegions = buildExcludeRegionsFor(targetChrom);
      const result = await design4cPrimers(targetChrom, primer.targetStart, primer.targetEnd, {
        min_tm: params.min_tm, max_tm: params.max_tm, max_tm_diff: params.max_tm_diff,
        min_len: params.min_len, max_len: params.max_len, max_g_count: params.max_g_count,
        max_run_length: params.max_run_length, max_gc_pct: params.max_gc_pct,
        tm_method: params.tm_method,
        check_tandem_repeats: params.check_tandem_repeats,
        check_three_prime_specificity: params.check_three_prime_specificity,
        ...(excludeRegions.length > 0 ? { exclude_regions: excludeRegions } : {}),
      }, { signal: controller.signal, genome: targetGenome() });
      if (!isCurrentDesignRun(runSeq, controller)) return;
      if (result.success && result.pairs && result.pairs.length > 0) {
        const pairs = result.pairs.map(withContext);
        setDesignResults(pairs);
        setPrimerPair(pairs[0]);
      } else {
        setPrimerError(result.message || 'No 4C primers found');
      }
    } catch (error) {
      if (isAbortError(error) || !isCurrentDesignRun(runSeq, controller)) return;
      setPrimerError('Failed to design 4C primers');
    } finally {
      finishDesignRun(runSeq, controller);
    }
  };

  const handleHighlightPair = (pair: PrimerPair) => {
    setPrimerPair(pair);
  };

  const handleAbortDesign = () => {
    designRunSeqRef.current += 1;
    designAbortControllerRef.current?.abort();
    designAbortControllerRef.current = null;
    progressPollAbortRef.current?.abort();
    progressPollAbortRef.current = null;
    setProgress({ active: false, stage: '', progress: 0, message: '' });
    void abortPrimerDesign().catch(err => console.error('Primer abort failed:', err));
    setPrimerDesigning(false);
  };

  const handleAddToOrder = (pair: PrimerPair, index: number) => {
    const name = resultNames[index] || `Primer_${primer.savedPrimers.length + 1}`;
    // Where it was designed, not where the view is now.
    const saved: SavedPrimer = {
      name,
      pair,
      chrom: pair.designChrom ?? targetChrom,
      targetStart: pair.designTargetStart ?? primer.targetStart!,
      targetEnd: pair.designTargetEnd ?? primer.targetEnd!,
      addedAt: Date.now(),
      source: 'design',
    };
    addSavedPrimer(saved);
    // Show checkmark feedback for 2 seconds
    setAddedIndices(prev => new Set(prev).add(index));
    setTimeout(() => setAddedIndices(prev => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    }), 2000);
  };

  const updateParam = <K extends keyof PrimerDesignOptions>(key: K, value: PrimerDesignOptions[K]) => {
    setParams(p => ({ ...p, [key]: value }));
  };

  // ── Import existing primer BEDs/TSVs into the cart ───────────
  const handleImportPrimers = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    let totalAdded = 0, totalSkipped = 0;
    const allErrors: string[] = [];
    const fileNames: string[] = [];
    for (const file of Array.from(files)) {
      fileNames.push(file.name);
      try {
        const text = await file.text();
        const { primers, errors } = parsePrimerFile(file.name, text);
        if (errors.length > 0) allErrors.push(...errors.map(e => `${file.name}: ${e}`));
        if (primers.length > 0) {
          const { added, skipped } = addSavedPrimers(primers);
          totalAdded += added; totalSkipped += skipped;
        }
      } catch (e) {
        allErrors.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    const parts = [`Imported ${totalAdded} primer${totalAdded !== 1 ? 's' : ''} from ${fileNames.join(', ')}`];
    if (totalSkipped > 0) parts.push(`${totalSkipped} already in cart`);
    if (allErrors.length > 0) parts.push(`${allErrors.length} error${allErrors.length !== 1 ? 's' : ''}`);
    setImportMsg(parts.join(' · '));
    if (allErrors.length > 0) {
      console.warn('Primer import warnings:', allErrors);
    }
    // Switch to order tab so the user sees the result immediately
    if (totalAdded > 0) setActiveTab('order');
    // Clear the input so re-selecting the same file triggers change
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [addSavedPrimers]);

  // Build exclusion regions from cart primers. Each cart primer contributes
  // its fwd and rev footprints (padded by ±excludePadBp) as forbidden
  // intervals for fresh candidates. Flat list for the chrom of interest.
  const buildExcludeRegionsFor = useCallback(
    (targetChrom: string): Array<[number, number]> => buildPrimerExcludeRegions(
      primer.savedPrimers,
      targetChrom,
      excludeCartPrimers,
      excludePadBp,
    ),
    [excludeCartPrimers, excludePadBp, primer.savedPrimers],
  );

  // Per-chromosome map for 3C (primers in Locus X and Y may live on different chroms).
  const buildExcludeRegionsByChrom = useCallback(
    (): Record<string, Array<[number, number]>> => buildPrimerExcludeRegionsByChrom(
      primer.savedPrimers,
      excludeCartPrimers,
      excludePadBp,
    ),
    [excludeCartPrimers, excludePadBp, primer.savedPrimers],
  );

  // Memo: which design-result indices already match a cart primer?
  // Re-computed when designResults or savedPrimers change.
  const designDuplicates = useMemo(() => {
    const map: Record<number, SavedPrimer> = {};
    primer.designResults.forEach((pair, i) => {
      const dup = isDuplicateOfSaved(pair, pair.designChrom ?? chrom, primer.savedPrimers);
      if (dup) map[i] = dup;
    });
    return map;
  }, [primer.designResults, primer.savedPrimers, chrom]);

  // Export functions
  const downloadBlob = useCallback((content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  // Imports (source = 'bed' | 'tsv') are excluded by default so users don't
  // re-order primers they already have on hand. The Full TSV export always
  // includes everything — it's the roundtrip format and tracks what's in the cart.
  const exportableForOrder = useMemo(
    () => includeLoadedInExport
      ? primer.savedPrimers
      : primer.savedPrimers.filter(sp => (sp.source ?? 'design') === 'design'),
    [primer.savedPrimers, includeLoadedInExport],
  );

  const exportOrderFile = () => {
    const formatted = formatPrimerOrder(exportableForOrder, orderExportFormat);
    downloadBlob(formatted.content, formatted.filename, formatted.mimeType);
  };

  const exportTsv = () => {
    const headers = ['Name', 'Chrom', 'Target_Start', 'Target_End', 'Fwd_Seq', 'Fwd_Start', 'Fwd_End', 'Fwd_Tm', 'Rev_Seq', 'Rev_Start', 'Rev_End', 'Rev_Tm', 'Product_Size', 'Tm_Diff', 'G_Count', 'Source'];
    const rows = [headers.join('\t')];
    for (const sp of primer.savedPrimers) {
      const p = sp.pair;
      rows.push([sp.name, sp.chrom, sp.targetStart, sp.targetEnd, p.fwd_seq, p.fwd_start, p.fwd_end, p.fwd_tm, p.rev_seq, p.rev_start, p.rev_end, p.rev_tm, p.product_size, p.tm_diff, p.g_count, sp.source ?? 'design'].join('\t'));
    }
    downloadBlob(rows.join('\n'), 'primer_order_details.tsv', 'text/tab-separated-values');
  };

  // Validation: target region vs product size (only relevant in standard mode)
  const targetSize = peakTarget ? peakTarget.end - peakTarget.start : 0;
  const maxProduct = params.max_product ?? 50000;
  const targetTooLarge = primer.mode === 'standard' && targetSize > maxProduct;
  // 4C mode: viewpoint must be large enough for two primers + spacing
  const viewpointTooSmall = primer.mode === '4c' && peakTarget && targetSize < 100;
  const canDesign = peakCount > 0 && (hasFasta || !!primer.configFasta) && !!primer.configBlastDb && !targetTooLarge;
  const modeLabel = primer.mode === 'standard' ? 'Standard PCR' : primer.mode === 'dafc' ? '3C' : '4C';
  const blastDbName = primer.configBlastDb ? primer.configBlastDb.split('/').pop() : null;
  const hasFastaReady = hasFasta || !!primer.configFasta;
  // Without a database the banner offers Browse (and Build once a FASTA is loaded).
  const needsBlastSetup = !primer.configBlastDb;
  const targetSummary = primer.mode === 'dafc'
    ? hasSplitView
      ? `Split view: ${locusX!.chrom}:${locusX!.start.toLocaleString()}-${locusX!.end.toLocaleString()} x ${locusY!.chrom}:${locusY!.start.toLocaleString()}-${locusY!.end.toLocaleString()}`
      : 'Enter two loci to open a split view'
    : peakTarget
      ? mixedTargetChroms
        ? `Peaks on ${peakChroms.join(', ')}: select peaks on one chromosome`
        : `${targetChrom}:${peakTarget.start.toLocaleString()}-${peakTarget.end.toLocaleString()} (${targetSize.toLocaleString()}bp)`
      : 'Select peaks to define the target';
  const tmLabel = PRIMER_TM_SHORT_LABELS[params.tm_method ?? 'primer3'] ?? 'Primer3';
  const parameterSummary = `${(params.min_product ?? 0).toLocaleString()}-${(params.max_product ?? 0).toLocaleString()}bp products, ${tmLabel} Tm ${params.min_tm}-${params.max_tm}C`;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'design', label: 'Design' },
    { key: 'order', label: 'Order list' },
    { key: 'capture', label: `Capture${captureRegionCount > 0 ? ` (${captureRegionCount})` : ''}` },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden text-xs">
      <AnalysisPanelShell
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          window.sessionStorage.setItem(PRIMER_DESIGN_TAB_STORAGE_KEY, tab);
        }}
        theme="rose"
        layout="standard"
        className="flex flex-col min-h-0 flex-1"
        bodyMode="fill"
        header={
          <AnalysisPanelHeader
            theme="rose"
            detail={<>Design PCR primers around the selected peaks, check them against BLAST, and collect the ones to order. <span className="text-gray-700 dark:text-gray-200">{modeLabel}: {targetSummary}.</span></>}
          />
        }
        summary={
          <div className="flex flex-wrap items-center gap-1">
            <PrimerStatusChip tone={hasFastaReady ? 'success' : 'neutral'}>
              FASTA {hasFastaReady ? 'ready' : 'missing'}
            </PrimerStatusChip>
            <PrimerStatusChip tone={primer.configBlastDb ? 'success' : 'warning'} title={primer.configBlastDb || undefined}>
              {blastDbName ? `BLAST: ${blastDbName}` : 'BLAST DB missing'}
            </PrimerStatusChip>
            {/* Without a DB the banner below offers Build/Browse; with one, change it here. */}
            {primer.configBlastDb && (
              <span className="inline-flex items-center gap-1 text-[11px]">
                <button type="button" onClick={handlePickBlast} className="text-rose-700 hover:underline dark:text-rose-300" title="Choose a different local BLAST database">
                  change
                </button>
                {hasFastaReady && (
                  <button
                    type="button"
                    onClick={() => buildBlastDbFromFasta(true)}
                    disabled={blastSetupBusy}
                    className="text-rose-700 hover:underline disabled:cursor-wait disabled:opacity-60 dark:text-rose-300"
                    title="Rebuild the BLAST database from the loaded FASTA (e.g. after the FASTA changed)"
                  >
                    {blastSetupBusy ? 'rebuilding…' : 'rebuild'}
                  </button>
                )}
              </span>
            )}
            {blastTool && (
              <PrimerStatusChip tone={blastTool.ok ? 'neutral' : 'warning'}
                title={blastTool.ok ? `${blastTool.label}${blastTool.blastn.source ? ` · found via ${blastTool.blastn.source}` : ''}` : blastTool.hint}>
                <span data-testid="primer-blast-tool">{blastTool.ok ? `BLAST+ ${blastTool.blastn.version}` : 'BLAST+ not found'}</span>
              </PrimerStatusChip>
            )}
            <PrimerStatusChip tone={peakCount > 0 ? 'info' : 'neutral'}>
              {peakCount} selected peak{peakCount !== 1 ? 's' : ''}
            </PrimerStatusChip>
            {primer.savedPrimers.length > 0 && (
              <PrimerStatusChip tone="info">
                {primer.savedPrimers.length} in order list
              </PrimerStatusChip>
            )}
            <AnalysisRunSummary
              seed={analysisSampleSeed}
              peaksLocked={peaksLocked}
              inputs={[modeLabel, peakTarget ? targetSummary : 'no peak target']}
              outputs={primer.designResults.length > 0 ? [
                `${primer.designResults.length} design result${primer.designResults.length !== 1 ? 's' : ''}`,
                `${primer.savedPrimers.length} saved primer${primer.savedPrimers.length !== 1 ? 's' : ''}`,
              ] : []}
              className="basis-full"
            />
          </div>
        }
        toolbar={blastDbChoices && blastDbChoices.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1.5 dark:border-yellow-800/30 dark:bg-yellow-900/20 flex-shrink-0">
            <span className="text-[11px] text-yellow-700 dark:text-yellow-400 whitespace-nowrap">Multiple DBs found:</span>
            <select
              className="input-tool flex-1 text-xs"
              defaultValue=""
              onChange={e => { if (e.target.value) selectBlastDb(e.target.value); }}
            >
              <option value="" disabled>Select a database...</option>
              {blastDbChoices.map(db => (
                <option key={db} value={db}>{db.split('/').pop()}</option>
              ))}
            </select>
            <AnalysisButton
              variant="neutral"
              onClick={() => setBlastDbChoices(null)}
              className="px-1 py-0 text-gray-400 hover:text-gray-600"
              title="Dismiss"
            >
              x
            </AnalysisButton>
          </div>
        ) : blastTool && !blastTool.ok ? (
          <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-300 flex-shrink-0"
            role="alert" data-testid="primer-blast-missing">
            BLAST+ was not found (looked in the app, PATH, Homebrew and conda folders). {blastTool.hint}
          </div>
        ) : needsBlastSetup || (blastSetupMessage && !primer.configBlastDb) ? (
          <div className="flex flex-wrap items-center gap-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 dark:border-rose-900/40 dark:bg-rose-950/20 flex-shrink-0">
            <span className="min-w-[12rem] text-[11px] text-rose-700 dark:text-rose-300 flex-1 leading-snug">
              {blastSetupMessage || (hasFastaReady ? 'No BLAST DB selected. Build one from the loaded FASTA or browse to an existing DB before designing primers.' : 'No BLAST DB selected. Browse to an existing DB, or load a FASTA to build one.')}
            </span>
            {hasFastaReady && (
              <AnalysisButton
                theme="rose"
                variant="soft"
                onClick={() => buildBlastDbFromFasta(false)}
                disabled={blastSetupBusy}
                className={`whitespace-nowrap ${blastSetupBusy ? 'disabled:cursor-wait' : ''}`}
              >
                {blastSetupBusy ? 'Building...' : 'Build DB'}
              </AnalysisButton>
            )}
            <AnalysisButton
              variant="neutral"
              onClick={handlePickBlast}
              className="whitespace-nowrap"
            >
              Browse
            </AnalysisButton>
          </div>
        ) : null}
      >
        {activeTab === 'design' && (
          <>
            <DesignTargetSection
              mode={primer.mode}
              setMode={setPrimerMode}
              chrom={targetChrom}
              targetStart={primer.targetStart}
              targetEnd={primer.targetEnd}
              targetSize={targetSize}
              peakCount={peakCount}
              selectedPeaksList={selectedPeaksList}
              hasSplitView={hasSplitView}
              locusX={locusX}
              locusY={locusY}
              locusXInput={locusXInput}
              setLocusXInput={setLocusXInput}
              locusYInput={locusYInput}
              setLocusYInput={setLocusYInput}
              resolvingLoci={resolvingLoci}
              onCreateSplitView={handleCreateSplitView}
              onCloseSplitView={() => useBrowserStore.getState().closeContactRegions()}
            />

            <DesignWarningsSection
              mode={primer.mode}
              selectedPeaksList={selectedPeaksList}
              locusX={locusX}
              locusY={locusY}
              targetTooLarge={targetTooLarge}
              targetSize={targetSize}
              maxProduct={maxProduct}
            />

            <DesignParametersSection
              open={showParams}
              onOpenChange={setShowParams}
              params={params}
              updateParam={updateParam}
              parameterSummary={parameterSummary}
              excludeCartPrimers={excludeCartPrimers}
              setExcludeCartPrimers={setExcludeCartPrimers}
              excludePadBp={excludePadBp}
              setExcludePadBp={setExcludePadBp}
              excludedRegionCount={buildExcludeRegionsFor(targetChrom).length}
              chrom={targetChrom}
              onResetDefaults={() => setParams(DEFAULT_PARAMS)}
            />

            <DesignRunControls
              mode={primer.mode}
              designing={primer.designing}
              canDesign={canDesign}
              peakCount={peakCount}
              hasFastaReady={hasFastaReady}
              hasBlastDb={!!primer.configBlastDb}
              hasSplitView={hasSplitView}
              targetTooLarge={targetTooLarge}
              progressMessage={progress.message}
              progressPercent={progress.progress}
              progressDetails={progress.details}
              error={primer.error}
              blastWarning={blastWarning}
              onDesignPrimers={handleDesignPrimers}
              onDesign4c={handleDesign4c}
              onDesignDafc={handleDesignDafc}
              onAbort={handleAbortDesign}
              onClearError={() => setPrimerError(null)}
              onClearBlastWarning={() => setBlastWarning(null)}
            />

            <DesignResultsSection
              dafcQuads={primer.dafcQuads}
              designResults={primer.designResults}
              activePair={primer.pair}
              savedPrimerCount={primer.savedPrimers.length}
              resultNames={resultNames}
              setResultNames={setResultNames}
              addedIndices={addedIndices}
              designDuplicates={designDuplicates}
              onAddDafcQuadToOrder={handleAddDafcQuadToOrder}
              onHighlightPair={handleHighlightPair}
              onAddToOrder={handleAddToOrder}
              onRedesignDafc={handleDesignDafc}
              onRedesignPrimers={primer.mode === '4c' ? handleDesign4c : handleDesignPrimers}
              onClearPrimers={clearPrimers}
              designing={primer.designing}
            />
          </>
        )}

        {activeTab === 'order' && (
          <OrderListTab
            fileInputRef={fileInputRef}
            onImportPrimers={handleImportPrimers}
            importMsg={importMsg}
            setImportMsg={setImportMsg}
            savedPrimers={primer.savedPrimers}
            cartTrackDisplay={primer.cartTrackDisplay}
            setCartTrackDisplay={setCartTrackDisplay}
            updateSavedPrimerName={updateSavedPrimerName}
            removeSavedPrimer={removeSavedPrimer}
            exportOrderFile={exportOrderFile}
            exportTsv={exportTsv}
            orderExportFormat={orderExportFormat}
            setOrderExportFormat={setOrderExportFormat}
            includeLoadedInExport={includeLoadedInExport}
            setIncludeLoadedInExport={setIncludeLoadedInExport}
            exportableForOrder={exportableForOrder}
            clearSavedPrimers={clearSavedPrimers}
          />
        )}
        {activeTab === 'capture' && <CapturePanel isFullView={isFullView} embedded />}
      </AnalysisPanelShell>
    </div>
  );
}
