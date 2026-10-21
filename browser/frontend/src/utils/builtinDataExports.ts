/**
 * The app's own data exports, registered once (utils/dataExportRegistry.ts).
 * Files made from the store are made here (utils/dataExportActions.ts, shared
 * with the Export dialog's Data tab); tables whose data lives in an analysis
 * panel open that panel, whose header has the export buttons.
 */
import { consensusExportUrl } from '../api/consensusWorkflow';
import { useConsensusViewStore } from '../stores/consensusViewStore';
import { useDafcStore } from '../stores/dafcStore';
import { useReadStatusStore } from '../stores/readStatusStore';
import { isPublicMode } from './publicMode';
import { buildSessionManifest, formatSessionManifest } from './sessionManifest';
import {
  copyReadNames, downloadClusterAssignments, downloadClusterRegionsBed, downloadPeaksBed, downloadReadBams,
  downloadHighlightsBed, downloadReadNames, downloadReadTable, downloadStateJson, downloadViewportBed, downloadWorkingSetTsv, openPanelForExport,
  readsInViewFromStatus, viewportViews,
} from './dataExportActions';
import { shownPanelViews, viewLocusLabel } from './panelScope';
import { registerDataExport, type DataExportAvailability, type DataExportContext, type DataExportEntry } from './dataExportRegistry';
import { useRegionCatalogStore } from '../stores/regionCatalogStore';
import { shownGenomes } from './regionNavigation';
import { MAX_READ_STATS_READS } from './readStatsScope';
import { onScreenStateKeys, readScopeGroups, readScopeOptions, readScopeSlug, type ReadScopeKey } from './exportReadScopes';
import { clusterOfScope } from './readStatsScope';

const ok: DataExportAvailability = { ok: true };
const no = (reason: string): DataExportAvailability => ({ ok: false, reason });

function emptyScopeReason(scope: ReadScopeKey): string {
  if (scope === 'selection') return 'No reads selected: Shift+click reads (or choose another set of reads above)';
  if (scope === 'shown') return 'No reads in view: open a dataset, or go to where it has reads';
  if (scope === 'filtered') return 'No read filter is on: Filter reads first (or choose another set of reads above)';
  return `Cluster ${clusterOfScope(scope)} has no reads on screen`;
}

/** The scope has reads (and how many). */
function scopeAvailability({ state, readScope }: DataExportContext): DataExportAvailability {
  if (state.datasets.length === 0) return no('Open a dataset first');
  const option = readScopeOptions(state).find(o => o.key === readScope);
  if (!option || option.count === 0) return no(emptyScopeReason(readScope));
  return { ok: true, detail: `${option.count.toLocaleString()} read${option.count === 1 ? '' : 's'}` };
}

function needs(condition: boolean, reason: string): DataExportAvailability {
  return condition ? ok : no(reason);
}

const notPublic = () => !isPublicMode();

let registered = false;

/** Register the built-in exports (once). */
/**
 * Projection coordinates with no map on show: opens Clusters > Projection.
 * ClusterDetailPanel registers a direct download under the same id while its
 * Projection tab shows a map, and puts this back when it doesn't.
 */
export const CLUSTER_PROJECTION_PLACEHOLDER: DataExportEntry = {
  id: 'cluster-projection', group: 'clusters', order: 20, action: 'open',
  title: 'Projection coordinates', format: 'TSV',
  description: 'Opens Clusters > Projection (t-SNE by default): each read\'s map coordinates, cluster and strand.',
  available: ({ state }) => needs(Object.keys(state.clusterAssignments).length > 0, 'Cluster reads first'),
  run: ({ state }) => openPanelForExport(state, 'cluster-detail', 'projection'),
};

export function registerBuiltinDataExports(): void {
  if (registered) return;
  registered = true;

  // --- Reads --------------------------------------------------------------
  registerDataExport({
    id: 'read-names', group: 'reads', order: 10, usesReadScope: true,
    title: 'Read names', format: 'text',
    description: 'One read name per line (for samtools view -N, grep, or a script).',
    available: scopeAvailability,
    run: ({ state, readScope }) => {
      const n = downloadReadNames(readScopeGroups(state, readScope), readScopeSlug(readScope), state);
      return `Saved ${n.toLocaleString()} read name${n === 1 ? '' : 's'}`;
    },
    buttonLabel: 'Download .txt',
  });
  registerDataExport({
    id: 'read-names-copy', group: 'reads', order: 11, usesReadScope: true, action: 'copy',
    title: 'Copy read names', format: 'clipboard',
    description: 'The same names, one per line, to paste elsewhere.',
    available: scopeAvailability,
    run: async ({ state, readScope }) => {
      const n = await copyReadNames(readScopeGroups(state, readScope));
      return `Copied ${n.toLocaleString()} read name${n === 1 ? '' : 's'}`;
    },
  });
  registerDataExport({
    id: 'read-table', group: 'reads', order: 20, usesReadScope: true,
    title: 'Read table', format: 'TSV',
    description: `Per read: dataset, cluster, span, strand, MAPQ, footprints, accessibility, modifications, display order (up to ${MAX_READ_STATS_READS.toLocaleString()} reads).`,
    available: (ctx) => {
      const scope = scopeAvailability(ctx);
      if (!scope.ok) return scope;
      // Lifted datasets are described too: their alignment bounds are on the sample's own assembly (ref_contig).
      const groups = readScopeGroups(ctx.state, ctx.readScope);
      const lifted = groups.some(g => ctx.state.datasets.find(d => d.id === g.datasetId)?.data_type === 'bam_livelift');
      return lifted ? { ok: true, detail: [scope.detail, 'lifted reads\' alignment bounds on their source assembly'].filter(Boolean).join('; ') } : scope;
    },
    run: ({ state, readScope }) => downloadReadTable(state, readScopeGroups(state, readScope), readScopeSlug(readScope)),
  });
  registerDataExport({
    id: 'read-bam', group: 'reads', order: 30, usesReadScope: true,
    title: 'BAM subset', format: '.bam',
    description: 'The reads\' alignments with every tag, one coordinate-sorted BAM per dataset.',
    available: (ctx) => {
      const scope = scopeAvailability(ctx);
      if (!scope.ok) return scope;
      if (!notPublic()) return no('Not available on a public server');
      const groups = readScopeGroups(ctx.state, ctx.readScope);
      const bam = groups.filter(g => isBamType(ctx.state.datasets.find(d => d.id === g.datasetId)?.data_type));
      if (bam.length === 0) return no('These reads are from BigBed datasets: a BAM subset needs a BAM');
      const lifted = bam.some(g => ctx.state.datasets.find(d => d.id === g.datasetId)?.data_type === 'bam_livelift');
      const detail = [scope.detail, bam.length < groups.length ? 'BigBed datasets are left out' : '',
        lifted ? 'lifted datasets\' reads on their source assembly' : ''].filter(Boolean).join('; ');
      return { ok: true, detail };
    },
    run: ({ state, readScope }) => downloadReadBams(readScopeGroups(state, readScope)
      .filter(g => isBamType(state.datasets.find(d => d.id === g.datasetId)?.data_type)),
      new Set(state.datasets.filter(d => d.data_type === 'bam_livelift').map(d => d.id))),
  });
  registerDataExport({
    id: 'working-set', group: 'reads', order: 40,
    title: 'Working-set reads & intervals', format: 'TSV',
    description: 'Every read the span and read filters admit in each panel on screen (all its reads, not just the ones picked above), with footprint and layer intervals, qualities and modification marks, and each row\'s reference and chromosome.',
    available: ({ state }) => {
      if (state.datasets.length === 0) return no('Open a dataset first');
      return shownPanelViews(state, { scope: 'all' }).length > 0 ? ok : no('No dataset panel on screen');
    },
    sizeWarning: ({ state }) => {
      // The panels whose reads it saves (not a minimized or hidden one).
      const byKey = useReadStatusStore.getState().byStateKey;
      const n = readsInViewFromStatus(onScreenStateKeys(state).map(k => byKey[k]).filter(Boolean));
      return n > 1000 ? `About ${n.toLocaleString()} reads in view: the file can be hundreds of MB and take a while.` : null;
    },
    run: ({ state }) => downloadWorkingSetTsv(state),
  });

  // --- Peaks & regions ------------------------------------------------------
  registerDataExport({
    id: 'peaks-bed', group: 'peaks', order: 10,
    title: 'Peaks', format: 'BED',
    description: 'Every peak with its rule, signal, threshold, mode and whether it is selected; one BED per reference.',
    available: ({ state }) => {
      const n = state.getAllPeaks().length;
      return n > 0 ? { ok: true, detail: `${n} peak${n === 1 ? '' : 's'} across rules` } : no('No peaks in view: Scan (S) finds them');
    },
    run: ({ state }) => downloadPeaksBed(state),
  });
  registerDataExport({
    id: 'selected-peaks-bed', group: 'peaks', order: 11,
    title: 'Selected peaks', format: 'BED',
    description: 'Only the peaks you selected (the ones clustering uses).',
    available: ({ state }) => needs(state.selectedPeaks.size > 0, 'No peaks selected: click peaks in the peak track'),
    run: ({ state }) => downloadPeaksBed(state, true),
  });
  registerDataExport({
    id: 'cluster-regions-bed', group: 'peaks', order: 20,
    title: 'Cluster regions', format: 'BED',
    description: 'The peak regions the current clustering used, with their mode.',
    available: ({ state }) => needs(state.clusterPeakRegions.length > 0, 'Cluster reads first'),
    run: ({ state }) => downloadClusterRegionsBed(state),
  });
  registerDataExport({
    id: 'viewport-bed', group: 'peaks', order: 30,
    title: 'Current region', format: 'BED',
    description: 'The locus of each panel on screen (the selected panels\' when panels are selected), one BED line each; one BED per reference.',
    available: ({ state }) => {
      const views = viewportViews(state);
      if (views.length === 0) return no('No dataset panel on screen');
      const several = new Set(views.map(v => v.genomeKey)).size > 1;
      return { ok: true, detail: views.map(v => `${several ? `${v.genomeKey} ` : ''}${viewLocusLabel(v)}`).join(', ') };
    },
    run: ({ state }) => downloadViewportBed(state),
  });
  registerDataExport({
    id: 'highlights-bed', group: 'peaks', order: 32,
    title: 'Highlights', format: 'BED',
    description: 'The highlighted regions (toolbar Highlight), named and coloured as drawn; one BED per reference.',
    available: ({ state }) => (state.highlights.length > 0
      ? { ok: true, detail: `${state.highlights.length} highlight${state.highlights.length === 1 ? '' : 's'}` }
      : { ok: false, reason: 'No highlights yet: use the toolbar\u2019s Highlight, or Shift-drag a ruler' }),
    run: ({ state }) => downloadHighlightsBed(state),
  });
  registerDataExport({
    id: 'saved-regions', group: 'peaks', order: 34, action: 'open',
    title: 'Saved regions', format: 'BED',
    description: 'Opens Regions, which exports a category, the regions shown or the ones you tick as BED.',
    available: ({ state }) => {
      const regions = useRegionCatalogStore.getState();
      const n = shownGenomes(state).reduce((sum, genome) => sum + regions.catalogFor(genome).entries.length, 0);
      return n > 0 ? { ok: true, detail: `${n} region${n === 1 ? '' : 's'}` } : { ok: false, reason: 'No saved regions on the references shown: add them in Regions' };
    },
    run: ({ state }) => openPanelForExport(state, 'circular-genome'),
  });
  registerDataExport({
    id: 'capture-regions', group: 'peaks', order: 40, action: 'open',
    title: 'Capture regions', format: 'BED · Twist TSV · FASTA · probes',
    description: 'Opens Capture Regions, which exports them in the format you pick.',
    available: ({ state }) => needs(state.captureRegions.length > 0, 'No capture regions yet: add them in Primers > Capture'),
    run: ({ state }) => openPanelForExport(state, 'capture'),
  });
  registerDataExport({
    id: 'track-values', group: 'peaks', order: 50, action: 'open',
    title: 'Track values in view', format: 'bedGraph · TSV',
    description: 'Opens Tracks: each track row\'s Export view saves its values for this region.',
    available: ({ state }) => needs(state.compositeTracks.length > 0, 'No tracks in the cart: add tracks in Tracks'),
    run: ({ state }) => openPanelForExport(state, 'track-browser'),
  });
  registerDataExport({
    id: 'annotation-profile', group: 'peaks', order: 60, action: 'open',
    title: 'Annotation profile', format: 'TSV',
    description: 'Opens Annotations: its Profile tab exports the binned annotation signal.',
    available: ({ state }) => needs(state.annotationFiles.length > 0, 'No annotation files loaded'),
    run: ({ state }) => openPanelForExport(state, 'annotations'),
  });

  // --- Classes & footprints --------------------------------------------------
  const classRun = () => {
    const { jobId, catalog } = useConsensusViewStore.getState();
    return jobId && catalog ? jobId : null;
  };
  registerDataExport({
    id: 'footprint-classes', group: 'classes', order: 10, action: 'open',
    title: 'Footprint class table', format: 'TSV',
    description: 'Opens Footprints > Classes: the class table\'s Export TSV (coordinates, channel, molecules, prevalence, support).',
    available: () => needs(classRun() != null, 'No class run yet: Footprints > Classes finds them'),
    run: ({ state }) => openPanelForExport(state, 'footprint-analysis', 'states'),
  });
  registerDataExport({
    id: 'class-result', group: 'classes', order: 20,
    title: 'Class result + provenance', format: '.json.gz',
    description: 'The frozen class run with its curation, to import again or share.',
    available: () => needs(classRun() != null, 'No class run yet: Footprints > Classes finds them'),
    run: () => {
      const id = classRun();
      if (!id) return;
      const a = document.createElement('a');
      a.href = consensusExportUrl(id);
      a.download = `fiberhmm-consensus-${id}.json.gz`;
      a.click();
    },
    buttonLabel: 'Download .json.gz',
  });
  registerDataExport({
    id: 'tagged-bams', group: 'classes', order: 30, action: 'open',
    title: 'Tagged BAMs', format: '.bam',
    description: 'Opens Footprints > Classes; Advanced > Save tagged BAMs writes BAMs with the class calls as tags.',
    available: () => {
      if (!notPublic()) return no('Not available on a public server');
      return needs(classRun() != null, 'No class run yet: Footprints > Classes finds them');
    },
    run: ({ state }) => openPanelForExport(state, 'footprint-analysis', 'states'),
  });
  registerDataExport({
    id: 'saved-footprints', group: 'classes', order: 40, action: 'open',
    title: 'Saved footprints', format: 'FASTA · .fiberlayers · rules JSON',
    description: 'Opens Footprints > Saved: its Export menu saves their sequences, matched calls or rules.',
    available: ({ state }) => needs(state.footprintGroups.length > 0, 'No saved footprints yet: save some in Footprints'),
    run: ({ state }) => openPanelForExport(state, 'footprint-analysis', 'saved'),
  });
  registerDataExport({
    id: 'co-occupancy', group: 'classes', order: 50, action: 'open',
    title: 'Co-occupancy', format: 'TSV',
    description: 'Opens Footprints > Co-occupancy: per-group and pairwise counts, odds ratios, q-values and read IDs.',
    available: ({ state }) => needs(state.footprintGroups.length > 0, 'Save footprints in Footprints first: co-occupancy compares them'),
    run: ({ state }) => openPanelForExport(state, 'footprint-analysis', 'co-occ'),
  });

  // --- Clusters ---------------------------------------------------------------
  registerDataExport({
    id: 'cluster-assignments', group: 'clusters', order: 10,
    title: 'Cluster assignments', format: 'TSV',
    description: 'Read, dataset, cluster and display order, with the clustering\'s settings as # lines.',
    available: ({ state }) => {
      const ids = Object.keys(state.clusterAssignments);
      if (ids.length === 0) return no('No clustering active: Cluster reads first');
      const reads = ids.reduce((sum, id) => sum + Object.keys(state.clusterAssignments[id]).length, 0);
      return { ok: true, detail: `${reads.toLocaleString()} reads across ${ids.length} dataset${ids.length > 1 ? 's' : ''}; rows keep viewer order` };
    },
    run: ({ state }) => downloadClusterAssignments(state),
  });
  // A placeholder: while Clusters > Projection shows a map, it takes this id over with a direct download.
  registerDataExport(CLUSTER_PROJECTION_PLACEHOLDER);
  registerDataExport({
    id: 'saved-clusterings', group: 'clusters', order: 30, action: 'open',
    title: 'Saved clusterings', format: 'JSON · TSV',
    description: 'Opens Clusters > Saved, which exports them.',
    available: ({ state }) => needs(state.savedClusters.length > 0, 'No saved clusterings yet'),
    run: ({ state }) => openPanelForExport(state, 'cluster-detail', 'saved'),
  });

  // --- Analysis tables --------------------------------------------------------
  registerDataExport({
    id: 'read-stats', group: 'analysis', order: 10, action: 'open',
    title: 'Read Stats', format: 'TSV · JSON',
    description: 'Opens Read Stats, whose header copies or saves its table.',
    available: ({ state }) => needs(state.datasets.length > 0, 'Open a dataset first'),
    run: ({ state }) => openPanelForExport(state, 'read-stats'),
  });
  registerDataExport({
    id: 'co-accessibility', group: 'analysis', order: 20, action: 'open',
    title: 'Co-accessibility matrix', format: 'TSV · JSON · Python',
    description: 'Opens Co-accessibility; its Export group saves the matrix or copies the Python call.',
    available: ({ state }) => needs(state.datasets.length > 0, 'Open a dataset first'),
    run: ({ state }) => openPanelForExport(state, 'co-accessibility'),
  });
  registerDataExport({
    id: 'transcription', group: 'analysis', order: 30, action: 'open',
    title: 'Transcription states', format: 'TSV · JSON · Python',
    description: 'Opens Transcription: per read pause, PIC and elongating calls for the genes picked.',
    available: ({ state }) => needs(state.selectedGenes.length > 0, 'Pick genes in Transcription first'),
    run: ({ state }) => openPanelForExport(state, 'transcription-state'),
  });
  registerDataExport({
    id: 'primer-order', group: 'analysis', order: 40, action: 'open',
    title: 'Primer order list', format: 'IDT · GENEWIZ · Sigma · CSV · FASTA · TSV',
    description: 'Opens Primers; its Order list tab exports the saved primers.',
    available: ({ state }) => needs((state.primer?.savedPrimers?.length ?? 0) > 0, 'No primers saved yet'),
    run: ({ state }) => openPanelForExport(state, 'primer-design'),
  });
  registerDataExport({
    id: 'contact-matrix', group: 'analysis', order: 50, action: 'open',
    title: 'Contact matrix', format: 'TSV',
    description: 'Opens Contacts; each contact track saves its matrix, arcs or virtual 4C as TSV.',
    available: () => needs(useDafcStore.getState().dafcLoaded, 'No contact data loaded'),
    run: ({ state }) => openPanelForExport(state, 'contact-map'),
  });

  // --- Session & working set ----------------------------------------------------
  registerDataExport({
    id: 'session-json', group: 'session', order: 10, primary: true,
    title: 'Exact browser state', format: 'JSON',
    description: 'Viewport, datasets, analysis settings and results, selections, panels, history and the reproducibility manifest. Open it again with Open in the top bar.',
    available: () => ok,
    run: ({ state }) => downloadStateJson(state.sessionName),
  });
  registerDataExport({
    id: 'reproducibility-summary', group: 'session', order: 20, action: 'copy',
    title: 'Reproducibility summary', format: 'text',
    description: 'Datasets, reference, seed, read cap, peaks, clustering, filters and restore warnings, to paste into notes.',
    available: () => ok,
    run: async ({ state }) => {
      await navigator.clipboard.writeText(formatSessionManifest(buildSessionManifest(state)));
      return 'Copied the summary';
    },
  });
}

/** A BAM subset's datasets: BAMs, and lifted datasets (their reads on the source assembly). */
function isBamType(type: string | undefined): boolean {
  return type === 'bam' || type === 'bam_livelift';
}
