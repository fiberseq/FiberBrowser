/**
 * The zoom-out hand-off (DESIGN_GRAPH_PRIMARY §7; graph primary G6) and the graph-mode settings.
 *
 * A host draws its graph while its own viewport is at most `outBp` wide (50 kb, the helper's ceiling) and draws
 * linear past it; it returns to the graph at or below `inBp` (40 kb). In between it keeps what it shows. A wheel
 * gesture crossing the band is judged once, when the viewport has been still for 300 ms. `viewMode` (the user's
 * intent) stays 'graph' throughout. While linear, the host's folded members are revealed side by side (D5), marked,
 * and folded again on the way back unless the user revealed or folded them by hand meanwhile.
 *
 * The host's viewport is its own (the main view, or its own view): pans and zooms in the graph write it through the
 * ordinary panel navigation, never a clamp or a detached graph viewport (§7.1).
 */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import type { PanelConfig } from '../../types';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { isHost, panelView } from './hostMode';
import { canFollow, defaultCompared, defaultTarget, GRAPH_MAX_PATHS, type LinearView } from './state';
import { useGraphStatusStore } from './statusStore';

export const HANDOFF_OUT_BP = 50_000;
export const HANDOFF_IN_BP = 40_000;
export const HANDOFF_SETTLE_MS = 300;

export type LiftedOpenView = 'graph' | 'split' | 'pooled';

interface GraphSettings {
  /** How a new lifted dataset opens when a registered package binds it (D2: graph). */
  defaultLiftedView: LiftedOpenView;
  outBp: number;
  inBp: number;
  set: (patch: Partial<Pick<GraphSettings, 'defaultLiftedView' | 'outBp' | 'inBp'>>) => void;
}

const SETTINGS_KEY = 'fiberbrowser_graph_mode_settings_v1';

function loadSettings(): Pick<GraphSettings, 'defaultLiftedView' | 'outBp' | 'inBp'> {
  const base = { defaultLiftedView: 'graph' as LiftedOpenView, outBp: HANDOFF_OUT_BP, inBp: HANDOFF_IN_BP };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return base;
    const view = ['graph', 'split', 'pooled'].includes(raw.defaultLiftedView) ? raw.defaultLiftedView : base.defaultLiftedView;
    const clampBp = (v: unknown, d: number) => (typeof v === 'number' && v >= 10_000 && v <= 50_000 ? Math.round(v) : d);
    const outBp = clampBp(raw.outBp, base.outBp);
    const inBp = Math.min(outBp, clampBp(raw.inBp, base.inBp));
    return { defaultLiftedView: view, outBp, inBp };
  } catch {
    return base;
  }
}

/** Per-viewer conveniences (localStorage): the default view of new lifted datasets and the hand-off thresholds. */
export const useGraphSettings = create<GraphSettings>((set, get) => ({
  ...loadSettings(),
  set: patch => {
    const next = { ...get(), ...patch };
    if (next.inBp > next.outBp) next.inBp = next.outBp;
    set({ defaultLiftedView: next.defaultLiftedView, outBp: next.outBp, inBp: next.inBp });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ defaultLiftedView: next.defaultLiftedView, outBp: next.outBp, inBp: next.inBp })); } catch { /* not kept */ }
  },
}));

/** "Open as" chosen for a dataset when it was added (the Add live lift dialog): used once, when its panels open. */
const openViews: Record<string, LiftedOpenView> = {};
export function setOpenViewFor(datasetId: string, view: LiftedOpenView): void { openViews[datasetId] = view; }
/** How a new lifted dataset opens: its own "Open as", else the browser default (D2: graph). */
export function liftedOpenView(datasetId: string): LiftedOpenView {
  return openViews[datasetId] ?? useGraphSettings.getState().defaultLiftedView;
}

/** What a host shows, from what it showed: graph up to `outBp`, back at `inBp` (hysteresis), linear when pinned or
 * when its view has no graph (another contig or reference than the package's target). */
export function decideShown(prev: 'graph' | 'linear', widthBp: number, opts: { outBp: number; inBp: number; pinnedLinear?: boolean; followable: boolean }): 'graph' | 'linear' {
  if (!opts.followable || opts.pinnedLinear) return 'linear';
  if (prev === 'graph') return widthBp > opts.outBp ? 'linear' : 'graph';
  return widthBp <= opts.inBp ? 'graph' : 'linear';
}

/** Pure: the panels with a host showing `shown`: going linear reveals its folded members (marked); going back to the
 * graph folds the members it revealed (still marked). */
export function applyShown(panels: PanelConfig[], hostId: string, shown: 'graph' | 'linear'): PanelConfig[] {
  const host = panels.find(p => p.id === hostId);
  const revealing = shown === 'linear' && panels.some(p => p.graphMemberOf === hostId && p.collapsedByGraphGroup === hostId);
  return panels.map(p => {
    if (p.id === hostId && p.graphView) {
      const lock = shown === 'linear' && p.viewportOverride && revealing ? { siteLocked: true } : {};
      return p.graphView.handoff?.shown === shown && !('siteLocked' in lock) ? p : { ...p, ...lock, graphView: { ...p.graphView, handoff: { ...p.graphView.handoff, shown } } };
    }
    if (p.graphMemberOf !== hostId) return p;
    if (shown === 'linear' && p.collapsedByGraphGroup === hostId) {
      // Revealed at the host's own view, site-locked with it, so the side-by-side panels show the same window.
      const { collapsedByGraphGroup: _c, ...rest } = p;
      return { ...rest, collapsed: false, graphHandoff: hostId,
        ...(host?.viewportOverride ? { viewportOverride: { ...host.viewportOverride }, siteLocked: true } : {}) };
    }
    if (shown === 'graph' && p.graphHandoff === hostId) {
      const { graphHandoff: _h, ...rest } = p;
      return { ...rest, collapsed: true, collapsedByGraphGroup: hostId };
    }
    return p;
  });
}

/** A host's view on another contig of its package: that contig's target and its own paths (else null: unchanged). */
export function retargetHost(host: PanelConfig, view: LinearView): PanelConfig['graphView'] | null {
  const gv = host.graphView;
  const reg = useGraphStatusStore.getState().status?.registrations.find(r => r.id === gv?.registrationId);
  if (!gv || !reg) return null;
  const current = reg.bindings.find(b => b.key === gv.targetBinding);
  if (current && current.path.contig === view.chrom) return null;
  const next = defaultTarget(reg, view);
  if (!next || next.key === gv.targetBinding || !canFollow(next, view)) return null;
  return { ...gv, targetBinding: next.key, targetReferenceId: next.reference,
    selectedPathKeys: [next.key, ...defaultCompared(reg, next.key)].slice(0, GRAPH_MAX_PATHS) };
}

/** Whether a host's view can draw its graph (its target on the view's contig and reference). */
export function hostFollowable(host: PanelConfig, view: LinearView): boolean {
  const gv = host.graphView;
  const reg = useGraphStatusStore.getState().status?.registrations.find(r => r.id === gv?.registrationId);
  const target = reg?.bindings.find(b => b.key === gv?.targetBinding);
  return canFollow(target, view);
}

/** What the host should show now (no settling), given the store. */
export function desiredShown(host: PanelConfig, main: LinearView, settings = useGraphSettings.getState()): 'graph' | 'linear' {
  const view = panelView(host, main);
  const prev = host.graphView?.handoff?.shown ?? 'graph';
  return decideShown(prev, view.end - view.start, { outBp: settings.outBp, inBp: settings.inBp,
    pinnedLinear: host.graphView?.handoff?.pinnedLinear, followable: hostFollowable(host, view) });
}

const timers = new Map<string, { sig: string; timer: number }>();
let started = false;

/** Watch every host's viewport and apply the hand-off once it has settled (one decision per gesture). */
export function startHandoffController(): void {
  if (started) return;
  started = true;
  const check = () => {
    const s = useBrowserStore.getState();
    const main: LinearView = { chrom: s.chrom, start: s.start, end: s.end, reference: genomeKeyFor(null, s) };
    for (const host of s.panels) {
      if (!isHost(host)) continue;
      const view = panelView(host, main);
      const retarget = retargetHost(host, view);
      if (retarget) {
        useBrowserStore.setState(st => ({ panels: st.panels.map(p => (p.id === host.id ? { ...p, graphView: retarget } : p)) }));
        return;   // the change re-runs the check
      }
      const want = desiredShown(host, main);
      const shown = host.graphView?.handoff?.shown ?? 'graph';
      const pending = timers.get(host.id);
      // The gesture is judged once its viewport has been still for 300 ms: a new viewport restarts the wait,
      // an unrelated change (another panel) does not.
      const sig = `${want}|${view.chrom}:${view.start}-${view.end}`;
      if (want === shown) {
        if (pending) { window.clearTimeout(pending.timer); timers.delete(host.id); }
        continue;
      }
      if (pending?.sig === sig) continue;
      if (pending) window.clearTimeout(pending.timer);
      timers.set(host.id, { sig, timer: window.setTimeout(() => {
        timers.delete(host.id);
        const st = useBrowserStore.getState();
        const h = st.panels.find(p => p.id === host.id);
        if (!isHost(h)) return;
        const m: LinearView = { chrom: st.chrom, start: st.start, end: st.end, reference: genomeKeyFor(null, st) };
        const now = desiredShown(h, m);
        if (now !== (h.graphView?.handoff?.shown ?? 'graph')) useBrowserStore.setState(x => ({ panels: applyShown(x.panels, h.id, now) }));
      }, HANDOFF_SETTLE_MS) });
    }
  };
  useBrowserStore.subscribe((s, prev) => {
    if (s.panels === prev.panels && s.chrom === prev.chrom && s.start === prev.start && s.end === prev.end) return;
    check();
  });
  useGraphStatusStore.subscribe(check);
  useGraphSettings.subscribe(check);
}

/** "Stay linear" / "Resume graph" (handoff.pinnedLinear): saved with the host, applied at once. */
export function setPinnedLinear(hostId: string, pinned: boolean): void {
  useBrowserStore.setState(s => {
    const panels = s.panels.map(p => (p.id === hostId && p.graphView ? { ...p, graphView: { ...p.graphView, handoff: { ...p.graphView.handoff, pinnedLinear: pinned } } } : p));
    const host = panels.find(p => p.id === hostId);
    if (!isHost(host)) return { panels };
    const main: LinearView = { chrom: s.chrom, start: s.start, end: s.end, reference: genomeKeyFor(null, s) };
    return { panels: applyShown(panels, hostId, desiredShown(host, main)) };
  });
}
