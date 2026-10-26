/**
 * Linked source views (DESIGN_LIVE_LIFT.md §5.1, P3): "Open source view" on a live-lift panel opens the same BAM on
 * its own source haplotype (its BAM-header contigs as the panel's reference when no HG002 FASTA is loaded), stacked
 * under the lifted panel. The two move together through the lift map (`liftViewLink`, a ViewLink): synchronously from
 * the outline or loaded exact tiles, then one exact correction of the source panel when the tiles arrive.
 *
 * Loops: a main-view move maps to the source panel by writing its view (no move back); the source panel's own move maps
 * to the main view inside `withLinkedPanelMoving` (the main view's move skips it); a correction writes only the source
 * panel (`setPanelViewportFromLink`) and is dropped when the panel's navigation generation, its link or the main
 * chromosome changed since it was scheduled.
 */
import { create } from 'zustand';
import { addDataset } from '../../../api/datasets';
import { attachPanelGenome } from '../../../api/panelGenomes';
import { useBrowserStore } from '../../../stores/browserStore';
import { lastSnapshotId, serializeState } from '../../../stores/historySlice';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { createDefaultSubTracks, generatePanelId } from '../../../stores/utils';
import { registerPanelLink, registerViewLink, withLinkedPanelMoving, type Span } from '../../../utils/panelExtensions';
import type { Dataset, PanelConfig } from '../../../types';
import { useLiveLiftStore } from '../store';
import { ensureSummary, mapSpan, onNavigationData, prefetchView, sourceContigsFor, type MapCandidate, type SpanMapping } from './navigation';
import type { LiftLinkConfig } from './types';
import { sourceHapLabel } from '../sampleLabel';
import './types';

export const LIFT_RIBBON_TRACK = 'lift-ribbon';

// ── Candidates (disjoint / mixed-orientation correspondences) ───────────────

export const useLiftLinkCandidates = create<{ byPanel: Record<string, { chosen: number; minus: boolean; candidates: MapCandidate[] }> }>(() => ({ byPanel: {} }));

function publishCandidates(panelId: string, mapping: SpanMapping) {
  const prev = useLiftLinkCandidates.getState().byPanel[panelId];
  const next = { chosen: mapping.chain, minus: mapping.minus, candidates: mapping.candidates };
  if (prev && prev.chosen === next.chosen && prev.minus === next.minus && prev.candidates.length === next.candidates.length
    && prev.candidates.every((c, i) => c.chain === next.candidates[i].chain)) return;
  // Published after the store update that mapped it (never inside a store set).
  queueMicrotask(() => useLiftLinkCandidates.setState(s => ({ byPanel: { ...s.byPanel, [panelId]: next } })));
}

// ── Generations and corrections ─────────────────────────────────────────────

const generation = new Map<string, number>();
interface Correction {
  gen: number; linkId: string; chrom: string; datasetId: string; kind: 'panel' | 'main';
  /** Undo history when it was scheduled: the one step the move that scheduled it records (an id above `after`,
   * not a baseline) absorbs the correction while it is still the current, latest step. */
  history: { after: number };
}
const pending = new Map<string, Correction>();

function bump(panelId: string): number {
  const g = (generation.get(panelId) ?? 0) + 1;
  generation.set(panelId, g);
  return g;
}

/** The navigation generation of a linked panel (tests and the e2e read it). */
export function linkGeneration(panelId: string): number { return generation.get(panelId) ?? 0; }
export function pendingCorrection(panelId: string): Correction | undefined { return pending.get(panelId); }

function liftKey(datasetId: string): string | null {
  const d = useBrowserStore.getState().datasets.find(x => x.id === datasetId);
  return d?.data_type === 'bam_livelift' && d.live_lift ? d.live_lift.key : null;
}

function contigSize(panel: PanelConfig, contig: string): number {
  const genome = usePanelGenomeStore.getState().genomes[panel.genome ?? ''];
  return genome?.chroms.find(c => c.name === contig)?.size ?? Infinity;
}

function clampSpan(panel: PanelConfig, m: SpanMapping): Span {
  const size = contigSize(panel, m.chrom);
  let { start, end } = m;
  if (end > size) { start = Math.max(0, start - (end - size)); end = size; }
  return { chrom: m.chrom, start: Math.max(0, start), end: Math.max(Math.max(0, start) + 1, end) };
}

/** The panel whose view is the lifted side of a link: its lifted panel, or the graph host that panel is folded into.
 * (A source-view pop-out of a graph host's haplotype stays linked to that haplotype's panel, which is hidden in the
 * host's graph: the host's view is the one the user moves, and it carries its folded members along.) */
function liftedViewPanel(l: Pick<LiftLinkConfig, 'liftPanelId'>, panels: PanelConfig[]): PanelConfig | undefined {
  const lifted = panels.find(p => p.id === l.liftPanelId);
  const host = lifted?.collapsedByGraphGroup ? panels.find(p => p.id === lifted.collapsedByGraphGroup) : undefined;
  return host ?? lifted;
}

/** The view a lifted panel shows when it is not the main view ("Each panel navigates", or a graph host with a locus of
 * its own): its own view, or its host's. Null: it follows the main view. */
export function liftedOwnView(liftPanelId: string, panels: PanelConfig[]): Span | null {
  const v = liftedViewPanel({ liftPanelId }, panels)?.viewportOverride;
  return v ? { chrom: v.chrom, start: v.start, end: v.end } : null;
}

/** Whether the link is live: the flag is on, its lifted dataset is open and its lifted panel follows the main view. */
function linkActive(l: LiftLinkConfig): string | null {
  if (!useLiveLiftStore.getState().enabled) return null;
  const key = liftKey(l.datasetId);
  if (!key) return null;
  const liftPanel = liftedViewPanel(l, useBrowserStore.getState().panels);
  // A lifted panel with a view of its own ("Each panel navigates") is not the main view this panel follows.
  if (liftPanel?.viewportOverride) return null;
  return key;
}

/** The source view for a main view (the pure mapping, no side effects but tile requests). */
export function sourceViewFor(panel: PanelConfig, main: Span): { span: Span; mapping: SpanMapping } | 'pending' | null {
  const l = panel.liftLink;
  if (!l) return null;
  const key = liftKey(l.datasetId);
  if (!key) return null;
  const out = mapSpan(l.datasetId, key, 'toSource', main, { hap: l.hap, preferChain: l.chain ?? null });
  if (out.status === 'pending') return 'pending';
  if (out.status === 'none') return null;
  return { span: clampSpan(panel, out.mapping), mapping: out.mapping };
}

function schedule(panel: PanelConfig, gen: number, chrom: string, kind: Correction['kind']) {
  const prior = pending.get(panel.id);
  // A move rescheduled by its own approximate correction keeps the original move's history mark.
  const history = prior && prior.gen === gen ? prior.history
    : { after: lastSnapshotId() };
  pending.set(panel.id, { gen, linkId: panel.liftLink!.id, chrom, datasetId: panel.liftLink!.datasetId, kind, history });
}

/** "Each panel navigates": a source panel and its lifted panel both keep views of their own, so the link moves one
 * panel with the other directly (through the loaded map; a move whose tiles are not loaded yet leaves the other
 * panel where it is, there being no main view to correct later). */
export const liftPanelLink = {
  followers: (panel: PanelConfig, next: Span, panels: PanelConfig[]): { panelId: string; span: Span }[] => {
    if (!useLiveLiftStore.getState().enabled) return [];
    const l = panel.liftLink;
    if (l) {
      const lifted = liftedViewPanel(l, panels);
      const key = liftKey(l.datasetId);
      if (!lifted?.viewportOverride || !key) return [];
      const out = mapSpan(l.datasetId, key, 'toTarget', next, { preferChain: l.chain ?? null });
      return out.status === 'mapped' ? [{ panelId: lifted.id, span: clampSpan(lifted, out.mapping) }] : [];
    }
    if (!panel.viewportOverride) return [];
    const out: { panelId: string; span: Span }[] = [];
    for (const source of panels) {
      if (!source.liftLink || liftedViewPanel(source.liftLink, panels)?.id !== panel.id || !source.viewportOverride) continue;
      const view = sourceViewFor(source, next);
      if (view && view !== 'pending') { publishCandidates(source.id, view.mapping); out.push({ panelId: source.id, span: view.span }); }
    }
    return out;
  },
};

export const liftViewLink = {
  toPanel: (panel: PanelConfig, main: Span): Span | null | undefined => {
    const l = panel.liftLink;
    if (!l || !linkActive(l)) return undefined;
    const gen = bump(panel.id);
    const out = sourceViewFor(panel, main);
    if (out === 'pending') { schedule(panel, gen, main.chrom, 'panel'); return null; }
    if (!out) { pending.delete(panel.id); return null; }
    publishCandidates(panel.id, out.mapping);
    if (out.mapping.exact) pending.delete(panel.id); else schedule(panel, gen, main.chrom, 'panel');
    return out.span;
  },
  toMain: (panel: PanelConfig, next: Span): Span | null | undefined => {
    const l = panel.liftLink;
    const key = l ? linkActive(l) : null;
    if (!l || !key) return undefined;
    const gen = bump(panel.id);
    const out = mapSpan(l.datasetId, key, 'toTarget', next, { preferChain: l.chain ?? null });
    // Nothing loaded yet: the main view follows once it is (the source panel keeps the user's move).
    if (out.status === 'pending') { schedule(panel, gen, next.chrom, 'main'); return null; }
    if (out.status === 'none') { pending.delete(panel.id); return null; }
    // Approximate: the main view goes there now. This panel's span is the user's: the exact tile then moves the
    // main view to match it (never this panel to match the approximate main view).
    if (out.mapping.exact) pending.delete(panel.id); else schedule(panel, gen, next.chrom, 'main');
    return { chrom: out.mapping.chrom, start: out.mapping.start, end: out.mapping.end };
  },
};

function updateLink(panelId: string, patch: Partial<LiftLinkConfig>) {
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === panelId && p.liftLink ? { ...p, liftLink: { ...p.liftLink, ...patch } } : p) }));
}

/** A main-view correction belongs to the move that scheduled it: when that move's undo step is still the latest
 * (nothing else was recorded or undone since), the corrected view replaces the step's state, so Undo/Redo keep the
 * panel and the main view together. */
function foldCorrection(c: Correction): void {
  const st = useBrowserStore.getState();
  const stack = st._historyStack ?? [];
  const current = stack[st._historyPointer];
  // Exactly one step recorded since the move scheduled this (its own), still current and latest, and not a
  // "Before navigation" baseline: anything else (an undo, another step, only a baseline) leaves history alone.
  const since = stack.filter(s => (s.id ?? 0) > c.history.after && !s.baseline);
  if (!current || st._historyPointer !== stack.length - 1 || since.length !== 1 || since[0] !== current) return;
  st.foldIntoCurrentSnapshot?.(serializeState(st));
}

/** Apply what the navigation data that just arrived lets a linked panel correct (at most once per scheduled move). */
export function applyCorrections(datasetId?: string): void {
  for (const [panelId, c] of [...pending]) {
    if (datasetId && c.datasetId !== datasetId) continue;
    const st = useBrowserStore.getState();
    const panel = st.panels.find(p => p.id === panelId);
    if (!panel?.liftLink || panel.liftLink.id !== c.linkId || generation.get(panelId) !== c.gen) { pending.delete(panelId); continue; }
    const key = linkActive(panel.liftLink);
    if (!key || !panel.viewportOverride) { pending.delete(panelId); continue; }
    if (c.kind === 'panel') {
      if (st.chrom !== c.chrom) { pending.delete(panelId); continue; }
      const out = sourceViewFor(panel, { chrom: st.chrom, start: st.start, end: st.end });
      if (out === 'pending') continue;
      if (!out) { pending.delete(panelId); continue; }
      if (out.mapping.exact) pending.delete(panelId);
      publishCandidates(panelId, out.mapping);
      st.setPanelViewportFromLink(panelId, out.span);
    } else {
      const v = panel.viewportOverride;
      if (v.chrom !== c.chrom) { pending.delete(panelId); continue; }
      const out = mapSpan(panel.liftLink.datasetId, key, 'toTarget', v, { preferChain: panel.liftLink.chain ?? null });
      if (out.status === 'pending') continue;
      pending.delete(panelId);
      if (out.status === 'none') continue;
      const m = out.mapping;
      if (m.chrom === st.chrom && m.start === st.start && m.end === st.end) { if (!m.exact) schedule(panel, generation.get(panelId)!, v.chrom, 'main'); continue; }
      withLinkedPanelMoving(panelId, () => st.setViewport(m.chrom, m.start, m.end));
      foldCorrection(c);
      if (!m.exact) schedule(panel, generation.get(panelId)!, v.chrom, 'main');
    }
  }
}

// ── Opening, jumping, orientation ───────────────────────────────────────────

function hapKeyFor(dataset: Dataset, label: string | null | undefined): string | null {
  const info = dataset.live_lift;
  if (!info) return null;
  if (!label) return info.haplotypes[0] ?? null;
  return info.haplotypes.find(h => h === label || (info.haplotype_labels?.[h] ?? h) === label) ?? null;
}

function samePaths(a: Dataset, b: Dataset): boolean {
  const pa = a.paths?.length ? a.paths : [a.path];
  const pb = b.paths?.length ? b.paths : [b.path];
  return pa.length === pb.length && pa.every((p, i) => p === pb[i]);
}

/** The linked source panels of a lifted dataset (optionally of one haplotype). */
export function linkedSourcePanels(datasetId: string, hap?: string | null): PanelConfig[] {
  return useBrowserStore.getState().panels.filter(p => p.liftLink?.datasetId === datasetId && (!hap || p.liftLink.hap === hap || p.liftLink.hapLabel === hap));
}

/**
 * "Open source view" for a lifted panel: the source BAM on haplotype `hapLabel` (the panel's own when split), mapped
 * from the main view, stacked under the lifted panel and linked to it. An already linked panel for that haplotype is
 * kept (and returned).
 */
export async function openLinkedSourceView(liftPanelId: string, hapLabel?: string | null,
  /** A graph pop-out (graph features): the view to map (the host's own view) and the panel to stack it beside (the
   * host, when the lifted panel is folded into its graph). */
  opts: { view?: { chrom: string; start: number; end: number }; besidePanelId?: string } = {}): Promise<string | null> {
  const st = useBrowserStore.getState();
  const liftPanel = st.panels.find(p => p.id === liftPanelId);
  const dataset = st.datasets.find(d => d.id === liftPanel?.datasetId);
  if (!liftPanel || !dataset?.live_lift) return null;
  const hap = hapKeyFor(dataset, hapLabel ?? liftPanel.liftHap);
  if (!hap) return null;
  const label = dataset.live_lift.haplotype_labels?.[hap] ?? hap;
  const key = dataset.live_lift.key;
  // A lifted panel (or graph host) with a view of its own: the source view maps that view, never the main view.
  const own = opts.view ? { ...opts.view } : liftedOwnView(liftPanelId, st.panels);
  const existing = linkedSourcePanels(dataset.id, hap)[0];
  if (existing) {
    if (existing.liftLink!.liftPanelId !== liftPanelId) updateLink(existing.id, { liftPanelId });
    // Reopened or relinked beside a view of its own: shown at that view now, not where it was left.
    if (own && await ensureSummary(dataset.id, key)) {
      await prefetchView(dataset.id, key, 0, own.chrom, own.start, own.end);
      const now = useBrowserStore.getState().panels.find(p => p.id === existing.id);
      const out = now ? sourceViewFor(now, own) : null;
      if (out && out !== 'pending') {
        bump(existing.id);
        pending.delete(existing.id);
        publishCandidates(existing.id, out.mapping);
        useBrowserStore.getState().setPanelViewportFromLink(existing.id, out.span);
      }
    }
    return existing.id;
  }
  try {
    const summary = await ensureSummary(dataset.id, key);
    if (!summary) throw new Error('the lift map summary is unavailable');
    const main = own ?? { chrom: st.chrom, start: st.start, end: st.end };
    await prefetchView(dataset.id, key, 0, main.chrom, main.start, main.end);
    const out = mapSpan(dataset.id, key, 'toSource', main, { hap });
    const contigs = sourceContigsFor(summary, main.chrom, hap);
    if (out.status !== 'mapped' || !contigs.length) throw new Error(`no ${label} correspondence for ${main.chrom} here`);
    const mapping = out.mapping;
    let native = st.datasets.find(n => n.data_type === 'bam' && samePaths(n, dataset));
    if (!native) {
      const result = await addDataset(dataset.paths?.length ? dataset.paths : dataset.path, `${dataset.label} · ${label} source`);
      if (!result.success || !result.dataset || result.dataset.data_type !== 'bam') throw new Error(result.error ?? 'cannot open the source BAM as a native dataset');
      native = result.dataset;
    }
    const references = usePanelGenomeStore.getState();
    const assigned = references.genomes[references.assignments[native.id]];
    const attached = assigned?.chroms.some(c => c.name === mapping.chrom) ? { success: true, genome: assigned }
      : await attachPanelGenome({ dataset_ids: [native.id], contigs: true, span: 0 });
    if (!attached.success || !attached.genome) throw new Error((attached as { error?: string }).error ?? 'cannot attach the BAM-header reference');
    await usePanelGenomeStore.getState().refresh();
    await prefetchView(dataset.id, key, 1, mapping.chrom, mapping.start, mapping.end);
    const id = generatePanelId();
    const source = native;
    const genomeKey = attached.genome.key;
    const link: LiftLinkConfig = { id: `lift-link-${id}`, datasetId: dataset.id, liftPanelId, hap, hapLabel: label,
      contig: mapping.chrom, flip: mapping.minus, chain: null };
    useBrowserStore.setState(state => {
      const beside = opts.besidePanelId && state.panels.some(p => p.id === opts.besidePanelId) ? opts.besidePanelId : liftPanelId;
      const at = state.panels.findIndex(p => p.id === beside);
      if (at < 0) return state;
      const lp = state.panels[at];
      const row = lp.layoutRow ?? 0;
      const column = lp.layoutColumn ?? Math.max(-1, ...state.panels.filter(p => (p.layoutRow ?? 0) === row && p.layoutColumn != null).map(p => p.layoutColumn!)) + 1;
      const panel: PanelConfig = {
        id, contentType: 'dataset', datasetId: source.id, stateKey: `${id}~lift-source`,
        subTracks: [{ type: LIFT_RIBBON_TRACK, visible: true }, ...createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks)],
        collapsed: false, linkGroup: null, layoutRow: row, layoutColumn: column, genome: genomeKey, siteLocked: false,
        title: `${sourceHapLabel(dataset, label)} source`, titleDetail: `Linked to the live-lift ${label} panel through the map`,
        viewportOverride: { chrom: mapping.chrom, start: mapping.start, end: mapping.end }, liftLink: link,
      } as PanelConfig;
      const panels = [...state.panels];
      panels[at] = lp.layoutColumn === column ? lp : { ...lp, layoutColumn: column };
      panels.splice(at + 1, 0, panel);
      return {
        datasets: state.datasets.some(n => n.id === source.id) ? state.datasets : [...state.datasets, source],
        slotOrder: state.slotOrder.includes(source.id) ? state.slotOrder : [...state.slotOrder, source.id],
        panels,
      };
    });
    // The main view may have moved while the source BAM and its reference opened: the panel then follows the view
    // there now (it was installed at the view it was opened from).
    const now = useBrowserStore.getState();
    const moved = now.chrom !== main.chrom || now.start !== main.start || now.end !== main.end;
    const installed = now.panels.find(p => p.id === id);
    // (Opened at a view of its own, a host's or a lifted panel's: the main view's corrections are not for it.)
    if (installed && !own && (moved || !mapping.exact)) {
      schedule(installed, bump(id), now.chrom, 'panel');
      queueMicrotask(() => applyCorrections(dataset.id));
    }
    publishCandidates(id, mapping);
    useBrowserStore.getState().pushSnapshot(`Open ${label} source view`, { kind: 'layout' });
    return id;
  } catch (e) {
    useBrowserStore.getState().setError(`Source view: ${(e as Error).message}`);
    return null;
  }
}

/** The source panel shows the other orientation (the user's override of the entry orientation). */
export function toggleLinkFlip(panelId: string): void {
  const panel = useBrowserStore.getState().panels.find(p => p.id === panelId);
  if (!panel?.liftLink) return;
  updateLink(panelId, { flip: !panel.liftLink.flip });
}

/** Follow another correspondence of the view (a disjoint or mixed-orientation map), or the dominant one (null). */
export function chooseLinkChain(panelId: string, chain: number | null): void {
  const st = useBrowserStore.getState();
  const panel = st.panels.find(p => p.id === panelId);
  if (!panel?.liftLink) return;
  const link = { ...panel.liftLink, chain };
  const next = { ...panel, liftLink: link };
  // The lifted panel's own view when it has one ("Each panel navigates", a graph host's locus), else the main view.
  const own = liftedOwnView(panel.liftLink.liftPanelId, st.panels);
  const out = sourceViewFor(next, own ?? { chrom: st.chrom, start: st.start, end: st.end });
  const minus = out && out !== 'pending' ? out.mapping.minus : panel.liftLink.flip;
  const gen = bump(panelId);
  // Not loaded yet, or only approximately: the arriving tables correct it, as after a main-view move (the main view's
  // corrections are not for a panel paired with a view of its own).
  if (!own && (out === 'pending' || (out && !out.mapping.exact))) schedule(next, gen, st.chrom, 'panel');
  else pending.delete(panelId);
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === panelId ? {
    ...p, liftLink: { ...link, flip: minus },
    ...(out && out !== 'pending' ? { viewportOverride: out.span } : {}),
  } : p) }));
  if (out && out !== 'pending') publishCandidates(panelId, out.mapping);
}

/** Show a source span (an insertion's inserted bases) in the linked source panel, without moving the main view. */
export function jumpLinkedSource(panelId: string, src: { contig: string; start: number; end: number }): boolean {
  const st = useBrowserStore.getState();
  const panel = st.panels.find(p => p.id === panelId);
  const v = panel?.viewportOverride;
  if (!panel?.liftLink || !v) return false;
  const len = Math.max(1, src.end - src.start);
  const width = Math.max(v.end - v.start, Math.ceil(len * 1.5), 200);
  const mid = (src.start + src.end) / 2;
  const size = contigSize(panel, src.contig);
  let start = Math.max(0, Math.round(mid - width / 2));
  let end = start + width;
  if (end > size) { end = size; start = Math.max(0, end - width); }
  bump(panelId);           // a pending correction no longer applies
  pending.delete(panelId);
  st.setPanelViewportFromLink(panelId, { chrom: src.contig, start, end });
  return true;
}

/**
 * The lifted panel a link pairs with, after "Pool haplotypes" or "Split by haplotype" replaced it: its haplotype's
 * split panel, else the dataset's pooled one (null: none open).
 */
export function liftPanelFor(link: LiftLinkConfig, panels: PanelConfig[]): PanelConfig | null {
  const mine = panels.filter(p => p.contentType === 'dataset' && p.datasetId === link.datasetId && !p.liftLink);
  const current = mine.find(p => p.id === link.liftPanelId);
  if (current && (!current.liftHap || current.liftHap === link.hapLabel)) return current;
  return mine.find(p => p.liftHap === link.hapLabel) ?? mine.find(p => !p.liftHap) ?? null;
}

function retargetLinks(): void {
  const st = useBrowserStore.getState();
  const fixes: Array<[string, string]> = [];
  for (const p of st.panels) {
    if (!p.liftLink) continue;
    const target = liftPanelFor(p.liftLink, st.panels);
    if (target && target.id !== p.liftLink.liftPanelId) fixes.push([p.id, target.id]);
  }
  if (!fixes.length) return;
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => {
    const fix = fixes.find(([id]) => id === p.id);
    return fix && p.liftLink ? { ...p, liftLink: { ...p.liftLink, liftPanelId: fix[1] } } : p;
  }) }));
}

let registered = false;
export function registerLiftLinking(): void {
  if (registered) return;
  registered = true;
  registerViewLink(liftViewLink);
  registerPanelLink(liftPanelLink);
  useBrowserStore.subscribe((s, prev) => { if (s.panels !== prev.panels && s.panels.some(p => p.liftLink)) queueMicrotask(retargetLinks); });
  onNavigationData(id => queueMicrotask(() => applyCorrections(id)));
}
