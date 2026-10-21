/**
 * The graph panel's navigation adapter (DESIGN_GRAPH_PANEL.md §6, Gate F), registration-based and independent of
 * live lift:
 *
 * - `navigateGraph`: a graph target move. Following, it moves the initiating panel (the main view or a panel of its
 *   own) in that panel's own frame, which the graph then follows back; on its own, only the graph's viewport.
 *   Following is only ever offered on the same reference and contig (state.ts canFollow): never numerical
 *   coordinates copied between assemblies.
 * - Navigation tokens: a correction computed after a response (an anchored zoom keeping the pointer's target base
 *   under the pointer) applies only while its token still matches: the same panel generation, link identity
 *   (mode, initiator, initiator reference), package revision and viewport it was computed for. Anything newer drops
 *   it; a correction never schedules another (no echo).
 * - `showSourceSpan`: an existing linear source panel of the same files moves to the placement; otherwise a new
 *   graph view opens on the source path itself (a path panel from the registration: no BAM needed).
 */
import { useBrowserStore } from '../../stores/browserStore';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { clampViewport, type GraphViewport } from './coordinates';
import { useGraphReadsStore } from './graphReadsStore';
import { sourceWindow, type SourcePlacement } from './inspection';
import { canFollow, initialGraphView, initiatorView, type LinearView } from './state';
import { useGraphStatusStore } from './statusStore';
import type { GraphRegistration, GraphViewState } from './types';

export const GRAPH_VIEW_PANEL_TYPE = 'graph-view';

function mainView(): LinearView {
  const s = useBrowserStore.getState();
  return { chrom: s.chrom, start: s.start, end: s.end, reference: genomeKeyFor(null, s) };
}

function registration(id: string | null | undefined): GraphRegistration | null {
  return useGraphStatusStore.getState().status?.registrations.find(r => r.id === id) ?? null;
}

export function setGraphViewState(panelId: string, next: GraphViewState): void {
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === panelId ? { ...p, graphView: next } : p)) }));
}

// ---------------------------------------------------------------------------------------------------- tokens

const generations = new Map<string, number>();

export interface NavigationToken {
  panelId: string;
  gen: number;
  link: string;
  packageRevision: string | null;
  /** The viewport the correction was computed for. */
  viewport: string;
}

export const linkIdentity = (s: Pick<GraphViewState, 'linkMode' | 'initiatingPanelId' | 'initiatingReferenceId'>) =>
  `${s.linkMode}|${s.initiatingPanelId ?? 'main'}|${s.initiatingReferenceId ?? ''}`;
export const viewportKey = (v: GraphViewport | null | undefined) => (v ? `${v.contig}:${v.start}-${v.end}` : '');

/** A new navigation of the panel: every older token is stale from now on. */
export function bumpNavigation(panelId: string): number {
  const g = (generations.get(panelId) ?? 0) + 1;
  generations.set(panelId, g);
  return g;
}

export function navigationGeneration(panelId: string): number {
  return generations.get(panelId) ?? 0;
}

export function navigationToken(panelId: string, state: GraphViewState, viewport: GraphViewport): NavigationToken {
  return { panelId, gen: navigationGeneration(panelId), link: linkIdentity(state), packageRevision: state.packageRevision,
    viewport: viewportKey(viewport) };
}

/** Whether a correction computed under `token` may still be applied now. */
export function tokenCurrent(token: NavigationToken, state: GraphViewState | null | undefined, viewport: GraphViewport | null): boolean {
  return Boolean(state && token.gen === navigationGeneration(token.panelId) && token.link === linkIdentity(state)
    && token.packageRevision === state.packageRevision && token.viewport === viewportKey(viewport));
}

// ---------------------------------------------------------------------------------------------------- moves

/**
 * Move a graph panel's target view to `next` (clamped). `follow`: keep following (the initiator moves to it, in its
 * own frame); otherwise the panel goes on its own there. Returns whether anything moved.
 */
export function navigateGraph(panelId: string, next: GraphViewport, opts: { follow?: boolean } = {}): boolean {
  const s = useBrowserStore.getState();
  const panel = s.panels.find(p => p.id === panelId);
  const state = panel?.graphView;
  const reg = registration(state?.registrationId);
  const target = reg?.bindings.find(b => b.key === state?.targetBinding) ?? null;
  if (!state || !target) return false;
  const v = clampViewport(next, target.size, target.size_inferred);
  bumpNavigation(panelId);
  const main = mainView();
  const linear = state.linkMode === 'follow' ? initiatorView(state, s.panels, main) : null;
  if (opts.follow !== false && state.linkMode === 'follow' && linear && canFollow(target, linear)
    && (!state.initiatingReferenceId || state.initiatingReferenceId === linear.reference)) {
    if (state.initiatingPanelId == null) s.setViewport(v.contig, v.start, v.end);
    else s.navigatePanelOwnView(state.initiatingPanelId, v.contig, v.start, v.end);
    return true;
  }
  setGraphViewState(panelId, { ...state, linkMode: 'independent', targetViewport: v, initiatingPanelId: null, initiatingReferenceId: null });
  return true;
}

// ---------------------------------------------------------------------------------------------------- source

export interface SourceTarget { kind: 'panel'; panelId: string; contig: string; label: string }

/**
 * The linear panels that show a placement's path from the same files: a live-lift source panel (`liftLink`) of a
 * dataset whose read binding maps the path to a BAM contig, on that contig. Only the bindings of the graph panel
 * the selection came from count (its registration's path key; another package's same-named path is another
 * assembly); its graph panel closed, there are none (the path view is still offered).
 */
export function sourcePanelsFor(path: string, fromPanelId: string, registrationId?: string | null): SourceTarget[] {
  const s = useBrowserStore.getState();
  const own = useGraphReadsStore.getState().byPanel[fromPanelId];
  // The selection's registration (else the panel's): bindings verified for another package say nothing about it.
  const reg = registrationId ?? s.panels.find(p => p.id === fromPanelId)?.graphView?.registrationId ?? null;
  const bindings = own && own.registrationId != null && own.registrationId === reg ? own.bindings : [];
  const out: SourceTarget[] = [];
  for (const b of bindings) {
    const contig = b.paths[path];
    if (!contig) continue;
    for (const p of s.panels) {
      const l = p.liftLink;
      if (!l || l.datasetId !== b.dataset_id) continue;
      const shows = p.viewportOverride?.chrom ?? l.contig;
      if (shows !== contig && l.contig !== contig) continue;
      if (!out.some(o => o.panelId === p.id)) out.push({ kind: 'panel', panelId: p.id, contig, label: `${b.label} · ${l.hapLabel || l.hap} source view` });
    }
  }
  return out;
}

/**
 * Show a placement's source sequence: in `into` (a source panel from sourcePanelsFor) when given, else in a new
 * graph view on the path itself. Returns the panel it is shown in.
 */
export function showSourceSpan(fromPanelId: string, placement: SourcePlacement, into?: SourceTarget | null,
  registrationId?: string): string | null {
  const win = sourceWindow(placement.span);
  const s = useBrowserStore.getState();
  if (into) {
    s.navigatePanelOwnView(into.panelId, into.contig, win.start, win.end);
    return into.panelId;
  }
  // The graph panel it came from may be closed or show another package now: the selection's registration opens the
  // path view (the panel's own settings only when it still shows that registration).
  const live = s.panels.find(p => p.id === fromPanelId)?.graphView;
  const from = live && (!registrationId || live.registrationId === registrationId) ? live
    : (registrationId ? initialGraphView(registration(registrationId), null) : null);
  const reg = registration(from?.registrationId);
  const binding = reg?.bindings.find(b => b.key === placement.path);
  if (!from || !reg || !binding) return null;
  const before = new Set(s.panels.map(p => p.id));
  s.openAnalysisPanel(GRAPH_VIEW_PANEL_TYPE as never);
  const opened = useBrowserStore.getState().panels.find(p => !before.has(p.id) && p.contentType === GRAPH_VIEW_PANEL_TYPE);
  if (!opened) return null;
  const viewport = clampViewport({ contig: binding.path.contig, start: win.start, end: win.end }, binding.size, binding.size_inferred);
  setGraphViewState(opened.id, {
    ...from, targetBinding: binding.key, targetReferenceId: binding.reference, selectedPathKeys: [binding.key],
    targetViewport: viewport, linkMode: 'independent', initiatingPanelId: null, initiatingReferenceId: null,
    reads: from.reads,
  });
  return opened.id;
}
