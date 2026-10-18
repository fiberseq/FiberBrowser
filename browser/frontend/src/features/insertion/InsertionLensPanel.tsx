/**
 * The insertion lens: carrier reads of one insertion drawn in insertion-local
 * coordinates (left flank | insert | right flank), with per-group profiles,
 * the insert's consensus and its exports. Reads are drawn by the read track's
 * own renderer, so the inserted bases look exactly like reads in the main view.
 */
import { datasetPanelView } from '../../utils/panelScope';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRememberedState } from '../../hooks/useRememberedState';
import { usePreviewsEnabled } from '../../utils/previewFeatures';
import { PreviewBadge } from '../../components/ui/PreviewBadge';
import { ALT_ALLELE_PREVIEW } from '../altAllele/preview';
import { openAltAllelePanel } from '../altAllele/altAllelePanel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchJson } from '../../api/sharedFetch';
import { isAbortError, sharedRequest, sharedResult } from '../../api/sharedRequest';
import { useViewReadsReady } from '../../hooks/useViewReadsReady';
import { AnalysisButton, AnalysisPanelShell, AnalysisSelect, AnalysisToggleGroup } from '../../components/controls/shared';
import { drawReadTrack } from '../../components/tracks/read-track/ReadTrackCanvas';
import { computeReadRowGap } from '../../components/tracks/read-track/layout';
import { MOD_COLORS } from '../../components/tracks/read-track/constants';
import { getLayerColor } from '../../utils/layerColors';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { downloadTextFile, safeFilenamePart } from '../../utils/analysisExport';
import { copyText } from '../../utils/clipboard';
import { splitBySv } from '../../utils/svAlleleSplit';
import { formatShare } from '../../utils/denominators';
import type { CompactRead } from '../../components/tracks/read-track/types';
import {
  LENS_ANCHORS, axisTicks, computeLensProfile, consensusFasta, consensusMethod, describeAxisPosition, describeCarrier, insertionName,
  insertsFasta, layoutLens, lensParams, pickCluster, profilesTsv, targetForCluster,
  type InsertionCluster, type InsertionLensTarget, type LensAnchor, type LensAxis, type LensLayout,
  type LensProfile, type LensResponse, type LensRowMeta,
} from './insertionLensModel';
import { INSERTION_LENS_PANEL, isSeek, setInsertionLensState, useInsertionLensState } from './insertionLensTarget';
import { IdentifyTab, identifyLens, lensIdentifyKey } from './IdentifyTab';
import { useIdentifyStore } from './identifyStore';
import { forgetPanelMemory, restorePanelFields } from '../panelMemory';

type Tab = 'lens' | 'identify' | 'insertions';
type ClustersResponse = { success: boolean; error?: string; clusters: InsertionCluster[] };
/** Wait this long after the view last moved before listing its insertions. */
export const INSERTIONS_SETTLE_MS = 400;
const ROW_HEIGHT = 7;
const PROFILE_STRIP = 44;
const AXIS_HEIGHT = 34;
// Row pitch: the row plus the separator the read renderer adds at this height.
const ROW_PITCH = ROW_HEIGHT + computeReadRowGap(ROW_HEIGHT, 'auto', 3, 1);
const LABEL_WIDTH = 0;
const INSERT_TINT = 'rgba(168, 85, 247, 0.10)';
// Hard-clipped carriers: the insert is there, but its bases are not in the record.
const HARD_HATCH = 'rgba(168, 85, 247, 0.35)';
const INSERT_EDGE = '#a855f7';
const FLANKS = [
  { value: 500, label: '0.5 kb' }, { value: 1000, label: '1 kb' }, { value: 2000, label: '2 kb' }, { value: 5000, label: '5 kb' },
];

// ---------------------------------------------------------------------------
// Drawing helpers (also used for the PNG figure)

function drawInsertBand(ctx: CanvasRenderingContext2D, axis: LensAxis, width: number, height: number, hatch: boolean) {
  const x0 = ((axis.reversed ? axis.total - axis.flank - axis.displayLen : axis.flank) / axis.total) * width;
  const x1 = x0 + (axis.displayLen / axis.total) * width;
  if (hatch) {
    // No insert in these reads: an opaque hatched gap (it also hides the read body behind it).
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, height);
    ctx.clip();
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(x0, 0, x1 - x0, height);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0 - height; x < x1; x += 7) { ctx.moveTo(x, height); ctx.lineTo(x + height, 0); }
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.strokeStyle = INSERT_EDGE;
  ctx.globalAlpha = 0.8;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x0) + 0.5, 0); ctx.lineTo(Math.round(x0) + 0.5, height);
  ctx.moveTo(Math.round(x1) - 0.5, 0); ctx.lineTo(Math.round(x1) - 0.5, height);
  ctx.stroke();
  ctx.restore();
}

/** A light hatch over the insert on the rows of hard-clipped carriers (no bases to draw). */
function drawHardRows(ctx: CanvasRenderingContext2D, axis: LensAxis, width: number, rows: LensRowMeta[]) {
  const x0 = ((axis.reversed ? axis.total - axis.flank - axis.displayLen : axis.flank) / axis.total) * width;
  const x1 = x0 + (axis.displayLen / axis.total) * width;
  ctx.save();
  ctx.strokeStyle = HARD_HATCH;
  ctx.lineWidth = 1;
  rows.forEach((row, i) => {
    if (!row.hard && row.evidenceLevel !== 'putative' && row.evidenceLevel !== 'ambiguous') return;
    const top = i * ROW_PITCH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, top, x1 - x0, ROW_HEIGHT);
    ctx.clip();
    ctx.beginPath();
    for (let x = x0 - ROW_HEIGHT; x < x1; x += 5) { ctx.moveTo(x, top + ROW_HEIGHT); ctx.lineTo(x + ROW_HEIGHT, top); }
    ctx.stroke();
    ctx.restore();
  });
  ctx.restore();
}

/** The axis labels that fit without overlapping: majors (the breakpoints) first, then the others in order. */
export function placeAxisLabels(ticks: { x: number; label: string; major: boolean }[], width: number,
  measure: (text: string, major: boolean) => number, gap = 6): { x: number; label: string; major: boolean; align: CanvasTextAlign }[] {
  const out: { x: number; label: string; major: boolean; align: CanvasTextAlign; l: number; r: number }[] = [];
  for (const t of [...ticks.filter(t => t.major), ...ticks.filter(t => !t.major)]) {
    const w = measure(t.label, t.major);
    const align: CanvasTextAlign = t.x < 30 ? 'left' : t.x > width - 30 ? 'right' : 'center';
    const l = align === 'left' ? t.x : align === 'right' ? t.x - w : t.x - w / 2;
    const r = l + w;
    if (out.some(o => l < o.r + gap && r > o.l - gap)) continue;
    out.push({ ...t, align, l, r });
  }
  return out.map(({ l: _l, r: _r, ...rest }) => rest);
}

export function drawLensAxis(ctx: CanvasRenderingContext2D, axis: LensAxis, width: number, dark: boolean) {
  ctx.clearRect(0, 0, width, AXIS_HEIGHT);
  const ink = dark ? '#cbd5e1' : '#334155';
  const x0 = ((axis.reversed ? axis.total - axis.flank - axis.displayLen : axis.flank) / axis.total) * width;
  const x1 = x0 + (axis.displayLen / axis.total) * width;
  ctx.fillStyle = INSERT_TINT;
  ctx.fillRect(x0, 0, x1 - x0, AXIS_HEIGHT);
  ctx.fillStyle = INSERT_EDGE;
  ctx.fillRect(x0, AXIS_HEIGHT - 5, x1 - x0, 3);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.beginPath();
  ctx.moveTo(0, AXIS_HEIGHT - 3.5); ctx.lineTo(width, AXIS_HEIGHT - 3.5);
  ctx.stroke();
  const ticks = axisTicks(axis);
  for (const tick of ticks) {
    const x = Math.min(width - 1, Math.max(0, (tick.X / axis.total) * width));
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, AXIS_HEIGHT - (tick.major ? 9 : 6));
    ctx.lineTo(Math.round(x) + 0.5, AXIS_HEIGHT - 3);
    ctx.stroke();
  }
  // Labels that don't overlap (audit bug 7: "−1 kbleft bp" in a narrow drawer): the breakpoints first, then the rest
  // where they fit; a tick whose label would collide keeps its mark.
  const font = (major: boolean) => (major ? '600 10px ui-sans-serif, system-ui, sans-serif' : '10px ui-sans-serif, system-ui, sans-serif');
  const placed = placeAxisLabels(ticks.map(t => ({ ...t, x: Math.min(width - 1, Math.max(0, (t.X / axis.total) * width)) })), width,
    (text, major) => { ctx.font = font(major); return ctx.measureText(text).width; });
  for (const l of placed) {
    ctx.font = font(l.major);
    ctx.textAlign = l.align;
    ctx.fillText(l.label, l.x, 10);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = INSERT_EDGE;
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
  if (x1 - x0 > 120) ctx.fillText(`insert ${axis.displayLen.toLocaleString()} bp`, (x0 + x1) / 2, 23);
}

export function drawLensProfiles(
  ctx: CanvasRenderingContext2D, width: number, axis: LensAxis,
  groups: { label: string; profile: LensProfile }[], markColor: string, dark: boolean,
) {
  const height = groups.length * PROFILE_STRIP;
  ctx.clearRect(0, 0, width, height);
  const nucColor = getLayerColor('nuc');
  const mspColor = getLayerColor('msp');
  const ink = dark ? '#cbd5e1' : '#334155';
  groups.forEach((group, gi) => {
    const top = gi * PROFILE_STRIP;
    const h = PROFILE_STRIP - 12;
    const base = top + 10 + h;
    const { profile } = group;
    const bw = width / profile.bins;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.03)' : 'rgba(15,23,42,0.025)';
    ctx.fillRect(0, top + 10, width, h);
    // Nucleosome occupancy: filled bars; MSP and marks: lines.
    ctx.fillStyle = nucColor;
    ctx.globalAlpha = 0.55;
    profile.nuc.forEach((v, k) => { if (v !== null) ctx.fillRect(k * bw, base - v * h, Math.max(1, bw), v * h); });
    ctx.globalAlpha = 1;
    const line = (values: (number | null)[], color: string, scale: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let pen = false;
      values.forEach((v, k) => {
        if (v === null) { pen = false; return; }
        const x = (k + 0.5) * bw;
        const y = base - Math.min(1, v / scale) * h;
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      });
      ctx.stroke();
    };
    line(profile.msp, mspColor, 1);
    const maxMarks = Math.max(1e-6, ...profile.marks.map(v => v ?? 0));
    line(profile.marks, markColor, maxMarks);
    ctx.fillStyle = ink;
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(group.label, 2, top + 9);
    const labelRight = 2 + ctx.measureText(group.label).width + 8;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    const legend = [`nuc occupancy`, `MSP`, `marks/100 bp (max ${maxMarks.toFixed(1)})`];
    const colors = [nucColor, mspColor, markColor];
    let x = width - 2;
    // Right to left, as many as fit beside the group's name (never over it, in a narrow drawer).
    for (let i = legend.length - 1; i >= 0; i--) {
      const w = ctx.measureText(legend[i]).width;
      if (x - w < labelRight) break;
      ctx.fillStyle = colors[i];
      ctx.fillText(legend[i], x, top + 9);
      x -= w + 10;
    }
  });
  ctx.save();
  drawInsertBand(ctx, axis, width, height, false);
  ctx.restore();
}

/** One labelled field of the lens's summary ("Carriers 3,267 of 3,600 informative (91%)"). */
function LensField({ label, title, testId, children }: { label: string; title?: string; testId?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1" title={title}>
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="tabular-nums text-ink" data-testid={testId}>{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function InsertionLensPanel() {
  // "Open carriers with the insert expanded": a Preview feature (alt-allele panels).
  const previews = usePreviewsEnabled();
  const state = useInsertionLensState();
  const target = state && !isSeek(state) ? state : null;
  const { datasets, darkMode } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets, darkMode: s.darkMode,
  })));
  // Kept while the panel is remounted (the row re-laid out when the reference copies open beside it).
  const [tab, setTab] = useRememberedState<Tab>(`${INSERTION_LENS_PANEL}:tab`, () => 'lens');
  const showDuplicateReads = useBrowserStore(s => Boolean(s.showDuplicateReads));
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);
  const dupParam = { include_duplicates: String(showDuplicateReads) };
  const fetchKey = target ? lensParams(target, dupParam).toString() : '';
  const requestIdentity = JSON.stringify([fetchKey, refreshGeneration]);
  const [loadedResponse, setLoadedResponse] = useState<{ identity: string; data: LensResponse } | null>(null);
  // Guard during render too: effects run after the new target has rendered.
  const response = target && loadedResponse?.identity === requestIdentity ? loadedResponse.data : null;
  const currentResponse = useRef(loadedResponse);
  currentResponse.current = response ? loadedResponse : null;
  const exportController = useRef<AbortController | null>(null);
  const [includePutative, setIncludePutative] = useState(true);
  const [includeAmbiguous, setIncludeAmbiguous] = useState(false);
  useEffect(() => () => { exportController.current?.abort(); }, [requestIdentity]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clusters, setClusters] = useState<InsertionCluster[] | null>(null);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const bamDatasets = useMemo(() => datasets.filter(d => d.data_type === 'bam'), [datasets]);
  const [listDataset, setListDataset] = useState<string>('');
  const listDatasetId = listDataset || target?.datasetId || bamDatasets[0]?.id || '';
  const { chrom: viewChrom, start: viewStart, end: viewEnd, genome: viewGenome } = useBrowserStore(useShallow(s => datasetPanelView(s, listDatasetId)));
  // Identify: a dot on its tab when a result arrived while it was out of sight.
  const identifyKey = response && target ? lensIdentifyKey(response, target.datasetId, target.genome) : '';
  const identifyEntry = useIdentifyStore(s => (identifyKey ? s.entries[identifyKey] : undefined));
  const savedIdentify = useBrowserStore(s => s.panels.find(p => p.contentType === INSERTION_LENS_PANEL)?.insertionIdentify);
  const TABS = [
    { key: 'lens' as const, label: 'Lens' },
    { key: 'identify' as const, label: identifyEntry?.unseen ? 'Identify •' : identifyEntry?.status === 'running' ? 'Identify…' : 'Identify' },
    { key: 'insertions' as const, label: 'Insertions in view' },
  ];

  const say = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(n => (n === text ? null : n)), 2500);
  }, []);

  // Opened again (after it was closed, or the splits around it): the last insertion and its Identify result, while
  // its dataset is open (audit VAR-7 / bug 3). Clear starts over.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (state) return;
    const ok = restorePanelFields(INSERTION_LENS_PANEL);
    if (ok) setRestored(true);
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** "Clear": the lens empty, its Identify results off the panel, nothing kept for the next open (Close keeps them). */
  const clearLens = () => {
    forgetPanelMemory(INSERTION_LENS_PANEL);
    useBrowserStore.setState(s => ({
      panels: s.panels.map(p => (p.contentType === INSERTION_LENS_PANEL ? { ...p, insertionLens: undefined, insertionIdentify: undefined } : p)),
    }));
    setLoadedResponse(null);
    setLoading(false);
    setError(null);
    setNotice(null);
    setRestored(false);
    setTab('lens');
  };

  // A click position from the read menu: open the cluster nearest it.
  useEffect(() => {
    if (!state || !isSeek(state)) return;
    let cancelled = false;
    const controller = new AbortController();
    const params = new URLSearchParams({
      chrom: state.chrom, start: String(Math.max(0, Math.round(state.pos - 300))), end: String(Math.round(state.pos + 300)),
      ...(state.genome ? { panel_genome: state.genome } : {}), dataset_id: state.datasetId, min_len: '50',
    });
    setLoading(true);
    setError(null);
    fetchJson<{ success: boolean; error?: string; clusters: InsertionCluster[] }>(`/api/insertions/clusters?${params}`, { signal: controller.signal })
      .then(res => {
        if (cancelled) return;
        const best = res.success ? pickCluster(res.clusters, state.pos) : null;
        if (!best) {
          setLoading(false);
          setError(res.error || `No insertion of 50 bp or more within 300 bp of ${state.chrom}:${Math.round(state.pos).toLocaleString()}.`);
          return;
        }
        setTab('lens');
        setInsertionLensState(targetForCluster(best, state.datasetId, state.chrom, state));
      })
      .catch(err => { if (!cancelled) { setLoading(false); setError(String(err?.message ?? err)); } });
    return () => { cancelled = true; controller.abort(); };
  }, [state]);

  // The lens data. Anchor and reverse are view options: no refetch. Duplicates
  // follow the panels' setting, as "Split by this SV" does (same reads).
  useEffect(() => {
    setLoadedResponse(null);
    setNotice(null);
    setHover(null);
    if (!target) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchJson<LensResponse>(`/api/insertions/lens?${fetchKey}`, { signal: controller.signal })
      .then(res => {
        if (cancelled) return;
        setLoading(false);
        if (!res.success) { setError(res.error || 'Could not load the insertion'); return; }
        setLoadedResponse({ identity: requestIdentity, data: res });
      })
      .catch(err => { if (!cancelled) { setLoading(false); setError(String(err?.message ?? err)); } });
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestIdentity]);

  // Insertions in view: asked only while the list is shown, once the view has
  // settled (panning asks nothing), one request per view (shared, and kept for
  // going back); a view left while listing aborts its request (the server stops).
  // The server keeps the reads' SV events in tiles, so a panned view reads only its new part.
  const loadClusters = useCallback((signal?: AbortSignal, fresh = false) => {
    if (!listDatasetId) { setClusterError('Open a BAM or choose one in the Library: insertions live in the alignments.'); return; }
    const span = viewEnd - viewStart;
    const params = new URLSearchParams({
      chrom: viewChrom, start: String(Math.max(0, Math.round(viewStart))), end: String(Math.round(viewEnd)),
      ...(viewGenome ? { panel_genome: viewGenome } : {}), dataset_id: listDatasetId, min_len: span > 200_000 ? '500' : '50',
    });
    const show = (res: ClustersResponse) => {
      if (!res.success) { setClusterError(res.error || 'Could not list insertions'); return; }
      setClusters([...res.clusters].sort((a, b) => b.carriers - a.carriers || a.ref - b.ref));
    };
    setClusterError(null);
    // The data's revision too: a reload of the same dataset ID is a new question.
    const key = `insertion-clusters|${refreshGeneration}|${params}`;
    const known = fresh ? undefined : sharedResult<ClustersResponse>(key);
    if (known) { show(known); return; }
    setClusters(null);
    sharedRequest(key, s => fetchJson<ClustersResponse>(`/api/insertions/clusters?${params}`, { signal: s }), signal,
      { keep: res => Boolean(res?.success), ttlMs: fresh ? -1 : undefined })
      .then(res => { if (!signal?.aborted) show(res); })
      .catch(err => { if (!signal?.aborted && !isAbortError(err)) setClusterError(String(err?.message ?? err)); });
  }, [listDatasetId, viewGenome, viewChrom, viewStart, viewEnd, refreshGeneration]);

  const readsReady = useViewReadsReady();
  // Refresh asks again for this view (through the effect, so a view left meanwhile aborts it too).
  const [refreshNonce, setRefreshNonce] = useState(0);
  const lastNonce = useRef(0);
  useEffect(() => {
    if (tab !== 'insertions') return;
    setClusters(null); // never the list of another view
    setClusterError(null);
    if (!readsReady) return; // the view's reads first
    const fresh = refreshNonce !== lastNonce.current;
    lastNonce.current = refreshNonce;
    const controller = new AbortController();
    const timer = window.setTimeout(() => loadClusters(controller.signal, fresh), fresh ? 0 : INSERTIONS_SETTLE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [tab, loadClusters, readsReady, refreshNonce]);

  const anchor: LensAnchor = target?.anchor ?? 'consensus';
  const reversed = Boolean(target?.reversed);
  const update = (patch: Partial<InsertionLensTarget>) => { if (target) setInsertionLensState({ ...target, ...patch }); };

  const layout: LensLayout | null = useMemo(
    () => (response ? layoutLens({ ...response, carriers: response.carriers.filter(c => !c.evidence_level
      || c.evidence_level === 'confirmed' || (includePutative && c.evidence_level === 'putative') || (includeAmbiguous && c.evidence_level === 'ambiguous')) }, anchor, reversed) : null),
    [response, anchor, reversed, includePutative, includeAmbiguous],
  );
  const markColor = useMemo(() => {
    const first = response?.carriers[0]?.read;
    if (first?.methyl_m6a) return MOD_COLORS.m6a;
    if (first?.methyl_m5c) return MOD_COLORS.m5c;
    return MOD_COLORS.deam;
  }, [response]);
  const profiles = useMemo(() => {
    if (!layout) return [];
    const groups = [{ label: `Carriers (${layout.carriers.length}; ${layout.carrierRows.filter(r => !r.evidenceLevel || r.evidenceLevel === 'confirmed').length} confirmed, ${layout.carrierRows.filter(r => r.evidenceLevel === 'putative').length} putative, ${layout.carrierRows.filter(r => r.evidenceLevel === 'ambiguous').length} ambiguous)`, profile: computeLensProfile(layout.carriers, layout.axis.total) }];
    if (layout.reference.length) {
      groups.push({ label: `Reference (${layout.reference.length})`, profile: computeLensProfile(layout.reference, layout.axis.total) });
    }
    return groups;
  }, [layout]);

  // ---- canvases
  // The reads fill the panel's width and follow it (drawer, side dock, full view), also after the
  // Lens tab's body is mounted again (another tab and back).
  const [bodyRef, bodyWidth] = useElementWidth(240, 600);
  const width = bodyWidth - LABEL_WIDTH;
  const profileRef = useRef<HTMLCanvasElement>(null);
  const axisRef = useRef<HTMLCanvasElement>(null);
  const carrierRef = useRef<HTMLCanvasElement>(null);
  const referenceRef = useRef<HTMLCanvasElement>(null);
  const enabledModTypes = useBrowserStore(s => s.enabledModTypes);
  const activeColormap = useBrowserStore(s => s.activeColormap);
  const renderVersion = useCanvasRenderVersion();

  const drawReads = useCallback((canvas: HTMLCanvasElement, reads: CompactRead[], axis: LensAxis, hatch: boolean, key: string, rows?: LensRowMeta[]) => {
    const height = Math.max(ROW_PITCH, reads.length * ROW_PITCH);
    drawReadTrack({
      canvas, displayReads: reads, width, height, regionWidth: axis.total,
      chrom: response?.chrom ?? '', start: 0, end: axis.total, loading: false,
      datasetId: `insertion-lens:${key}`, stateKey: `insertion-lens:${key}`, sidebarWidth: 0,
      hasCluster: false, myClusterAssignments: {}, myClusterOrder: [], hasClusterFocus: false,
      myClusterFocus: null, mySelectedClusters: null,
      enabledModTypes, enabledCigarTypes: { mismatches: false, insertions: false, deletions: false },
      isBAM: true, fillReadHeight: false, storeReadRowHeight: ROW_HEIGHT, readScrollOffset: 0,
      readSeparatorMode: 'auto', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
      showCoverageHistogram: false, isReversed: false,
      activeColormap, genes: [], allPeaks: [], orthogonalTracks: [],
      modificationOverlays: [], overlayMarks: {}, jupyterReadHighlights: new Map(),
      jupyterFootprintColorMap: new Map(), allJupyterMarkers: [],
      selectedReadIds: undefined, selectedFootprints: [], footprintCrossHighlight: false,
      footprintGroups: [], selectedFamilyGroupId: null, footprintAnalysisLayer: null,
      clusterStateConsensus: new Map(), hasFilter: false, myFilteredReadIds: null,
      maxRegionForReads: Number.MAX_SAFE_INTEGER,
    } as unknown as Parameters<typeof drawReadTrack>[0]);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // drawReadTrack leaves the context scaled to CSS pixels.
      drawInsertBand(ctx, axis, width, height, hatch);
      if (rows?.some(r => r.hard)) drawHardRows(ctx, axis, width, rows);
    }
  }, [width, response, enabledModTypes, activeColormap]);

  useEffect(() => {
    if (!layout || tab !== 'lens') return;
    const { axis } = layout;
    if (profileRef.current) {
      const ctx = setupHighDpiCanvas(profileRef.current, width, profiles.length * PROFILE_STRIP);
      if (ctx) drawLensProfiles(ctx, width, axis, profiles, markColor, darkMode);
    }
    if (axisRef.current) {
      const ctx = setupHighDpiCanvas(axisRef.current, width, AXIS_HEIGHT);
      if (ctx) drawLensAxis(ctx, axis, width, darkMode);
    }
    if (carrierRef.current) drawReads(carrierRef.current, layout.carriers, axis, false, 'carriers', layout.carrierRows);
    if (referenceRef.current && layout.reference.length) drawReads(referenceRef.current, layout.reference, axis, true, 'reference');
  }, [layout, profiles, width, darkMode, markColor, drawReads, tab, renderVersion]);

  const onHover = (e: React.MouseEvent<HTMLCanvasElement>, rows: LensRowMeta[] | null) => {
    if (!layout || !response) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const X = ((e.clientX - rect.left) / rect.width) * layout.axis.total;
    let text = describeAxisPosition(X, layout.axis, response, layout.anchor);
    if (rows) {
      const row = rows[Math.floor((e.clientY - rect.top) / ROW_PITCH)];
      if (row) {
        text += ` · ${row.id} (${row.strand})`;
        if (row.carrier) text += ` · ${row.evidenceLevel ?? 'confirmed'} · ${describeCarrier(row)}`;
      }
    }
    setHover(text);
  };

  // ---- split the main view's reads by this insertion (the same reads as the lens's groups)
  const splitView = useMemo(() => {
    if (!response?.sv || !target) return null;
    const store = useBrowserStore.getState();
    const panel = store.panels.find(p => p.contentType === 'dataset' && p.datasetId === target.datasetId && !p.collapsed);
    const inView = viewChrom === response.chrom && viewStart <= response.sv.ref && response.sv.ref <= viewEnd;
    return { stateKey: panel ? (panel.stateKey ?? panel.datasetId ?? target.datasetId) : null, inView };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response, target, viewChrom, viewStart, viewEnd, datasets]);
  const splitReads = async () => {
    if (!response?.sv || !target || !splitView?.stateKey || !splitView.inView) return;
    try {
      const def = await splitBySv(
        { stateKey: splitView.stateKey, datasetId: target.datasetId, chrom: viewChrom, viewStart, viewEnd, includePutative, includeAmbiguous },
        { t: 'I', ref: response.sv.ref, len: response.sv.len },
      );
      say(`Grouped by ${def.label}: ${def.counts[0].toLocaleString()} carriers, ${def.counts[1].toLocaleString()} reference, ${def.counts[2].toLocaleString()} not informative (all reads in view)`);
    } catch (err) {
      say(`Could not split the reads: ${String((err as Error)?.message ?? err)}`);
    }
  };

  // ---- exports
  const fileStem = response ? safeFilenamePart(insertionName(response)) : 'insertion';
  const copyConsensus = async () => {
    if (!response?.consensus) return;
    const seq = consensusFasta(response, reversed).split('\n').slice(1).join('');
    say(await copyText(seq) ? 'Consensus copied: paste it into Dfam, RepeatMasker or BLAST' : 'Could not copy');
  };
  const downloadConsensus = () => {
    if (response?.consensus) downloadTextFile(consensusFasta(response, reversed), `${fileStem}_consensus.fa`, 'text/x-fasta');
  };
  const downloadInserts = async () => {
    if (!target || !response) return;
    const snapshot = loadedResponse;
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    try {
      const res = await fetchJson<LensResponse>(`/api/insertions/lens?${lensParams(target, { ...dupParam, include_sequences: 'true', consensus: 'false', max_reference: '0' })}`, { signal: controller.signal });
      if (controller.signal.aborted || currentResponse.current !== snapshot) return;
      if (!res.success) throw new Error(res.error || 'Could not fetch the inserts');
      downloadTextFile(insertsFasta(res.carriers.filter(c => !c.evidence_level || c.evidence_level === 'confirmed'
        || (includePutative && c.evidence_level === 'putative') || (includeAmbiguous && c.evidence_level === 'ambiguous')), response, reversed), `${fileStem}_inserts.fa`, 'text/x-fasta');
    } catch (err) {
      if (controller.signal.aborted || currentResponse.current !== snapshot) return;
      say(`Could not fetch the inserts: ${String((err as Error)?.message ?? err)}`);
    }
  };
  const downloadProfiles = () => {
    if (layout) downloadTextFile(profilesTsv(layout.axis, profiles), `${fileStem}_profiles.tsv`, 'text/tab-separated-values');
  };
  const savePng = () => {
    const parts = [profileRef.current, axisRef.current, carrierRef.current, layout?.reference.length ? referenceRef.current : null]
      .filter((c): c is HTMLCanvasElement => Boolean(c));
    if (!parts.length) return;
    const gap = 6;
    const w = Math.max(...parts.map(c => c.width));
    const h = parts.reduce((sum, c) => sum + c.height + gap, 0);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    let y = 0;
    for (const c of parts) { ctx.drawImage(c, 0, y); y += c.height + gap; }
    out.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileStem}_lens.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };

  // ---- render
  const strands = layout ? layout.carrierRows.reduce((acc, c) => { acc[c.strand] += 1; return acc; }, { '+': 0, '-': 0 }) : null;
  const lowIdentity = layout ? layout.carrierRows.filter(c => c.identity !== undefined && c.identity < 0.8).length : 0;

  const cl = response?.cluster;
  const clipped = cl?.clipped ?? 0;
  // The summary as labelled fields, each with its scope (audit VAR-12 / SV-3): the lens counts every read at the site,
  // the SV row only the loaded ones.
  const informative = cl ? cl.carriers + cl.reference : 0;
  const summary = response && cl && (
    <div className="text-[12px] leading-snug" data-testid="insertion-lens-summary">
      <div>
        <span className="font-semibold text-ink">{response.chrom}:{cl.ref.toLocaleString()}</span>
        {' · '}+{cl.len.toLocaleString()} bp
        {(cl.ref_len ?? 0) > 0 && <span> · replaces {cl.ref_len} reference bp with {cl.alt_len} query bp</span>}
        {cl.len_lo !== cl.len_hi && <span className="text-ink-secondary"> (lengths {cl.len_lo.toLocaleString()}–{cl.len_hi.toLocaleString()})</span>}
        <span className="text-ink-secondary" title="Every read at the site, not only the reads loaded for drawing (the SV row above the reads counts those)"> · all reads at the site</span>
      </div>
      <dl className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
        <LensField label="Confirmed" testId="insertion-lens-carriers-count"
          title="Sequence or query-collinear junction evidence; denominator includes confirmed and reference molecules">
          {formatShare(cl.carriers, informative, 'informative', { pct: true })}
        </LensField>
        <LensField label="Other evidence">{cl.putative ?? 0} putative · {cl.ambiguous ?? 0} ambiguous</LensField>
        {clipped > 0 && (
          <LensField label="Alignment evidence" testId="insertion-lens-clipped"
            title="Clips alone are putative or ambiguous; hard clips contain no inserted sequence">
            {(cl.cigar ?? cl.carriers - clipped).toLocaleString()} in the alignment, {clipped.toLocaleString()} clipped
            {(cl.hard ?? 0) > 0 && <>, {cl.hard!.toLocaleString()} hard-clipped (no inserted bases in the record)</>}
          </LensField>
        )}
        <LensField label="Reference" testId="insertion-lens-reference-count" title="Reads spanning the site without the insertion">{cl.reference.toLocaleString()}</LensField>
        {(response.excluded.other_insert > 0 || response.excluded.not_informative > 0) && (
          <LensField label="Not informative" title="Reads at the site that are neither carriers nor reference: another insertion there, or not spanning it">
            {(response.excluded.not_informative + response.excluded.other_insert).toLocaleString()}
            {response.excluded.other_insert > 0 && <> ({response.excluded.other_insert.toLocaleString()} another insertion)</>}
          </LensField>
        )}
        {strands && <LensField label="Strands (drawn)" title="Strands of the carriers drawn here">{strands['+']} + · {strands['-']} −</LensField>}
        {response.truncated.carriers > 0 && (
          <LensField label="Drawn" testId="insertion-lens-drawn" title="The lens draws a sample of the carriers; the counts above are of all of them">
            {formatShare(layout?.carriers.length ?? 0, cl.carriers + (includePutative ? cl.putative ?? 0 : 0) + (includeAmbiguous ? cl.ambiguous ?? 0 : 0), includePutative ? 'confirmed + putative' : 'confirmed')}
          </LensField>
        )}
      </dl>
      {lowIdentity > 0 && <div className="text-amber-600 dark:text-amber-400"> {lowIdentity} carrier{lowIdentity === 1 ? '' : 's'} under 80% identity to the consensus (another insert here?)</div>}
    </div>
  );

  return (
    <AnalysisPanelShell
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      theme="violet"
      className="flex flex-col h-full"
      tabBarClassName="px-2"
      bodyMode="fill"
    >
      {tab === 'lens' ? (
        <div className="px-3 py-2 flex flex-col gap-2 text-[12px]" data-testid="insertion-lens">
          {!state && (
            <div className="text-ink-muted">
              Open an insertion to see the chromatin inside it: right-click an insertion in the SV row and choose
              {' '}<span className="font-medium text-ink">Open this insertion in the lens</span> (on the reads at one:
              {' '}<span className="font-medium text-ink">Open insertion lens</span>), or pick one under
              {' '}<button type="button" className="underline" onClick={() => setTab('insertions')}>Insertions in view</button>.
            </div>
          )}
          {error && <div className="text-red-600 dark:text-red-400" role="alert">{error}</div>}
          {loading && <div className="text-ink-muted">Loading the insertion's reads…</div>}
          {target && (
            <div className="flex items-center gap-2 text-[11px] text-ink-secondary" data-testid="insertion-lens-restore">
              {restored && <span className="flex-1" data-testid="insertion-lens-restored">The last insertion again (the lens keeps it when closed).</span>}
              <AnalysisButton variant="quiet" className="ml-auto" onClick={clearLens} data-testid="insertion-lens-clear"
                title="Clear the lens: no insertion, no Identify result, nothing kept for the next open (closing the panel keeps them)">Clear</AnalysisButton>
            </div>
          )}
          {summary}
          {target && response && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <AnalysisToggleGroup
                label="Anchor"
                value={layout?.anchor ?? anchor}
                onChange={value => value && update({ anchor: value })}
                options={LENS_ANCHORS.map(a => ({
                  value: a.key, label: a.label, title: a.title,
                  disabled: a.key === 'consensus' && !response.consensus,
                }))}
                theme="violet"
              />
              <label className="flex items-center gap-1 cursor-pointer" title="Mirror the lens (right flank on the left) and reverse-complement the consensus">
                <input type="checkbox" checked={reversed} onChange={e => update({ reversed: e.target.checked })} />
                Reverse
              </label>
              <AnalysisSelect
                label="Flank"
                value={target.flank}
                onChange={value => update({ flank: Number(value) })}
                options={FLANKS}
              />
            </div>
          )}
          {target && response && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-ink-muted mr-1">
                Consensus{response.consensus ? ` ${response.consensus.length.toLocaleString()} bp` : ''}
                {response.consensus && (
                  <span title={consensusMethod(response).title} data-testid="insertion-lens-consensus-method"
                    className={response.consensus.fallback ? 'text-amber-600 dark:text-amber-400' : undefined}>
                    {' '}({consensusMethod(response).label})
                  </span>
                )}
              </span>
              <AnalysisButton
                variant="primary" theme="violet"
                onClick={() => { if (!identifyEntry || identifyEntry.status === 'error' || identifyEntry.status === 'cancelled') identifyLens(response, target.datasetId, { genome: target.genome }); setTab('identify'); }}
                disabled={!response.consensus}
                title={response.consensus ? 'What is this insertion? Its consensus against the genome and known TEs (searched on this computer), with a cartoon' : 'No consensus to identify'}
                data-testid="insertion-lens-identify"
              >{identifyEntry?.status === 'running' ? `Identifying… ${Math.round((identifyEntry.progress || 0) * 100)}%` : identifyEntry?.status === 'done' ? 'Identified ›' : 'Identify insertion'}</AnalysisButton>
              <AnalysisButton onClick={copyConsensus} disabled={!response.consensus} title="Copy the consensus sequence (for Dfam, RepeatMasker or BLAST)">Copy</AnalysisButton>
              <AnalysisButton onClick={downloadConsensus} disabled={!response.consensus}>Consensus FASTA</AnalysisButton>
              <AnalysisButton onClick={downloadInserts} title="Every carrier's inserted bases">All inserts FASTA</AnalysisButton>
              <span className="mx-1 h-4 w-px bg-slate-300 dark:bg-slate-600" />
              <AnalysisButton onClick={savePng}>Save PNG</AnalysisButton>
              <AnalysisButton onClick={downloadProfiles}>Profiles TSV</AnalysisButton>
              <label><input type="checkbox" checked={includePutative} onChange={e => setIncludePutative(e.target.checked)} /> Include putative (hatched; uncheck for confirmed only)</label>
              <label><input type="checkbox" checked={includeAmbiguous} onChange={e => setIncludeAmbiguous(e.target.checked)} /> Include ambiguous</label>
              <span className="mx-1 h-4 w-px bg-slate-300 dark:bg-slate-600" />
              <AnalysisButton
                onClick={splitReads}
                disabled={!splitView?.stateKey || !splitView.inView}
                title={!splitView?.stateKey ? 'Open the dataset\'s panel first'
                  : !splitView.inView ? 'Bring the insertion into view first'
                  : 'Colour the reads in view in the dataset\'s panel: carriers (the lens\'s carriers, clipped ones included), reference, not informative'}
                data-testid="insertion-lens-split"
              >Group in this panel by this insertion</AnalysisButton>
              {previews && <AnalysisButton
                onClick={() => {
                  const sv = response.sv;
                  setNotice('Building the alternate allele (the first time takes a while for thousands of carriers)…');
                  void openAltAllelePanel({ datasetId: target.datasetId, chrom: response.chrom ?? target.chrom, ref: sv?.ref ?? target.ref ?? undefined, len: sv?.len ?? target.len ?? undefined, pos: target.pos })
                    .then(id => setNotice(id ? 'Opened a panel of the carriers with the insert expanded' : ''));
                }}
                title="A panel of this insertion's carriers on its alternate allele (reference flank + insert consensus + reference flank): every carrier is an ordinary read there, so the reads inside the insert can be clustered, sorted, filtered and analysed like any region"
                data-testid="insertion-lens-open-alt-allele"
              >Open carriers with the insert expanded <PreviewBadge feature={ALT_ALLELE_PREVIEW} className="ml-1" /></AnalysisButton>}
              {notice && <span className="text-ink-muted ml-1">{notice}</span>}
            </div>
          )}
          <div ref={bodyRef} className="w-full">
            {layout && (
              <>
                <canvas ref={profileRef} style={{ width, height: profiles.length * PROFILE_STRIP }}
                  onMouseMove={e => onHover(e, null)} onMouseLeave={() => setHover(null)} data-testid="insertion-lens-profiles" />
                <canvas ref={axisRef} style={{ width, height: AXIS_HEIGHT }} className="mt-1" />
                <div className="mt-1 text-[11px] font-semibold text-ink">
                  Carriers{clipped > 0 && <span className="font-normal text-ink-muted"> · whole inserts first, then clipped reads (part of the insert{(cl?.hard ?? 0) > 0 ? '; hatched: hard-clipped, bases not in the record' : ''})</span>}
                </div>
                <canvas ref={carrierRef} style={{ width, height: Math.max(ROW_PITCH, layout.carriers.length * ROW_PITCH) }}
                  onMouseMove={e => onHover(e, layout.carrierRows)} onMouseLeave={() => setHover(null)} data-testid="insertion-lens-carriers" />
                {layout.reference.length > 0 && (
                  <>
                    <div className="mt-1 text-[11px] font-semibold text-ink">Reference reads (no insert)</div>
                    <canvas ref={referenceRef} style={{ width, height: layout.reference.length * ROW_PITCH }}
                      onMouseMove={e => onHover(e, layout.referenceRows)} onMouseLeave={() => setHover(null)} data-testid="insertion-lens-reference" />
                  </>
                )}
                <div className="h-4 text-[11px] text-ink-muted tabular-nums" data-testid="insertion-lens-readout">{hover ?? ''}</div>
              </>
            )}
          </div>
        </div>
      ) : tab === 'identify' ? (
        <div className="px-3 py-2 flex flex-col gap-2 text-[12px]">
          {summary}
          {!response || !target ? (
            <div className="text-ink-muted">{loading ? 'Loading the insertion…' : 'Open an insertion first, then identify its consensus here.'}</div>
          ) : (
            <IdentifyTab
              response={response} datasetId={target.datasetId} genome={target.genome} reversed={reversed} visible={tab === 'identify'}
              dark={darkMode} saved={savedIdentify}
              carrierProfile={layout && profiles[0] ? { axis: layout.axis, profile: profiles[0].profile, n: layout.carriers.length } : null}
            />
          )}
        </div>
      ) : (
        <div className="px-3 py-2 flex flex-col gap-2 text-[12px]" data-testid="insertion-lens-list">
          <div className="flex items-center gap-2">
            {bamDatasets.length > 1 && (
              <AnalysisSelect
                label="Dataset"
                value={listDatasetId}
                onChange={value => setListDataset(String(value))}
                options={bamDatasets.map(d => ({ value: d.id, label: d.label ?? d.id }))}
              />
            )}
            <span className="text-ink-muted flex-1">{viewChrom}:{Math.round(viewStart).toLocaleString()}–{Math.round(viewEnd).toLocaleString()}</span>
            <AnalysisButton onClick={() => setRefreshNonce(n => n + 1)}>Refresh</AnalysisButton>
          </div>
          {clusterError && <div className="text-red-600 dark:text-red-400">{clusterError}</div>}
          {!clusters && !clusterError && <div className="text-ink-muted">Looking for insertions in view…</div>}
          {clusters && clusters.length === 0 && <div className="text-ink-muted">No insertions in view.</div>}
          {clusters && clusters.length > 0 && (
            <table className="w-full text-left tabular-nums">
              <thead className="text-ink-muted">
                <tr><th className="font-medium">Position</th><th className="font-medium">Length</th><th className="font-medium" title="Default carriers include confirmed and putative; ambiguous evidence is separate">Carriers</th><th /></tr>
              </thead>
              <tbody>
                {clusters.map(c => (
                  <tr key={`${c.ref}-${c.len}`} className="border-t border-slate-200 dark:border-slate-700">
                    <td>{viewChrom}:{c.ref.toLocaleString()}</td>
                    <td>{c.len.toLocaleString()} bp</td>
                    <td>
                      {(c.confirmed ?? c.carriers).toLocaleString()} confirmed · {c.putative ?? 0} putative · {c.ambiguous ?? 0} ambiguous
                      {(c.clip_support ?? 0) > 0 && <span className="text-ink-muted"> ({c.clip_support!.toLocaleString()} clipped)</span>}
                    </td>
                    <td className="text-right py-0.5">
                      <AnalysisButton
                        variant="soft" theme="violet"
                        onClick={() => { setInsertionLensState(targetForCluster(c, listDatasetId, viewChrom, { ...target, genome: viewGenome })); setTab('lens'); }}
                      >Open</AnalysisButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </AnalysisPanelShell>
  );
}

export default InsertionLensPanel;
