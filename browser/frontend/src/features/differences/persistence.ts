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
declare module '../../types' { interface PanelConfig { differenceSources?: {assembly:boolean;reads:boolean}; liveLiftMinBp?: number; liftGroupByHaplotype?: boolean } }

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
      && !seen.has(JSON.stringify([e.referenceScope ?? 'main-reference',e.chrom,e.ins_id])) && Boolean(seen.add(JSON.stringify([e.referenceScope ?? 'main-reference',e.chrom,e.ins_id]))))
      .map(e => ({ ...e, ...(e.kind === 'replacement' && !e.anchor_convention && e.t_end !== undefined
        ? { pos: e.t_end, ref_start: e.pos, anchor_convention: 'ref_end' as const } : {}), label: String(e.label ?? ''), hap_label: String(e.hap_label ?? ''), ...(e.detail !== undefined && typeof e.detail !== 'string' ? { detail: undefined } : {}),
        ...(e.alleles === undefined ? {} : { alleles: Array.isArray(e.alleles) ? e.alleles.filter((a: any) => a && typeof a.ins_id === 'string' && typeof a.hap_label === 'string' && Number.isFinite(a.length) && a.length > 0 && a.length <= e.length) : [] }),
        ...(e.selected_length === undefined ? {} : { selected_length: Number.isFinite(e.selected_length) && e.selected_length > 0 && e.selected_length <= e.length ? e.selected_length : e.length }),
      }));
  }
  return out;
}

/** Known older column fields are aliases, never an inferred allele or source.
 * Entries lacking complete geometry remain in the reversible session capsule. */
export function restoreExpansionState(saved: Record<string, unknown> = {}): Record<string, LiveLiftExpansion[]> {
  const current = normalizeExpansions(saved.liveLiftExpansions);
  const legacy: Record<string, unknown[]> = {};
  if (saved.expandedInsertions && typeof saved.expandedInsertions === 'object') {
    for (const [view, entries] of Object.entries(saved.expandedInsertions)) {
      if (Array.isArray(entries)) legacy[view] = entries.map(e => e && typeof e === 'object' ? { ...e, ins_id: e.ins_id ?? e.id } : e);
    }
  }
  const out = { ...legacy };
  for (const [view, entries] of Object.entries(current)) out[view] = [...entries, ...(legacy[view] ?? [])];
  return normalizeExpansions(out);
}
registerStoreExtension({
  id: 'liveLift', keys: ['liveLiftExpansions'],
  create: set => ({
    liveLiftExpansions: {},
    expandLiveLift: (view: string, ins: LiveLiftExpansion) => {
      if (!(ins.length > 0 && ins.length <= 50_000)) return;
      set(s => ({ liveLiftExpansions: { ...s.liveLiftExpansions,
        [view]: [...(s.liveLiftExpansions?.[view] ?? []).filter(e => e.chrom !== ins.chrom || (e.referenceScope ?? 'main-reference') !== (ins.referenceScope ?? 'main-reference') ||
          e.ins_id !== ins.ins_id && !e.alleles?.some(a => a.ins_id === ins.ins_id) && !ins.alleles?.some(a => a.ins_id === e.ins_id)), ins] } }));
    },
    collapseLiveLift: (view: string, id: string) => set(s => ({ liveLiftExpansions: { ...s.liveLiftExpansions,
      [view]: (s.liveLiftExpansions?.[view] ?? []).filter(e => e.ins_id !== id) } })),
  }),
  serialize: s => ({ liveLiftExpansions: s.liveLiftExpansions ?? {} }),
  restoreSnapshot: saved => ({ liveLiftExpansions: restoreExpansionState(saved) }),
  importSession: frontend => ({ liveLiftExpansions: restoreExpansionState(frontend) }),
  onSessionImport: () => {
    void import('./selectionStore').then(m => m.restoreDifferenceSelection());
    // Which lifted dataset a native inspector compares with is picked again in the imported session.
    void import('./AssemblyComparisonPanel').then(m => m.useMapChoice.setState({ byDataset: {} }));
  },
});
