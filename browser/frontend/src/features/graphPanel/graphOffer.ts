/**
 * The one-time "View as graph" offer (DESIGN_GRAPH_PRIMARY §5.2 step 3, §5.4): a saved split session restores exactly
 * as saved, and a binding that arrives after the user acted on a new dataset's split panels never rearranges them.
 * Either way the dataset's first split panel shows a dismissible notice offering "View as graph". Once the user
 * uses or dismisses it, it is not shown again for that dataset in this browser session. Nothing is moved.
 */
import { create } from 'zustand';
import type { PanelConfig } from '../../types';
import { isHost, viewSelectionAsGraph } from './hostMode';

interface OfferState {
  /** Datasets offered (restored split, or bound late). */
  offered: Record<string, true>;
  /** Datasets whose offer was used or dismissed. */
  done: Record<string, true>;
}

export const useGraphOffers = create<OfferState>(() => ({ offered: {}, done: {} }));

/** Offer "View as graph" for a dataset. `fresh`: a session restore just laid its panels out again, so an earlier
 * offer that was used or dismissed (on another layout) does not suppress this one. */
export function offerGraphView(datasetId: string, opts: { fresh?: boolean } = {}): void {
  const s = useGraphOffers.getState();
  if (opts.fresh && s.done[datasetId]) {
    const { [datasetId]: _used, ...done } = s.done;
    void _used;
    useGraphOffers.setState({ offered: { ...s.offered, [datasetId]: true }, done });
    return;
  }
  if (s.offered[datasetId] || s.done[datasetId]) return;
  useGraphOffers.setState({ offered: { ...s.offered, [datasetId]: true } });
}

/** The dataset is in a graph now (viewed as a graph some other way): its offer is withdrawn. */
export function withdrawGraphOffer(datasetId: string): void {
  const s = useGraphOffers.getState();
  if (!s.offered[datasetId]) return;
  const { [datasetId]: _gone, ...offered } = s.offered;
  void _gone;
  useGraphOffers.setState({ offered });
}

export function dismissGraphOffer(datasetId: string): void {
  const s = useGraphOffers.getState();
  if (s.done[datasetId]) return;
  useGraphOffers.setState({ done: { ...s.done, [datasetId]: true } });
}

/** Pure: the panel that shows a dataset's offer (its first shown dataset panel), or null: not offered, used or
 * dismissed, or the dataset is already in a graph (a host or a member). */
export function graphOfferPanel(panels: readonly PanelConfig[], datasetId: string | null | undefined, offers: Pick<OfferState, 'offered' | 'done'>): string | null {
  if (!datasetId || !offers.offered[datasetId] || offers.done[datasetId]) return null;
  const mine = panels.filter(p => p.contentType === 'dataset' && p.datasetId === datasetId && !p.readSubset && !p.liftLink);
  if (mine.some(p => isHost(p) || p.graphView?.role === 'host' || p.graphMemberOf)) return null;
  return mine.find(p => !p.collapsed)?.id ?? null;
}

/** "View as graph" from the offer: the panel views its graph (its split siblings fold in); the offer is used. */
export function acceptGraphOffer(panelId: string, datasetId: string): string | null {
  const why = viewSelectionAsGraph(panelId);
  if (!why) dismissGraphOffer(datasetId);
  return why;
}

// e2e and local checks read the offers (App.tsx exposes the browser store the same way).
if (typeof window !== 'undefined' && (window as unknown as { __FIBERBROWSER_E2E_EXPOSE_STORE?: boolean }).__FIBERBROWSER_E2E_EXPOSE_STORE) {
  (window as unknown as { __FIBERBROWSER_GRAPH_OFFERS__?: typeof useGraphOffers }).__FIBERBROWSER_GRAPH_OFFERS__ = useGraphOffers;
}
