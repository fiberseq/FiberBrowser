import { signalFilterUrl } from '../utils/signalFilters';
import { fetchJson } from './sharedFetch';
import { withSandboxParam } from '../utils/sandbox';

const API_BASE = '/api';

export interface CoaccMetadata {
  n_bins: number;
  bin_size: number;
  n_reads: number;
  coverage_median: number;
  coverage_min: number;
  coverage_max: number;
  masked_fraction: number;
  marginal_accessibility: (number | null)[];
}

export type CoaccReadScopeOptions = {
  readIds?: string[];
  readIdsByDataset?: Record<string, string[]>;
};

function appendCoaccReadScope(params: URLSearchParams, options?: CoaccReadScopeOptions) {
  if (options?.readIds?.length) params.set('read_ids', options.readIds.join(','));
  const scoped = options?.readIdsByDataset
    ? Object.fromEntries(
      Object.entries(options.readIdsByDataset)
        .filter(([, ids]) => Array.isArray(ids)),
    )
    : null;
  if (scoped && Object.keys(scoped).length > 0) {
    params.set('read_ids_by_dataset', JSON.stringify(scoped));
  }
}

export function getCoaccMatrixImageUrl(
  chrom: string,
  start: number,
  end: number,
  options?: {
    binSize?: number;
    datasetIds?: string[];
    normalization?: 'raw' | 'oe' | 'oe_distance' | 'correlation';
    scaling?: 'linear' | 'log' | 'sqrt';
    colormap?: string;
    vmin?: number | null;
    vmax?: number | null;
    minCoverage?: number;
    readIds?: string[];
    readIdsByDataset?: Record<string, string[]>;
    signalType?: string;
    layer?: string | null;
    panelGenome?: string | null;
    sampleSeed?: string;
  },
): string {
  const params = new URLSearchParams();
  params.set('chrom', chrom);
  params.set('start', start.toString());
  params.set('end', end.toString());
  if (options?.binSize) params.set('bin_size', options.binSize.toString());
  if (options?.datasetIds?.length) params.set('dataset_ids', options.datasetIds.join(','));
  if (options?.normalization && options.normalization !== 'oe') params.set('normalization', options.normalization);
  if (options?.scaling && options.scaling !== 'linear') params.set('scaling', options.scaling);
  if (options?.colormap && options.colormap !== 'fall') params.set('colormap', options.colormap);
  if (options?.vmin != null) params.set('vmin', options.vmin.toString());
  if (options?.vmax != null) params.set('vmax', options.vmax.toString());
  if (options?.minCoverage && options.minCoverage !== 20) params.set('min_coverage', options.minCoverage.toString());
  appendCoaccReadScope(params, options);
  if (options?.signalType && options.signalType !== 'accessibility') params.set('signal_type', options.signalType);
  if (options?.layer) params.set('layer', options.layer);
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  if (options?.sampleSeed) params.set('sample_seed', options.sampleSeed);
  return withSandboxParam(signalFilterUrl(`${API_BASE}/coacc/matrix/image?${params}`));
}

export async function getCoaccMetadata(
  chrom: string,
  start: number,
  end: number,
  options?: {
    binSize?: number;
    datasetIds?: string[];
    normalization?: 'raw' | 'oe' | 'oe_distance' | 'correlation';
    minCoverage?: number;
    readIds?: string[];
    readIdsByDataset?: Record<string, string[]>;
    signalType?: string;
    layer?: string | null;
    panelGenome?: string | null;
    sampleSeed?: string;
    signal?: AbortSignal;
  },
): Promise<CoaccMetadata> {
  const params = new URLSearchParams();
  params.set('chrom', chrom);
  params.set('start', start.toString());
  params.set('end', end.toString());
  if (options?.binSize) params.set('bin_size', options.binSize.toString());
  if (options?.datasetIds?.length) params.set('dataset_ids', options.datasetIds.join(','));
  if (options?.normalization && options.normalization !== 'oe') params.set('normalization', options.normalization);
  if (options?.minCoverage && options.minCoverage !== 20) params.set('min_coverage', options.minCoverage.toString());
  appendCoaccReadScope(params, options);
  if (options?.signalType && options.signalType !== 'accessibility') params.set('signal_type', options.signalType);
  if (options?.layer) params.set('layer', options.layer);
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  if (options?.sampleSeed) params.set('sample_seed', options.sampleSeed);
  return fetchJson(`${API_BASE}/coacc/metadata?${params}`, options?.signal ? { signal: options.signal } : undefined);
}

export interface CoaccMatrixData {
  matrix: (number | null)[][];
  coverage: (number | null)[][];
  chrom: string;
  start: number;
  end: number;
  bin_size: number;
  n_bins: number;
  n_reads: number;
  normalization: string;
  marginal_accessibility: (number | null)[];
  sample_seed?: string | null;
}

export async function getCoaccMatrixData(
  chrom: string,
  start: number,
  end: number,
  options?: {
    binSize?: number;
    datasetIds?: string[];
    normalization?: string;
    minCoverage?: number;
    readIds?: string[];
    readIdsByDataset?: Record<string, string[]>;
    signalType?: string;
    layer?: string | null;
    panelGenome?: string | null;
    sampleSeed?: string;
  },
): Promise<CoaccMatrixData> {
  const params = new URLSearchParams();
  params.set('chrom', chrom);
  params.set('start', start.toString());
  params.set('end', end.toString());
  if (options?.binSize) params.set('bin_size', options.binSize.toString());
  if (options?.datasetIds?.length) params.set('dataset_ids', options.datasetIds.join(','));
  if (options?.normalization) params.set('normalization', options.normalization);
  if (options?.minCoverage) params.set('min_coverage', options.minCoverage.toString());
  appendCoaccReadScope(params, options);
  if (options?.signalType && options.signalType !== 'accessibility') params.set('signal_type', options.signalType);
  if (options?.layer) params.set('layer', options.layer);
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  if (options?.sampleSeed) params.set('sample_seed', options.sampleSeed);
  return fetchJson(`${API_BASE}/coacc/matrix/data?${params}`);
}

export interface CoaccSlice {
  profile: (number | null)[];
  coverage: number[];
  bin_size: number;
  n_bins: number;
  n_reads: number;
  viewpoint_bin: number;
  viewpoint_start: number;
  viewpoint_end: number;
}

export async function getCoaccSlice(
  chrom: string,
  start: number,
  end: number,
  position: number,
  options?: {
    binSize?: number;
    datasetIds?: string[];
    normalization?: string;
    minCoverage?: number;
    readIds?: string[];
    readIdsByDataset?: Record<string, string[]>;
    signalType?: string;
    layer?: string | null;
    panelGenome?: string | null;
    sampleSeed?: string;
  },
): Promise<CoaccSlice> {
  const params = new URLSearchParams();
  params.set('chrom', chrom);
  params.set('start', start.toString());
  params.set('end', end.toString());
  params.set('position', position.toString());
  if (options?.binSize) params.set('bin_size', options.binSize.toString());
  if (options?.datasetIds?.length) params.set('dataset_ids', options.datasetIds.join(','));
  if (options?.normalization) params.set('normalization', options.normalization);
  if (options?.minCoverage) params.set('min_coverage', options.minCoverage.toString());
  appendCoaccReadScope(params, options);
  if (options?.signalType && options.signalType !== 'accessibility') params.set('signal_type', options.signalType);
  if (options?.layer) params.set('layer', options.layer);
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  if (options?.sampleSeed) params.set('sample_seed', options.sampleSeed);
  return fetchJson(`${API_BASE}/coacc/slice?${params}`);
}

export interface CoaccArc {
  start: number;
  end: number;
  strength: number;
  coverage: number;
}

export interface CoaccArcsResponse {
  arcs: CoaccArc[];
  bin_size: number;
  n_arcs: number;
}

export async function getCoaccArcs(
  chrom: string,
  start: number,
  end: number,
  options?: {
    binSize?: number;
    datasetIds?: string[];
    normalization?: string;
    minCoverage?: number;
    threshold?: number;
    maxArcs?: number;
    minDistance?: number;
    readIds?: string[];
    readIdsByDataset?: Record<string, string[]>;
    signalType?: string;
    layer?: string | null;
    panelGenome?: string | null;
    sampleSeed?: string;
  },
): Promise<CoaccArcsResponse> {
  const params = new URLSearchParams();
  params.set('chrom', chrom);
  params.set('start', start.toString());
  params.set('end', end.toString());
  if (options?.binSize) params.set('bin_size', options.binSize.toString());
  if (options?.datasetIds?.length) params.set('dataset_ids', options.datasetIds.join(','));
  if (options?.normalization) params.set('normalization', options.normalization);
  if (options?.minCoverage) params.set('min_coverage', options.minCoverage.toString());
  if (options?.threshold != null) params.set('threshold', options.threshold.toString());
  if (options?.maxArcs != null) params.set('max_arcs', options.maxArcs.toString());
  if (options?.minDistance != null) params.set('min_distance', options.minDistance.toString());
  appendCoaccReadScope(params, options);
  if (options?.signalType && options.signalType !== 'accessibility') params.set('signal_type', options.signalType);
  if (options?.layer) params.set('layer', options.layer);
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  if (options?.sampleSeed) params.set('sample_seed', options.sampleSeed);
  return fetchJson(`${API_BASE}/coacc/arcs?${params}`);
}

export function getCoaccStripUrl(
  chrom: string,
  start: number,
  end: number,
  options?: {
    width?: number;
    height?: number;
    binSize?: number;
    datasetIds?: string[];
    normalization?: string;
    scaling?: string;
    colormap?: string;
    minCoverage?: number;
    readIds?: string[];
    readIdsByDataset?: Record<string, string[]>;
    signalType?: string;
    layer?: string | null;
    panelGenome?: string | null;
    sampleSeed?: string;
  },
): string {
  const params = new URLSearchParams();
  params.set('chrom', chrom);
  params.set('start', start.toString());
  params.set('end', end.toString());
  if (options?.width) params.set('width', options.width.toString());
  if (options?.height) params.set('height', options.height.toString());
  if (options?.binSize) params.set('bin_size', options.binSize.toString());
  if (options?.datasetIds?.length) params.set('dataset_ids', options.datasetIds.join(','));
  if (options?.normalization) params.set('normalization', options.normalization);
  if (options?.scaling) params.set('scaling', options.scaling);
  if (options?.colormap) params.set('colormap', options.colormap);
  if (options?.minCoverage) params.set('min_coverage', options.minCoverage.toString());
  appendCoaccReadScope(params, options);
  if (options?.signalType && options.signalType !== 'accessibility') params.set('signal_type', options.signalType);
  if (options?.layer) params.set('layer', options.layer);
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  if (options?.sampleSeed) params.set('sample_seed', options.sampleSeed);
  return withSandboxParam(signalFilterUrl(`${API_BASE}/coacc/strip?${params}`));
}
