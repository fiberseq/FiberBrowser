import { registerStoreExtension } from '../../stores/storeExtensions';
import type { BrowserState } from '../../stores/browserStore';
import type { PanelConfig } from '../../types';
import type { LiveLiftExpansion } from './axis';

declare module '../../stores/browserStore' {
  interface BrowserState {
    liveLiftExpansions: Record<string, LiveLiftExpansion[]>;
    expandLiveLift: (view: string, ins: LiveLiftExpansion) => void;
    collapseLiveLift: (view: string, id: string) => void;
  }
}
declare module '../../types' { interface PanelConfig { liveLiftMinBp?: number } }

/** Linked panels share columns; independently pinned loci have their own axis.
 * Default panels (including the native sibling) all belong to the main view. */
export function liveLiftViewKey(panel?: PanelConfig | null): string {
  if (!panel?.viewportOverride) return 'main';
  return panel.linkGroup ? `link:${panel.linkGroup}` : `panel:${panel.id}`;
}
export function viewChrom(s: Pick<BrowserState, 'panels' | 'chrom'>, key: string): string | undefined {
  if (key === 'main') return s.chrom;
  const panel = s.panels.find(p => liveLiftViewKey(p) === key);
  return panel?.viewportOverride?.chrom;
}
export function normalizeExpansions(raw: unknown): Record<string, LiveLiftExpansion[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, LiveLiftExpansion[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    out[key] = value.filter((e): e is LiveLiftExpansion => e && typeof e.chrom === 'string' && typeof e.ins_id === 'string'
      && Number.isFinite(e.pos) && e.pos >= 0 && Number.isFinite(e.length) && e.length > 0 && e.length <= 50_000
      && !seen.has(e.ins_id) && Boolean(seen.add(e.ins_id)))
      .map(e => ({ ...e, label: String(e.label ?? ''), hap_label: String(e.hap_label ?? '') }));
  }
  return out;
}
registerStoreExtension({
  id: 'liveLift', keys: ['liveLiftExpansions'],
  create: set => ({
    liveLiftExpansions: {},
    expandLiveLift: (view: string, ins: LiveLiftExpansion) => {
      if (!(ins.length > 0 && ins.length <= 50_000)) return;
      set(s => ({ liveLiftExpansions: { ...s.liveLiftExpansions,
        [view]: [...(s.liveLiftExpansions?.[view] ?? []).filter(e => e.ins_id !== ins.ins_id && e.chrom === ins.chrom), ins] } }));
    },
    collapseLiveLift: (view: string, id: string) => set(s => ({ liveLiftExpansions: { ...s.liveLiftExpansions,
      [view]: (s.liveLiftExpansions?.[view] ?? []).filter(e => e.ins_id !== id) } })),
  }),
  serialize: s => ({ liveLiftExpansions: s.liveLiftExpansions ?? {} }),
  restoreSnapshot: saved => ({ liveLiftExpansions: normalizeExpansions(saved.liveLiftExpansions) }),
  importSession: frontend => ({ liveLiftExpansions: normalizeExpansions(frontend?.liveLiftExpansions) }),
  onSessionImport: () => { void import('./inspectionStore').then(m => m.useDifferenceSelection.getState().select(null)); },
  // Changing chromosomes invalidates source blocks, even when the panel moves
  // away and back before React has drawn. Do this in the store transaction chain.
  persist: (s, previous) => {
    if (s.chrom === previous.chrom && s.panels === previous.panels) return;
    const entries = Object.entries(s.liveLiftExpansions ?? {});
    if (!entries.some(([key, es]) => es.some(e => e.chrom !== viewChrom(s, key)))) return;
    s.collapseLiveLift && entries.forEach(([key, es]) => es.forEach(e => {
      if (e.chrom !== viewChrom(s, key)) s.collapseLiveLift(key, e.ins_id);
    }));
  },
});
