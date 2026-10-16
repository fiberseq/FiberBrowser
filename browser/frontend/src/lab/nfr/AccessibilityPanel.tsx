import { ReadDepthControls } from '../../components/controls/shared/ReadDepthControls';
import { nfrReadDepthNotes } from './readDepth';
import { READ_DEPTH_NAMES, readDepthParameters, type ReadDepth } from '../../utils/readDepth';
import { ClassRegionChoice } from '../../components/controls/shared/ClassRegionChoice';
import { selectedAnalysisWindows, regionAnalysisExtension } from '../../utils/regionAnalysis';
import { useAnalysisRegionStore } from '../../stores/analysisRegionStore';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { savedRegionAt, type ClassRegionMode } from '../../utils/classRegion';
import { categoryShown, useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { runRegionBatch, cancelRegionBatch } from './regionBatch';
import { scrollIntoViewWithin } from '../../utils/scrollWithin';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useAccessibilityStore } from './accessibilityStore';
import { useFocusedReadIds } from '../../hooks/useFocusedReadIds';
import { useAnalysisLoci } from '../../hooks/useAnalysisLoci';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { classRegionLine } from '../../utils/classRegion';
import { sameChrom } from '../../utils/chromAliases';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import { getClusterColor } from '../../components/tracks/read-track/constants';
import {
  ACCESSIBILITY_EXPORTS, accessibilityExportUrl, getAccessibilityJob, getAccessibilityJobs, getClassStatus,
  getAccessibilitySchema, splitAccessibilityReads, startAccessibility, type AccessibilityJob, type AccessibilityResult, type AccessibilitySplit, type ClassStatus,
} from './api';
import {
  bp, directionWord, filteredArcs, filterPairs, formatQ, NO_DATASET_HINT, pairCounts, pairKey, plainError, Q_HELP, opportunityDiagnosticLine, runDetectionLine, share, shortElement, signed, type PairFilter,
} from './accessibilityView';
import { groupingIsCurrent, restoreReadGroups } from '../../utils/readGroups';
import { requestGuard, STALE } from '../../utils/featureClustering';
import { applySplit, groupReadsByNfrVariant, splitReadsByElements } from './nfrGrouping';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { cardKey, savedVariantsBed, shownVariants, starredSplit, type SavedNfr } from './savedNfrVariants';
import { downloadTextFile, exportTimestamp } from '../../utils/analysisExport';
import { CheckboxRow, AnalysisButton, AnalysisPanelShell, AnalysisStatus, AnalysisToggleGroup } from '../../components/controls/shared';
import { AnalysisRegionChoice } from '../../components/controls/shared/AnalysisRegionChoice';
import { OpenBamHint } from '../../components/controls/shared/OpenBamHint';
import { DatasetSetupTab } from '../../components/controls/footprint-analysis/DatasetSetupTab';
import { datasetsMissingConsensusChemistry } from '../../utils/datasetChemistry';
import { HowItWorks } from '../../components/ui/HowItWorks';
import { ElementArcs } from './accessibility/ElementArcs';
import { NfrFoldChips } from './accessibility/NfrFoldChips';
import { PositionCorrelation } from './accessibility/PositionCorrelation';
import { pairForPicks, shownArcs, shownElements as drawnElements } from './nfrPairsLayout';
import { pickElement } from './nfrSelection';
import { ElementMatrix } from './accessibility/ElementMatrix';
import { PairDetail } from './accessibility/PairDetail';
import { type SavedReadActions } from './accessibility/SavedVariants';
import { LiveNfrCard, StoredNfrCard, type CardCommon } from './accessibility/NfrCard';
import { DisclosureChevron } from '../../components/ui/Disclosure';
import { PooledMotifs } from './accessibility/PooledMotifs';
import { NfrFilterStrip } from './accessibility/NfrFilterStrip';
import { NfrMotifParameters } from './accessibility/NfrMotifParameters';
import { NewDot, NfrNotices } from './accessibility/NfrNotices';
import { ChartMaximizeModal } from '../../components/charts/ChartMaximizeModal';
import { clearBadge, useJobBadges, type JobOwner } from './nfrJobs';
import { cssValue } from '../../utils/panelLinks';
import { FOCUS_NFR_EVENT, type FocusNfrDetail } from './nfrLinks';
import { JobStatus, type JobState } from '../../components/controls/shared/JobStatus';
import { NFR_STEPS, nfrPhase, nfrProgress, nfrStageProgress, nfrStageTitle, nfrStepIndex } from './nfrProgress';
import { runTitle } from '../../utils/classIdentity';
import { useRunName } from '../../utils/runNames';
import { HelpTip } from './accessibility/HelpTip';
import { HELP } from './accessibility/nfrHelp';

const SETTINGS_KEY = 'fiberhmm-nfr-preview-settings-v1';
const CONSENSUS_PARAMETERS_KEY = 'fiberhmm-consensus-parameters-v2';
type Tab = 'nfrs' | 'coaccess';
const NO_EXPANDED: string[] = [];

export interface NfrSettings extends ReadDepth {
  regionMode?: ClassRegionMode;
  stringency: number;
  mode: 'variants' | 'depth';
  elements: 'variants' | 'nfrs';
  internalFootprintLabels: boolean;
  nfrRegions: string;
  /** The chromosome the given NFR regions are on (set with them; '' = the chromosome typed with them, or any). */
  nfrRegionsChrom: string;
  withinClusters: boolean;
  /** Engine knobs (FiberHMM NFROptions); sent only when changed from these defaults. */
  minGapBp: number;
  minReads: number;
  opennessPadBp: number;
  openThreshold: number;
  shiftBp: number;
  /** NFR region detection: the rarest NFR found (share of callable reads inside a >= 175-bp gap), the main-row slider. */
  minFraction: number;
  /** Advanced detection method; fold and q gate only the enrichment method. */
  detectMethod: 'raw' | 'enrichment' | 'fixed';
  clipGapsToRegion: boolean;
  minFold: number;
  detectQ: number;
  minOpenReads: number;
  detectThreshold: number;
  pairs: 'nfr' | 'all';
  robust: number;
  bootstrap: number;
}

export const DEFAULT_NFR_SETTINGS: NfrSettings = {
  max_discovery_molecules: 0, max_quantification_molecules: 0, sample_seed: 1,
  stringency: 0.9, mode: 'variants', elements: 'variants', internalFootprintLabels: true, nfrRegions: '', nfrRegionsChrom: '', withinClusters: false,
  minGapBp: 60, minReads: 10, opennessPadBp: 0, openThreshold: 0.5, shiftBp: 25, pairs: 'nfr', robust: 0, bootstrap: 200,
  minFraction: 0.10, detectMethod: 'raw', clipGapsToRegion: false, minFold: 2, detectQ: 0.01, minOpenReads: 10, detectThreshold: 0.15,
};

/** Reading the engine's schema: retries before the panel says it could not (a FiberHMM still starting). */
export const SCHEMA_RETRIES = 3;
export const SCHEMA_RETRY_MS = 1500;

/** The Rarest NFR slider's range (share of callable reads). */
export const MIN_FRACTION_RANGE = [0.01, 0.3] as const;

/** The engine knobs of the Advanced settings: [key, engine name, label, min, max, step, one-line help]. */
export const ENGINE_KNOBS: [keyof NfrSettings, string, string, number, number, number, string][] = [
  ['minGapBp', 'min_gap_bp', 'Minimum gap (bp)', 20, 300, 5, 'Smallest nucleosome-free stretch counted as an opening; linkers below it are ignored.'],
  ['minReads', 'min_reads', 'Minimum reads', 2, 500, 1, 'Expected member reads a variant needs to be kept.'],
  ['opennessPadBp', 'openness_pad_bp', 'Openness pad (bp)', 0, 200, 5, 'Extra bp masked around both tested elements when measuring a read\'s openness (pair tests).'],
  ['openThreshold', 'open_threshold', 'Member at P ≥', 0.5, 0.99, 0.01, 'A read is a member of (open for) a variant when P(variant in its configuration) is at least this.'],
  ['shiftBp', 'shift_bp', 'Shift tolerance (bp)', 5, 100, 1, 'Edges within this of the reference count as the same in the labels (full, extended, shifted…).'],
  ['robust', 'robust', 'Robustness reruns', 0, 10, 1, 'Re-run discovery on reordered reads this many times; variants found in most reruns are marked robust.'],
  ['bootstrap', 'bootstrap', 'Bootstrap', 20, 2000, 10, 'Read bootstrap replicates for the prevalence intervals.'],
];

/** NFR detection knobs of the Advanced settings (the Rarest NFR share is the main-row slider); same layout as ENGINE_KNOBS. */
export const DETECTION_KNOBS: [keyof NfrSettings, string, string, number, number, number, string][] = [
  ['minFold', 'min_fold', 'Fold over background', 1, 10, 0.1, 'An NFR\'s share must be at least this many times the view\'s background (the share at its quietest 20% of positions).'],
  ['detectQ', 'detect_q', 'Detection q', 0.0001, 0.2, 0.0001, 'False discovery rate of the test that a position\'s share is above the background (Benjamini-Hochberg over the view).'],
  ['minOpenReads', 'min_open_reads', 'Minimum open reads', 1, 500, 1, 'Reads inside a ≥ 175-bp gap an NFR needs at its positions.'],
  ['detectThreshold', 'detect_threshold', 'Fixed rule: share above', 0.05, 0.6, 0.01, 'The fixed rule only: share of reads with a ≥ 175-bp gap that marks an NFR.'],
];

function loadSettings(): NfrSettings {
  try { return { ...DEFAULT_NFR_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return DEFAULT_NFR_SETTINGS; }
}

/** "47518170-47518510, chr19:47,514,930-47,516,010" -> [[a, b], ...] (separated by spaces, ';' or ', '); null when malformed. */
export function parseNfrRegions(text: string): number[][] | null {
  const parts = text.split(/[;\s]+|,\s+/).map(s => s.trim().replace(/,/g, '')).filter(Boolean);
  const out: number[][] = [];
  for (const part of parts) {
    const m = part.replace(/^.*:/, '').match(/^(\d+)[-–](\d+)$/);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]);
    if (!(b > a)) return null;
    out.push([a, b]);
  }
  return out;
}

/** The chromosome given NFR regions are on: set with them ("Find again"), or typed before them ("chr3L:100-600"). */
function givenRegionsChrom(s: Pick<NfrSettings, 'nfrRegions' | 'nfrRegionsChrom'>): string {
  return s.nfrRegionsChrom || /^([^:\s]+):/.exec(s.nfrRegions.trim())?.[1] || '';
}

/**
 * The given NFR regions a run at this locus uses: those on its chromosome and inside its window. A region carried over
 * from another locus is not sent (it found nothing there, silently); ``ignored`` says some were left out.
 */
export function activeNfrRegions(s: Pick<NfrSettings, 'nfrRegions' | 'nfrRegionsChrom'>,
  locus: { chrom: string; start: number; end: number } | null): { used: number[][]; ignored: boolean; chrom: string } {
  const all = s.nfrRegions.trim() ? parseNfrRegions(s.nfrRegions) ?? [] : [];
  const chrom = givenRegionsChrom(s);
  if (!all.length || !locus) return { used: [], ignored: all.length > 0, chrom };
  const onChrom = !chrom || sameChrom(chrom, locus.chrom);
  const used = onChrom ? all.filter(([a, b]) => a < locus.end && b > locus.start) : [];
  return { used, ignored: used.length < all.length, chrom };
}

/**
 * The engine parameters a run sends (FiberHMM NFROptions names). ``detectSupport``: whether this FiberHMM has the
 * depth-aware NFR detection (its schema lists min_fraction). Only true sends its settings (always the Rarest NFR
 * share); false (an older FiberHMM, which refuses them) sends only a changed fixed-rule threshold, the one rule it
 * has; null (not known) sends no detection setting at all, so the engine's own default applies.
 */
export function runParameters(s: NfrSettings, clusterK: number | null, detectSupport: boolean | null = null, rawSupport = false, clipSupport = false,
  locus?: { chrom: string; start: number; end: number } | null, depthSupport = false): Record<string, unknown> {
  // Given NFR regions: only those in this view (locus given), else all of them as typed.
  const given = locus === undefined ? (s.nfrRegions.trim() ? parseNfrRegions(s.nfrRegions) ?? [] : []) : activeNfrRegions(s, locus).used;
  const params: Record<string, unknown> = {
    ...readDepthParameters(s, depthSupport),
    stringency: s.stringency, mode: s.mode, elements: s.elements, internal_footprint_labels: s.internalFootprintLabels,
  };
  const changed = (key: keyof NfrSettings) => {
    const v = s[key] as number;
    return typeof v === 'number' && Number.isFinite(v) && v !== DEFAULT_NFR_SETTINGS[key];
  };
  for (const [key, name] of ENGINE_KNOBS) if (changed(key)) params[name] = s[key];
  if (detectSupport === true && !given.length) {
    if (s.detectMethod === 'fixed') {
      params.detect_method = 'fixed';
      params.detect_threshold = s.detectThreshold;
    } else {
      params.detect_method = s.detectMethod === 'raw' && !rawSupport ? 'enrichment' : s.detectMethod;
      params.min_fraction = s.minFraction;
      for (const [key, name] of DETECTION_KNOBS) if (key !== 'detectThreshold' && (key === 'minOpenReads' || params.detect_method === 'enrichment') && changed(key)) params[name] = s[key];
    }
  } else if (detectSupport === false && !given.length && changed('detectThreshold')) {
    params.detect_threshold = s.detectThreshold;      // an older FiberHMM: its fixed rule is the only one
  }
  if (clipSupport) params.clip_gaps_to_region = s.clipGapsToRegion;
  if (s.pairs !== DEFAULT_NFR_SETTINGS.pairs) params.pairs = s.pairs;
  if (given.length) params.nfr_regions = given;
  if (s.withinClusters && clusterK) params.within_clusters = clusterK;
  return params;
}

/**
 * A run's request to replay as it ran: a run from before depth-aware detection (its result has no ``detection``)
 * found its NFRs with the fixed rule, so its threshold is sent (a detect_threshold alone selects that rule, and an
 * older FiberHMM takes it too).
 */
export function legacyDetection(params: Record<string, unknown>, result: Pick<AccessibilityResult, 'detection' | 'parameters'> | null): Record<string, unknown> {
  if (!result || 'detect_method' in params || 'detect_threshold' in params || 'nfr_regions' in params) return params;
  if (result.detection) return result.detection.method === 'given' ? params : { ...params, detect_method: result.detection.method };
  const t = result.parameters?.detect_threshold;
  return typeof t === 'number' ? { ...params, detect_threshold: t } : params;
}

function loaderParameters(): Record<string, unknown> | undefined {
  // The Footprints panel's input settings (e.g. the Hia5 annotation frame): the same molecules as Find classes.
  try {
    const saved = JSON.parse(localStorage.getItem(CONSENSUS_PARAMETERS_KEY) ?? '{}');
    return saved && typeof saved.input === 'object' ? { input: saved.input } : undefined;
  } catch { return undefined; }
}

/** The main row's Rarest NFR slider: the share of callable reads an NFR needs at least (sent as min_fraction). */
function RarestNfrSlider({ value, onChange, disabledWhy, background, defaultValue }: { defaultValue: number; background?: number | null; value: number; onChange: (v: number) => void; disabledWhy: string | null }) {
  const [lo, hi] = MIN_FRACTION_RANGE;
  const isDefault = value === defaultValue;
  const id = useId();
  return (
    <div role="group" aria-labelledby={`${id}-label`} className={`flex flex-wrap items-center gap-1.5 text-[11px] ${disabledWhy ? 'opacity-60' : ''}`} title={disabledWhy ?? HELP.rarest} data-testid="nfr-rarest">
      <label id={`${id}-label`} htmlFor={id}>Find NFRs open in at least {Math.round(value * 100)}% of reads</label>
      <span className="relative inline-flex w-24 items-center">
      <input id={id} type="range" min={lo} max={hi} step={0.01} value={value} aria-label="Find NFRs open in at least (% of reads)" data-testid="nfr-min-fraction"
        aria-valuetext={`${Math.round(value * 100)}% of reads`} title={disabledWhy ?? HELP.rarest}
        disabled={!!disabledWhy} onChange={e => onChange(Number(e.target.value))} className="w-24 accent-fuchsia-600" />
      {background != null && Number.isFinite(background) && <span data-testid="nfr-background-marker"
        title={`Background here: about ${share(background)} of reads have a long gap outside any NFR`}
        className="absolute top-0 h-3 w-0.5 bg-ink-muted" style={{ left: `${Math.max(0, Math.min(100, (background - lo) / (hi - lo) * 100))}%` }} />}
      </span>
      <button type="button" data-testid="nfr-fraction-default" disabled={!!disabledWhy}
        className={`rounded px-1 text-[10px] ${isDefault ? 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10'}`}
        onClick={() => onChange(defaultValue)}>{Math.round(defaultValue * 100)}% default</button>
      <HelpTip term="Rarest NFR" text={disabledWhy ? `${HELP.rarest} ${disabledWhy}` : HELP.rarest} testId="nfr-help-rarest" />
    </div>
  );
}

const running = (job: AccessibilityJob | null) => !!job && ['queued', 'running', 'cancelling'].includes(job.status);

export function AccessibilityPanel({ isFullView }: { isFullView?: boolean }) {
  const { datasets, clusterAssignments, saved } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets, clusterAssignments: s.clusterAssignments, saved: s.savedNfrVariants,
  })));
  const { targetStateKeys, stateKeyMap } = useFocusedReadIds();
  const loci = useAnalysisLoci(targetStateKeys);
  const regionState = useBrowserStore(useShallow(s => ({ peakRules:s.peakRules, peaksByRule:s.peaksByRule, selectedPeaks:s.selectedPeaks, panels:s.panels, chrom:s.chrom, start:s.start, end:s.end, currentGenome:s.currentGenome, fastaPath:s.fastaPath })));
  const viewLocus = loci.length === 1 ? loci[0] : null;
  const {
    jobId, result, showArcs, showClassArcs, applied, setRun, setShowArcs, setShowClassArcs, pushApplied, dismissApplied,
    qMax, minEffect, topN, focus, setFilter, hoveredElement, setHoveredElement,
  } = useAccessibilityStore();
  const badges = useJobBadges();
  const [expanded, setExpanded] = useState(false);
  // The view lives in the store: a remount (closing split panels re-mounts the panel) keeps the tab, the filter, the
  // open card and the scroll position.
  const { tab, listFilter, openCard, showEarlier, setPanelView } = useAccessibilityStore(useShallow(s => ({
    tab: s.panelTab, listFilter: s.listFilter, openCard: s.openCard, showEarlier: s.showEarlier, setPanelView: s.setPanelView,
  })));
  const setTab = useCallback((t: Tab) => setPanelView({ panelTab: t }), [setPanelView]);
  const [settings, setSettingsState] = useState<NfrSettings>(loadSettings);
  const { job, setJob, batchRunning, regionJobs, batchError, batchTotal } = useAccessibilityStore(useShallow(s => ({
    job: s.job, setJob: s.setJob, batchRunning: s.batchRunning, regionJobs: s.regionJobs, batchError: s.batchError, batchTotal: s.batchTotal,
  })));
  const mode = settings.regionMode ?? 'view';
  const matched = selectedAnalysisWindows(useBrowserStore.getState(), [...new Set(loci.flatMap(l=>l.datasetIds))]);
  const selectedPeaks = useBrowserStore.getState().getAllPeaks().filter(p => !p.match && regionState.selectedPeaks.has(p.index));
  const peaksHere = viewLocus ? selectedPeaks.filter(p => sameChrom(p.chrom ?? regionState.chrom, viewLocus.chrom) && (p.genome ?? null) === viewLocus.genome) : [];
  const regionGenome = genomeKeyFor(viewLocus?.genome ?? null, regionState);
  const catalog = useRegionCatalogStore(s => s.catalogs[regionGenome]);
  useEffect(() => { void useRegionCatalogStore.getState().ensureLoaded(regionGenome); }, [regionGenome]);
  const regionFingerprints=useRegionCatalogStore(s=>s.fingerprints);
  const shownCategories=new Set(catalog?.categories.filter(c=>categoryShown(c,regionFingerprints)).map(c=>c.id));
  const savedRegion = viewLocus && catalog ? savedRegionAt(catalog.entries.filter(e=>shownCategories.has(e.category)), viewLocus) : null;
  const locus = mode === 'peaks' && peaksHere.length && viewLocus ? { ...viewLocus, start:Math.min(...peaksHere.map(p=>p.start)), end:Math.max(...peaksHere.map(p=>p.end)) }
    : mode === 'region' && savedRegion && viewLocus ? { ...viewLocus, chrom:savedRegion.chrom, start:savedRegion.start, end:savedRegion.end } : viewLocus;
  const useMatched = mode === 'matched';
  const manualRegions = activeNfrRegions(settings,locus).used;
  const outlineKey = settings.nfrRegions+'|'+JSON.stringify(useMatched ? matched.windows : locus ? [{ ...locus, dataset_id:'' }] : []);
  useEffect(() => {
    const rows = useMatched ? matched.windows.map(w => ({ ...w, datasetIds:[w.dataset_id] })) : locus ? manualRegions.length ? manualRegions.map(([start,end])=>({...locus,start,end})) : [locus] : [];
    useAnalysisRegionStore.getState().set('nfr', rows.map(r => ({ ...r, genomeKey:genomeKeyFor(r.genome,regionState), label:'Find NFRs', color:'#c026d3' })));
    return () => useAnalysisRegionStore.getState().set('nfr',[]);
  },[outlineKey,regionGenome]); // eslint-disable-line react-hooks/exhaustive-deps

  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // in the store: a remount (the drawer's layout changing) keeps it
  const coView = useAccessibilityStore(s => s.pairsView);
  const pairsMode = useAccessibilityStore(s => s.pairsMode);
  const setCoView = (v: 'arcs' | 'matrix') => setPanelView({ pairsView: v });
  const [exportName, setExportName] = useState(ACCESSIBILITY_EXPORTS[0].name);
  const [available, setAvailable] = useState<Set<string>>(new Set());
  // Whether this FiberHMM has the depth-aware NFR detection (Rarest NFR): null until its schema is read.
  const [detectSupport, setDetectSupport] = useState<boolean | null>(null);
  const [rawSupport, setRawSupport] = useState(false);
  const [depthSupport, setDepthSupport] = useState<boolean | null>(null);
  const [clipSupport, setClipSupport] = useState(false);
  const method = detectSupport === false ? 'fixed' : settings.detectMethod === 'raw' && !rawSupport ? 'enrichment' : settings.detectMethod;
  const [schemaFailed, setSchemaFailed] = useState(false);
  const alive = useRef(true);
  const discovery = useRef(0);
  const generation = useAccessibilityStore(s => s.generation);

  const setSettings = (patch: Partial<NfrSettings>) => setSettingsState(prev => {
    const next = { ...prev, ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });

  // Reads clustered in the targeted panels: the within-cluster check re-clusters into as many groups.
  const clusterK = useMemo(() => {
    const ids = new Set<number>();
    for (const key of targetStateKeys) for (const v of Object.values(clusterAssignments[key] ?? {})) if (v >= 0) ids.add(v);
    return ids.size >= 2 ? Math.min(8, ids.size) : null;
  }, [clusterAssignments, targetStateKeys]);

  const refreshAvailable = useCallback(() => getAccessibilityJobs()
    .then(({ jobs }) => { if (alive.current) setAvailable(new Set(jobs.filter(j => j.status === 'complete').map(j => j.job_id))); })
    .catch(() => { /* engine missing */ }), []);

  // On opening (and after a session import): a run still going is followed (progress, Cancel); the run shown is the
  // stored one if this server still has it, else the session's last completed run. A newer local request wins.
  useEffect(() => {
    alive.current = true;
    const seq = ++discovery.current;
    if (useAccessibilityStore.getState().batchRunning) return () => { alive.current = false; };
    const current = () => alive.current && seq === discovery.current && !useAccessibilityStore.getState().batchRunning;
    getAccessibilityJobs().then(async ({ jobs }) => {
      if (!current()) return;
      setAvailable(new Set(jobs.filter(j => j.status === 'complete').map(j => j.job_id)));
      const active = [...jobs].reverse().find(running) ?? null;
      if (active) setJob(active);
      const stored = useAccessibilityStore.getState().jobId;
      const known = !!stored && jobs.some(j => j.job_id === stored && j.status === 'complete');
      if (stored && !known) setRun(null, null);
      const target = known ? stored : [...jobs].reverse().find(j => j.status === 'complete')?.job_id;
      if (!target) { if (!active) setJob(null); return; }
      const full = await getAccessibilityJob(target);
      if (!current()) return;
      if (!active) setJob(full);
      if (full.status === 'complete' && full.result) setRun(full.job_id, full.result);
    }).catch(() => { /* engine missing: the run button says so */ });
    return () => { alive.current = false; };
  }, [generation, setRun]);

  useEffect(() => { if (tab === 'nfrs') void refreshAvailable(); }, [tab, refreshAvailable]);
  // A failed read (the engine still starting, a network blip) is retried a few times before the panel says so.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDepthSupport(null); setDetectSupport(null); setRawSupport(false); setClipSupport(false); setSchemaFailed(false);
    const load = (attempt: number) => getAccessibilitySchema()
      .then(sc => {
        if (!live) return;
        const raw = sc?.defaults?.detect_method === 'raw';
        setDetectSupport(!!sc?.defaults && 'min_fraction' in sc.defaults);
        setRawSupport(raw);
        setDepthSupport(READ_DEPTH_NAMES.every(n => n in (sc?.defaults ?? {})));
        setClipSupport(!!sc?.defaults && 'clip_gaps_to_region' in sc.defaults);
        try {
          if (!raw && !localStorage.getItem(SETTINGS_KEY)) setSettingsState(prev => ({ ...prev, minFraction: 0.05 }));
        } catch { /* private mode */ }
      })
      .catch(() => {
        if (!live) return;
        if (attempt < SCHEMA_RETRIES) timer = setTimeout(() => void load(attempt + 1), SCHEMA_RETRY_MS * (attempt + 1));
        else setSchemaFailed(true);
      });
    void load(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [generation]);
  useEffect(() => { clearBadge(`tab:${tab}`); }, [tab, badges]);

  // Open a card in place and bring it (or the clicked variant's row) into view; a card of another run is in Earlier.
  const revealCard = useCallback((key: string, variantId?: string | null, earlier = false, classId?: string | null, classJob?: string | null) => {
    const st = useAccessibilityStore.getState();
    const starredHere = useBrowserStore.getState().savedNfrVariants.some(e => cardKey(e.jobId, e.nfrId) === key);
    // A class linked from the Footprints panel: the card's Footprints view, with the class marked.
    if (classId) st.setCardView(key, 'classes');
    setPanelView({
      panelTab: 'nfrs', openCard: key, focusedVariant: variantId ? { card: key, variantId } : null,
      highlightClass: classId ? { card: key, classId, ...(classJob ? { classJob } : {}) } : null,
      ...(earlier ? { showEarlier: true } : {}),
      // the Starred filter would hide a card not starred: show the whole list
      ...(st.listFilter === 'starred' && !starredHere ? { listFilter: 'all' as const } : {}),
    });
    window.setTimeout(() => {
      const card = document.querySelector<HTMLElement>(`[data-testid="nfr-card"][data-card="${cssValue(key)}"]`);
      if (!card) return;
      const row = variantId
        ? card.querySelector<HTMLElement>(`[data-testid="nfr-variant-row"][data-variant="${cssValue(variantId)}"], [data-testid="nfr-saved-variant"][data-variant="${cssValue(variantId)}"]`)
        : null;
      scrollIntoViewWithin(row ?? card, { block: row ? 'center' : 'start', behavior: 'smooth' });
    }, 80);
  }, [setPanelView]);
  const openOwner = (owner: JobOwner) => {
    if (owner.entry) {
      const shown = useAccessibilityStore.getState().jobId;
      revealCard(owner.entry, null, !shown || !owner.entry.startsWith(`${shown}|`));
    } else if (owner.tab === 'coaccess') setTab('coaccess');
    else setTab('nfrs');
  };

  // An NFR or variant clicked in the NFR channel, or linked from the Footprints panel:
  // its card opens in place and comes into view, wherever the panel was (another tab, the Starred filter). A starred
  // NFR of another run opens in Earlier; an NFR of another run not starred loads that run first.
  // Only the newest click counts: a run still loading for an earlier click is not shown over it.
  const focusSeq = useRef(0);
  useEffect(() => {
    const handler = (event: Event) => {
      const d = (event as CustomEvent<FocusNfrDetail>).detail;
      if (!d) return;
      const seq = ++focusSeq.current;
      const key = cardKey(d.jobId, d.nfrId);
      if (d.jobId === useAccessibilityStore.getState().jobId) { revealCard(key, d.variantId, false, d.classId, d.classJob); return; }
      const entry = useBrowserStore.getState().savedNfrVariants.find(e => e.jobId === d.jobId && e.nfrId === d.nfrId);
      if (entry) { revealCard(key, d.variantId, true, d.classId, d.classJob); return; }
      const gen = useAccessibilityStore.getState().generation;
      discovery.current += 1;           // the run shown on opening must not replace the one this click loads
      void getAccessibilityJob(d.jobId).then(full => {
        if (!alive.current || useAccessibilityStore.getState().generation !== gen || seq !== focusSeq.current) return;
        if (full.status === 'complete' && full.result) { setRun(full.job_id, full.result); revealCard(key, d.variantId, false, d.classId, d.classJob); }
      }).catch(e => setError(plainError(e)));
    };
    window.addEventListener(FOCUS_NFR_EVENT, handler);
    return () => window.removeEventListener(FOCUS_NFR_EVENT, handler);
  }, [setRun, revealCard]);

  // Poll a running job.
  const pollId = !batchRunning && running(job) ? job!.job_id : null;
  useEffect(() => {
    if (!pollId) return;
    let timer: ReturnType<typeof setTimeout>;
    let stop = false;
    const poll = async () => {
      try {
        const next = await getAccessibilityJob(pollId);
        if (stop) return;
        setJob(current => (current?.status === 'cancelling' && next.status === 'running' ? current : next));
        if (next.status === 'complete' && next.result) {
          setRun(next.job_id, next.result);
          setAvailable(prev => new Set([...prev, next.job_id]));
          return;
        }
        if (!running(next)) return;
      } catch (e) { if (!stop) setError(plainError(e)); }
      if (!stop) timer = setTimeout(poll, 800);
    };
    timer = setTimeout(poll, 400);
    return () => { stop = true; clearTimeout(timer); };
  }, [pollId, setRun]);

  const regionsValid = !settings.nfrRegions.trim() || parseNfrRegions(settings.nfrRegions) !== null;
  const givenRegions = activeNfrRegions(settings, locus);
  const givenRegionsLabel = (givenRegions.chrom ? `${givenRegions.chrom}:` : '')
    + (parseNfrRegions(settings.nfrRegions) ?? []).map(([a, b]) => `${a.toLocaleString()}–${b.toLocaleString()}`).join(', ');
  // No dataset loaded (or none in the targeted panels): Find is off and says what to do, as Footprints does (N10).
  // (Several regions in the targeted panels is another matter: Find stays off with its own words.)
  const noData = !datasets.length || (loci.length <= 1 && !locus?.datasetIds.length);
  // A dataset without its assay type (FiberHMM needs it to read the BAM): the same setup card as Footprints, not an error.
  const missingType = datasetsMissingConsensusChemistry(datasets,useMatched?[...new Set(matched.windows.map(w=>w.dataset_id))]:locus?.datasetIds??[]);
  const depthPending = depthSupport === null && !!(settings.max_discovery_molecules || settings.max_quantification_molecules);
  const depthPendingNote = schemaFailed ? 'Could not check read-cap support. Reopen the panel to retry before running with saved caps.' : 'Checking read-cap support before running with saved caps…';
  const run = async () => {
    if (missingType.length || depthPending || (useMatched ? !!matched.error : !locus || noData)) return;
    discovery.current += 1;   // a discovery still in flight must not replace this request's job
    setError('');
    try {
      if (useMatched) {
        await runRegionBatch(matched.windows.map(w => ({ genome: w.genome ?? null, dataset_ids: [w.dataset_id], chrom: w.chrom, start: w.start, end: w.end,
          region_source: 'matched', region_label: `${w.label ?? w.name}${w.strand === '-' ? ' · reversed' : ''}`,
          parameters: { ...runParameters({ ...settings, nfrRegions: '', nfrRegionsChrom: '' }, clusterK, detectSupport, rawSupport, clipSupport, w, depthSupport === true), nfr_regions: [[w.start, w.end]] },
          loader_parameters: loaderParameters() })));
      } else if (locus) {
        const next = await startAccessibility({
          dataset_ids: locus.datasetIds, chrom: locus.chrom, start: locus.start, end: locus.end, region_source: mode,
          parameters: runParameters(settings, clusterK, detectSupport, rawSupport, clipSupport, locus, depthSupport === true), loader_parameters: loaderParameters(),
        });
        setJob(next);
      }
    } catch (e) { setError(plainError(e)); }
  };
  const cancel = cancelRegionBatch;

  // ---------------------------------------------------------------- footprint classes in the pair tests
  // The pair tests include the classes the run joined when it ran. A Find classes run made since (from an NFR card)
  // joins the NFR views at once but the tests only on a new run: say so, never "no classes" while classes exist.
  const classRevision = useAccessibilityStore(s => s.classRevision);
  const [classStatus, setClassStatus] = useState<ClassStatus | null>(null);
  // Class counts say their scope (this run's window) and their run, by its one short name (N11).
  const joinedRun = useRunName('footprint', job?.class_job_id ?? null);
  const laterRun = useRunName('footprint', classStatus?.class_job ?? null);
  const joinedInRun = (result?.class_join?.classes ?? 0) > 0;
  useEffect(() => {
    setClassStatus(null);
    if (!jobId || joinedInRun || tab !== 'coaccess') return;
    let live = true;
    getClassStatus(jobId).then(st => { if (live) setClassStatus(st); }).catch(() => { /* an older server: nothing to add */ });
    return () => { live = false; };
  }, [jobId, joinedInRun, tab, classRevision]);
  /** Find NFR variants again on the shown run's own window, datasets and settings (its classes then join the tests). */
  const rerun = async () => {
    if (!result || !jobId) return;
    discovery.current += 1;
    setError('');
    try {
      // The shown run's own request (its settings, loader input and datatypes), as the server recorded it.
      const req = (job?.job_id === jobId && job.request ? job : await getAccessibilityJob(jobId)).request;
      if (!req) throw new Error('This run\'s settings are not available: find NFR variants again from the NFRs tab.');
      const { loader_parameters, chemistry_overrides } = req as { loader_parameters?: Record<string, unknown>; chemistry_overrides?: Record<string, string> };
      const parameters = legacyDetection(req.parameters ?? {}, result);
      setJob(await startAccessibility({
        dataset_ids: req.dataset_ids, chrom: req.chrom, start: req.start, end: req.end,
        region_source: req.region_source ?? 'view', ...(req.region_label ? { region_label: req.region_label } : {}),
        parameters,
        ...(loader_parameters ? { loader_parameters } : {}), ...(chemistry_overrides ? { chemistry_overrides } : {}),
      }));
    } catch (e) { setError(plainError(e)); }
  };

  // ---------------------------------------------------------------- read groups (configurations, splits)
  // The grouping the read panels hold now (newest first; undo / redo can bring an earlier one back), else the newest
  // one not dismissed, shown as replaced. clusterAssignments is read above, so this follows every change.
  const currentApplied = useMemo(() => [...applied].reverse().find(a => groupingIsCurrent(a.grouping)) ?? null, [applied, clusterAssignments]);
  const newest = applied.length ? applied[applied.length - 1] : null;
  const last = currentApplied ?? (newest && !newest.dismissed ? newest : null);
  const lastCurrent = !!last && last === currentApplied;
  // A response for a run or a session that is no longer shown is dropped (a session import resets the panel).
  const stillShown = (gen: number, job: string) => useAccessibilityStore.getState().generation === gen && useAccessibilityStore.getState().jobId === job && alive.current;

  // The same code as the main toolbar's Cluster (combinatorial) on these elements (utils/featureClustering.ts).
  const split = useCallback(async (body: { a: string; b: string } | { elements: string[] }) => {
    if (!jobId) return;
    dropInspect();                                            // the card shows the grouping applied now
    setBusy('split'); setError('');
    const gen = useAccessibilityStore.getState().generation;
    try {
      await splitReadsByElements(jobId, body, result, stateKeyMap, () => stillShown(gen, jobId));
    } catch (e) { setError(plainError(e)); } finally { setBusy(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, stateKeyMap, result]);

  // An arc, a matrix cell or a pair row inspects the pair (its 2x2 groups and statistics) without touching the read
  // panels; "Group reads by this pair" then puts those groups there, and "Restore previous grouping" takes them back.
  const inspected = useAccessibilityStore(s => (s.inspected && s.inspected.jobId === jobId ? s.inspected.split : null));
  // Only the newest request counts: a slow answer for an earlier pair, or one after Close or a grouping, is dropped.
  const inspectSeq = useRef(0);
  const dropInspect = () => { inspectSeq.current += 1; setBusy(b => (b === 'inspect' ? null : b)); useAccessibilityStore.getState().setInspected(null); };
  const inspect = useCallback(async (body: { a: string; b: string } | { elements: string[] }) => {
    if (!jobId) return;
    const seq = ++inspectSeq.current;
    setBusy('inspect'); setError('');
    const gen = useAccessibilityStore.getState().generation;
    try {
      const s: AccessibilitySplit = await splitAccessibilityReads(jobId, body);
      if (seq === inspectSeq.current && stillShown(gen, jobId)) useAccessibilityStore.getState().setInspected({ jobId, split: s });
    } catch (e) { if (seq === inspectSeq.current) setError(plainError(e)); } finally {
      if (seq === inspectSeq.current) setBusy(b => (b === 'inspect' ? null : b));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  const groupInspected = () => {
    if (!inspected || !jobId) return;
    const s = inspected;
    dropInspect();
    applySplit(jobId, s, result, stateKeyMap);
  };

  const clearGroups = () => {
    if (!last) return;
    if (groupingIsCurrent(last.grouping)) restoreReadGroups(last.grouping, 'Clear NFR read groups');
    dismissApplied(last);
  };
  const reapply = () => {
    if (!last?.split) return;
    const s = last.split;
    dismissApplied(last);
    void split(s.kind === 'pair' ? { a: s.a!, b: s.b! } : { elements: s.elements! });
  };

  // ---------------------------------------------------------------- read controls of an NFR card
  // One set for every card; the run may not be the one shown (Earlier), so the guard is the toolbar's (the session,
  // the main locus, the undo position, and no newer read action from a saved NFR) rather than the shown run, and the
  // result is read from the server when it is another run.
  const resultFor = async (job: string) => (job === jobId && result ? result : (await getAccessibilityJob(job)).result ?? null);
  const savedAction = async (kind: string, e: SavedNfr, work: (stillCurrent: () => boolean) => Promise<unknown>) => {
    setBusy(`${kind}:${e.id}`); setError('');
    const guard = requestGuard('nfr-saved-reads');
    const current = () => guard() && alive.current;
    try {
      // null: the answer came after the session, the locus, the undo position or a newer action changed; not applied
      if ((await work(current)) === null && alive.current) setError(STALE);
    } catch (err) { if (alive.current) setError(plainError(err)); } finally { setBusy(b => (b === `${kind}:${e.id}` ? null : b)); }
  };
  const savedActions: SavedReadActions = {
    busy,
    group: e => void savedAction('group', e, ok => groupReadsByNfrVariant(e.jobId, e.nfrId, stateKeyMap, ok)),
    splitPatterns: e => void savedAction('patterns', e, async ok => {
      const res = await resultFor(e.jobId);
      if (!ok()) return null;
      const ticked = shownVariants(e).map(v => v.variantId);
      // the run's own element order (the split numbers its patterns by it), as the toolbar's plan does
      const order = (res?.elements ?? []).map(x => x.id).filter(id => ticked.includes(id));
      return splitReadsByElements(e.jobId, { elements: order.length === ticked.length ? order : ticked }, res, stateKeyMap, ok);
    }),
    splitPanels: e => void savedAction('panels', e, async ok => {
      const res = await resultFor(e.jobId);
      if (!ok()) return null;
      useSplitPanelStore.getState().request({ kind: 'configurations', jobId: e.jobId, nfrId: e.nfrId, result: res });
      return true;
    }),
    groupedEntry: e => !!last && lastCurrent && last.kind === 'configurations' && last.configurations?.nfr === e.nfrId && last.jobId === e.jobId,
  };

  // ---------------------------------------------------------------- the list
  const runDatasetIds = result?.datasets.map(d => d.dataset_id) ?? [];
  const { here: starredHere, earlier } = useMemo(() => starredSplit(saved, jobId), [saved, jobId]);
  const findAgain = (e: SavedNfr) => {
    useBrowserStore.getState().setViewport(e.chrom, Math.max(0, e.region.start), e.region.end);
    setSettings({ regionMode:'view', nfrRegions: `${e.chrom}:${e.nfrStart}-${e.nfrEnd}`, nfrRegionsChrom: e.chrom });
    setPanelView({ panelTab: 'nfrs', listFilter: 'all' });
  };

  const pairFilter: PairFilter = useMemo(() => ({ qMax, minEffect, topN, focus, includeClasses: showClassArcs }), [qMax, minEffect, topN, focus, showClassArcs]);
  const arcs = useMemo(() => filteredArcs(result, pairFilter), [result, pairFilter]);
  const passing = useMemo(() => new Set(filterPairs(result, pairFilter).map(p => pairKey(p.a, p.b))), [result, pairFilter]);
  const counts = useMemo(() => pairCounts(result, pairFilter), [result, pairFilter]);
  const shownElements = useMemo(() => (result?.elements ?? []).filter(e => showClassArcs || e.kind !== 'tf'), [result, showClassArcs]);
  const byId = useMemo(() => new Map((result?.elements ?? []).map(e => [e.id, e])), [result]);
  const notable = useMemo(() => filterPairs(result, pairFilter).slice(0, 12), [result, pairFilter]);
  // One selection and one fold state with the matrix and the NFR track (nfrSelection.ts, nfrPairsLayout.ts): a click
  // on an element selects it, on a second one inspects their pair; a pair inside a folded NFR unfolds it.
  const unfolded = useAccessibilityStore(s => (jobId ? s.expanded[jobId] : undefined)) ?? NO_EXPANDED;
  const unfold = (nfrId: string, open: boolean) => { if (jobId) useAccessibilityStore.getState().setExpanded(jobId, nfrId, open); };
  const inspectPicks = (a: string, b: string) => {
    const pick = pairForPicks(result, a, b, pairFilter);
    if ('error' in pick) { setError(pick.error); return; }
    const [ea, eb] = [byId.get(pick.a), byId.get(pick.b)];
    if (ea?.nfr && ea.nfr === eb?.nfr && ea.kind !== 'tf' && eb.kind !== 'tf') unfold(ea.nfr, true);
    void inspect(pick);
  };
  const pairRequest = useAccessibilityStore(s => s.pairRequest);
  useEffect(() => {
    if (!pairRequest || !jobId || !result || pairRequest.jobId !== jobId) return;
    useAccessibilityStore.getState().clearPairRequest(pairRequest.seq);
    inspectPicks(pairRequest.a, pairRequest.b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairRequest, jobId, result]);
  const label = (id: string) => datasets.find(d => d.id === id);
  const runDatasets = runDatasetIds.map(id => label(id)).filter(Boolean).map(d => getDatasetDisplayLabel(d!)).join(', ');
  const span = result ? [Math.min(...shownElements.map(e => e.start), result.region.start), Math.max(...shownElements.map(e => e.end), result.region.end)] : null;
  const arcSpan = span && shownElements.length ? [Math.max(result!.region.start, Math.min(...shownElements.map(e => e.start)) - 150),
    Math.min(result!.region.end, Math.max(...shownElements.map(e => e.end)) + 150)] : span;
  const shownSplit = last && last.jobId === jobId && last.split ? last.split : null;
  // The drill-down card: the pair inspected last, else the split the read panels hold (or held).
  const detailSplit = inspected ?? shownSplit;
  const selectedPair = detailSplit?.kind === 'pair' ? `${detailSplit.a}|${detailSplit.b}` : null;
  const focusKeys = useMemo(() => Object.keys(last?.grouping.written ?? {}), [last]);
  const datasetLabel = (id: string) => { const d = label(id); return d ? getDatasetDisplayLabel(d) : id; };
  const cardCommon: CardCommon = { actions: savedActions, stateKeyMap, isFullView, datasetLabel };
  const pairsOf = (nfrId: string) => { setFilter({ focus: nfrId }); setPanelView({ pairsMode: 'elements' }); setTab('coaccess'); };
  const scrollRef = usePanelScrollMemory(tab === 'nfrs' && !!openCard);

  const header = (
    <div className="space-y-1.5">
      {!useMatched && loci.length > 1 && <AnalysisRegionChoice loci={loci} what="Accessibility" />}
      <ClassRegionChoice prefix="nfr" mode={mode} source={mode} onChoose={regionMode=>setSettings({ regionMode })} matchedAvailable={!!regionAnalysisExtension()}
        line={useMatched?matched.label:locus?classRegionLine(locus,mode==='peaks'?(peaksHere.length?'selected peaks':'this view (no selected peak here)'):mode==='region'?(savedRegion?'saved region':'this view (no saved region here)'):'this view'):null}
        peaksAvailable={!!peaksHere.length} savedRegion={savedRegion?.label??null} short={false} viewChosen={mode==='view'} disabled={batchRunning||running(job)} />
      {useMatched && matched.recovery && <AnalysisButton data-testid="nfr-shared-block" onClick={matched.recovery.run}>{matched.recovery.label}</AnalysisButton>}
      {mode!=='view'&&<button type="button" data-testid="nfr-region-clear" className="text-[11px] text-ink-muted underline" onClick={()=>setSettings({regionMode:'view',nfrRegions:'',nfrRegionsChrom:''})}>Clear</button>}
      {useMatched&&<p data-testid="nfr-region-method" className="text-[11px] text-ink-muted">Each region is analysed separately in genomic coordinates; compare the results below. Reversed partners keep their own coordinates.</p>}
      {regionJobs.length>0&&<div data-testid="nfr-region-results" className="flex flex-wrap gap-2">{regionJobs.map(j=><button type="button" key={j.job_id} disabled={batchRunning} data-testid="nfr-region-result" className="rounded-fb border border-line px-2 py-1 text-[11px] text-ink-muted" onClick={()=>{setJob(j);if(j.result)setRun(j.job_id,j.result);}}>
        {j.request?.region_label} · {j.request?.dataset_ids.map(id=>datasetLabel(id)).join(', ')} · {j.request?.chrom}:{j.request?.start}–{j.request?.end} · {j.result?.nfrs.length??0} NFRs
        {j.result?.nfrs.flatMap(n=>n.variants.map(v=><span key={`${n.id}-${v.id}`} className="block tabular-nums">{v.name}: {v.start.toLocaleString()}–{v.end.toLocaleString()} · {share(v.prevalence)} open</span>))}
      </button>)}</div>}

    </div>
  );

  const groupsBar = last && (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-fuchsia-200 bg-fuchsia-50/70 px-2 py-1 text-[11px] dark:border-fuchsia-900/60 dark:bg-fuchsia-900/15" data-testid="nfr-groups-bar">
      <span className="font-medium text-fuchsia-800 dark:text-fuchsia-200">{lastCurrent ? 'Reads grouped:' : 'Grouping replaced:'}</span>
      <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">{last.grouping.label}</span>
      {lastCurrent && (last.configurations || last.split) && (
        <span className="flex flex-wrap gap-x-2" data-testid="nfr-group-legend">
          {(last.configurations ? last.configurations.groups.map(g => ({ id: g.id, label: g.display_label, n: g.count }))
            : last.split!.groups.map(g => ({ id: g.id, label: g.label, n: g.molecules }))).map(g => (
            <span key={g.id} className="whitespace-nowrap">
              <span className="mr-0.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: getClusterColor(g.id) }} />
              {g.label} <span className="text-ink-muted">{g.n.toLocaleString()}</span>
            </span>
          ))}
        </span>
      )}
      <AnalysisButton theme="fuchsia" variant="quiet" onClick={clearGroups} data-testid="nfr-groups-clear"
        title={lastCurrent ? 'Put back the read grouping you had before (an undo step of its own)' : 'Forget this grouping (the read panels already show another one)'}>
        {lastCurrent ? 'Restore previous grouping' : 'Dismiss'}
      </AnalysisButton>
    </div>
  );

  const runSettings = (
    <>
      <div className="grid gap-1.5 text-[11px]" data-testid="nfr-run-settings">
          <div className="font-medium text-gray-700 dark:text-gray-200">Finding NFR variants <span className="font-normal text-ink-muted">(applies to the next Find NFR variants)</span></div>
          <label className="flex items-center gap-2" title="Variants: positions and widths found from the reads (default). Timer depth: nested width states by the widest opening on the read (at least 175, 300 or 500 bp).">
            States
            <select value={settings.mode} onChange={e => setSettings({ mode: e.target.value as NfrSettings['mode'] })} className="rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900">
              <option value="variants">Discovered variants</option>
              <option value="depth">Timer depth (175 / 300 / 500 bp)</option>
            </select>
          </label>
          <label className="flex items-center gap-2" title="What NFR pairs compare: each variant as its own element (default), or each NFR as a whole (open when any opening is there).">
            Elements
            <select value={settings.elements} onChange={e => setSettings({ elements: e.target.value as NfrSettings['elements'] })} className="rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900">
              <option value="variants">Each variant</option>
              <option value="nfrs">Whole NFRs</option>
            </select>
          </label>
          <label className="flex items-center gap-2" title="When the protection between two openings on a read matches a supported footprint class (from a Find classes run here), call it one NFR with a factor bound inside rather than two NFRs.">
            <input type="checkbox" checked={settings.internalFootprintLabels} onChange={e => setSettings({ internalFootprintLabels: e.target.checked })} />
            Label splits with a footprint inside as “full NFR with internal footprint”
          </label>
          <label className="flex items-center gap-2" title="Optional. Start-end positions of the NFRs to analyse, comma separated. Empty: found automatically from the reads in this view.">
            NFR regions
            <input type="text" value={settings.nfrRegions} placeholder="automatic" onChange={e => setSettings({ nfrRegions: e.target.value, nfrRegionsChrom: '' })}
              className={`w-64 rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900 ${regionsValid ? '' : 'border-red-400'}`} />
          </label>
          <CheckboxRow checked={settings.clipGapsToRegion} onChange={v => setSettings({ clipGapsToRegion: v })}
            label="Count each gap toward one region only" disabled={!clipSupport} testId="nfr-clip-gaps"
            title="A gap spanning several NFRs can otherwise count in each. Assign it to the region with the largest overlap (ties go left), preserving its observed edges."
            description={!clipSupport ? 'Update FiberHMM to use this setting.' : undefined} />
          <details className="rounded border border-gray-100 px-1.5 py-1 dark:border-white/5" data-testid="nfr-engine-knobs">
            <summary className="cursor-pointer text-gray-600 dark:text-gray-300" title="Fixed in FiberHMM: nucleosome calls are those of 90 bp or more, factor-sized protections never split an opening, and the Timer depth states are 175 / 300 / 500 bp.">Advanced (FiberHMM engine)</summary>
            {depthSupport === null ? <p className="text-ink-muted">{schemaFailed ? depthPendingNote : 'Checking read-cap support…'}</p> : <ReadDepthControls prefix="nfr" values={settings} supported={depthSupport === true} onChange={(name,value)=>setSettings({[name]:value})}/>}
            <div className="mt-1 grid gap-1">
              {ENGINE_KNOBS.map(([key, name, label, min, max, step, help]) => (
                <label key={key} className="grid grid-cols-[9rem_5rem] items-center gap-2" title={help}>
                  <span>{label}</span>
                  <input type="number" min={min} max={max} step={step} value={settings[key] as number} data-testid={`nfr-knob-${name}`}
                    onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setSettings({ [key]: Math.max(min, Math.min(max, v)) } as Partial<NfrSettings>); }}
                    className="rounded border px-1 py-0.5 tabular-nums dark:border-gray-700 dark:bg-gray-900" />
                </label>
              ))}
              <div className="mt-1 font-medium text-gray-600 dark:text-gray-300" data-testid="nfr-detection-knobs">NFR detection (when regions are found automatically)</div>
              <label className="grid grid-cols-[9rem_auto] items-center gap-2" title={detectSupport === false
                ? 'This FiberHMM finds NFRs only with its older fixed rule; update FiberHMM for the enrichment rule.'
                : 'Raw: the percentage of reads open, with read and width floors. Fold and q are information. Enrichment adds background and q gates. Fixed uses the older fixed level.'}>
                <span>Method</span>
                <select value={method} disabled={detectSupport !== true} data-testid="nfr-detect-method"
                  onChange={e => setSettings({ detectMethod: e.target.value as NfrSettings['detectMethod'] })} className="rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900">
                  {rawSupport && <option value="raw">Raw percentage (default)</option>}
                  <option value="enrichment">Enrichment over background</option><option value="fixed">Fixed share (older rule)</option>
                </select>
              </label>
              {DETECTION_KNOBS.filter(([key]) => method === 'fixed' ? key === 'detectThreshold' : method === 'raw' ? key === 'minOpenReads' : key !== 'detectThreshold').map(([key, name, label, min, max, step, help]) => (
                <label key={key} className="grid grid-cols-[9rem_5rem] items-center gap-2" title={help}>
                  <span>{label}</span>
                  <input type="number" min={min} max={max} step={step} value={settings[key] as number} data-testid={`nfr-knob-${name}`}
                    onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setSettings({ [key]: Math.max(min, Math.min(max, v)) } as Partial<NfrSettings>); }}
                    className="rounded border px-1 py-0.5 tabular-nums dark:border-gray-700 dark:bg-gray-900" />
                </label>
              ))}
              <label className="grid grid-cols-[9rem_5rem] items-center gap-2" title="Which element pairs the NFR pairs test">
                <span>Pairs</span>
                <select value={settings.pairs} onChange={e => setSettings({ pairs: e.target.value as NfrSettings['pairs'] })} className="rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900">
                  <option value="nfr">with an NFR</option><option value="all">all (class × class too)</option>
                </select>
              </label>
              <button type="button" className="justify-self-start text-[10px] text-fuchsia-700 hover:underline dark:text-fuchsia-300"
                onClick={() => setSettings(Object.fromEntries([...[...ENGINE_KNOBS, ...DETECTION_KNOBS].map(([k]) => [k, DEFAULT_NFR_SETTINGS[k]]), ...READ_DEPTH_NAMES.map(k=>[k,DEFAULT_NFR_SETTINGS[k]]), ['pairs', 'nfr'], ['detectMethod', 'raw'], ['clipGapsToRegion', false], ['minFraction', rawSupport ? DEFAULT_NFR_SETTINGS.minFraction : 0.05]]) as Partial<NfrSettings>)}>Engine defaults</button>
            </div>
          </details>
          {clusterK && (
            <label className="flex items-center gap-2" data-testid="nfr-within-clusters" title={`Also test each pair within ${clusterK} groups of reads with similar accessibility. The reads are re-clustered for every pair with the two tested elements masked, so the clustering cannot decide the answer.`}>
              <input type="checkbox" checked={settings.withinClusters} onChange={e => setSettings({ withinClusters: e.target.checked })} />
              Within-cluster check ({clusterK} clusters)
            </label>
          )}
        </div>
      <NfrMotifParameters />
    </>
  );

  // Find NFR variants' progress, in the layout Find classes uses (nfrProgress.ts): the step strip, a plain stage title,
  // the bar (determinate wherever the run gives counts), the engine's message as the detail line, elapsed time and
  // Cancel; its outcome when it failed or was cancelled.
  const progressBlock = job && (running(job) || job.status === 'error' || job.status === 'cancelled') ? (
    <JobStatus title="Find NFR variants" testId="nfr-progress" state={job.status as JobState}
      stage={nfrStageTitle(job)} steps={NFR_STEPS} stepIndex={nfrStepIndex(job)} runKey={job.job_id}
      startedAt={job.started_at ?? job.created_at ?? null} finishedAt={job.finished_at ?? null}
      progress={nfrProgress(job)} stageProgress={nfrStageProgress(job)} phase={nfrPhase(job)}
      message={job.message ?? ''} onCancel={cancel} progressLabel="Find NFR variants current-step progress"
      note="The bar counts completed work in the current step, not estimated time." stepsTestId="nfr-progress-steps" />
  ) : null;

  const shownNfrs = !result || !jobId ? [] : listFilter === 'starred' ? result.nfrs.filter(n => starredHere.has(cardKey(jobId, n.id))) : result.nfrs;
  const earlierOpen = showEarlier || (listFilter === 'starred' && !shownNfrs.length);
  const listTab = (
    <div className="space-y-2.5">
      {batchRunning && <div className="flex items-center gap-2 text-[11px]" data-testid="nfr-batch-progress">
        <span>{regionJobs.length} of {batchTotal} regions complete</span>
        <AnalysisButton data-testid="nfr-batch-cancel" onClick={cancel}>Cancel</AnalysisButton>
      </div>}
      {batchError && <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400">{batchError}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <AnalysisButton theme="fuchsia" variant="primary" size="sm" data-testid="nfr-find" disabled={missingType.length > 0 || (useMatched ? !!matched.error : !locus || noData) || batchRunning || running(job) || !regionsValid || depthPending} onClick={run}
          title={depthPending ? depthPendingNote : noData ? `${NO_DATASET_HINT} to find NFR variants in its reads`
            : missingType.length ? `Set the assay type of ${missingType.map(d => getDatasetDisplayLabel(d)).join(', ')} first (below): FiberHMM needs it to read the BAM`
            : !locus ? 'The targeted panels show different regions: target one panel (or one region) to find NFR variants there' : 'Find the NFR variants in this view with FiberHMM: per-read openings between nucleosomes, grouped the way Find classes groups footprints, with how often each occurs.'}>
          {missingType.length && !noData ? 'Set up datasets to continue' : 'Find NFR variants'}
        </AnalysisButton>
        {depthPending && <p data-testid="nfr-read-depth-pending" className="text-[11px] text-ink-muted">{depthPendingNote}</p>}
        {noData && <OpenBamHint testId="nfr-no-data" />}
        <label className="flex items-center gap-1.5 text-[11px]" title="How reproducible a variant must be across random halves of the reads (prediction strength). Lower finds finer variants; 0.9 is the default, 0.85 finer.">
          Stringency
          <input type="range" min={0.5} max={0.95} step={0.01} value={settings.stringency} aria-label="Stringency" data-testid="nfr-stringency"
            onChange={e => setSettings({ stringency: Number(e.target.value) })} className="w-28 accent-fuchsia-600" />
          <span className="w-9 tabular-nums">{settings.stringency.toFixed(2)}</span>
          <button type="button" className={`rounded px-1 text-[10px] ${settings.stringency === 0.85 ? 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10'}`}
            onClick={() => setSettings({ stringency: 0.85 })}>0.85 finer</button>
          <button type="button" className={`rounded px-1 text-[10px] ${settings.stringency === 0.9 ? 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10'}`}
            onClick={() => setSettings({ stringency: 0.9 })}>0.9 default</button>
        </label>
        <RarestNfrSlider defaultValue={rawSupport ? DEFAULT_NFR_SETTINGS.minFraction : 0.05} background={result && locus && result.region.chrom === locus.chrom && result.region.start === locus.start && result.region.end === locus.end && result.datasets.length === locus.datasetIds.length && result.datasets.every(d => locus.datasetIds.includes(d.dataset_id)) ? result.detection?.background : null} value={settings.minFraction} onChange={v => setSettings({ minFraction: v })}
          disabledWhy={detectSupport === false ? `This FiberHMM finds NFRs only with its older fixed rule (more than ${share(settings.detectThreshold)} of reads open); update FiberHMM (Settings > FiberHMM) to set the rarest NFR.`
            : detectSupport === null ? (schemaFailed ? 'Could not read which NFR detection this FiberHMM has (is FiberHMM available?); Find NFR variants uses its own default.' : 'Checking which NFR detection this FiberHMM has…')
            : givenRegions.used.length ? 'NFR regions are given (beside Find): nothing is detected; Clear them to detect NFRs.'
            : settings.detectMethod === 'fixed' ? `The fixed rule is on (Settings > Advanced): NFRs are where more than ${share(settings.detectThreshold)} of reads are open.` : null} />
      </div>
      {settings.nfrRegions.trim() && (
        // Given NFR regions on show (they were only in Settings, and one carried over from another locus found nothing).
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted" data-testid="nfr-given-regions">
          <span>NFR region given: <span className="tabular-nums text-ink">{givenRegionsLabel}</span>
            {givenRegions.used.length ? ' · nothing is detected' : ' · not in this view, so NFRs are found automatically'}</span>
          <button type="button" className="text-ink-muted underline"
            onClick={() => setSettings({ nfrRegions: '', nfrRegionsChrom: '' })} data-testid="nfr-given-regions-clear">Clear</button>
          {locus&&regionAnalysisExtension()&&<button type="button" data-testid="nfr-region-link" disabled={!givenRegions.used.length} className="text-ink-muted underline" onClick={()=>{
            for(const [start,end] of givenRegions.used) regionAnalysisExtension()!.link({...locus,start,end});
          }}>Link as matched</button>}
        </p>
      )}
      {detectSupport !== null && !rawSupport && <p className="text-[11px] text-ink-muted" data-testid="nfr-raw-unavailable">{detectSupport ? 'This FiberHMM uses enrichment: background and q also gate NFRs.' : 'This FiberHMM uses its older fixed rule.'} Update FiberHMM for raw percentages.</p>}
      {missingType.length > 0 && !noData && (
        <div className="rounded border border-amber-300 bg-amber-50/60 p-2 dark:border-amber-700 dark:bg-amber-950/20" data-testid="nfr-dataset-setup">
          <DatasetSetupTab datasetIds={missingType.map(d => d.id)} />
        </div>
      )}
      {progressBlock}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {groupsBar}
      {result && (
        <div className="space-y-2" data-testid="nfr-result">
          <p className="text-[11px] text-gray-500">
            {result.region.chrom}:{bp(result.region.start)}–{bp(result.region.end)}{runDatasets ? ` · ${runDatasets}` : ''} · stringency {String(result.parameters.stringency)}
            {job?.payload_source && job.payload_source !== 'loaded' ? ` · ${job.payload_source}` : ''}
          </p>
          {opportunityDiagnosticLine(result) && <p className="text-[11px] text-ink-muted" data-testid="nfr-background-diagnostic">{opportunityDiagnosticLine(result)}</p>}
          {runDetectionLine(result) && <p className="text-[11px] text-gray-500" data-testid="nfr-detection-line" title={HELP.detection}>{runDetectionLine(result)}</p>}
          <div data-testid="nfr-read-depth-notes" className="text-[11px] text-ink-muted">{nfrReadDepthNotes(result.detection?.molecule_sampling,Object.fromEntries(datasets.map(d=>[d.id,d.label])),result.detection?.loader_sampling).map(note=><p key={note}>{note}</p>)}</div>
          {result.warnings.map(w => <AnalysisStatus key={w} kind="info">{w}</AnalysisStatus>)}
          {result.nfrs.length === 0 && <AnalysisStatus kind="info">No NFR found in this view.</AnalysisStatus>}
          {shownNfrs.map(n => (
            <LiveNfrCard key={n.id} nfr={n} result={result} jobId={jobId!} starred={starredHere.get(cardKey(jobId!, n.id))} common={cardCommon}
              classesJoined={(result.class_join?.joined_molecules ?? 0) > 0} onPairs={pairsOf} />
          ))}
          {listFilter === 'starred' && result.nfrs.length > 0 && !shownNfrs.length && (
            <p className="text-[11px] text-gray-500" data-testid="nfr-starred-none-here">No NFR of this run is starred: star one (☆) in All.</p>
          )}
        </div>
      )}
      {!result && listFilter === 'starred' && !earlier.length && (
        <p className="rounded-lg border border-dashed border-gray-300 p-4 text-center text-[12px] text-gray-500 dark:border-gray-700" data-testid="nfr-starred-empty">Nothing starred yet: star an NFR (☆) to keep it with the session.</p>
      )}
      {earlier.length > 0 && (
        <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700" data-testid="nfr-earlier">
          <button type="button" onClick={() => setPanelView({ showEarlier: !earlierOpen })} aria-expanded={earlierOpen} data-testid="nfr-earlier-toggle"
            className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-gray-600 dark:text-gray-300"
            title="Starred from other windows or earlier sessions: kept with their stored numbers; Go there shows the window, and an entry whose run this server still has opens to its analysis">
            <DisclosureChevron open={earlierOpen} /> Earlier ({earlier.length})
            {earlier.some(e => badges[`entry:${cardKey(e.jobId, e.nfrId)}`]) && <NewDot />}
          </button>
          {earlierOpen && (
            <div className="space-y-1.5 px-1.5 pb-1.5">
              {earlier.map(e => <StoredNfrCard key={e.id} entry={e} ready={available.has(e.jobId)} common={cardCommon} onFindAgain={findAgain} />)}
            </div>
          )}
        </div>
      )}
      {result && <ExportRow jobId={jobId} exportName={exportName} setExportName={setExportName} />}
      <details className="rounded-md border border-gray-200 px-2 py-1 text-[11px] dark:border-gray-700" data-testid="nfr-pooled-disclosure">
        <summary className="cursor-pointer text-gray-600 dark:text-gray-300">Advanced / exploratory: motifs pooled over runs</summary>
        <p className="mt-1 text-gray-500">Across every NFR of the runs you pick, is a motif family more often present, open or footprinted in one kind of variant (full, core, extended, shifted) than in its siblings?</p>
        <div className="mt-1.5"><PooledMotifs jobId={jobId} /></div>
      </details>
      <HowItWorks summary="How this works">
        <p>An NFR on a read is the stretch between two nucleosome calls of at least 90 bp; a factor-sized protection inside it does not split it. Only reads with a nucleosome on both sides of the region count (callable reads).</p>
        <p>The openings’ left and right edges are clustered with the same recipe Find classes uses for footprints (prediction strength for the number of variants, held-out tests to merge or drop them). Each read then gets a probability for each variant; prevalence is the EM estimate with a read-bootstrap interval that holds the variant set fixed (Statistics in an open card: the strict share, strands and support).</p>
      </HowItWorks>
    </div>
  );

  const focusOptions = result ? result.nfrs.filter(n => n.variants.length).flatMap(n => [
    { id: n.id, label: `${n.id} (all variants)` }, ...n.variants.map(v => ({ id: v.id, label: `  ${n.id} ${v.name}` })),
  ]) : [];
  const focusLabel = focus ? (byId.get(focus) ? shortElement(byId.get(focus), focus) : `${focus} (all variants)`) : null;
  const arcView = (w: number, h: number) => arcSpan && (
    <ArcsBlock arcs={arcs} result={result!} expanded={unfolded} onToggle={unfold} includeClasses={showClassArcs} start={arcSpan[0]} end={arcSpan[1]}
      onPick={inspectPicks} selected={selectedPair} onElement={id => void pickElement(id)} focus={focus} width={w} height={h} hovered={hoveredElement} onElementHover={setHoveredElement} />
  );

  const coaccessTab = !result ? <div className="space-y-2">{progressBlock}<p className="text-[11px] text-gray-500">Find NFR variants first (NFRs tab).</p></div> : (
    <div className="space-y-2.5" data-testid="nfr-coaccess">
      <p className="text-[11px] text-ink-muted" data-testid="nfr-coaccess-subtitle">Pairs of NFRs or NFR variants (and footprint classes) opened together on the same reads, against read openness: one run's reads.</p>
      {progressBlock}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
        <AnalysisToggleGroup theme="fuchsia" value={coView} onChange={v => v && setCoView(v)}
          options={[{ value: 'arcs', label: 'Arcs' }, { value: 'matrix', label: 'Matrix' }]} />
        <label className="flex items-center gap-1.5" title="Only pairs whose adjusted log₂ odds ratio (openness-adjusted, pooled over strata) is at least this far from 0 (the arc height)">
          |adjusted log₂ OR| ≥
          <input type="range" min={0} max={3} step={0.25} value={minEffect} aria-label="Minimum strength" data-testid="nfr-min-effect"
            onChange={e => setFilter({ minEffect: Number(e.target.value) })} className="w-20 accent-fuchsia-600" />
          <span className="w-7 tabular-nums">{minEffect.toFixed(minEffect % 1 ? 2 : 0)}</span>
        </label>
        <label className="flex items-center gap-1" title="Only the strongest pairs that pass (by |adjusted log₂ OR|, then q)">
          Top
          <select value={topN ?? 0} onChange={e => setFilter({ topN: Number(e.target.value) || null })} data-testid="nfr-top-n"
            className="rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900">
            {[10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}<option value={0}>all</option>
          </select>
        </label>
        <label className="flex items-center gap-1" title="Only the connections of one variant, or of one NFR and all its variants (or click an element on the arcs)">
          Focus
          <select value={focus ?? ''} onChange={e => setFilter({ focus: e.target.value || null })} data-testid="nfr-focus"
            className="max-w-[10rem] rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900">
            <option value="">all</option>
            {focusOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1" title="Include footprint classes from a Find classes run on these datasets (variant × class pairs)">
          <input type="checkbox" checked={showClassArcs} onChange={e => setShowClassArcs(e.target.checked)} /> Classes
        </label>
        <label className="flex items-center gap-1" title="Draw these arcs (with these filters) on the NFR track over the reads of the run's datasets; select elements and pairs there too">
          <input type="checkbox" checked={showArcs} onChange={e => setShowArcs(e.target.checked)} data-testid="nfr-show-arcs" /> On the NFR track
        </label>
        {coView === 'arcs' && (
          <button type="button" onClick={() => setExpanded(true)} data-testid="nfr-arcs-expand" title="Open the arcs larger"
            className="ml-auto rounded px-1.5 py-0.5 text-fuchsia-700 hover:bg-fuchsia-50 dark:text-fuchsia-300 dark:hover:bg-white/5">⤢ Expand</button>
        )}
      </div>
      <p className="text-[11px] text-gray-500" data-testid="nfr-pair-counts">
        <span className="font-medium text-gray-700 dark:text-gray-200">{counts.shown}</span> shown of {counts.significant} significant (q ≤ {qMax}) · {counts.tested} tested
        {focusLabel && <> · focus <button type="button" className="font-medium text-fuchsia-700 hover:underline dark:text-fuchsia-300" onClick={() => setFilter({ focus: null })} title="Show every element">{focusLabel} ×</button></>}
        {joinedInRun || !classStatus?.classes ? (
          <span className="ml-2 text-ink-muted" data-testid="nfr-class-join" title={result.class_join
            ? `Footprint classes from ${runTitle('footprint', job?.class_job_id)}`
            : classStatus?.reason ?? 'Run Find classes (Footprints panel, or an NFR card\'s Footprints view) on these datasets here to add footprint classes to the comparison.'}>
            {result.class_join ? `${result.class_join.classes} class${result.class_join.classes === 1 ? '' : 'es'} in this window · ${result.class_join.joined_molecules.toLocaleString()} of ${result.class_join.molecules.toLocaleString()} molecules joined${job?.class_job_id ? ` · ${joinedRun.name}` : ''}` : 'no classes'}
          </span>
        ) : (
          <span className="ml-2 inline-flex flex-wrap items-center gap-1 text-gray-700 dark:text-gray-200" data-testid="nfr-class-join" data-state="after-run"
            title={`${runTitle('footprint', classStatus.class_job)}: found after this run, so its pair tests do not include them yet`}>
            {classStatus.classes} class{classStatus.classes === 1 ? '' : 'es'} in this window ({laterRun.name}) found after this run ·
            <button type="button" onClick={() => void rerun()} disabled={running(job)} data-testid="nfr-class-rerun"
              className="font-medium text-fuchsia-700 underline-offset-2 hover:underline disabled:opacity-50 dark:text-fuchsia-300">Re-run to include them</button>
          </span>
        )}
      </p>
      {coView === 'arcs' && <ArcsBlockFill render={arcView} />}
      {coView === 'arcs' && (
        <p className="text-[10px] text-ink-muted" data-testid="nfr-arcs-legend" title="Height: the adjusted log₂ odds ratio (openness-adjusted, pooled over strata); thickness: significance; dotted: a footprint class inside the variant, dashed: at its edge. Click an arc to inspect the pair (the read panels stay as they are); click an element to select it (only its connections), then a second one to inspect their pair. ▸ shows an NFR's variants (here, in the matrix and on the NFR track).">
          <span style={{ color: '#c2410c' }}>▲ open together</span> · <span style={{ color: '#1d4ed8' }}>▼ rarely together</span> · click an arc to inspect the pair; click an element to select it, then another for their pair
        </p>
      )}
      {coView === 'matrix' && <ElementMatrix result={result} includeClasses={showClassArcs} qMax={qMax} passing={passing} focus={focus}
        onPick={inspectPicks} selected={selectedPair} expanded={unfolded} onToggle={unfold} />}
      {expanded && arcSpan && (
        <ChartMaximizeModal title={`NFR pair arcs${focusLabel ? `: ${focusLabel}` : ''} (${counts.shown} pairs)`} filename="nfr-arcs"
          onClose={() => setExpanded(false)} renderChart={(w, h) => <div data-testid="nfr-arcs-expanded">{arcView(w, Math.max(240, h - 30))}</div>} />
      )}
      {busy === 'split' && <AnalysisStatus kind="loading">Grouping the reads…</AnalysisStatus>}
      {busy === 'inspect' && <AnalysisStatus kind="loading">Reading the pair…</AnalysisStatus>}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {groupsBar && (!shownSplit || detailSplit !== shownSplit) && groupsBar}
      {detailSplit && (
        <PairDetail split={detailSplit} byId={byId} mode={detailSplit === inspected ? 'inspect' : lastCurrent ? 'grouped' : 'replaced'}
          onGroup={groupInspected} onClear={clearGroups} onReapply={reapply}
          onClose={() => {
            if (detailSplit === inspected) dropInspect();
            else if (lastCurrent) clearGroups(); else dismissApplied(last!);
          }} focusKeys={focusKeys} />
      )}
      {notable.length > 0 && (
        <table className="w-full text-[11px] tabular-nums" data-testid="nfr-pair-table">
          <thead className="text-left text-gray-500">
            <tr><th className="font-medium">Pair</th><th className="font-medium" title="The log₂ odds ratio adjusted for read openness (Mantel–Haenszel over strata of similar openness); in brackets the pooled one, unadjusted, as a plain Fisher test gives it">Adjusted log₂ OR (pooled)</th>
              <th className="font-medium" title={Q_HELP}>q</th><th className="font-medium">Reads</th><th /></tr>
          </thead>
          <tbody>
            {notable.map(p => {
              const key = `${p.a}|${p.b}`;
              const shown = detailSplit?.kind === 'pair' && `${detailSplit.a}|${detailSplit.b}` === key;
              return (
                <tr key={key} onClick={() => inspectPicks(p.a, p.b)} tabIndex={0} data-testid="nfr-pair-row" data-pair={key} aria-selected={shown}
                  onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inspectPicks(p.a, p.b); } }}
                  title="Inspect this pair (Enter); the read panels stay as they are"
                  className={`cursor-pointer border-t border-gray-100 hover:bg-fuchsia-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fuchsia-500 dark:border-gray-800 dark:hover:bg-white/[0.03] ${shown || selectedPair === key ? 'bg-fuchsia-50 dark:bg-fuchsia-900/20' : ''}`}>
                  <td className="pr-2">{shortElement(byId.get(p.a), p.a)} × {shortElement(byId.get(p.b), p.b)} <span className="text-ink-muted">{directionWord(p.class)}{p.nested ? `, ${p.nested}` : ''}</span></td>
                  <td className="pr-2">{signed(p.mh)} <span className="text-ink-muted">({signed(p.log2or)})</span></td>
                  <td className="pr-2">{formatQ(p.q)}</td>
                  <td>{p.n.toLocaleString()}{p.shared ? <span className="text-ink-muted"> · {p.shared} shared</span> : null}</td>
                  <td>
                    <button type="button" data-testid="nfr-pair-group" onClick={e => { e.stopPropagation(); void split({ a: p.a, b: p.b }); }}
                      title="Group the reads by this pair (its four 2×2 groups and the reads the test could not use)"
                      className="rounded px-1 text-[10px] text-fuchsia-700 hover:bg-fuchsia-50 dark:text-fuchsia-300 dark:hover:bg-white/5">Group reads</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {result.combos && result.combos.status === 'ok' && (
        <div className="flex flex-wrap items-start gap-2 text-[11px] text-gray-500" data-testid="nfr-combos">
          <p className="min-w-0 flex-1" title={`Combinations of ${result.combos.elements.map(id => shortElement(byId.get(id), id)).join(', ')} on ${result.combos.n.toLocaleString()} reads, against what the margins and read openness give`}>
            Combinations:{' '}
            {result.combos.patterns.filter(p => p.significant).length
              ? result.combos.patterns.filter(p => p.significant).slice(0, 4).map(p => `${comboPattern(p.pattern, result.combos!.elements, byId)} ${p.obs} vs ${p.null_med.toFixed(0)}`).join('; ')
              : 'none departs from expected.'}
            {result.combos.n < 100 ? ' Few reads.' : ''}
          </p>
          <AnalysisButton theme="fuchsia" variant="quiet" onClick={() => void split({ elements: result.combos!.elements })} data-testid="nfr-split-combos"
            title="Group the reads by which of these elements they open (one group per pattern, plus the reads that do not span them all)">Split by pattern</AnalysisButton>
          {jobId && (
            <AnalysisButton theme="fuchsia" variant="quiet" data-testid="nfr-split-combos-panels"
              onClick={() => useSplitPanelStore.getState().request({ kind: 'split', jobId, elements: result.combos!.elements, result })}
              title="Split into panels: one read panel per combination pattern, to cluster them together and compare">Split into panels</AnalysisButton>
          )}
        </div>
      )}
      <HowItWorks summary="About the statistics">
        <p>Only reads spanning both elements count, and a read whose single opening covers both is left out (“shared”: one opening says nothing about whether two separate ones open together). Each pair is tested exactly within groups of about 50 reads of similar overall openness (and per DAF strand), so two elements that are both open simply because some reads are open everywhere do not look linked.</p>
        <p>The arc height is that openness-adjusted (Mantel–Haenszel) log2 odds ratio; the tooltip also gives the pooled one, which is what a plain Fisher test reports. q is Benjamini–Hochberg across all tested pairs of the run. The filters above (q, strength, top N, focus) only choose which pairs are drawn; they never change a test. Splitting a pair puts exactly the test's four groups into the read panels.</p>
      </HowItWorks>
    </div>
  );

  // NFR pairs: the run's elements, or the view's positions (the Co-accessibility matrix; two datasets subtracted)
  const pairsTab = (
    <div className="space-y-2.5">
      <AnalysisToggleGroup theme="fuchsia" value={pairsMode} onChange={v => v && setPanelView({ pairsMode: v })}
        options={[{ value: 'elements', label: 'NFR elements' }, { value: 'positions', label: 'Position correlation' }]} />
      {pairsMode === 'positions' ? <PositionCorrelation isFullView={isFullView} locus={locus} regionsDiffer={loci.length > 1} /> : coaccessTab}
    </div>
  );

  const dot = (key: string) => (badges[key] ? ' •' : '');
  const tabs = [
    { key: 'nfrs' as const, label: `NFRs${dot('tab:nfrs')}` },
    { key: 'coaccess' as const, label: `NFR pairs${dot('tab:coaccess')}` },
  ];
  // One list: All, or the Starred cards (with the Earlier group of other runs); in the shared strip.
  const listFilterControl = tab === 'nfrs' && (
    <span className="flex items-center gap-1.5" data-testid="nfr-list-filter">
      <AnalysisToggleGroup theme="fuchsia" value={listFilter} onChange={v => v && setPanelView({ listFilter: v })}
        options={[{ value: 'all', label: 'All' }, { value: 'starred', label: `Starred${saved.length ? ` (${saved.length})` : ''}` }]} />
      {listFilter === 'starred' && saved.length > 0 && (
        <>
          <button type="button" onClick={() => downloadTextFile(savedVariantsBed(saved), `nfr_variants_${exportTimestamp()}.bed`)} data-testid="nfr-starred-bed"
            className="rounded px-1 text-fuchsia-700 hover:bg-fuchsia-50 dark:text-fuchsia-300 dark:hover:bg-white/5"
            title="BED of the ticked variants of every starred NFR (score: prevalence x 1000; the variant's colour)">BED</button>
          <button type="button" data-testid="nfr-starred-clear" className="rounded px-1 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
            onClick={() => { if (window.confirm(`Unstar all ${saved.length} NFRs (their names, notes and stored numbers go)?`)) useBrowserStore.getState().clearSavedNfrVariants(); }}>Unstar all</button>
        </>
      )}
    </span>
  );
  return (
    <div data-testid="accessibility-panel" ref={scrollRef} style={{ '--nfr-tabs-h': '34px' } as React.CSSProperties}>
      {/* No inner scroll box: the panel's frame (side dock, drawer, pop-out, full view) scrolls the whole
          panel at its full height, as Footprints and Clusters do (a 400-px box left blank space below). The tabs stay
          at the top of the frame, and an open card's name right under them. */}
      <AnalysisPanelShell tabs={tabs} activeTab={tab} onTabChange={setTab} theme="fuchsia" isFullView={isFullView} layout="standard" header={header} bodyMode="none"
        tabBarClassName="sticky top-0 z-20 bg-surface px-2">
        <div className="space-y-2.5">
          <NfrFilterStrip settings={runSettings} extra={listFilterControl || null} />
          {tab === 'nfrs' && <NfrLegend />}
          {tab === 'coaccess' ? pairsTab : listTab}
        </div>
      </AnalysisPanelShell>
      <NfrNotices onOpen={openOwner} />
    </div>
  );
}

/** One line under the filter strip: the card's terms, each with its "?" (focusable) help. */
function NfrLegend() {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="nfr-legend">
      <span className="inline-flex items-center">callable reads<HelpTip term="callable" text={HELP.callable} testId="nfr-legend-callable" /></span>·
      <span className="inline-flex items-center">closed %<HelpTip term="closed %" text={HELP.closed} testId="nfr-legend-closed" /></span>·
      <span className="inline-flex items-center">[26–30] 95% interval<HelpTip term="the interval in brackets" text={HELP.interval} testId="nfr-legend-interval" /></span>·
      <span className="inline-flex items-center">full, extended, satellite…<HelpTip term="the variant types" question="What are the variant types?" text={HELP.types} testId="nfr-legend-types" /></span>
    </p>
  );
}

/**
 * Remember the scroll position of the panel's frame (its nearest scrolling ancestor) and put it back when the panel
 * mounts again with a card open (closing split panels re-mounts it): the open card stays where it was.
 */
function usePanelScrollMemory(active: boolean) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const restored = useRef(false);
  useEffect(() => {
    if (!el) return;
    let frame: HTMLElement | null = el.parentElement;
    while (frame && frame !== document.body) {
      const o = getComputedStyle(frame).overflowY;
      if ((o === 'auto' || o === 'scroll') && frame.scrollHeight > frame.clientHeight) break;
      frame = frame.parentElement;
    }
    if (!frame || frame === document.body) return;
    const box = frame;
    if (!restored.current) {
      restored.current = true;
      const st = useAccessibilityStore.getState();
      if (active && st.listScroll != null) {
        box.scrollTop = st.listScroll;
        // the open card must be in view even when the frame changed size
        const card = st.openCard ? el.querySelector<HTMLElement>(`[data-testid="nfr-card"][data-card="${cssValue(st.openCard)}"]`) : null;
        if (card) {
          const r = card.getBoundingClientRect(), b = box.getBoundingClientRect();
          if (r.bottom < b.top || r.top > b.bottom) scrollIntoViewWithin(card, { block: 'start' });
        }
      }
    }
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => useAccessibilityStore.getState().setPanelView({ listScroll: box.scrollTop }));
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => { box.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);
  return setEl;
}

/** "N1 V2 + N3 V2 open" for a pattern of open (1) / closed (0) elements; "none open" for all zeros. */
export function comboPattern(pattern: string, ids: string[], byId: Map<string, AccessibilityResult['elements'][number]>): string {
  const open = ids.filter((_, i) => pattern[i] === '1').map(id => shortElement(byId.get(id), id));
  return open.length ? `${open.join(' + ')} open` : 'none open';
}

/** The arcs at the panel's width (measured once this tab is shown). */
function ArcsBlockFill({ render }: { render: (width: number, height: number) => React.ReactNode }) {
  const [width, ref] = useContainerWidth(360);
  return <div ref={ref} className="w-full">{render(Math.max(240, width), 170)}</div>;
}

function ArcsBlock({ arcs, result, expanded, onToggle, includeClasses, start, end, onPick, selected, onElement, focus, width, height, hovered, onElementHover }: {
  arcs: ReturnType<typeof filteredArcs>; result: AccessibilityResult; expanded: readonly string[]; onToggle: (nfrId: string, open: boolean) => void;
  includeClasses: boolean; start: number; end: number;
  onPick: (a: string, b: string) => void; selected: string | null; onElement: (id: string) => void; focus: string | null;
  width: number; height: number; hovered: string | null; onElementHover: (id: string | null) => void;
}) {
  const elements = useMemo(() => drawnElements(result, expanded, includeClasses), [result, expanded, includeClasses]);
  const drawn = useMemo(() => shownArcs(arcs, elements), [arcs, elements]);
  return (
    <div className="w-full">
      <NfrFoldChips result={result} expanded={expanded} onToggle={onToggle} inner={drawn.inner} />
      <ElementArcs arcs={drawn.arcs} elements={elements} start={start} end={end} width={width} height={height} onPick={onPick} selected={selected}
        onElement={onElement} focus={focus} hovered={hovered} onElementHover={onElementHover} onToggle={onToggle} inner={drawn.inner} />
      <div className="flex justify-between text-[10px] tabular-nums text-ink-secondary" style={{ width }}><span>{bp(start)}</span><span>{bp(end)}</span></div>
    </div>
  );
}

function ExportRow({ jobId, exportName, setExportName }: { jobId: string | null; exportName: string; setExportName: (v: string) => void }) {
  if (!jobId) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="nfr-export">
      <span className="text-ink-muted">Export</span>
      <select value={exportName} onChange={e => setExportName(e.target.value)} className="rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900" aria-label="File to export">
        {ACCESSIBILITY_EXPORTS.map(x => <option key={x.name} value={x.name}>{x.label}</option>)}
      </select>
      <a href={accessibilityExportUrl(jobId, exportName)} download className="rounded bg-fuchsia-50 px-2 py-0.5 font-medium text-fuchsia-700 hover:bg-fuchsia-100 dark:bg-fuchsia-900/20 dark:text-fuchsia-300"
        data-testid="nfr-export-link" title="The files fiberhmm-nfr writes for this run (TSV; the manifest records parameters, inputs and the FiberHMM version).">
        Export TSV
      </a>
    </div>
  );
}

export type { AccessibilityResult };
