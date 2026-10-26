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
import { serializeState } from '../../stores/historySlice';
import { useBrowserStore } from '../../stores/browserStore';
import type { PanelConfig } from '../../types';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { isHost, moveHostMembers, panelView } from './hostMode';
import { canFollow, defaultCompared, defaultTarget, GRAPH_MAX_PATHS, type LinearView } from './state';
import { useGraphStatusStore } from './statusStore';
import { complexityFor, complexityShown, judgmentKey, probeComplexity, useGraphComplexity } from './complexity';

export const HANDOFF_OUT_BP = 50_000;
export const HANDOFF_IN_BP = 40_000;
export const HANDOFF_SETTLE_MS = 300;

export type LiftedOpenView = 'graph' | 'split' | 'pooled';

interface GraphSettings {
  /** How a new lifted dataset opens when a registered package binds it (D2: graph). */
  defaultLiftedView: LiftedOpenView;
  outBp: number;
  inBp: number;
  /** The complexity hand-off (§7.2, D4: on): linear where most of the window is unresolved in the topology. */
  complexity: boolean;
  set: (patch: Partial<Pick<GraphSettings, 'defaultLiftedView' | 'outBp' | 'inBp' | 'complexity'>>) => void;
}

const SETTINGS_KEY = 'fiberbrowser_graph_mode_settings_v1';

function loadSettings(): Pick<GraphSettings, 'defaultLiftedView' | 'outBp' | 'inBp' | 'complexity'> {
  const base = { defaultLiftedView: 'graph' as LiftedOpenView, outBp: HANDOFF_OUT_BP, inBp: HANDOFF_IN_BP, complexity: true };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return base;
    const view = ['graph', 'split', 'pooled'].includes(raw.defaultLiftedView) ? raw.defaultLiftedView : base.defaultLiftedView;
    const clampBp = (v: unknown, d: number) => (typeof v === 'number' && v >= 10_000 && v <= 50_000 ? Math.round(v) : d);
    const outBp = clampBp(raw.outBp, base.outBp);
    const inBp = Math.min(outBp, clampBp(raw.inBp, base.inBp));
    return { defaultLiftedView: view, outBp, inBp, complexity: raw.complexity !== false };
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
    set({ defaultLiftedView: next.defaultLiftedView, outBp: next.outBp, inBp: next.inBp, complexity: next.complexity });
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ defaultLiftedView: next.defaultLiftedView, outBp: next.outBp, inBp: next.inBp,
        complexity: next.complexity }));
    } catch { /* not kept */ }
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
export function applyShown(panels: PanelConfig[], hostId: string, shown: 'graph' | 'linear', reason?: 'width' | 'complexity'): PanelConfig[] {
  const host = panels.find(p => p.id === hostId);
  const why = shown === 'linear' ? reason : undefined;
  return panels.map(p => {
    if (p.id === hostId && p.graphView) {
      const h = p.graphView.handoff;
      if (h?.shown === shown && (h?.reason ?? undefined) === why) return p;
      const { reason: _r, ...rest } = h ?? {};
      return { ...p, graphView: { ...p.graphView, handoff: { ...rest, shown, ...(why ? { reason: why } : {}) } } };
    }
    if (p.graphMemberOf !== hostId) return p;
    if (shown === 'linear' && p.collapsedByGraphGroup === hostId) {
      // Revealed at the host's own view, so the side-by-side panels show the same window (the host's moves carry
      // members in step with it: GraphPanel commitViewport, moveHostMembers).
      const { collapsedByGraphGroup: _c, ...rest } = p;
      return { ...rest, collapsed: false, graphHandoff: hostId,
        ...(host?.viewportOverride ? { viewportOverride: { ...host.viewportOverride } } : {}) };
    }
    // Back to the graph: the members it revealed fold again, unless the user moved one elsewhere meanwhile.
    if (shown === 'graph' && p.graphHandoff === hostId
      && JSON.stringify(p.viewportOverride ?? null) === JSON.stringify(host?.viewportOverride ?? null)) {
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

/** What the host should show now (no settling), given the store, and why it is linear (the width rule — also a
 * pin or a view with no graph — or the complexity rule). */
export function desiredHandoff(host: PanelConfig, main: LinearView, settings = useGraphSettings.getState()): { shown: 'graph' | 'linear'; reason?: 'width' | 'complexity' } {
  const view = panelView(host, main);
  const prev = host.graphView?.handoff?.shown ?? 'graph';
  // Not known yet: as it was. The helper or the package gone: the graph body, whose panel says why and relinks.
  const status = useGraphStatusStore.getState().status;
  if (!status) return { shown: prev, ...(prev === 'linear' && host.graphView?.handoff?.reason ? { reason: host.graphView.handoff.reason } : {}) };
  if (!status.helper.available || !status.registrations.some(r => r.id === host.graphView?.registrationId)) return { shown: 'graph' };
  const byComplexity = prev === 'linear' && host.graphView?.handoff?.reason === 'complexity';
  // The width rule's hysteresis is about the width: a host linear for complexity is graph as far as the width goes
  // (agy G7 review: at 40–50 kb it was relabelled linear-for-width and never came back).
  const byWidth = decideShown(byComplexity ? 'graph' : prev, view.end - view.start, { outBp: settings.outBp, inBp: settings.inBp,
    pinnedLinear: host.graphView?.handoff?.pinnedLinear, followable: hostFollowable(host, view) });
  if (byWidth === 'linear') return { shown: 'linear', reason: 'width' };
  if (!settings.complexity) return { shown: 'graph' };
  const want = complexityShown(prev, complexityFor(host, view), byComplexity);
  // Not judged for this window yet: a host linear for complexity stays so until its probe answers.
  if (want == null) return byComplexity ? { shown: 'linear', reason: 'complexity' } : { shown: 'graph' };
  return want === 'linear' ? { shown: 'linear', reason: 'complexity' } : { shown: 'graph' };
}

export function desiredShown(host: PanelConfig, main: LinearView, settings = useGraphSettings.getState()): 'graph' | 'linear' {
  return desiredHandoff(host, main, settings).shown;
}

const timers = new Map<string, { sig: string; timer: number }>();
const probes = new Map<string, { sig: string; timer: number }>();
const settings = () => useGraphSettings.getState();
let started = false;

/** Watch every host's viewport and apply the hand-off once it has settled (one decision per gesture). */
/**
 * A hand-off is part of the navigation that caused it (graph features): it amends that navigation's undo step in
 * place, never appending a step of its own or truncating Redo (Codex review, group C). Only the step at the history
 * pointer is amended, and only when it was taken at this very view: a hand-off that comes before the navigation's
 * step is recorded (Browser.tsx, 500 ms after the move) is simply part of that step, and one after an Undo or Redo
 * (a restored step at another view) amends nothing.
 */
function recordHandoffStep(_label: string): void {
  const st = useBrowserStore.getState();
  const stack = st._historyStack ?? [];
  const current = stack[st._historyPointer ?? stack.length - 1];
  if (!current || Date.now() - (st._lastRestoreTime ?? 0) < 1500) return;
  const now = serializeState(st);
  const at = (x: { chrom?: string; start?: number; end?: number; panels?: { id: string; viewportOverride?: unknown }[] }) =>
    JSON.stringify([x.chrom, x.start, x.end, (x.panels ?? []).map(p => [p.id, p.viewportOverride ?? null])]);
  if (at(current.state as never) !== at(now as never)) return;
  st.foldIntoCurrentSnapshot(now);
}

export function startHandoffController(): void {
  if (started) return;
  started = true;
  const check = () => {
    const s = useBrowserStore.getState();
    const main: LinearView = { chrom: s.chrom, start: s.start, end: s.end, reference: genomeKeyFor(null, s) };
    for (const host of s.panels) {
      if (!isHost(host) || host.collapsed) continue;
      const view = panelView(host, main);
      const retarget = retargetHost(host, view);
      if (retarget) {
        useBrowserStore.setState(st => ({ panels: st.panels.map(p => (p.id === host.id ? { ...p, graphView: retarget } : p)) }));
        return;   // the change re-runs the check
      }
      const desired = desiredHandoff(host, main);
      const want = desired.shown;
      const shown = host.graphView?.handoff?.shown ?? 'graph';
      const reason = host.graphView?.handoff?.reason;
      const pending = timers.get(host.id);
      // The gesture is judged once its viewport has been still for 300 ms: a new viewport restarts the wait,
      // an unrelated change (another panel) does not.
      const sig = `${want}|${desired.reason ?? ''}|${view.chrom}:${view.start}-${view.end}`;
      if (want === shown && desired.reason === (shown === 'linear' ? reason : undefined)) {
        if (pending) { window.clearTimeout(pending.timer); timers.delete(host.id); }
        // Linear for complexity, in a window the graph could draw but not judged yet: ask its topology once settled.
        if (shown === 'linear' && reason === 'complexity' && settings().complexity && view.end - view.start <= settings().outBp
          && complexityFor(host, view) === undefined) {
          const psig = `probe|${judgmentKey(host.graphView, view)}`;
          const probe = probes.get(host.id);
          if (probe?.sig !== psig) {
            if (probe) window.clearTimeout(probe.timer);
            probes.set(host.id, { sig: psig, timer: window.setTimeout(() => {
              probes.delete(host.id);
              const st = useBrowserStore.getState();
              const h = st.panels.find(p => p.id === host.id);
              const reg = useGraphStatusStore.getState().status?.registrations.find(r => r.id === h?.graphView?.registrationId);
              if (!isHost(h) || !reg) return;
              const m: LinearView = { chrom: st.chrom, start: st.start, end: st.end, reference: genomeKeyFor(null, st) };
              const v = panelView(h, m);
              if (`probe|${judgmentKey(h.graphView, v)}` === psig) probeComplexity(h, v, reg);
            }, HANDOFF_SETTLE_MS) });
          }
        }
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
        const now = desiredHandoff(h, m);
        if (now.shown !== (h.graphView?.handoff?.shown ?? 'graph') || now.reason !== (h.graphView?.handoff?.reason ?? undefined)) {
          useBrowserStore.setState(x => ({ panels: applyShown(x.panels, h.id, now.shown, now.reason) }));
          recordHandoffStep(now.shown === 'linear' ? 'Graph view: linear (zoomed out)' : 'Graph view: graph');
        }
      }, HANDOFF_SETTLE_MS) });
    }
  };
  // A host with its own view carries its members in step with it, however it moves (graph gestures, its linear
  // tracks while handed off, the locus box): once per move, from the view it moved from. Members a site lock already
  // moved, or that the user moved elsewhere, are left as they are.
  const lastView = new Map<string, { chrom: string; start: number; end: number }>();
  const carry = () => {
    const s = useBrowserStore.getState();
    let panels = s.panels;
    for (const host of s.panels) {
      if (!isHost(host) && host.graphView?.role !== 'host') continue;
      const now = host.viewportOverride;
      const before = lastView.get(host.id);
      if (now) lastView.set(host.id, { ...now }); else lastView.delete(host.id);
      if (now && before && (before.chrom !== now.chrom || before.start !== now.start || before.end !== now.end)) {
        panels = moveHostMembers(panels, host.id, before, now);
      }
    }
    // (Synchronous with the host's move: the move's own undo step records them.)
    if (panels !== s.panels) useBrowserStore.setState({ panels });
  };
  useBrowserStore.subscribe((s, prev) => {
    if (s.panels !== prev.panels) carry();
    if (s.panels === prev.panels && s.chrom === prev.chrom && s.start === prev.start && s.end === prev.end) return;
    check();
  });
  useGraphStatusStore.subscribe(check);
  useGraphSettings.subscribe(check);
  useGraphComplexity.subscribe(check);
}

/** "Stay linear" / "Resume graph" (handoff.pinnedLinear): saved with the host, applied at once. */
export function setPinnedLinear(hostId: string, pinned: boolean): void {
  useBrowserStore.setState(s => {
    const panels = s.panels.map(p => (p.id === hostId && p.graphView ? { ...p, graphView: { ...p.graphView, handoff: { ...p.graphView.handoff, pinnedLinear: pinned } } } : p));
    const host = panels.find(p => p.id === hostId);
    if (!isHost(host)) return { panels };
    const main: LinearView = { chrom: s.chrom, start: s.start, end: s.end, reference: genomeKeyFor(null, s) };
    const d = desiredHandoff(host, main);
    return { panels: applyShown(panels, hostId, d.shown, d.reason) };
  });
  // A user action: its own undo step.
  const st = useBrowserStore.getState();
  if (st._historyStack?.length) st.pushSnapshot(pinned ? 'Stay linear' : 'Resume graph');
}
