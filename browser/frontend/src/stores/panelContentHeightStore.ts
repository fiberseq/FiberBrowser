/**
 * Natural body heights that panels report (a panel whose plugin sets `sizeToContent`, such as the graph view): a
 * stacked column gives such a panel this height instead of an equal share, so a short panel does not leave a tall
 * empty body under its content (plugins/types.ts, components/tracks/TrackContainer.tsx).
 */
import { create } from 'zustand';

interface PanelContentHeightState {
  heights: Record<string, number>;
  report: (panelId: string, height: number | null) => void;
}

export const usePanelContentHeightStore = create<PanelContentHeightState>(set => ({
  heights: {},
  report: (panelId, height) => set(state => {
    const current = state.heights[panelId];
    if (height == null) {
      if (current === undefined) return state;
      const next = { ...state.heights };
      delete next[panelId];
      return { heights: next };
    }
    const h = Math.max(0, Math.round(height));
    return current === h ? state : { heights: { ...state.heights, [panelId]: h } };
  }),
}));

/**
 * Heights of a stacked column's panels, always summing to at most `total`: a size-to-content panel takes its
 * natural height plus `chrome` (header), at most `maxShare` of the column; the others share what is left equally,
 * at least `minOther` each when the column allows. When even that does not fit, the sized panels shrink first, and a
 * column too short for every panel's chrome falls back to equal shares.
 */
export function stackHeights(total: number, natural: (number | null)[], chrome: number, maxShare = 0.5, minOther = 160): number[] {
  const n = natural.length;
  const room = Math.max(0, Math.floor(total));
  if (n <= 1) return [room];
  // Too short for every header: equal shares (each panel scrolls inside itself).
  if (room < n * chrome) { const h = Math.floor(room / n); return natural.map(() => h); }
  // Every header first; then the bodies: sized panels their natural body (at most maxShare of the column with its
  // header), the others the rest, at least minOther with their header where the column allows.
  const body = room - n * chrome;
  const want = natural.map(h => (h == null ? null : Math.max(0, Math.min(Math.floor(room * maxShare) - chrome, Math.round(h)))));
  const flexible = want.filter(h => h == null).length;
  const sized = want.reduce((t: number, h) => t + (h ?? 0), 0);
  if (!flexible) {
    const f = sized > body ? body / sized : 1;
    const out = want.map(h => Math.floor((h ?? 0) * f));
    out[n - 1] += body - out.reduce((t, h) => t + h, 0);
    return out.map(h => h + chrome);
  }
  const minBody = Math.min(Math.max(0, minOther - chrome), Math.floor(body / flexible));
  const avail = Math.max(0, body - flexible * minBody);
  const f = sized > avail ? avail / sized : 1;
  const bodies = want.map(h => (h == null ? null : Math.floor(h * f)));
  const share = Math.floor((body - bodies.reduce((t: number, h) => t + (h ?? 0), 0)) / flexible);
  return bodies.map(h => (h ?? share) + chrome);
}
