import type { BrowserState } from './browserStore';
import {
  activateAnnotationFile as apiActivateAnnotationFile,
  deactivateAnnotationFile as apiDeactivateAnnotationFile,
} from '../api/annotations';

// ============================================================
// ANNOTATION SLICE — Types
// ============================================================

export interface AnnotationTypeInfo {
  name: string;
  category: string;
  description: string;
  color: string;
  count?: number;
}

export interface AnnotationFileInfo {
  id: string;
  path: string;
  label: string;
  active: boolean;
  datasetIds: string[];
  annotationTypes: AnnotationTypeInfo[];
}

/** One panel viewport's overlays (same shapes as the main view's). */
export interface AnnotationViewportOverlays {
  annotations: Record<string, ReadAnnotation[]>;
  byDataset: Record<string, Record<string, ReadAnnotation[]>>;
}

/** The key for a viewport's overlays in `annotationOverlaysByViewport`. */
export const annotationViewportKey = (chrom: string, start: number, end: number) => `${chrom}:${start}-${end}`;

export interface ReadAnnotation {
  start: number;
  end: number;
  type: string;
  confidence: number;
}

// ============================================================
// ANNOTATION SLICE — Interface
// ============================================================

export interface AnnotationSlice {
  // State
  annotationFiles: AnnotationFileInfo[];
  enabledAnnotationTypes: Record<string, boolean>;
  annotationThresholds: Record<string, number>;
  annotationColors: Record<string, string>;
  // Flat overlay data: readId -> annotations[] (shared across all datasets)
  annotationOverlays: Record<string, ReadAnnotation[]>;
  /** Per dataset (files that apply to it, over its own reads); read names can repeat across datasets. */
  annotationOverlaysByDataset: Record<string, Record<string, ReadAnnotation[]>>;
  /**
   * Overlays for panels at their own locus, by `annotationViewportKey`. The
   * fields above are for the main view; positions are relative to the start of
   * the view they were fetched for, so a panel elsewhere must use its own.
   */
  annotationOverlaysByViewport: Record<string, AnnotationViewportOverlays>;
  /**
   * The view (`annotationViewportKey`) the main-view overlays were fetched for:
   * after the view moves they describe the old one until a refresh succeeds, so
   * they are drawn only while it matches (null: not recorded).
   */
  annotationOverlaysViewport: string | null;
  annotationOpacityMin: number;  // 0–1, default 0.2
  annotationOpacityMax: number;  // 0–1, default 0.6
  // Actions
  setAnnotationFiles: (files: AnnotationFileInfo[]) => void;
  activateAnnotationFile: (fileId: string) => Promise<void>;
  deactivateAnnotationFile: (fileId: string) => Promise<void>;
  toggleAnnotationType: (name: string, enabled: boolean) => void;
  setAnnotationThreshold: (name: string, threshold: number) => void;
  setAnnotationColor: (name: string, color: string) => void;
  setAnnotationOverlays: (data: Record<string, ReadAnnotation[]>, byDataset?: Record<string, Record<string, ReadAnnotation[]>>, viewportKey?: string) => void;
  setAnnotationViewportOverlays: (byViewport: Record<string, AnnotationViewportOverlays>) => void;
  clearAnnotationOverlays: () => void;
  hasActiveAnnotations: () => boolean;
  setAnnotationOpacityRange: (min: number, max: number) => void;
}

// ============================================================
// ANNOTATION SLICE — Implementation
// ============================================================

export function createAnnotationSlice(
  set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void,
  get: () => BrowserState
): AnnotationSlice {
  return {
    annotationFiles: [],
    enabledAnnotationTypes: {},
    annotationThresholds: {},
    annotationColors: {},
    annotationOverlays: {},
    annotationOverlaysByDataset: {},
    annotationOverlaysByViewport: {},
    annotationOverlaysViewport: null,
    annotationOpacityMin: 0.2,
    annotationOpacityMax: 0.6,
    setAnnotationFiles: (files) => set({ annotationFiles: files }),

    activateAnnotationFile: async (fileId) => {
      try {
        const result = await apiActivateAnnotationFile(fileId);
        // Update files list
        set(state => ({
          annotationFiles: state.annotationFiles.map(f =>
            f.id === fileId ? { ...f, ...result.file, active: true } : f
          ),
          // Enable all discovered types and set their colors
          enabledAnnotationTypes: {
            ...state.enabledAnnotationTypes,
            ...Object.fromEntries(
              (result.file.annotationTypes || []).map((t: AnnotationTypeInfo) => [t.name, true])
            ),
          },
          annotationColors: {
            ...state.annotationColors,
            ...Object.fromEntries(
              (result.file.annotationTypes || []).map((t: AnnotationTypeInfo) => [t.name, t.color])
            ),
          },
        }));
      } catch (err) {
        console.error('Failed to activate annotation file:', err);
      }
    },

    deactivateAnnotationFile: async (fileId) => {
      try {
        await apiDeactivateAnnotationFile(fileId);
        set(state => ({
          annotationFiles: state.annotationFiles.map(f =>
            f.id === fileId ? { ...f, active: false } : f
          ),
          annotationOverlays: {},  // Clear overlays when deactivating
          annotationOverlaysByDataset: {},
          annotationOverlaysByViewport: {},
          annotationOverlaysViewport: null,
        }));
      } catch (err) {
        console.error('Failed to deactivate annotation file:', err);
      }
    },

    toggleAnnotationType: (name, enabled) => set(state => ({
      enabledAnnotationTypes: { ...state.enabledAnnotationTypes, [name]: enabled },
    })),

    setAnnotationThreshold: (name, threshold) => set(state => ({
      annotationThresholds: { ...state.annotationThresholds, [name]: threshold },
    })),

    setAnnotationColor: (name, color) => set(state => ({
      annotationColors: { ...state.annotationColors, [name]: color },
    })),

    setAnnotationOverlays: (data, byDataset, viewportKey) => set({
      annotationOverlays: data, annotationOverlaysByDataset: byDataset ?? {}, annotationOverlaysViewport: viewportKey ?? null,
    }),

    setAnnotationViewportOverlays: (byViewport) => set({ annotationOverlaysByViewport: byViewport }),

    clearAnnotationOverlays: () => set({ annotationOverlays: {}, annotationOverlaysByDataset: {}, annotationOverlaysByViewport: {}, annotationOverlaysViewport: null }),

    setAnnotationOpacityRange: (min, max) => set({
      annotationOpacityMin: min,
      annotationOpacityMax: max,
    }),

    hasActiveAnnotations: () => {
      const state = get();
      return state.annotationFiles.some(f => f.active) &&
        Object.values(state.enabledAnnotationTypes).some(v => v);
    },

  };
}
