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
 * Heights of a stacked column's panels: a size-to-content panel takes its natural height plus `chrome` (header),
 * at most `maxShare` of the column; the others share what is left equally (at least `minOther` each when possible).
 */
export function stackHeights(total: number, natural: (number | null)[], chrome: number, maxShare = 0.5, minOther = 160): number[] {
  const n = natural.length;
  if (n <= 1) return [total];
  const fixed = natural.map(h => (h == null ? null : Math.max(chrome + 40, Math.min(Math.floor(total * maxShare), h + chrome))));
  const flexible = fixed.filter(h => h == null).length;
  if (!flexible) {
    // Every panel sizes to its content: they keep their heights, the last takes the rest.
    const used = fixed.slice(0, -1).reduce((t: number, h) => t + (h ?? 0), 0);
    return fixed.map((h, i) => (i === n - 1 ? Math.max(h ?? 0, total - used) : h ?? 0));
  }
  let used = fixed.reduce((t: number, h) => t + (h ?? 0), 0);
  // Never squeeze the flexible panels below their minimum: shrink the fixed ones instead.
  if (total - used < flexible * minOther && used > 0) {
    const room = Math.max(0, total - flexible * minOther);
    const f = Math.min(1, room / used);
    for (let i = 0; i < n; i++) if (fixed[i] != null) fixed[i] = Math.floor(fixed[i]! * f);
    used = fixed.reduce((t: number, h) => t + (h ?? 0), 0);
  }
  const share = Math.floor((total - used) / flexible);
  return fixed.map(h => h ?? share);
}
