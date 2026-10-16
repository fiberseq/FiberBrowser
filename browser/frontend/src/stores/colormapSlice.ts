import type { BrowserState } from './browserStore';
import { DEFAULT_COLORMAP, type Colormap, type ColorRule, type ColormapQualityShading, type DisplaySmoothingConfig, type EdgeAmbiguityConfig, type TfOverlayConfig, type LayerQualityFilter } from '../types';
import { getInitialColormap, loadColormapsFromStorage, saveColormapsToStorage, loadDefaultColormapName, DEFAULT_COLORMAP_STORAGE_KEY, migrateColormap } from './utils';
import { normalizeAnnotationLayer, normalizeQualityFilterLayers } from '../utils/layerAliases';

// ============================================================
// COLORMAP SLICE — Interface
// ============================================================

export interface ColormapSlice {
  activeColormap: Colormap;
  savedColormaps: Colormap[];

  // UI State
  setActiveColormap: (colormap: Partial<Colormap>) => void;
  updateColormapRule: (ruleId: string, updates: Partial<ColorRule>) => void;
  addColormapRule: (rule: ColorRule) => void;
  addColormapRuleAtTop: (rule: ColorRule) => void;
  removeColormapRule: (ruleId: string) => void;
  reorderColormapRules: (fromIndex: number, toIndex: number) => void;
  setReadBackgroundColor: (color: string) => void;
  setNoReadBackgroundColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  setDisplaySmoothing: (smoothing: Partial<DisplaySmoothingConfig>) => void;
  setEdgeAmbiguity: (partial: Partial<EdgeAmbiguityConfig>) => void;
  setQualityShading: (shading: Partial<ColormapQualityShading>) => void;
  // v3 caller quality controls
  setTfOverlay: (partial: Partial<TfOverlayConfig>) => void;
  setLayerOpacity: (layer: string, opacity: number) => void;
  setLayerBackgroundOpacity: (layer: string, opacity: number) => void;
  setQualityFilters: (filters: LayerQualityFilter[]) => void;
  updateQualityFilter: (index: number, partial: Partial<LayerQualityFilter>) => void;
  addQualityFilter: (filter: LayerQualityFilter) => void;
  removeQualityFilter: (index: number) => void;
  // Persistence
  saveColormap: (name: string) => void;
  loadColormap: (name: string) => void;
  deleteColormap: (name: string) => void;
  setDefaultColormap: (name: string | null) => void;
}

// ============================================================
// COLORMAP SLICE — Implementation
// ============================================================

export function createColormapSlice(set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void, get: () => BrowserState): ColormapSlice {
  const ensureLabelingBaseline = () => {
    const state = get();
    if (state._historyStack?.length === 0) {
      state.pushSnapshot?.('Before labeling change', { kind: 'labeling' });
    }
  };
  const pushLabelingSnapshot = (label: string, coalesceKey?: string) => {
    get().pushSnapshot?.(label, {
      kind: 'labeling',
      coalesceKey,
      coalesceMs: 1200,
    });
  };
  const normalizeRule = (rule: ColorRule): ColorRule => ({
    ...rule,
    opacity: Math.max(0, Math.min(1, Number.isFinite(Number(rule.opacity)) ? Number(rule.opacity) : 1)),
  });
  const normalizeRuleUpdates = (updates: Partial<ColorRule>): Partial<ColorRule> => (
    updates.opacity === undefined
      ? updates
      : {
        ...updates,
        opacity: Math.max(0, Math.min(1, Number.isFinite(Number(updates.opacity)) ? Number(updates.opacity) : 1)),
      }
  );
  return {
  activeColormap: getInitialColormap(),
  savedColormaps: loadColormapsFromStorage(),

  setActiveColormap: (colormap) => {
    ensureLabelingBaseline();
    set({ activeColormap: migrateColormap(colormap) });
    pushLabelingSnapshot('Load labeling preset', 'labeling:preset');
  },
  updateColormapRule: (ruleId, updates) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      rules: state.activeColormap.rules.map(r =>
        r.id === ruleId ? { ...r, ...normalizeRuleUpdates(updates) } : r
      ),
    },
    }));
    pushLabelingSnapshot('Update labeling rule', `labeling:rule:${ruleId}`);
  },
  addColormapRule: (rule) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      rules: [...state.activeColormap.rules, normalizeRule(rule)],
    },
    }));
    pushLabelingSnapshot('Add labeling rule');
  },
  addColormapRuleAtTop: (rule) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      rules: [normalizeRule(rule), ...state.activeColormap.rules],
    },
    }));
    pushLabelingSnapshot('Add labeling rule');
  },
  removeColormapRule: (ruleId) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      rules: state.activeColormap.rules.filter(r => r.id !== ruleId),
    },
    }));
    pushLabelingSnapshot('Remove labeling rule');
  },
  reorderColormapRules: (fromIndex, toIndex) => {
    ensureLabelingBaseline();
    set(state => {
    const newRules = [...state.activeColormap.rules];
    const [moved] = newRules.splice(fromIndex, 1);
    newRules.splice(toIndex, 0, moved);
    return { activeColormap: { ...state.activeColormap, rules: newRules } };
    });
    pushLabelingSnapshot('Reorder labeling rules', 'labeling:rule-order');
  },
  setReadBackgroundColor: (color) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      readBackgroundColor: /^#[0-9a-fA-F]{6}$/.test(color)
        ? color
        : (state.activeColormap.readBackgroundColor ?? '#f1f5f9'),
    },
    }));
    pushLabelingSnapshot('Set read background', 'labeling:read-background');
  },
  setNoReadBackgroundColor: (color) => {
    ensureLabelingBaseline();
    set(state => {
    const next = /^#[0-9a-fA-F]{6}$/.test(color)
      ? color
      : (state.activeColormap.noReadBackgroundColor ?? state.activeColormap.backgroundColor ?? '#ffffff');
    return {
      activeColormap: {
        ...state.activeColormap,
        backgroundColor: next,
        noReadBackgroundColor: next,
      },
    };
    });
    pushLabelingSnapshot('Set no-read background', 'labeling:no-read-background');
  },
  setBackgroundColor: (color) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      backgroundColor: /^#[0-9a-fA-F]{6}$/.test(color) ? color : (state.activeColormap.backgroundColor ?? '#ffffff'),
      noReadBackgroundColor: /^#[0-9a-fA-F]{6}$/.test(color)
        ? color
        : (state.activeColormap.noReadBackgroundColor ?? state.activeColormap.backgroundColor ?? '#ffffff'),
    },
    }));
    pushLabelingSnapshot('Set no-read background', 'labeling:no-read-background');
  },
  setDisplaySmoothing: (smoothing) => {
    ensureLabelingBaseline();
    set(state => {
    const current = state.activeColormap.displaySmoothing ?? { enabled: false, sigmaX: 0, sigmaY: 0 };
    return {
      activeColormap: {
        ...state.activeColormap,
        displaySmoothing: {
          ...current,
          ...smoothing,
          sigmaX: Math.max(0, Math.min(10, Number(smoothing.sigmaX ?? current.sigmaX) || 0)),
          sigmaY: Math.max(0, Math.min(10, Number(smoothing.sigmaY ?? current.sigmaY) || 0)),
        },
      },
    };
    });
    pushLabelingSnapshot('Set layer smoothing', 'labeling:smoothing');
  },
  setEdgeAmbiguity: (partial) => {
    ensureLabelingBaseline();
    set(state => {
      const current = state.activeColormap.edgeAmbiguity ?? DEFAULT_COLORMAP.edgeAmbiguity;
      return {
        activeColormap: {
          ...state.activeColormap,
          edgeAmbiguity: {
            ...current,
            ...partial,
            maxGapBp: Math.max(0, Math.min(500, Number(partial.maxGapBp ?? current.maxGapBp) || 0)),
          },
        },
      };
    });
    pushLabelingSnapshot('Set edge ambiguity', 'labeling:edge-ambiguity');
  },
  setQualityShading: (shading) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      qualityShading: { ...state.activeColormap.qualityShading, ...shading },
    },
    }));
    pushLabelingSnapshot('Set quality shading', 'labeling:quality-shading');
  },
  setTfOverlay: (partial) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      tfOverlay: { ...state.activeColormap.tfOverlay, ...partial },
    },
    }));
    pushLabelingSnapshot('Set TF overlay', 'labeling:tf-overlay');
  },
  setLayerOpacity: (layer, opacity) => {
    ensureLabelingBaseline();
    set(state => {
    const key = normalizeAnnotationLayer(layer) ?? layer;
    return {
      activeColormap: {
        ...state.activeColormap,
        layerOpacities: {
          ...DEFAULT_COLORMAP.layerOpacities,
          ...(state.activeColormap.layerOpacities ?? {}),
          [key]: Math.max(0, Math.min(1, Number(opacity) || 0)),
        },
      },
    };
    });
    pushLabelingSnapshot('Set layer opacity', `labeling:layer-opacity:${layer}`);
  },
  setLayerBackgroundOpacity: (layer, opacity) => {
    ensureLabelingBaseline();
    set(state => {
    const key = normalizeAnnotationLayer(layer) ?? layer;
    return {
      activeColormap: {
        ...state.activeColormap,
        layerBackgroundOpacities: {
          ...DEFAULT_COLORMAP.layerBackgroundOpacities,
          ...(state.activeColormap.layerBackgroundOpacities ?? {}),
          [key]: Math.max(0, Math.min(1, Number(opacity) || 0)),
        },
      },
    };
    });
    pushLabelingSnapshot('Set layer baseline opacity', `labeling:layer-background-opacity:${layer}`);
  },
  setQualityFilters: (filters) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: { ...state.activeColormap, qualityFilters: normalizeQualityFilterLayers(filters) },
    }));
    pushLabelingSnapshot('Set quality filters', 'labeling:quality-filters');
  },
  updateQualityFilter: (index, partial) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      qualityFilters: state.activeColormap.qualityFilters.map((f, i) =>
        i === index ? normalizeQualityFilterLayers([{ ...f, ...partial }])[0] : f
      ),
    },
    }));
    pushLabelingSnapshot('Update quality filter', `labeling:quality-filter:${index}`);
  },
  addQualityFilter: (filter) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      qualityFilters: [...state.activeColormap.qualityFilters, normalizeQualityFilterLayers([filter])[0]],
    },
    }));
    pushLabelingSnapshot('Add quality filter');
  },
  removeQualityFilter: (index) => {
    ensureLabelingBaseline();
    set(state => ({
    activeColormap: {
      ...state.activeColormap,
      qualityFilters: state.activeColormap.qualityFilters.filter((_, i) => i !== index),
    },
    }));
    pushLabelingSnapshot('Remove quality filter');
  },
  saveColormap: (name) => {
    const state = get();
    const colormapToSave = { ...state.activeColormap, name };
    const existing = state.savedColormaps.filter(c => c.name !== name);
    const newSaved = [...existing, colormapToSave];
    saveColormapsToStorage(newSaved);
    set({ savedColormaps: newSaved, activeColormap: colormapToSave });
  },
  loadColormap: (name) => {
    const state = get();
    const found = state.savedColormaps.find(c => c.name === name);
    if (found) set({ activeColormap: found });
  },
  deleteColormap: (name) => {
    const state = get();
    const newSaved = state.savedColormaps.filter(c => c.name !== name);
    saveColormapsToStorage(newSaved);
    // If default was deleted, clear default
    if (loadDefaultColormapName() === name) {
      localStorage.removeItem(DEFAULT_COLORMAP_STORAGE_KEY);
    }
    set({ savedColormaps: newSaved });
  },
  setDefaultColormap: (name) => {
    if (name) {
      localStorage.setItem(DEFAULT_COLORMAP_STORAGE_KEY, name);
    } else {
      localStorage.removeItem(DEFAULT_COLORMAP_STORAGE_KEY);
    }
  },
  };
}
