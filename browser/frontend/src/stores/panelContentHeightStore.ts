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
  const equal = () => { const h = Math.floor(room / n); return natural.map(() => h); };
  // Too short for every header: equal shares (each panel scrolls inside itself).
  if (room < n * chrome) return equal();
  const want = natural.map(h => (h == null ? null : Math.max(chrome, Math.min(Math.floor(room * maxShare), Math.round(h) + chrome))));
  const flexible = want.filter(h => h == null).length;
  const sized = want.reduce((t: number, h) => t + (h ?? 0), 0);
  if (!flexible) {
    // Every panel sizes to its content: they keep their heights (shrunk in proportion if they overflow, never below
    // their header), and the last takes what is left.
    const f = sized > room ? room / sized : 1;
    const out = want.map(h => Math.max(chrome, Math.floor((h ?? 0) * f)));
    const used = out.slice(0, -1).reduce((t, h) => t + h, 0);
    out[n - 1] = Math.max(chrome, room - used);
    return out.reduce((t, h) => t + h, 0) <= room ? out : equal();
  }
  // The flexible panels keep at least minOther each (or an equal share of a short column): the sized ones give way.
  const floorOther = Math.min(minOther, Math.floor((room - (n - flexible) * chrome) / flexible));
  let fixed = want.slice();
  if (room - sized < flexible * floorOther) {
    const budget = Math.max(0, room - flexible * floorOther);
    const f = sized > 0 ? budget / sized : 1;
    fixed = want.map(h => (h == null ? null : Math.max(Math.min(chrome, Math.floor(budget / Math.max(1, n - flexible))), Math.floor(h * f))));
  }
  const used = fixed.reduce((t: number, h) => t + (h ?? 0), 0);
  const share = Math.floor(Math.max(0, room - used) / flexible);
  const out = fixed.map(h => h ?? share);
  return out.reduce((t, h) => t + h, 0) <= room ? out : equal();
}
