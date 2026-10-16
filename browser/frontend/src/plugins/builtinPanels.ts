import { lazy } from 'react';
import { registerAnalysisPanel } from './registry';
import { isCopilotIncluded } from '../utils/copilotIncluded';

const LazyColormapEditor = lazy(() =>
  import('../components/controls/ColormapEditor').then(m => ({ default: m.ColormapEditorInline }))
);
const LazyClusterDetail = lazy(() =>
  import('../components/controls/ClusterDetailPanel').then(m => ({ default: m.ClusterDetailPanel }))
);
const LazyClusterFeatureRules = lazy(() =>
  import('../components/controls/ClusterFeatureRulesPanel').then(m => ({ default: m.ClusterFeatureRulesPanel }))
);
const LazyTranscriptionState = lazy(() =>
  import('../components/controls/TranscriptionStatePanel').then(m => ({ default: m.TranscriptionStatePanel }))
);
const LazyFootprintAnalysis = lazy(() =>
  import('../components/controls/FootprintAnalysisPanel').then(m => ({ default: m.FootprintAnalysisPanel }))
);
const LazyContactMap = lazy(() =>
  import('../components/ContactMapPanel').then(m => ({ default: m.ContactMapPanel }))
);
const LazyReadStats = lazy(() =>
  import('../components/controls/ReadStatsPanel').then(m => ({ default: m.ReadStatsPanel }))
);
const LazyPrimerDesign = lazy(() =>
  import('../components/controls/PrimerDesignPanel').then(m => ({ default: m.PrimerDesignPanel }))
);
const LazyHistory = lazy(() =>
  import('../components/controls/HistoryAnalysisPanel').then(m => ({ default: m.HistoryAnalysisPanel }))
);
const LazyTrackBrowser = lazy(() =>
  import('../components/controls/TrackBrowserPanel').then(m => ({ default: m.TrackBrowserPanel }))
);
const LazyDatasetLayout = lazy(() =>
  import('../components/controls/DatasetLayoutPanel').then(m => ({ default: m.DatasetLayoutPanel }))
);
const LazyCoAccessibility = lazy(() =>
  import('../components/controls/CoAccessibilityPanel').then(m => ({ default: m.CoAccessibilityPanel }))
);
const LazyAnnotations = lazy(() =>
  import('../components/controls/AnnotationPanel').then(m => ({ default: m.AnnotationPanel }))
);
const LazyCapture = lazy(() =>
  import('../components/controls/CapturePanel').then(m => ({ default: m.CapturePanel }))
);
const LazyPeakDetection = lazy(() =>
  import('../components/controls/PeakDetectionPanel').then(m => ({ default: m.PeakDetectionPanel }))
);
const LazyGenomeNavigator = lazy(() =>
  import('../components/controls/CircularGenomePanel').then(m => ({ default: m.CircularGenomePanel }))
);

registerAnalysisPanel({
  contentType: 'colormap',
  label: 'Labeling',
  shortLabel: 'Labeling',
  headerColor: '#7c3aed',
  component: LazyColormapEditor,
  description: 'How footprints are coloured, quality filters, display options, and saved presets',
  group: 'view',
  stripOrder: 2,
  settingsTargets: ['Labeling & Quality', 'Analysis & Reproducibility'],
  sessionKeys: ['activeColormap', 'savedColormaps'],
  apiEndpoints: ['/api/quality_filters', '/api/jupyter/settings'],
});

registerAnalysisPanel({
  contentType: 'cluster-detail',
  label: 'Clusters',
  shortLabel: 'Clusters',
  headerColor: '#0891b2',
  component: LazyClusterDetail,
  description: 'Cluster visualization with profiles and composition',
  group: 'analysis',
  stripOrder: 1,
  settingsTargets: ['Clustering', 'Peak Detection', 'Labeling & Quality'],
  sessionKeys: ['clusterAssignments', 'clusterOrder', 'clusterPeakRegions', 'clusterMatchedRun', 'savedClusters'],
  apiEndpoints: ['/api/cluster_all', '/api/cluster/vplot', '/api/cluster_projection'],
});

registerAnalysisPanel({
  contentType: 'cluster-features',
  label: 'Rules',
  shortLabel: 'Rules',
  headerColor: '#9333ea',
  component: LazyClusterFeatureRules,
  description: 'Peak, cluster, sort and filter rules with saved presets',
  group: 'view',
  stripOrder: 3,
  settingsTargets: ['Clustering', 'Peak Detection', 'Labeling & Quality', 'Footprint Analysis', 'Selected Genes'],
  sessionKeys: ['clusterFeatureRules', 'savedClusterFeatureRuleSets', 'analysisSortRules', 'analysisFilterRules', 'peakRules', 'savedPeakPresets', 'activeColormap', 'savedColormaps'],
  apiEndpoints: ['/api/cluster_all', '/api/cluster_projection', '/api/assign_to_clusters'],
});

registerAnalysisPanel({
  contentType: 'transcription-state',
  label: 'Transcription',
  shortLabel: 'Transcription',
  headerColor: '#d97706',
  component: LazyTranscriptionState,
  description: 'Transcription state filtering and analysis',
  group: 'analysis',
  stripOrder: 3,
  settingsTargets: ['Labeling & Quality', 'Selected Genes'],
  sessionKeys: ['selectedGenes', 'transcriptionStateFilters', 'readStateDetails'],
  apiEndpoints: ['/api/filter_by_transcription_state', '/api/pol2_com'],
});

registerAnalysisPanel({
  contentType: 'footprint-analysis',
  label: 'Footprints',
  shortLabel: 'Footprints',
  headerColor: '#10b981',
  component: LazyFootprintAnalysis,
  description: 'What is bound at a footprint: its classes, motif matches, and co-occupancy',
  group: 'analysis',
  stripOrder: 2,
  settingsTargets: ['Analysis & Reproducibility', 'Labeling & Quality'],
  sessionKeys: ['selectedFootprints', 'footprintGroups', 'footprintFilterKey'],
  apiEndpoints: ['/api/footprint/analyze'],
});

registerAnalysisPanel({
  contentType: 'contact-map',
  label: 'Contacts',
  shortLabel: 'Contacts',
  headerColor: '#dc2626',
  component: LazyContactMap,
  description: 'Contact matrices and paired-region or haplotype comparisons',
  group: 'analysis',
  stripOrder: 6,
  settingsTargets: ['Genome', 'DAF-C'],
  sessionKeys: ['contactMode', 'splitViewMode', 'dafcSelection'],
  apiEndpoints: ['/api/dafc/*', '/api/contact/*'],
});

registerAnalysisPanel({
  contentType: 'read-stats',
  label: 'Read Stats',
  headerColor: '#8b5cf6',
  component: LazyReadStats,
  description: 'Per-read alignment and footprint statistics',
  group: 'analysis',
  stripOrder: 4,
  settingsTargets: ['Read Selection', 'Analysis & Reproducibility'],
  sessionKeys: ['selectedReadIds', 'readSortOrder'],
  apiEndpoints: ['/api/reads/stats'],
});

registerAnalysisPanel({
  contentType: 'primer-design',
  hostOnly: true,
  label: 'Primers',
  shortLabel: 'Primers',
  headerColor: '#e11d48',
  component: LazyPrimerDesign,
  description: 'Design PCR primers and manage capture regions for selected targets',
  group: 'tools',
  stripOrder: 1,
  settingsTargets: ['Primer Design', 'Capture Regions'],
  sessionKeys: ['primerDesigns', 'selectedPeaks', 'captureRegions', 'capturePadding'],
  apiEndpoints: ['/api/design_primers', '/api/design_dafc_primers'],
});

registerAnalysisPanel({
  contentType: 'history',
  // Shown on public pages too: the guided tour works there (Copilot's tab hides itself).
  label: 'Tutorial',
  shortLabel: 'Tutorial',
  headerColor: '#64748b',
  component: LazyHistory,
  description: isCopilotIncluded()
    ? 'Guided tour (start at any step) and Copilot, which answers plain-language requests'
    : 'Guided tour (start at any step)',
  group: 'tools',
  stripOrder: 2,
  settingsTargets: ['Session'],
  sessionKeys: ['historySnapshots', 'commandHistory'],
  apiEndpoints: ['/api/nl/plan', '/api/session/export', '/api/session/import'],
});

registerAnalysisPanel({
  contentType: 'track-browser',
  label: 'Tracks',
  shortLabel: 'Tracks',
  headerColor: '#2563eb',
  component: LazyTrackBrowser,
  description: 'Browse UCSC, ENCODE, and ChIP-Atlas tracks',
  group: 'view',
  stripOrder: 1,
  settingsTargets: ['Tracks', 'Genome'],
  sessionKeys: ['catalog', 'compositeTracks', 'savedTracks'],
  apiEndpoints: ['/api/catalog', '/api/tracks', '/api/ucsc/*', '/api/encode/*', '/api/chipatlas/*'],
});

registerAnalysisPanel({
  contentType: 'dataset-layout',
  label: 'Layout',
  shortLabel: 'Layout',
  headerColor: '#475569',
  component: LazyDatasetLayout,
  description: 'Dataset grouping, merge/fan-out, link groups, and saved path arrangements',
  group: 'view',
  stripOrder: 4,
  minUsableWidth: 340,
  settingsTargets: ['Session'],
  sessionKeys: ['datasets', 'panels', 'selectedDatasets'],
  apiEndpoints: ['/api/datasets/add', '/api/datasets/*', '/api/datasets/merge', '/api/datasets/unmerge'],
});

registerAnalysisPanel({
  contentType: 'co-accessibility',
  label: 'Co-accessibility',
  shortLabel: 'Co-accessibility',
  headerColor: '#0d9488',
  component: LazyCoAccessibility,
  description: 'Which positions open together on single molecules: a position-by-position matrix',
  group: 'analysis',
  stripOrder: 5,
  settingsTargets: ['Analysis & Reproducibility', 'Cluster Detail'],
  sessionKeys: ['clusterFocus', 'analysisSampleSeed'],
  apiEndpoints: ['/api/coacc/metadata', '/api/coacc/matrix/data', '/api/coacc/matrix/image'],
});

registerAnalysisPanel({
  contentType: 'annotations',
  label: 'Annotations',
  shortLabel: 'Annotations',
  headerColor: '#6366f1',
  component: LazyAnnotations,
  description: 'Read-level annotation overlays from FiberCNN, factorCNN, etc.',
  group: 'view',
  stripOrder: 6,
  settingsTargets: ['Annotations', 'Track Browser'],
  sessionKeys: ['annotationFiles', 'enabledAnnotationTypes', 'annotationThresholds'],
  apiEndpoints: ['/api/annotations/*'],
});

registerAnalysisPanel({
  contentType: 'capture',
  label: 'Capture Regions',
  shortLabel: 'Capture',
  headerColor: '#4f46e5',
  component: LazyCapture,
  description: 'Accumulate genomic regions for Twist capture panel design',
  group: 'tools',
  settingsTargets: ['Capture Design', 'Peak Detection'],
  sessionKeys: ['captureRegions', 'capturePadding'],
  apiEndpoints: ['/api/jupyter/settings', '/api/session/export'],
});

registerAnalysisPanel({
  contentType: 'peak-detection',
  label: 'Peak Detection',
  shortLabel: 'Peaks',
  headerColor: '#1d4ed8',
  component: LazyPeakDetection,
  description: 'Rule-based peak detection with configurable sources and thresholds',
  group: 'analysis',
  settingsTargets: ['Peak Detection', 'Analysis & Reproducibility'],
  sessionKeys: ['peakRules', 'peaksByRule', 'selectedPeaks', 'peaksLocked'],
  apiEndpoints: ['/api/scan_peaks', '/api/detect_peaks', '/api/jupyter/peak_rules'],
});

registerAnalysisPanel({
  contentType: 'circular-genome',
  label: 'Regions',
  shortLabel: 'Regions',
  headerColor: '#0f766e',
  component: LazyGenomeNavigator,
  description: 'Saved regions in categories (amplicons, BED files, views), whole-chromosome and circular/plasmid maps',
  group: 'view',
  stripOrder: 5,
  settingsTargets: ['Genome', 'Tracks', 'DAF-C'],
  sessionKeys: ['chrom', 'start', 'end', 'navigatorRegions', 'regionCatalogs'],
  apiEndpoints: ['/api/chroms', '/api/sequence', '/api/genes', '/api/load_plasmid', '/api/load_plasmids', '/api/circular_chrom',
    '/api/regions/catalog', '/api/reads/regions', '/api/regions/label'],
});
