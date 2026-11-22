/**
 * Drift check between the browser and the headless figure engine (browser/services/figure).
 *
 * The engine draws from the frontend state the open tab pushes (useLiveFigureState) or a session saves
 * (serializeState). Every frontend field it reads must therefore
 *   1. be serialized (a session, and the live push, carry it), and
 *   2. re-push the live view when it changes (LIVE_FIGURE_WATCHED_KEYS, autosave keys or a store extension's keys),
 * or `figure()` renders without it, or renders a stale view. A new setting the engine starts reading fails here until
 * both hold. A new store setting that changes what the reads or tracks show belongs in the engine too: add it to
 * RENDER_KEYS_NOT_IN_ENGINE below with a reason only when the engine cannot or need not draw it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerInsertionFeatures } from '../features/register';
import { useBrowserStore } from '../stores/browserStore';
import { serializeState } from '../stores/historySlice';
import { extensionKeys } from '../stores/storeExtensions';
import { LIVE_FIGURE_OTHER_STORE_KEYS, LIVE_FIGURE_WATCHED_KEYS, LIVE_ONLY_FIGURE_KEYS, liveOnlyFigureFields } from './useLiveFigureState';

const FIGURE_DIR = path.resolve(__dirname, '../../../services/figure');
/** Headless readers of the frontend state outside the figure engine (pooled-loci numbers, panel scope): scanned too. */
const OTHER_READERS = ['../../../services/panel_scope.py', '../../../services/meta_locus_numbers.py'].map(f => path.resolve(__dirname, f));

/** Engine-internal keys (set by the engine itself, never by the browser). */
const ENGINE_INTERNAL = new Set(['_peaksFromAnotherView', '_effectiveLayerColors', '_enableModTypes', '_metaLocus']);

/** Session fields saved from a store of their own (not the browser store), with where the engine gets them for a live
 *  view. The meta-locus store's payload: sessions carry it (api/session.ts); a live tab's figure on a meta contig reads
 *  that contig's pool on the server (services/figure/meta_locus.py axis_for_chrom). */
const OTHER_STORE_SESSION_FIELDS: Record<string, { saved: RegExp; why: string }> = {
  metaLocus: { saved: /frontendState\.metaLocus = metaLocusSessionPayload\(\)/, why: 'the meta-locus store (features/metaLocus)' },
};

/** Fields the engine reads that the browser derives at save time rather than keeping in the store. */
const DERIVED = new Set<string>(['datasets']);

/** Fields only older sessions carry (the engine reads them for those; the browser migrates them on load). */
const LEGACY_SESSION_ONLY = new Set<string>([
  'svTrackCollapsed',            // pre-3.0: now the panels' SV row (migratePanelTracks)
  'consensusTrackLabels',        // retired consensus-track settings
  'consensusTrackMinimumCount',
]);

function pythonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pythonFiles(full);
    return name.endsWith('.py') ? [full] : [];
  });
}

/** Frontend fields the engine reads: fe.get('x') / fe['x'] / ctx.fe.get('x') / fe.get("x", ...). */
function engineFrontendKeys(): Set<string> {
  const keys = new Set<string>();
  // fe.get('x'), fe['x'], ctx.fe.get('x'), (fe or {}).get('x'), _per_key(fe, 'x', ...).
  const pattern = /(?:(?:\bfe|\(fe or \{\}\))(?:\.get\(|\[)|_per_key\(fe,)\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  for (const file of [...pythonFiles(FIGURE_DIR), ...OTHER_READERS]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(pattern)) keys.add(m[1]);
  }
  return keys;
}

// Store extensions (layer colours, Quantify a window, Plots) register their keys here, as the app does at start.
registerInsertionFeatures();

describe('headless figure parity: frontend fields', () => {
  const engineKeys = [...engineFrontendKeys()].filter(k => !ENGINE_INTERNAL.has(k) && !LEGACY_SESSION_ONLY.has(k)
    && !(k in OTHER_STORE_SESSION_FIELDS));

  it('saves the fields other stores keep into sessions', () => {
    const sessionTs = readFileSync(path.resolve(__dirname, '../api/session.ts'), 'utf8');
    for (const [k, { saved }] of Object.entries(OTHER_STORE_SESSION_FIELDS)) expect(saved.test(sessionTs), k).toBe(true);
  });

  it('finds the fields the engine reads', () => {
    // Guards the scan itself: these are read in tracks/reads.py and spec.py.
    for (const k of ['minFootprints', 'showQcFailReads', 'compositeTracks', 'enabledModTypes', 'layerColorOverrides']) expect(engineKeys).toContain(k);
  });

  it('serializes every field the engine reads', () => {
    const state = useBrowserStore.getState();
    // What the live push sends: the session's frontend state plus the live-only fields.
    const serialized = { ...serializeState(state), ...liveOnlyFigureFields(state as unknown as Record<string, unknown>) } as Record<string, unknown>;
    const missing = engineKeys.filter(k => !DERIVED.has(k) && !(k in serialized));
    expect(missing).toEqual([]);
  });

  it('pushes the live view again when any field the engine reads changes', () => {
    const watched = new Set<string>([...LIVE_FIGURE_WATCHED_KEYS, ...LIVE_FIGURE_OTHER_STORE_KEYS, ...extensionKeys()]);
    const missing = engineKeys.filter(k => !watched.has(k));
    expect(missing).toEqual([]);
  });

  it('keeps the legacy and live-only lists honest', () => {
    const state = useBrowserStore.getState() as unknown as Record<string, unknown>;
    // A legacy field back in the store is no longer legacy; a live-only field must be a store field.
    expect([...LEGACY_SESSION_ONLY].filter(k => k in state)).toEqual([]);
    expect([...LIVE_ONLY_FIGURE_KEYS].filter(k => !(k in state))).toEqual([]);
  });

  it('watches only fields the store has', () => {
    const state = useBrowserStore.getState() as unknown as Record<string, unknown>;
    const unknown = [...LIVE_FIGURE_WATCHED_KEYS].filter(k => !(k in state));
    expect(unknown).toEqual([]);
  });
});

/**
 * Every field a session saves is decided on for figures: the engine reads it (found by the scan above), or it is
 * listed here with why a figure need not draw it. A new store setting a session saves fails this test until it is
 * drawn by the engine or listed, so a setting that changes the read view cannot silently miss headless figures.
 * KNOWN_GAPS change the browser's read view but the headless engine does not draw them yet.
 */
const NOT_DRAWN_IN_FIGURES: Record<string, string> = {
  // Inputs of analyses (clustering, sorting, filtering, scans): figures draw their results (clusters, order, filters).
  accessibilityThreshold: 'analysis input', subnucleosomalThreshold: 'analysis input', analysisFilterRules: 'analysis input',
  analysisSortRules: 'analysis input', clusterFeatureRules: 'analysis input', analysisSampleCount: 'analysis working-set cap',
  classRegionMode: 'analysis input', clusterK: 'analysis input', clusterMethod: 'analysis input', clusterPeakMode: 'analysis input',
  clusterResolution: 'analysis input', clusterPreparationCount: 'analysis input', clusterPreparationSamples: 'analysis input',
  clusterMetricCohort: 'analysis input', clusterCentroids: 'analysis result not drawn', clusterPatterns: 'analysis result not drawn',
  clusterPeakWidths: 'analysis result not drawn', clusterWindowPeaks: 'analysis result not drawn', clusterMatchedRun: 'analysis result not drawn',
  clusterTreeRootIds: 'cluster tree (the active node is read)', clusterMergeLog: 'Unmerge history', mergeMaxSimilarity: 'merge settings',
  mergeMinFraction: 'merge settings', mergeStrategy: 'merge settings', mergeThresholds: 'merge settings', dynamicOverlapMode: 'analysis input',
  cooccClusterSelections: 'Footprints panel', savedClusters: 'saved-clusters cart', readStateDetails: 'per-read analysis details',
  readFilterSources: 'what made the read filter (the filter itself is read)', transcriptionStateFilters: 'applied as the read filter',
  sortMode: 'applied as readSortOrder', sortSelection: 'applied as readSortOrder', filterMode: 'applied as the read filter',
  viewMode: 'legacy view mode', relativeGene: 'the gene behind relativeTSS (read)',
  minFootprintsAuto: 'whether Min footprints is untouched (minFootprints is read)', minFootprintsBeforeAllReads: 'what leaving All reads returns to',
  // Selections and UI state: not part of a figure.
  selectedClusters: 'selection', selectedFootprints: 'selection', selectedFeatures: 'selection',
  footprintCrossHighlight: 'hover highlight', clickTargetLayer: 'what a click selects', showReadTooltip: 'tooltip',
  readScrollOffsets: 'scroll position (figures show every row)', editMode: 'layout editing',
  commandHistory: 'Copilot history', sessionName: 'name', publicMode: 'server mode', showGenomeOverview: 'navigator strip',
  navigatorRegions: 'Regions panel', fillReadHeight: 'fit rows to the tab (figures size rows by row_height / read count)',
  darkMode: 'figures are drawn light', uiScale: 'figures at 100% (the browser engine has match_ui_size)',
  // Analysis panels and workspaces: figures do not draw them (both engines; see docs/jupyter-api.md, Figures).
  analysisStripCollapsed: 'analysis strip', hiddenStripPanels: 'analysis strip', showHiddenTrackStrip: 'track strip menu', coaccSettings: 'Co-accessibility panel', featureHub: 'feature hub',
  plotsWorkspace: 'Plots',
  differencesSession: 'Differences panel', savedNucGeometries: 'Nucleosomes panel', liveLiftExpansions: 'graph panel',
  fiberhmmLayerSettings: 'FiberHMM layers panel', captureRegions: 'Capture panel', capturePadding: 'Capture panel',
  primerSavedPrimers: 'primer cart', primerConfigBlastDb: 'primer designer', customMotifs: 'motif library',
  pinnedMotifs: 'motif views', motifPValue: 'motif views (lab panels)', motifScoreMode: 'motif views (lab panels)',
  motifThreshold: 'motif views (lab panels)', savedTracks: 'saved-tracks list (loaded tracks are catalog / composites)',
  // Server-side: applied by the server to every read request, the engine's too.
  hideShortEndFootprints: 'a server read setting', peakSettings: 'legacy (scan thresholds live on each peak rule, which is read)',
  referencePairs: 'server reference pairs',
};

const KNOWN_GAPS: Record<string, string> = {
  highlights: 'highlighted regions are drawn as bands in the browser; the headless engine does not draw them yet',
  enabledCigarTypes: 'mismatch / indel marks: drawn by the legacy numpy compositor (show_cigar), not the headless engine',
  svSplits: 'SV allele split groups: with the SV strip work on feat/headless-figure-revision',
  svCarrierEvidence: 'as svSplits', svConflictOptions: 'as svSplits', clusterGroupLabels: 'as svSplits (split group names)',
  splitPanelReads: 'split panels: membership names a rule cannot rebuild',
};

describe('headless figure parity: every saved field is decided on', () => {
  it('lists every session field the engine does not read, with a reason', () => {
    const engine = engineFrontendKeys();
    const saved = Object.keys(serializeState(useBrowserStore.getState()));
    const undecided = saved.filter(k => !engine.has(k) && !(k in NOT_DRAWN_IN_FIGURES) && !(k in KNOWN_GAPS)
      && !DERIVED.has(k) && !['chrom', 'start', 'end'].includes(k));
    expect(undecided).toEqual([]);
  });

  it('keeps the lists honest: nothing listed is read by the engine or gone from sessions', () => {
    const engine = engineFrontendKeys();
    const saved = new Set(Object.keys(serializeState(useBrowserStore.getState())));
    const listed = [...Object.keys(NOT_DRAWN_IN_FIGURES), ...Object.keys(KNOWN_GAPS)];
    expect(listed.filter(k => engine.has(k))).toEqual([]);
    expect(listed.filter(k => !saved.has(k))).toEqual([]);
  });
});
