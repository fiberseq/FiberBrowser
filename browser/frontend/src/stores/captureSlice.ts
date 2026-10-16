import type { BrowserState } from './browserStore';
import type { CaptureRegion } from '../types/capture';
import { logActivity } from '../utils/activityLog';

const _log = (label: string, details: Record<string, unknown>) =>
  logActivity({ timestamp: Date.now(), kind: 'ui', label, details });

// ============================================================
// CAPTURE SLICE — Interface
// ============================================================

export interface CaptureSlice {
  captureRegions: CaptureRegion[];
  capturePadding: number;

  addCaptureRegion: (region: CaptureRegion) => void;
  addCaptureRegions: (regions: CaptureRegion[]) => void;
  removeCaptureRegion: (id: string) => void;
  updateCaptureRegionName: (id: string, name: string) => void;
  updateCaptureRegionPadding: (id: string, padding: number) => void;
  setCaptureRegions: (regions: CaptureRegion[]) => void;
  clearCaptureRegions: () => void;
  setCapturePadding: (padding: number) => void;
}

// ============================================================
// CAPTURE SLICE — Implementation
// ============================================================

export function createCaptureSlice(
  set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void,
  _get: () => BrowserState,
): CaptureSlice {
  return {
    captureRegions: [],
    capturePadding: 0,

    addCaptureRegion: (region) => {
      _log('add_capture_region', { id: region.id, name: region.name });
      set((s) => ({ captureRegions: [...s.captureRegions, region] }));
    },

    addCaptureRegions: (regions) => {
      _log('add_capture_regions', { count: regions.length });
      set((s) => ({ captureRegions: [...s.captureRegions, ...regions] }));
    },

    removeCaptureRegion: (id) => {
      _log('remove_capture_region', { id });
      set((s) => ({ captureRegions: s.captureRegions.filter((r) => r.id !== id) }));
    },

    updateCaptureRegionName: (id, name) => {
      _log('rename_capture_region', { id, name });
      set((s) => ({
        captureRegions: s.captureRegions.map((r) => (r.id === id ? { ...r, name } : r)),
      }));
    },

    updateCaptureRegionPadding: (id, padding) => {
      _log('repad_capture_region', { id, padding });
      set((s) => ({
        captureRegions: s.captureRegions.map((r) => (r.id === id ? { ...r, padding: Math.max(0, padding) } : r)),
      }));
    },

    setCaptureRegions: (regions) => {
      _log('set_capture_regions', { count: regions.length });
      set({ captureRegions: regions });
    },

    clearCaptureRegions: () => {
      _log('clear_capture_regions', {});
      set({ captureRegions: [] });
    },

    setCapturePadding: (padding) => {
      _log('set_capture_padding', { padding });
      set({ capturePadding: Math.max(0, padding) });
    },
  };
}
