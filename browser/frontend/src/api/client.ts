export type { GenomeInfo } from './reference';
export {
  getChromosomes,
  getGenes,
  getGenomes,
  getSequence,
  loadFasta,
  loadGenome,
  loadGtf,
  removeGtf,
  searchGene,
} from './reference';

export type {
  AutozoomResult,
  AnalysisFilterResult,
  ClusterExpandResult,
  CompactRead,
  SortReadsResult,
  WorkingSetInfo,
} from './readOperations';
export {
  autozoom,
  clusterExpand,
  compactReadsAllQueryKey,
  compactReadsQueryKey,
  filterReadsByAnalysisRule,
  filterReads,
  getCompactReads,
  getCompactReadsAll,
  getFire,
  getLinkedCompactReads,
  getMeta,
  getMetaAll,
  getWorkingSetInfo,
  linkedCompactReadsQueryKey,
  sortReads,
} from './readOperations';

export type { PeakDetectionSettings, ScanPeaksResponse } from './peaks';
export { scanPeaks } from './peaks';

export type {
  ClusterVPlotData,
  DissolvedCluster,
  PeakRegionWithMode,
  ProjectionMethod,
  ProjectionResponse,
} from './clustering';
export {
  assignToClusters,
  autoCullClusters,
  clusterAllReads,
  clusterReads,
  dissolveCluster,
  fetchClusterProjection,
  fetchClusterVPlot,
} from './clustering';

export type {
  BigBedNamesResponse,
  TrackAnnotationInterval,
  TrackAnnotationsResponse,
  TrackDataResponse,
  TrackListEntry,
} from './tracks';
export {
  addMotifFileTracks,
  addMotifSequenceTrack,
  addTrack,
  exportTrack,
  exportTracksMulti,
  getBigBedNames,
  getTrackAnnotations,
  getTrackData,
  getTracks,
  removeTrack,
  reorderTracks,
  updateTrackFilter,
} from './tracks';

export type { Dataset } from './datasets';
export {
  addDataset,
  getDatasets,
  mergeDatasets,
  refreshDatasetCapabilities,
  removeDataset,
  unmergeDataset,
} from './datasets';

export type { PickFileType, PickPathResponse } from './files';
export { loadFolder, pickAnyFile, pickDataset, pickFile, pickFolder, uploadFile } from './files';

export type { StatusResponse } from './status';
export { getStatus } from './status';

export type { Catalog, CatalogGroup, CatalogTrack } from './catalog';
export {
  catalogLoad,
  catalogTrackLoad,
  catalogTrackUnload,
  catalogUnload,
  getCatalog,
} from './catalog';

// Primer Design API
export type { PrimerPair } from '../types';
export type { PrimerConfigResponse, PrimerDesignOptions, PrimerProgressResponse } from './primers';
export {
  abortPrimerDesign,
  buildPrimerBlastDb,
  clearPrimers,
  design4cPrimers,
  designDafcPrimers,
  designPrimers,
  getPrimerConfig,
  getPrimerProgress,
  getPrimers,
  pickFilePrimer,
  setPrimerConfig,
} from './primers';

export type { ModificationOverlay, OverlayMarks } from './overlays';
export { addOverlay, getOverlayMarks, getOverlays, pickOverlayFile, removeOverlay } from './overlays';


export type {
  BrowserSettingsSnapshot,
  JupyterFootprintColor,
  JupyterHighlight,
  JupyterMarker,
  JupyterState,
} from './jupyter';
export {
  clearCache,
  getJupyterReads,
  getJupyterState,
  setJupyterSelection,
  syncBrowserReadOrder,
  syncJupyterBrowserSettings,
} from './jupyter';

export type {
  Pol2COMResult,
  ReadStateInfo,
  TranscriptionStateFilterResult,
  TranscriptionStateFilters,
} from './transcription';
export { fetchPol2COM, filterByTranscriptionState } from './transcription';


export type {
  S3ConfigureResult,
  S3ListResult,
  S3Object,
  S3Status,
  S3TestResult,
} from './s3';
export {
  configureS3,
  getPresignedUrl,
  getS3Status,
  listS3Bucket,
  testS3Access,
} from './s3';


export type {
  ChipAtlasFacet,
  ChipAtlasFacetsResponse,
  ChipAtlasSearchResponse,
  ChipAtlasStatus,
  ChipAtlasTrack,
  EncodeFacet,
  EncodeFacetsResponse,
  EncodeSearchResponse,
  EncodeTrack,
  UcscBrowseResponse,
  UcscTrack,
} from './externalTracks';
export {
  browseUcscTracks,
  getChipAtlasFacets,
  getChipAtlasStatus,
  getEncodeFacets,
  getUcscCurated,
  searchChipAtlas,
  searchEncode,
  searchUcscTracks,
} from './externalTracks';


// =============================================================================
// Footprint Analysis
// =============================================================================

export type {
  CoOccupancyPair,
  DerivedLayerBundleResult,
  FootprintAnalysisResult,
  FootprintInfo,
  MotifHit,
  OverlapEntry,
  PerGroupOccupancy,
  SelectedFootprintAPI,
  SizeHistogram,
} from './footprints';
export {
  analyzeFootprints,
  exportDerivedLayers,
  loadDerivedLayers,
  loadFootprintRules,
  saveFootprintRules,
} from './footprints';


export type {
  CigarOp,
  HistogramBin,
  PerReadStats,
  ReadStatsAggregate,
  ReadStatsResponse,
} from './readStats';
export { fetchReadStats } from './readStats';

// File upload (for drag-and-drop)
export type { CoverageResponse } from './coverage';
export { coverageQueryKey, getCoverage } from './coverage';

export type {
  CoaccArc,
  CoaccArcsResponse,
  CoaccMatrixData,
  CoaccMetadata,
  CoaccReadScopeOptions,
  CoaccSlice,
} from './coaccessibility';
export {
  getCoaccArcs,
  getCoaccMatrixData,
  getCoaccMatrixImageUrl,
  getCoaccMetadata,
  getCoaccSlice,
  getCoaccStripUrl,
} from './coaccessibility';

// DAF-C API functions
export * from './dafc';


export type { BrowseAnnotationEntry } from './annotations';
export {
  activateAnnotationFile,
  addAnnotationFile,
  browseAnnotationFiles,
  clusterByAnnotations,
  deactivateAnnotationFile,
  detectSignalPeaks,
  filterByAnnotations,
  getAnnotationFiles,
  getAnnotationProfile,
  getAnnotationsForRegion,
  pickAnnotationFile,
  removeAnnotationFile,
  setAnnotationThreshold,
} from './annotations';
