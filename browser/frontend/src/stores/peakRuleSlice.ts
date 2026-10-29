import { peakTransaction } from '../features/hub/peakMigration';
import { equivalentFeaturePeaks } from '../utils/equivalentFeatures';
import type { CorrespondenceScan } from '../utils/equivalentScanning';
import { equivalentPeaks } from '../utils/equivalentPositions';
import { storeExtensions } from './storeExtensions';
import { isMatchedRule, keepMatched, MATCHED_COLORS, validMatchedPeak, type MatchedGroupInput } from '../utils/matchedRegions';
import type { BrowserState } from './browserStore';
import type { FirePeak, PeakRule, PeakRulePreset } from '../types';
import { DEFAULT_PEAK_RULES } from '../types';

// ============================================================
// LocalStorage helpers
// ============================================================

const PEAK_PRESETS_STORAGE_KEY = 'fiberhmm_peak_presets';

function loadPeakPresetsFromStorage(): PeakRulePreset[] {
  try {
    const stored = localStorage.getItem(PEAK_PRESETS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function savePeakPresetsToStorage(presets: PeakRulePreset[]): void {
  try {
    localStorage.setItem(PEAK_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch (e) {
    console.error('Failed to save peak presets:', e);
  }
}

// ============================================================
// Peak indexing: each rule's peaks get indices rulePosition * 10000 + localIndex
// ============================================================

export function computeRuleOffset(ruleIndex: number): number {
  return ruleIndex * 10000;
}

/** Re-index each rule's legacy projection; hit identities stay attached to their peaks. */
function reindexPeaks(
  peaksByRule: Record<string, FirePeak[]>,
  rules: PeakRule[],
): Record<string, FirePeak[]> {
  const next: Record<string, FirePeak[]> = {};
  rules.forEach((rule, ruleIdx) => {
    const existing = peaksByRule[rule.id];
    if (existing) {
      next[rule.id] = existing.map((p, localIdx) => {
        const index = computeRuleOffset(ruleIdx) + localIdx;
        return { ...p, index };
      });
    }
  });
  return next;
}

// ============================================================
// PEAK RULE SLICE — Interface
// ============================================================

export interface PeakRuleSlice {
  correspondenceScans: Record<string, Record<string, CorrespondenceScan>>;
  setCorrespondenceScans: (ruleId: string, scans: Record<string, CorrespondenceScan>) => void;
  peakRules: PeakRule[];
  peaksByRule: Record<string, FirePeak[]>;      // ruleId → detected peaks
  peakSignalCache: Record<string, number[]>;    // ruleId → signal array (transient)
  peaksLocked: boolean;                          // freeze current detected/selected peaks

  upsertMatchedGroup: (input: MatchedGroupInput) => string;
  removeMatchedGroup: (id: string) => void;
  selectMatchedGroup: (id: string, additive?: boolean) => void;
  reverseMatchedRegion: (index: number) => void;

  // Rule CRUD
  addPeakRule: (rule: PeakRule) => void;
  updatePeakRule: (id: string, updates: Partial<PeakRule>) => void;
  removePeakRule: (id: string) => void;
  reorderPeakRules: (from: number, to: number) => void;
  setPeakRules: (rules: PeakRule[]) => void;

  // Peak data
  setPeaksByRule: (ruleId: string, peaks: FirePeak[]) => void;
  clearPeaksByRule: (ruleId?: string) => void;  // clear one or all
  setPeaksLocked: (locked: boolean) => void;
  togglePeaksLocked: () => void;

  // Signal cache
  setPeakSignalCache: (ruleId: string, signal: number[]) => void;
  clearPeakSignalCache: () => void;

  // Presets (localStorage)
  savedPeakPresets: PeakRulePreset[];
  savePeakPreset: (name: string) => void;
  loadPeakPreset: (name: string) => void;
  deletePeakPreset: (name: string) => void;

  // Computed helpers
  getAllPeaks: () => FirePeak[];
  getCustomRuleId: () => string;
}

// ============================================================
// PEAK RULE SLICE — Implementation
// ============================================================

export function createPeakRuleSlice(
  set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void,
  get: () => BrowserState,
): PeakRuleSlice {
  // Per-store memo for getAllPeaks. Callers (ReadTrack/ClusterDetailPanel) feed
  // this directly into ruleMatching.buildRuleMatchContext, whose context cache
  // keys on object identity — building a fresh array every call defeats it.
  // Invalidate on peakRules / peaksByRule reference change (both are produced
  // immutably by the slice updaters above).
  let cachedFeatures: BrowserState['selectedFeatures'] | null = null;
  let cachedPanels: BrowserState['panels'] | null = null;
  let cachedFromChrom: string | null = null;
  let cachedAllPeaks: FirePeak[] | null = null;
  let cachedFromRules: PeakRule[] | null = null;
  let cachedFromPeaksByRule: Record<string, FirePeak[]> | null = null;

  return {
    correspondenceScans: {},
    setCorrespondenceScans: (id, scans) => set(s => ({ correspondenceScans: { ...s.correspondenceScans, [id]: scans } })),
    peakRules: DEFAULT_PEAK_RULES.map(r => ({ ...r })),
    peaksByRule: {},
    peakSignalCache: {},
    peaksLocked: false,
    savedPeakPresets: loadPeakPresetsFromStorage(),

    upsertMatchedGroup: ({ id = `matched-${crypto.randomUUID()}`, name, color, regions, matchGroup }) => {
      const state = get();
      const old = state.peakRules.find(r => r.id === id);
      const rule: PeakRule = { ...DEFAULT_PEAK_RULES[0], ...old, id, name, source: 'matched', enabled: true,
        color: color ?? old?.color ?? MATCHED_COLORS[state.peakRules.filter(isMatchedRule).length % MATCHED_COLORS.length],
        useGradient: false, matchGroup: matchGroup ?? old?.matchGroup };
      const peaks = regions.map(p => ({ ...p, hitId: p.ruleId === id ? p.hitId : undefined, ruleId: id, isCustom: false, match: { ...p.match!, groupId: id } }));
      if (!peaks.length || peaks.length >= 10000 || peaks.some(p => !validMatchedPeak(p, id))
        || new Set(peaks.map(p => p.match.label)).size !== peaks.length || new Set(peaks.map(p => p.match.length)).size !== 1) {
        throw new Error('Invalid region map');
      }
      const rules = old ? state.peakRules.map(r => r.id === id ? rule : r) : [...state.peakRules, rule];
      const offset = computeRuleOffset(rules.findIndex(r => r.id === id));
      const next = peaks.map((p, i) => ({ ...p, index: offset + i }));
      const mode = (state.peaksByRule[id] ?? []).map(p => state.peakModes[p.index]).find(Boolean);
      const transaction = peakTransaction(state, { ...state.peaksByRule, [id]: next });
      set({ peakRules: rules, ...transaction,
        ...(mode ? { peakModes: { ...transaction.peakModes, ...Object.fromEntries(next.map(p => [p.index, mode])) } } : {}) });
      return id;
    },
    removeMatchedGroup: id => get().removePeakRule(id),
    selectMatchedGroup: (id, additive = false) => {
      const s = get(), peaks = s.peaksByRule[id] ?? [];
      const selected = new Set(s.selectedPeaks);
      const deselect = peaks.every(p => selected.has(p.index));
      if (!additive) for (const r of s.peakRules.filter(isMatchedRule)) for (const p of s.peaksByRule[r.id] ?? []) selected.delete(p.index);
      for (const p of peaks) { if (deselect) selected.delete(p.index); else selected.add(p.index); }
      s.replacePeakSelection([...selected]);
      const mode = peaks.map(p => s.peakModes[p.index]).find(Boolean);
      if (mode) get().setPeakMode(peaks[0].index, mode);
    },
    reverseMatchedRegion: index => {
      const s = get(), p = s.getAllPeaks().find(p => p.index === index);
      if (!p?.match) return;
      s.setPeaksByRule(p.match.groupId, s.peaksByRule[p.match.groupId].map(q => q.index !== index ? q : {
        ...q, match: { ...q.match!, reversed: !q.match!.reversed,
          blocks: q.match!.blocks.map(b => ({ ...b, frame: [q.match!.length - b.frame[1], q.match!.length - b.frame[0]] as [number, number] })).sort((a, b) => a.frame[0] - b.frame[0]) }
      }));
    },

    // Rule CRUD
    addPeakRule: (rule) => set(state => ({
      peakRules: [...state.peakRules, rule],
    })),

    updatePeakRule: (id, updates) => set(state => ({
      peakRules: state.peakRules.map(r => r.id === id ? { ...r, ...updates } : r),
      ...Object.assign({}, ...storeExtensions().map(ext => ext.onPeakRuleChange?.(state, id, updates))),
    })),

    removePeakRule: (id) => set(state => {
      const newSignalCache = { ...state.peakSignalCache };
      delete newSignalCache[id];
      // The removed rule's peaks leave the selection; the rules after it
      // shift up, so their peaks are re-indexed like a reorder.
      const rules = state.peakRules.filter(r => r.id !== id);
      return {
        ...Object.assign({}, ...storeExtensions().map(ext => ext.onPeakRuleChange?.(state, id, null))),
        peakRules: rules,
        peakSignalCache: newSignalCache,
        correspondenceScans: Object.fromEntries(Object.entries(state.correspondenceScans).filter(([key]) => key !== id)
          .map(([key, scans]) => [key, Object.fromEntries(Object.entries(scans).filter(([group]) => group !== id))])),
        ...peakTransaction(state, reindexPeaks(state.peaksByRule, rules)),
      };
    }),

    reorderPeakRules: (from, to) => set(state => {
      const rules = [...state.peakRules];
      const [moved] = rules.splice(from, 1);
      rules.splice(to, 0, moved);
      // Re-index peaks after reorder; selected peaks stay the same peaks.
      const newPeaksByRule = reindexPeaks(state.peaksByRule, rules);
      return { peakRules: rules, peaksByRule: newPeaksByRule, ...peakTransaction(state, newPeaksByRule) };
    }),

    setPeakRules: (incoming) => set(state => {
      const rules = [...incoming, ...state.peakRules.filter(r => isMatchedRule(r) && !incoming.some(q => q.id === r.id))];
      const peaksByRule = reindexPeaks(state.peaksByRule, rules);
      return { peakRules: rules, peaksByRule, ...peakTransaction(state, peaksByRule) };
    }),

    // Peak data
    setPeaksByRule: (ruleId, peaks) => set(state => {
      const ruleIdx = state.peakRules.findIndex(r => r.id === ruleId);
      const offset = ruleIdx >= 0 ? computeRuleOffset(ruleIdx) : 0;
      const indexedPeaks = peaks.map((p, i) => ({
        ...p,
        hitId: p.ruleId === ruleId ? p.hitId : undefined,
        index: offset + i,
        ruleId,
      }));
      return peakTransaction(state, { ...state.peaksByRule, [ruleId]: indexedPeaks });
    }),

    clearPeaksByRule: (ruleId?) => set(state => {
      if (ruleId) {
        const newPeaksByRule = { ...state.peaksByRule };
        delete newPeaksByRule[ruleId];
        return { peaksByRule: newPeaksByRule, ...peakTransaction(state, newPeaksByRule),
          correspondenceScans: Object.fromEntries(Object.entries(state.correspondenceScans).filter(([id]) => id !== ruleId)) };
      }
      const kept = keepMatched(state, { peaksByRule: {}, selectedPeaks: new Set(), peakModes: {}, correspondenceScans: {} });
      return { ...kept, ...peakTransaction(state, kept.peaksByRule ?? {}) };
    }),

    setPeaksLocked: (locked) => set({ peaksLocked: locked }),
    togglePeaksLocked: () => set(state => ({ peaksLocked: !state.peaksLocked })),

    // Signal cache
    setPeakSignalCache: (ruleId, signal) => set(state => ({
      peakSignalCache: { ...state.peakSignalCache, [ruleId]: signal },
    })),

    clearPeakSignalCache: () => set({ peakSignalCache: {}, correspondenceScans: {} }),

    // Presets
    savePeakPreset: (name) => {
      const state = get();
      const preset: PeakRulePreset = { name, rules: state.peakRules.filter(r => !isMatchedRule(r)).map(r => ({ ...r })) };
      const existing = state.savedPeakPresets.filter(p => p.name !== name);
      const newPresets = [...existing, preset];
      savePeakPresetsToStorage(newPresets);
      set({ savedPeakPresets: newPresets });
    },

    loadPeakPreset: (name) => {
      const state = get();
      const preset = state.savedPeakPresets.find(p => p.name === name);
      if (!preset) return;
      // The old peaks are gone, so is any selection of them: a stale selection
      // would also keep the automatic scan from finding the new rules' peaks.
      get().clearPeaksByRule();
      get().setPeakRules(preset.rules.map(r => ({ ...r })));
      set({ peakSignalCache: {} });
    },

    deletePeakPreset: (name) => {
      const state = get();
      const newPresets = state.savedPeakPresets.filter(p => p.name !== name);
      savePeakPresetsToStorage(newPresets);
      set({ savedPeakPresets: newPresets });
    },

    // Computed helpers
    getAllPeaks: () => {
      const state = get();
      if (
        cachedAllPeaks !== null
        && cachedFeatures === state.selectedFeatures && cachedPanels === state.panels
        && cachedFromChrom === state.chrom
        && cachedFromRules === state.peakRules
        && cachedFromPeaksByRule === state.peaksByRule
      ) {
        return cachedAllPeaks;
      }
      const result: FirePeak[] = [];
      for (const rule of state.peakRules) {
        if (rule.enabled) {
          const peaks = state.peaksByRule[rule.id];
          if (peaks) result.push(...peaks.map(p => p.ruleId ? p : { ...p, ruleId: rule.id }));
        }
      }
      const groups = state.peakRules.filter(isMatchedRule).map(r => state.peaksByRule[r.id] ?? []);
      cachedAllPeaks = [...equivalentPeaks(result, groups, state.chrom), ...equivalentFeaturePeaks(state, groups)];
      cachedFeatures = state.selectedFeatures;
      cachedPanels = state.panels;
      cachedFromChrom = state.chrom;
      cachedFromRules = state.peakRules;
      cachedFromPeaksByRule = state.peaksByRule;
      return cachedAllPeaks;
    },

    getCustomRuleId: () => {
      const state = get();
      const customRule = state.peakRules.find(r => r.source === 'custom');
      return customRule?.id ?? 'default-custom';
    },
  };
}
