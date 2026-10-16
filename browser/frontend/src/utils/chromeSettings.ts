/**
 * Settings that live in the window's chrome rather than the settings sidebar:
 * the read toolbar's groups (Reads, Layers, Quality, Cluster, Sort, Filter),
 * the top bar and the side rail. Their controls are found by the selectors
 * they already carry, so the toolbar needs no changes for the palette.
 */
import { useBrowserStore } from '../stores/browserStore';
import { defineSettings, type SettingDef } from './settingsCatalog';

const toolbar = (group: string, groupLabel: string, selector: string): SettingDef['location'] =>
  ({ kind: 'toolbar', group, groupLabel, selector });

export const TOOLBAR_SETTINGS = defineSettings({
  rowHeight: {
    id: 'toolbar.row-height',
    label: 'Read row height',
    keywords: ['row height', 'thinner', 'thicker', 'read height', 'taller rows', 'compact'],
    location: toolbar('reads', 'Reads', '[data-testid="read-display-row-height-stepper"], [data-testid="read-display-row-height-compact"]'),
  },
  fitAll: {
    id: 'toolbar.read-display-mode',
    label: 'Reads: Fit or All',
    keywords: ['fit', 'all reads', 'display mode', 'sample', 'every read', 'scroll reads'],
    location: toolbar('reads', 'Reads', '[data-testid="read-display-mode-toggle"]'),
  },
  sampleCount: {
    id: 'toolbar.read-sample-count',
    label: 'Reads drawn in Fit mode',
    keywords: ['sample count', 'how many reads', 'read count'],
    location: toolbar('reads', 'Reads', '[data-testid="read-display-sample-count"]'),
  },
  layers: {
    id: 'toolbar.layers',
    label: 'Layers shown on the reads',
    keywords: ['nucleosomes', 'tf footprints', 'fire', 'accessibility', 'm6a', 'methylation', 'deamination', 'layer toggles'],
    location: toolbar('layers', 'Layers', '[data-testid="layer-toggle-group"]'),
  },
  edges: {
    id: 'toolbar.footprint-edges',
    label: 'Footprint edges: strict, soft or loose',
    keywords: ['edges', 'edge ambiguity', 'boundary', 'fuzzy edges', 'crisp'],
    location: toolbar('quality', 'Quality', '[aria-label="Footprint edges"]'),
  },
  clusterMethod: {
    id: 'toolbar.cluster-method',
    label: 'Clustering method',
    keywords: ['kmeans', 'hierarchical', 'leiden', 'algorithm', 'cluster mode', 'neighbourhoods', 'neighborhoods', 't-sne graph', 'tsne', 'graph clustering', 'hdbscan', 'combinatorial'],
    location: toolbar('cluster', 'Cluster', '[data-copilot-anchor="cluster-mode-select"]'),
  },
  clusterK: {
    id: 'toolbar.cluster-k',
    label: 'Number of clusters (K)',
    keywords: ['k', 'cluster count', 'how many clusters'],
    // Shown for the methods that take K (k-means, hierarchical).
    location: toolbar('cluster', 'Cluster', '[data-testid="cluster-k-input"]'),
  },
  clusterResolution: {
    id: 'toolbar.cluster-resolution',
    label: 'Neighbourhoods clustering resolution',
    keywords: ['resolution', 'more clusters', 'fewer clusters', 'graph', 't-sne', 'tsne', 'modularity', 'leiden'],
    // Shown for Neighbourhoods (t-SNE graph) clustering.
    location: toolbar('cluster', 'Cluster', '[data-testid="cluster-resolution-input"]'),
  },
  sortBy: {
    id: 'toolbar.sort-by',
    label: 'Sort reads by',
    keywords: ['sort order', 'order reads', 'arrange', 'by projection', 't-sne', 'tsne', 'similarity', 'sort by map'],
    location: toolbar('sort', 'Sort', '[data-testid="toolbar-group-controls-sort"] select'),
  },
  filterRule: {
    id: 'toolbar.filter-rule',
    label: 'Read filter rule',
    keywords: ['filter', 'subset reads', 'analysis filter'],
    location: toolbar('filter', 'Filter', '[data-testid="toolbar-group-controls-filter"] select'),
  },
  highlightColor: {
    id: 'toolbar.highlight-color',
    label: 'Colour of the next highlight',
    keywords: ['highlight', 'highlight colour', 'highlight color', 'shade', 'region colour'],
    location: toolbar('highlight', 'Highlight', '[role="radiogroup"][aria-label="Colour of the next highlight"]'),
  },
});

export const WINDOW_SETTINGS = defineSettings({
  darkMode: {
    id: 'chrome.dark-mode',
    label: 'Dark mode',
    keywords: ['theme', 'appearance', 'night', 'light mode', 'colors'],
    location: { kind: 'chrome', place: 'Side rail', selector: '[aria-label="Dark mode"], [aria-label="Light mode"]' },
    toggle: {
      get: () => useBrowserStore.getState().darkMode,
      set: on => { const s = useBrowserStore.getState(); if (s.darkMode !== on) s.toggleDarkMode(); },
    },
  },
  analysisDetails: {
    id: 'chrome.analysis-details',
    label: 'Analysis details',
    keywords: ['provenance', 'seeds', 'run details', 'reproducibility', 'inputs'],
    location: { kind: 'chrome', place: 'Top bar › More', selector: '[data-testid="toolbar-more-button"]' },
    toggle: {
      get: () => useBrowserStore.getState().showAnalysisDetails,
      set: on => useBrowserStore.getState().setShowAnalysisDetails(on),
    },
  },
  perPanelNavigation: {
    id: 'chrome.per-panel-navigation',
    label: 'Each panel navigates (own locus box per panel)',
    keywords: ['navigation mode', 'linked', 'per panel', 'independent panels', 'navigation toggle'],
    location: { kind: 'chrome', place: 'Top bar › Navigation', selector: '[data-testid="nav-mode-perPanel"]' },
    toggle: {
      get: () => useBrowserStore.getState().navigationMode === 'perPanel',
      set: on => useBrowserStore.getState().setNavigationMode(on ? 'perPanel' : 'linked'),
    },
  },
  genomeMap: {
    id: 'chrome.genome-map',
    label: 'Genome map',
    keywords: ['genome overview', 'coverage map', 'chromosome overview'],
    location: { kind: 'chrome', place: 'Top bar › Navigation', selector: '[data-testid="coverage-map-toggle"]' },
    toggle: {
      get: () => useBrowserStore.getState().showGenomeOverview,
      set: on => { const s = useBrowserStore.getState(); if (s.showGenomeOverview !== on) s.toggleGenomeOverview(); },
    },
  },
});
