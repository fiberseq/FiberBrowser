/**
 * The data exports themselves, as functions of the store: the Export dialog's
 * Data tab, the Export data… dialog and the panels call these, so each file is
 * made one way wherever it is asked for.
 */
import type { BrowserState } from '../stores/browserStore';
import { qnameOfId, recordKey } from './recordKeys';
import { clusterAssignmentForRead } from '../components/tracks/read-track/readFilter';
import { exportSession } from '../api/session';
import { getCompactReadsAll } from '../api/readOperations';
import { fetchReadStats, type PerReadStats } from '../api/readStats';
import { fetchApiResponse } from '../api/sharedFetch';
import { downloadTextFile, exportTimestamp, formatTsv, formatWorkingSetReadsTsv, safeFilenamePart, type WorkingSetBlock } from './analysisExport';
import { formatClusterAssignmentsTsv } from './clusterExport';
import { currentReadProjection } from './projectionExport';
import { formatPeakBed, type PeakBedExportEntry } from './peakBed';
import { MAX_READ_STATS_READS } from './readStatsScope';
import type { ReadScopeGroup } from './exportReadScopes';
import { downloadBlob } from './figureExport';
import { panelView, shownPanelViews, viewFileStem, type PanelView } from './panelScope';
import { genomeKeyFor, mainGenomeKey } from './regionNavigation';
import { usePanelGenomeStore } from '../stores/panelGenomeStore';
import type { ChromInfo } from '../types';

const TSV = 'text/tab-separated-values';

/** Reads in view across the dataset panels, from their header counts ("586/3,170 visible", "0 reads"). */
export function readsInViewFromStatus(statuses: Array<{ text: string }>): number {
  let total = 0;
  for (const { text } of statuses) {
    // "339 of 2,698 rows drawn" (and the older "339/2,698 visible", "80 reads"): the reads in view.
    const m = /\bof\s+([\d,]+)\s+rows?\b/.exec(text) ?? /\/\s*([\d,]+)/.exec(text) ?? /([\d,]+)\s+reads?\b/.exec(text);
    if (m) total += Number(m[1].replace(/,/g, '')) || 0;
  }
  return total;
}

// --- Where an export is ------------------------------------------------------
//
// In "Each panel navigates" the main locus (state.chrom/start/end) goes stale
// and panels on another assembly have their own locus: exports about "the
// view" take the panels' views (utils/panelScope), and file names their loci.

interface Place { chrom: string; start: number; end: number; genome?: string | null }

/** Each reference + locus once, in order. */
function distinctPlaces<T extends Place>(places: T[]): T[] {
  const seen = new Set<string>();
  return places.filter(p => {
    const key = `${p.genome ?? ''}|${p.chrom}:${p.start}-${p.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A file-name part for some loci ("chr19_47514262-47519210", "…_plus2"); the
 * reference's key first when another reference has a contig of the same name
 * (hg19 and hg38 both have chr1).
 */
export function placesFileStem(places: Place[], state: Pick<BrowserState, 'currentGenome' | 'fastaPath'>): string {
  const list = distinctPlaces(places);
  if (list.length === 0) return 'view';
  const keyOf = (p: Place) => genomeKeyFor(p.genome, state);
  const shared = list.some(a => list.some(b => keyOf(a) !== keyOf(b) && a.chrom === b.chrom));
  const stem = viewFileStem(list);
  return shared ? `${safeFilenamePart(keyOf(list[0]))}_${stem}` : stem;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map];
}

/** Group by reference key, the main genome's first. */
function byReference<T>(state: BrowserState, items: T[], keyOf: (item: T) => string): Array<[string, T[]]> {
  const main = mainGenomeKey(state);
  return groupBy(items, keyOf).sort(([a], [b]) => Number(b === main) - Number(a === main));
}

/** One span per chromosome (and reference) of some places. */
function spans(places: Array<Place & { genome?: string | null }>): Place[] {
  return groupBy(places, p => `${p.genome ?? ''}|${p.chrom}`).map(([, list]) => ({
    chrom: list[0].chrom, genome: list[0].genome,
    start: Math.min(...list.map(p => p.start)), end: Math.max(...list.map(p => p.end)),
  }));
}

const savedFiles = (n: number, what: string) =>
  (n > 1 ? `Saved ${n} BED files, one per reference (${what})` : `Saved ${what}`);

/**
 * The reference of a table about some datasets at a locus (a projection map):
 * that of their panels there (else anywhere); panels on several references
 * are listed ("hg38,dm6"); none: the main genome.
 */
export function referenceAt(state: BrowserState, locus: { chrom: string; start: number; end: number }, datasetIds?: string[]): string {
  const wanted = datasetIds ? new Set(datasetIds) : null;
  const panels = state.panels.filter(p => p.contentType === 'dataset' && p.datasetId && (!wanted || wanted.has(p.datasetId)));
  const views = panels.map(p => panelView(state, p));
  const here = views.filter(v => v.chrom === locus.chrom && v.start === locus.start && v.end === locus.end);
  const keys = [...new Set((here.length ? here : views).map(v => v.genomeKey))];
  return keys.length ? keys.join(',') : mainGenomeKey(state);
}

// --- Peaks & regions --------------------------------------------------------

export interface PeakBedFile { genome: string; bed: string; count: number; places: Place[] }

/**
 * Every peak (or the selected ones) as fiberbrowser_peaks_v1 BED, one per
 * reference (a BED holds one assembly's coordinates; peaks scanned in a panel
 * on another assembly carry its key), each naming its reference.
 */
export function formatPeakBedsForState(state: BrowserState, selectedOnly = false): PeakBedFile[] {
  const rulesById = new Map(state.peakRules.map(rule => [rule.id, rule]));
  const peaks = state.getAllPeaks().filter(peak => !selectedOnly || state.selectedPeaks.has(peak.index));
  return byReference(state, peaks, peak => genomeKeyFor(peak.genome, state)).map(([genome, list]) => {
    const entries: PeakBedExportEntry[] = list.map(peak => ({
      chrom: peak.chrom || state.chrom,
      peak,
      rule: peak.ruleId ? rulesById.get(peak.ruleId) : undefined,
      selected: state.selectedPeaks.has(peak.index),
      mode: state.peakModes[peak.index] || 'accessibility',
    }));
    return {
      genome,
      bed: formatPeakBed(entries, { reference: genome }),
      count: entries.length,
      places: entries.map(e => ({ chrom: e.chrom, start: e.peak.start, end: e.peak.end, genome })),
    };
  });
}

/** One reference's peak BED (default: the first, the main genome's when it has peaks). */
export function formatPeakBedForState(state: BrowserState, selectedOnly = false, genome?: string): string {
  const files = formatPeakBedsForState(state, selectedOnly);
  return (files.find(f => f.genome === genome) ?? files[0])?.bed ?? formatPeakBed([]);
}

/** The views on screen of one reference, else the span of `places` (a file name's loci). */
function referencePlaces(state: BrowserState, genome: string, places: Place[]): Place[] {
  const views = shownPanelViews(state, { scope: 'all' }).filter(v => v.genomeKey === genome);
  return views.length ? views : spans(places);
}

/** Download the peak BED(s), one per reference; '' when there are no peaks. */
export function downloadPeaksBed(state: BrowserState, selectedOnly = false): string {
  const files = formatPeakBedsForState(state, selectedOnly);
  if (files.length === 0) return '';
  const prefix = selectedOnly ? 'selected_peaks' : 'peaks';
  for (const file of files) {
    const reference = files.length > 1 ? `${safeFilenamePart(file.genome)}_` : '';
    downloadTextFile(file.bed, `${prefix}_${reference}${viewFileStem(referencePlaces(state, file.genome, file.places))}.bed`, TSV);
  }
  const n = files.reduce((sum, f) => sum + f.count, 0);
  return savedFiles(files.length, `${n.toLocaleString()} ${selectedOnly ? 'selected ' : ''}peak${n === 1 ? '' : 's'}`);
}

type ClusterRegion = BrowserState['clusterPeakRegions'][number] & { genome?: string };

/**
 * Where a clustering region is. A clustering is of one reference (one across
 * references is refused): the clustered panels' reference, when they are on
 * one. The chromosome is the region's own (a peak scanned in a panel at
 * another locus), else that of the peak it came from (none: the main view's),
 * else of the view it lies in.
 */
function clusterRegionPlace(
  state: BrowserState, r: ClusterRegion, peaks: ReturnType<BrowserState['getAllPeaks']>, clustered: string[],
): { chrom: string; genome: string } {
  let genome = r.genome ?? (clustered.length === 1 ? clustered[0] : undefined);
  const peak = peaks.find(p => p.start === r.start && p.end === r.end
    && (!r.chrom || (p.chrom || state.chrom) === r.chrom)
    && (!genome || genomeKeyFor(p.genome, state) === genome));
  if (peak) return { chrom: r.chrom || peak.chrom || state.chrom, genome: genome ?? genomeKeyFor(peak.genome, state) };
  const views = shownPanelViews(state, { scope: 'all' })
    .filter(v => (!genome || v.genomeKey === genome) && (!r.chrom || v.chrom === r.chrom) && v.start < r.end && v.end > r.start);
  const view = views.find(v => v.followsMain) ?? views[0];
  genome ??= view?.genomeKey ?? mainGenomeKey(state);
  return { chrom: r.chrom || view?.chrom || state.chrom, genome };
}

function clusterRegionRows(state: BrowserState): Array<Place & { genome: string; mode: string }> {
  const peaks = state.getAllPeaks();
  const clustered = [...new Set(clusteredViews(state).map(v => v.genomeKey))];
  return state.clusterPeakRegions.map(r => ({
    ...clusterRegionPlace(state, r as ClusterRegion, peaks, clustered),
    start: r.start, end: r.end, mode: r.mode || 'accessibility',
  }));
}

export function formatClusterRegionsBed(state: BrowserState): string {
  const lines = clusterRegionRows(state).map((r, i) =>
    `${r.chrom}\t${r.start}\t${r.end}\tregion_${i}\t0\t.\t${r.start}\t${r.end}\t0\t${r.mode}\t${r.genome}`);
  const header = '#chrom\tstart\tend\tname\tscore\tstrand\tthickStart\tthickEnd\trgb\tmode\treference';
  return header + '\n' + lines.join('\n') + '\n';
}

export function downloadClusterRegionsBed(state: BrowserState): void {
  if (state.clusterPeakRegions.length === 0) return;
  downloadTextFile(formatClusterRegionsBed(state), `cluster_regions_${placesFileStem(spans(clusterRegionRows(state)), state)}.bed`, TSV);
}

/** The views "Current region" saves: the selected panels', else every one on screen (as Highlight > View). */
export function viewportViews(state: BrowserState): PanelView[] {
  return shownPanelViews(state);
}

/** A view's chromosome as its reference lists it (size, circular). */
function chromInfoOf(state: BrowserState, view: PanelView): ChromInfo | undefined {
  const chroms = view.genome
    ? (usePanelGenomeStore.getState().genomes[view.genome]?.chroms ?? []) as ChromInfo[]
    : state.chroms ?? [];
  return chroms.find(c => c.name === view.chrom);
}

/**
 * A view as BED intervals (reference coordinates): a circular contig's view
 * across its origin (a logical start below 0, an end past its length) is a
 * piece on each side of the seam, as the read loaders fetch it.
 */
export function viewBedIntervals(view: { start: number; end: number }, chrom?: Pick<ChromInfo, 'size' | 'circular'>): Array<[number, number]> {
  const size = chrom?.circular ? chrom.size : 0;
  if (!size || (view.start >= 0 && view.end <= size)) return [[Math.max(0, view.start), view.end]];
  const pieces: Array<[number, number]> = [];
  for (let cursor = view.start; cursor < view.end && pieces.length < 16;) {
    const cycle = Math.floor(cursor / size);
    const next = Math.min(view.end, (cycle + 1) * size);
    pieces.push([cursor - cycle * size, next - cycle * size]);
    cursor = next;
  }
  return pieces;
}

/** "Current region" as BED, one per reference: a line per view on screen. */
export function formatViewportBeds(state: BrowserState): Array<{ genome: string; bed: string; views: PanelView[] }> {
  return byReference(state, viewportViews(state), v => v.genomeKey).map(([genome, views]) => ({
    genome,
    views,
    bed: views.flatMap(v => viewBedIntervals(v, chromInfoOf(state, v))
      .map(([start, end]) => `${v.chrom}\t${start}\t${end}\tviewport\t0\t.\n`)).join(''),
  }));
}

export function downloadViewportBed(state: BrowserState): string {
  const files = formatViewportBeds(state);
  if (files.length === 0) throw new Error('No dataset panel on screen');
  for (const file of files) {
    const reference = files.length > 1 ? `${safeFilenamePart(file.genome)}_` : '';
    downloadTextFile(file.bed, `region_${reference}${viewFileStem(file.views)}.bed`, TSV);
  }
  const n = files.reduce((sum, f) => sum + f.views.length, 0);
  return savedFiles(files.length, `${n} region${n === 1 ? '' : 's'}`);
}

/** "#fde047" → "253,224,71" (BED itemRgb); anything else → "0,0,0". */
function itemRgb(color: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  return m ? m.slice(1, 4).map(h => parseInt(h, 16)).join(',') : '0,0,0';
}

/**
 * Highlights as BED9 (name = its label, else its locus; itemRgb = its
 * colour), one BED per reference: a BED holds one assembly's coordinates
 * (the Regions panel imports a file onto one reference).
 */
export function formatHighlightsBed(highlights: BrowserState['highlights']): Array<{ genome: string; bed: string }> {
  const byGenome = new Map<string, typeof highlights>();
  for (const h of highlights) byGenome.set(h.genome, [...(byGenome.get(h.genome) ?? []), h]);
  return [...byGenome].map(([genome, list]) => ({
    genome,
    bed: [...list]
      .sort((a, b) => a.chrom.localeCompare(b.chrom) || a.start - b.start)
      .map(h => {
        const name = (h.label || `${h.chrom}:${h.start}-${h.end}`).replace(/\s+/g, '_');
        return `${[h.chrom, h.start, h.end, name, 0, '.', h.start, h.end, itemRgb(h.color)].join('\t')}\n`;
      })
      .join(''),
  }));
}

/** One file per reference (highlights_<reference>_<time>.bed); returns what was saved. */
export function downloadHighlightsBed(state: BrowserState): string {
  const files = formatHighlightsBed(state.highlights);
  const stamp = exportTimestamp();
  for (const { genome, bed } of files) downloadTextFile(bed, `highlights_${safeFilenamePart(genome)}_${stamp}.bed`, TSV);
  return files.length > 1 ? `Saved ${files.length} BED files, one per reference` : 'Saved';
}

// --- Clusters ---------------------------------------------------------------

/** The views of the panels the clustering is about (each reference + locus once), else those on screen. */
export function clusteredViews(state: BrowserState): PanelView[] {
  const keys = new Set(Object.keys(state.clusterAssignments));
  const panels = state.panels.filter(p => p.contentType === 'dataset' && p.datasetId && keys.has(p.stateKey ?? p.datasetId));
  const views = distinctPlaces(panels.map(p => panelView(state, p)));
  return views.length ? views : shownPanelViews(state, { scope: 'all' });
}

export function formatClusterAssignmentsForState(state: BrowserState): string {
  const views = clusteredViews(state);
  const first = views[0] ?? { chrom: state.chrom, start: state.start, end: state.end, genomeKey: mainGenomeKey(state) };
  return formatClusterAssignmentsTsv({
    clusterAssignments: state.clusterAssignments,
    clusterPatterns: state.clusterPatterns,
    datasets: state.datasets,
    panels: state.panels,
    readSortOrder: state.readSortOrder,
    clusterOrder: state.clusterOrder,
    activeReadIds: state.activeReadIds,
    jupyterReadOrder: state.jupyterReadOrder,
    // The Projection tab's latest map of this region, if any: adds its x/y columns (fb-r3-tsne).
    projection: currentReadProjection(state.readProjection, state),
    clusterGroupLabels: state.clusterGroupLabels,
    provenance: {
      // The clustered panels' locus and reference (the main locus is stale in "Each panel navigates").
      chrom: first.chrom,
      start: first.start,
      end: first.end,
      reference: first.genomeKey,
      ...(views.length > 1 ? { regions: views.map(v => `${v.genomeKey}:${v.chrom}:${v.start}-${v.end}`) } : {}),
      dataset_ids: state.datasets.map(d => d.id),
      dataset_labels: state.datasets.map(d => d.label ?? d.id),
      analysis_sample_seed: state.analysisSampleSeed,
      analysis_sample_count: state.analysisSampleCount,
      ...(Object.keys(state.clusterPreparationSamples).length
        ? { cluster_preparation_samples: state.clusterPreparationSamples } : {}),
      spanning_only: state.spanningOnly,
      peaks_locked: state.peaksLocked,
      selected_peak_count: state.selectedPeaks.size,
      cluster_method: state.clusterMethod,
      cluster_k: state.clusterK,
      ...(state.clusterMethod === 'graph' ? { cluster_resolution: state.clusterResolution } : {}),
      small_footprint_threshold_bp: state.subnucleosomalThreshold,
      accessibility_threshold: state.accessibilityThreshold,
      quality_filters: state.activeColormap.qualityFilters,
      // The SV allele splits the groups come from (fb-n9-sv).
      ...(Object.keys(state.svSplits ?? {}).length > 0
        ? { sv_allele_split: Object.fromEntries(Object.entries(state.svSplits).map(([key, d]) => [key, `${d.label} (margin ${d.margin} bp)`])) }
        : {}),
    },
  });
}

export function downloadClusterAssignments(state: BrowserState): void {
  if (Object.keys(state.clusterAssignments).length === 0) return;
  downloadTextFile(formatClusterAssignmentsForState(state), `clusters_${placesFileStem(clusteredViews(state), state)}.tsv`, TSV);
}

// --- Session & working set ----------------------------------------------------

/** The exact, reloadable browser state (frontend + backend + history). */
export async function downloadStateJson(sessionName: string): Promise<void> {
  const blob = await exportSession();
  const base = sessionName.trim() ? safeFilenamePart(sessionName) : 'fiberbrowser_state';
  downloadBlob(blob, `${base}_${exportTimestamp()}.json`);
}

function workingSetParams(state: BrowserState, view: PanelView, datasetIds: string[]): URLSearchParams {
  const params = new URLSearchParams({
    chrom: view.chrom,
    start: view.start.toString(),
    end: view.end.toString(),
    dataset_ids: datasetIds.join(','),
    spanning: state.spanningOnly.toString(),
    max_reads: '0',
    include_methylation: 'true',
    include_layers: 'true',
    include_layer_qualities: 'true',
    include_metaprofile: 'false',
    profile_max_reads: '0',
    hide_terminal_gaps: state.hideTerminalGaps.toString(),
    terminal_gap_threshold: state.terminalGapThreshold.toString(),
    min_fp_quality: state.minFpQuality.toString(),
    min_footprints: state.minFootprints.toString(),
    include_duplicates: state.showDuplicateReads.toString(),
    infer_legacy_layers: state.legacyLayerInference.toString(),
    legacy_nuc_min_size: state.legacyNucMinSize.toString(),
    sample_seed: state.analysisSampleSeed,
  });
  if (state.fillSmallGaps && state.fillGapSize > 0) params.set('fill_gap_size', state.fillGapSize.toString());
  // A panel on another assembly: its reference (services/panel_genomes.py).
  if (view.genome) params.set('panel_genome', view.genome);
  return params;
}

/**
 * Every read admitted by the span and read filters of each view on screen
 * (each panel locus and reference: one request each), with its intervals,
 * qualities and marks; every row names its reference and chromosome.
 */
export async function downloadWorkingSetTsv(state: BrowserState): Promise<string> {
  const views = shownPanelViews(state, { scope: 'all' });
  const blocks: WorkingSetBlock[] = [];
  for (const view of views) {
    const datasetIds = [...new Set(view.panelIds
      .map(id => state.panels.find(p => p.id === id)?.datasetId)
      .filter((id): id is string => !!id))];
    if (datasetIds.length === 0) continue;
    const response = await getCompactReadsAll<{ datasets: Record<string, { reads?: Array<any> }> }>(workingSetParams(state, view, datasetIds));
    blocks.push({ datasets: response.datasets ?? {}, chrom: view.chrom, regionStart: view.start, reference: view.genomeKey });
  }
  if (blocks.length === 0) throw new Error('No dataset panel on screen');
  downloadTextFile(
    formatWorkingSetReadsTsv({ blocks }),
    `working_set_${placesFileStem(views, state)}_${exportTimestamp()}.tsv`,
    TSV,
  );
  const reads = blocks.reduce((n, b) => n + Object.values(b.datasets).reduce((m, d) => m + (d.reads?.length ?? 0), 0), 0);
  return `Saved ${reads.toLocaleString()} read${reads === 1 ? '' : 's'}${blocks.length > 1 ? ` from ${blocks.length} regions` : ''}`;
}

// --- Nucleosome footprints -------------------------------------------------------

export const NUC_FOOTPRINT_COLUMNS = [
  'dataset_id', 'read_id', 'reference', 'chrom', 'start', 'end', 'molecular_length',
  'coarse_class', 'named_class', 'posterior', 'z', 'tf',
] as const;

/** nucsz byte 1 (low 4 bits) and byte 2 codes, named as the nuc.size.* cluster modes are. */
const NUC_COARSE_NAMES = ['cant_tell', 'short', 'mono', 'long', 'multi2', 'multi3', 'edge_truncated'];
const NUC_NAMED_NAMES = ['', 'small', 'hexasome', 'octasome', 'chromatosome'];

/**
 * One row per `nucsz` mark (one per nucleosome or TF footprint) of the blocks' reads. The bytes are read by
 * position (coarse, named, posterior, z; older scans name them q0..q3): posterior = byte / 255, z = (byte - 128) / 20
 * with 255 missing, TF = bit 16 of the coarse byte.
 */
export function formatNucFootprintsTsv(blocks: WorkingSetBlock[]): { tsv: string; rows: number; reads: number } {
  const rows: unknown[][] = [[...NUC_FOOTPRINT_COLUMNS]];
  let reads = 0;
  for (const block of blocks) {
    for (const [datasetId, dataset] of Object.entries(block.datasets)) {
      for (const read of dataset.reads ?? []) {
        const layer = read.layers?.nucsz;
        if (!layer?.intervals?.length) continue;
        reads += 1;
        const byte = (k: number, i: number): number | undefined => {
          const v = layer.qualities?.[k]?.[i];
          return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        };
        layer.intervals.forEach(([start, end, size], i) => {
          const coarse = byte(0, i) ?? 0;
          const named = byte(1, i) ?? 0;
          const posterior = byte(2, i);
          const z = byte(3, i);
          rows.push([
            datasetId, qnameOfId(read.id), block.reference ?? '', block.chrom,
            block.regionStart + start, block.regionStart + end,
            Number.isFinite(size) && size > 0 ? size : end - start,
            NUC_COARSE_NAMES[coarse & 15] ?? `code_${coarse & 15}`,
            NUC_NAMED_NAMES[named] ?? `code_${named}`,
            posterior == null ? '' : Number((posterior / 255).toFixed(4)),
            z == null || z === 255 ? '' : (z - 128) / 20,
            coarse & 16 ? 1 : 0,
          ]);
        });
      }
    }
  }
  return { tsv: formatTsv(rows), rows: rows.length - 1, reads };
}

/** Datasets with a nucleosome size layer (a scan's annotated BAM, or a live nucleosome run). */
export function nucFootprintDatasetIds(state: Pick<BrowserState, 'datasets'>): Set<string> {
  return new Set(state.datasets.filter(d => (d.available_layers as Record<string, unknown> | undefined)?.nucsz).map(d => d.id));
}

/**
 * The nucleosome footprints of the target panels' reads (the selected panels', else every panel on screen), one
 * request per view as the working-set export makes them.
 */
export async function downloadNucFootprintsTsv(state: BrowserState): Promise<string> {
  const withLayer = nucFootprintDatasetIds(state);
  const views = shownPanelViews(state);
  const blocks: WorkingSetBlock[] = [];
  for (const view of views) {
    const datasetIds = [...new Set(view.panelIds
      .map(id => state.panels.find(p => p.id === id)?.datasetId)
      .filter((id): id is string => !!id && withLayer.has(id)))];
    if (datasetIds.length === 0) continue;
    const response = await getCompactReadsAll<{ datasets: Record<string, { reads?: Array<any> }> }>(workingSetParams(state, view, datasetIds));
    blocks.push({ datasets: response.datasets ?? {}, chrom: view.chrom, regionStart: view.start, reference: view.genomeKey });
  }
  if (blocks.length === 0) throw new Error('No panel on screen shows a dataset with nucleosome size classes');
  const table = formatNucFootprintsTsv(blocks);
  downloadTextFile(table.tsv, `nucleosome_footprints_${placesFileStem(views, state)}_${exportTimestamp()}.tsv`, TSV);
  return `Saved ${table.rows.toLocaleString()} footprint${table.rows === 1 ? '' : 's'} from ${table.reads.toLocaleString()} read${table.reads === 1 ? '' : 's'}`;
}

// --- Reads --------------------------------------------------------------------

/** One read name per line (each once), as samtools view -N and most tools take them. */
export function formatReadNames(groups: ReadScopeGroup[]): string {
  // Cohort identities and record keys (lifted rows, graph rows) are written as the QNAME they name.
  const names = [...new Set(groups.flatMap(g => g.readIds).map(qnameOfId))];
  return names.length ? names.join('\n') + '\n' : '';
}

export function downloadReadNames(groups: ReadScopeGroup[], slug: string, state: Pick<BrowserState, 'currentGenome' | 'fastaPath'>): number {
  const text = formatReadNames(groups);
  const n = text ? text.trimEnd().split('\n').length : 0;
  if (n === 0) return 0;
  downloadTextFile(text, `read_names_${slug}_${placesFileStem(groups, state)}.txt`, 'text/plain');
  return n;
}

export async function copyReadNames(groups: ReadScopeGroup[]): Promise<number> {
  const text = formatReadNames(groups);
  await navigator.clipboard.writeText(text);
  return text ? text.trimEnd().split('\n').length : 0;
}

export const READ_TABLE_COLUMNS = [
  'read_id', 'dataset_id', 'reference', 'chrom', 'cluster', 'aligned_span', 'read_length', 'ref_start', 'ref_end', 'ref_contig', 'strand', 'mapq',
  'footprint_count', 'nucleosome_count', 'subnuc_count', 'avg_footprint_size', 'median_footprint_size',
  'accessibility_pct', 'methyl_count', 'methyl_pct',
  'nrl', 'regularity', 'gap_cv', 'lambda_acc', 'n_short', 'n_mono', 'n_multi', 'n_cant_tell', 'reg_fraction',
  'disordered_fraction', 'undetermined_fraction', 'n_missing', 'viewer_order',
] as const;

/**
 * Per-read statistics (Read Stats' numbers, from POST /api/reads/stats) with
 * each read's cluster, in display order. At most MAX_READ_STATS_READS reads.
 * One request per region, so each row keeps the locus and panel it came from
 * (a read shown in two windows is two rows).
 */
export async function buildReadTable(
  state: BrowserState,
  groups: ReadScopeGroup[],
): Promise<{ tsv: string; rows: number; truncated: boolean; total: number }> {
  // Lifted datasets are described too (graph features): their ref_start/ref_end are on the sample's own assembly,
  // on ref_contig (empty for native reads, whose bounds are on chrom).
  const total = groups.reduce((n, g) => n + g.readIds.length, 0);
  let budget = MAX_READ_STATS_READS;
  const regions = new Map<string, { chrom: string; start: number; end: number; genome?: string; groups: ReadScopeGroup[] }>();
  for (const g of groups) {
    if (budget <= 0) break;
    const take = { ...g, readIds: g.readIds.slice(0, budget) };
    budget -= take.readIds.length;
    // One request per locus and reference (a panel on another assembly asks its reference).
    const key = `${g.genome ?? ''}|${g.chrom}:${g.start}-${g.end}`;
    if (!regions.has(key)) regions.set(key, { chrom: g.chrom, start: g.start, end: g.end, genome: g.genome, groups: [] });
    regions.get(key)!.groups.push(take);
  }
  // A read's label in its group's panel, else in its dataset's haplotype panels (MAT and PAT of one dataset share a
  // group; their reads are disjoint), by identity (a graph run's labels are record keys; graph features review).
  const clusterOfRead = (stateKey: string, datasetId: string, readId: string) => {
    const asRead = recordKey(readId) ? { id: qnameOfId(readId), analysis_id: readId, live_lift: true } : readId;
    const keys = [stateKey, ...state.panels.filter(p => p.contentType === 'dataset' && p.datasetId === datasetId && p.liftHap)
      .map(p => p.stateKey ?? p.datasetId!)];
    for (const k of keys) {
      const c = clusterAssignmentForRead(state.clusterAssignments[k] ?? {}, asRead);
      if (c !== undefined) return c;
    }
    return undefined;
  };
  const rows: unknown[][] = [[...READ_TABLE_COLUMNS]];
  let order = 0;
  for (const region of regions.values()) {
    const byDataset: Record<string, string[]> = {};
    for (const g of region.groups) byDataset[g.datasetId] = [...new Set([...(byDataset[g.datasetId] ?? []), ...g.readIds])];
    const response = await fetchReadStats(region.chrom, region.start, region.end, state.spanningOnly, byDataset, state.analysisSampleSeed,
      region.genome ? { genome: region.genome } : undefined);
    const statsOf = new Map<string, PerReadStats>();
    for (const r of response.per_read ?? []) {
      const key = `${r.dataset_id}\t${r.read_id}`;
      if (!statsOf.has(key)) statsOf.set(key, r);
    }
    for (const g of region.groups) {
      for (const readId of g.readIds) {
        const r = statsOf.get(`${g.datasetId}\t${readId}`);
        if (!r) continue;  // not found at this locus (the server says which in Read Stats)
        const values: Record<string, unknown> = {
          ...r,
          chrom: region.chrom,
          reference: genomeKeyFor(region.genome, state),
          // A lifted row's label is under its cohort identity or its record key (a graph run): the read track's rule.
          cluster: clusterOfRead(g.stateKey, g.datasetId, readId) ?? '',
          viewer_order: ++order,
        };
        rows.push(READ_TABLE_COLUMNS.map(c => values[c] ?? ''));
      }
    }
  }
  return { tsv: formatTsv(rows), rows: rows.length - 1, truncated: total > MAX_READ_STATS_READS, total };
}

export async function downloadReadTable(state: BrowserState, groups: ReadScopeGroup[], slug: string): Promise<string> {
  const table = await buildReadTable(state, groups);
  downloadTextFile(table.tsv, `reads_${slug}_${placesFileStem(groups, state)}_${exportTimestamp()}.tsv`, TSV);
  return table.truncated
    ? `Saved the first ${table.rows.toLocaleString()} of ${table.total.toLocaleString()} reads (at most ${MAX_READ_STATS_READS.toLocaleString()} at a time)`
    : `Saved ${table.rows.toLocaleString()} reads`;
}

/** One BAM per dataset and region (POST /api/reads/export_bam; a lifted dataset's reads on its source assembly:
 * POST /api/lift/export_bam, from the source windows the region lifts from). */
export async function downloadReadBams(groups: ReadScopeGroup[], lifted: ReadonlySet<string> = new Set()): Promise<string> {
  const notes: string[] = [];
  let files = 0;
  for (const g of groups) {
    // A panel on another assembly: its reference (topology, contig names; services/panel_genomes.py).
    const query = g.genome ? `?panel_genome=${encodeURIComponent(g.genome)}` : '';
    const route = lifted.has(g.datasetId) ? '/api/lift/export_bam' : `/api/reads/export_bam${query}`;
    const response = await fetchApiResponse(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset_id: g.datasetId, chrom: g.chrom, start: g.start, end: g.end, read_ids: g.readIds }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `BAM export failed (${response.status})`);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    downloadBlob(await response.blob(), name ? decodeURIComponent(name) : `${g.datasetId}_${g.chrom}_${g.start}-${g.end}.bam`);
    files += 1;
    const missing = Number(response.headers.get('x-fiberbrowser-missing') ?? 0);
    if (missing > 0) notes.push(`${missing} read${missing === 1 ? '' : 's'} of ${g.datasetId} not found`);
    const source = response.headers.get('x-fiberbrowser-source-contigs');
    if (source) notes.push(`${g.datasetId} on its source assembly (${source.split('+').join(', ')})`);
  }
  return `Saved ${files} BAM${files === 1 ? '' : 's'} (index with samtools index)${notes.length ? `; ${notes.join('; ')}` : ''}`;
}

// --- Opening the panel an export lives in -----------------------------------

// Panels that open on a requested tab (consumed when they mount; the event moves an open one).
const TAB_REQUESTS: Record<string, { storageKey: string; event: string }> = {
  'footprint-analysis': { storageKey: 'fiberbrowser_footprint_analysis_tab', event: 'fiberbrowser:open-footprint-analysis-tab' },
  'cluster-detail': { storageKey: 'fiberbrowser_cluster_detail_tab', event: 'fiberbrowser:open-cluster-detail-tab' },
};

/** Open an analysis panel (on one of its tabs), where that table's own export buttons are. */
export function openPanelForExport(state: BrowserState, panel: string, tab?: string): void {
  const request = tab ? TAB_REQUESTS[panel] : undefined;
  if (request) {
    try { window.sessionStorage.setItem(request.storageKey, tab!); } catch { /* opens on its last tab */ }
  }
  state.openAnalysisPanel(panel as never);
  if (request) queueMicrotask(() => window.dispatchEvent(new CustomEvent(request.event, { detail: { tab, source: 'export-data' } })));
}
