/**
 * Test helpers for creating fresh Zustand stores.
 *
 * Each test creates a fresh store instance via create() so tests don't leak state.
 */
import { createNavigationSlice } from '../navigationSlice';
import { createSvSlice } from '../svSlice';
import { createHighlightSlice } from '../highlightSlice';
import { create } from 'zustand';
import type { BrowserState } from '../browserStore';
import { createViewportSlice } from '../viewportSlice';
import { createDatasetSlice } from '../datasetSlice';
import { createClusterSlice } from '../clusterSlice';
import { createPanelSlice } from '../panelSlice';
import { createColormapSlice } from '../colormapSlice';
import { createUiSlice } from '../uiSlice';
import { createJupyterSlice } from '../jupyterSlice';
import { createPrimerSlice } from '../primerSlice';
import { createSelectionSlice } from '../selectionSlice';
import { createHistorySlice } from '../historySlice';
import { createAnnotationSlice } from '../annotationSlice';
import { createCaptureSlice } from '../captureSlice';
import { createPeakRuleSlice } from '../peakRuleSlice';
import { createCatalogSlice } from '../catalogSlice';
import { createCompositeTracksSlice } from '../compositeTracksSlice';
import { createSavedTracksSlice } from '../savedTracksSlice';
import { registerAnalysisPanel, getAnalysisPanel } from '../../plugins/registry';

/**
 * Register builtin analysis panels if not already registered.
 * Must be called before any test that uses openAnalysisPanel.
 */
export function ensureBuiltinPanelsRegistered() {
  if (!getAnalysisPanel('cluster-detail')) {
    registerAnalysisPanel({
      contentType: 'cluster-detail',
      label: 'Clusters',
      headerColor: '#0891b2',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'cluster-features',
      label: 'Cluster Feature Rules',
      headerColor: '#9333ea',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'transcription-state',
      label: 'Transcription State',
      headerColor: '#d97706',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'footprint-analysis',
      label: 'Footprint Analysis',
      headerColor: '#10b981',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'colormap',
      label: 'Labeling & Quality',
      headerColor: '#7c3aed',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'contact-map',
      label: 'Contact Map',
      headerColor: '#dc2626',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'read-stats',
      label: 'Read Stats',
      headerColor: '#8b5cf6',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'primer-design',
      label: 'Primer Design',
      headerColor: '#e11d48',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'history',
      label: 'History',
      headerColor: '#64748b',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'track-browser',
      label: 'Track Browser',
      headerColor: '#2563eb',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'dataset-layout',
      label: 'Layout',
      headerColor: '#475569',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'co-accessibility',
      label: 'Co-Accessibility',
      headerColor: '#0d9488',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'annotations',
      label: 'Annotations',
      headerColor: '#6366f1',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'capture',
      label: 'Capture Regions',
      headerColor: '#4f46e5',
      component: () => null,
    });
    registerAnalysisPanel({
      contentType: 'peak-detection',
      label: 'Peak Detection',
      headerColor: '#1d4ed8',
      component: () => null,
    });
  }
}

/**
 * Create a fresh BrowserState store for testing.
 * Returns a Zustand store with all slices composed.
 */
export function createTestStore() {
  return create<BrowserState>((set, get) => ({
    ...createViewportSlice(set, get),
    ...createDatasetSlice(set, get),
    ...createClusterSlice(set, get),
    ...createPanelSlice(set, get),
    ...createColormapSlice(set, get),
    ...createUiSlice(set, get),
    ...createJupyterSlice(set, get),
    ...createPrimerSlice(set, get),
    ...createSelectionSlice(set, get),
    ...createHistorySlice(set, get),
    ...createAnnotationSlice(set, get),
    ...createCaptureSlice(set, get),
    ...createPeakRuleSlice(set, get),
    ...createCatalogSlice(set, get),
    ...createCompositeTracksSlice(set, get),
    ...createSavedTracksSlice(set, get),
      ...createNavigationSlice(set as any, get),
    ...createHighlightSlice(set as any, get),
    ...createSvSlice(set as any, get),
}) as BrowserState);
}
