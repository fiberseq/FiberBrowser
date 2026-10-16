import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import type { ConsensusCatalog } from '../../../api/consensusWorkflow';
import type { FootprintGroup } from '../../../types';
import { consensusFamilyColor } from '../../../utils/consensusVisual';
import { displayFamilies, familyCount, stateDisplayName } from '../../../utils/consensusTrack';
import { isRecallerCatalog } from '../../../utils/recallerTable';
import { RecallerClassTable } from './RecallerClassTable';
import { classFeature, hoverFeature, toggleClassFeatures } from '../../../utils/classFeatures';
import { featureKey } from '../../../stores/featureStore';

type CatalogDataset = ConsensusCatalog['datasets'][string];

export const stateFilterKey = (datasetId: string, family: string) => `state:${datasetId}:${family}`;

/** Saved definition for a found state (what used to be "Add to Cart"). */
export function consensusStateGroup(
  jobId: string,
  datasetId: string,
  dataset: CatalogDataset,
  family: { family: string; consensus_start: number; consensus_end: number },
  chrom?: string,
  stage?: string | null,
): FootprintGroup {
  return {
    id: crypto.randomUUID(),
    name: stateDisplayName(dataset, family.family, { jobId, datasetId }),
    color: consensusFamilyColor(family.family),
    layer: 'tf_cr',
    consensusStateId: family.family,
    consensusJobId: jobId,
    ...(stage ? { consensusStage: stage } : {}),
    sourceDatasetId: datasetId,
    sizeMin: 0,
    sizeMax: null,
    referenceAbsStart: family.consensus_start,
    referenceAbsEnd: family.consensus_end,
    referenceChrom: chrom ?? null,
    minFpCoverage: .5,
    minTargetCoverage: .5,
    overlapFraction: 0,
    enabled: true,
    sourceIndex: -1,
  };
}

interface StateListProps {
  jobId: string;
  datasetLabels: Record<string, string>;
  activeFilterKey: string | null;
  onFilter: (datasetId: string, family: string, name: string) => void;
  /** Lattice-recaller runs: names the run on the classes saved from it. */
  runLabel?: string;
  /** "chr19:47,518,060–47,518,500 · 440 bp · the selected peak": the run's region, kept with saved classes and exports. */
  analysedRegion?: string;
}

/**
 * The found footprint classes, one row each: filter reads to a state, or tick
 * Save to add it to Saved (it is also compared in Co-occupancy).
 */
export function StateList({ jobId, datasetLabels, activeFilterKey, onFilter, runLabel, analysedRegion }: StateListProps) {
  const catalog = useConsensusViewStore(s => (s.jobId === jobId ? s.catalog : null));
  const selections = useConsensusViewStore(s => s.selections);
  const curation = useConsensusViewStore(s => s.curation);
  const selectedFeatureKeys = useBrowserStore(useShallow(s => s.selectedFeatures.map(featureKey)));
  const { footprintGroups, setFootprintGroups } = useBrowserStore(useShallow(s => ({
    footprintGroups: s.footprintGroups,
    setFootprintGroups: s.setFootprintGroups,
  })));
  if (!catalog) return <p className="text-[11px] text-gray-500">Loading classes…</p>;
  // Recaller classes are shared by every channel: one row per class, one column per channel.
  if (isRecallerCatalog(catalog) && Object.values(catalog.datasets).some(d => d.catalog?.some(f => f.recaller)))
    return <RecallerClassTable jobId={jobId} catalog={catalog} datasetLabels={datasetLabels} runLabel={runLabel} analysedRegion={analysedRegion} />;

  // Genomic order across datasets; names are "Class N" in that order.
  const rows = Object.entries(catalog.datasets).flatMap(([datasetId, dataset]) => displayFamilies(dataset)
    .filter(family => family.consensus_start != null && family.consensus_end != null)
    .map(family => ({
      datasetId, dataset, family,
      name: stateDisplayName(dataset, family.family, { jobId, datasetId }),
      ignored: !!family.ignored || !!curation?.ignored_families[datasetId]?.includes(family.family),
    })))
    .sort((a, b) => a.family.consensus_start - b.family.consensus_start || a.family.consensus_end - b.family.consensus_end);
  const multipleDatasets = Object.keys(catalog.datasets).length > 1;
  const savedKeys = new Set(footprintGroups
    .filter(group => group.consensusJobId === jobId && group.consensusStateId && group.sourceDatasetId)
    .map(group => `${group.sourceDatasetId}\t${group.consensusStateId}`));
  const isCompared = (datasetId: string, family: string) => savedKeys.has(`${datasetId}\t${family}`);

  // One store update per action, however many states are affected.
  const setCompared = (targets: typeof rows, on: boolean) => {
    const current = useBrowserStore.getState().footprintGroups;
    const wanted = new Set(targets.map(row => `${row.datasetId}\t${row.family.family}`));
    if (on) {
      const present = new Set(current.filter(group => group.consensusJobId === jobId)
        .map(group => `${group.sourceDatasetId}\t${group.consensusStateId}`));
      const additions = targets.filter(row => !present.has(`${row.datasetId}\t${row.family.family}`))
        // The run's chromosome: the view may have moved on since.
        .map(row => consensusStateGroup(jobId, row.datasetId, row.dataset, row.family, catalog.region?.chrom ?? useBrowserStore.getState().chrom,
          catalog.view_stage ?? catalog.final_stage));
      if (additions.length) setFootprintGroups([...current, ...additions]);
    } else {
      const next = current.filter(group => !(group.consensusJobId === jobId
        && wanted.has(`${group.sourceDatasetId}\t${group.consensusStateId}`)));
      if (next.length !== current.length) setFootprintGroups(next);
    }
  };
  const activeRows = rows.filter(row => !row.ignored);
  const comparedCount = rows.filter(row => isCompared(row.datasetId, row.family.family)).length;

  if (rows.length === 0) {
    return <p className="text-[11px] text-gray-500">No recurrent footprint classes were found in this region.</p>;
  }

  return (
    <div data-testid="state-list" className="space-y-1">
      <div className="flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300">
        <span className="font-medium">{rows.length} class{rows.length === 1 ? '' : 'es'}</span>
        <span className="text-gray-400">·</span>
        <span>{comparedCount} saved</span>
        <button
          type="button"
          className="ml-auto underline disabled:opacity-40"
          disabled={activeRows.every(row => isCompared(row.datasetId, row.family.family))}
          onClick={() => setCompared(activeRows, true)}
          title="Save every class to Saved (they are also compared in Co-occupancy)"
        >
          Save all
        </button>
        <button
          type="button"
          className="underline disabled:opacity-40"
          disabled={comparedCount === 0}
          onClick={() => setCompared(rows, false)}
          title="Remove these classes from Saved"
        >
          Unsave all
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto rounded border border-gray-200 dark:border-gray-700">
        {rows.map(row => {
          const { datasetId, family, name, ignored } = row;
          const compared = isCompared(datasetId, family.family);
          const filtering = activeFilterKey === stateFilterKey(datasetId, family.family);
          const selected = selections.some(s => s.jobId === jobId && s.datasetId === datasetId && s.family === family.family);
          const calls = familyCount(family);
          const feature = classFeature(jobId, datasetId, family.family, family.consensus_start, family.consensus_end, catalog.region?.chrom, name);
          const featureSelected = selectedFeatureKeys.includes(featureKey(feature));
          return (
            <div
              key={`${datasetId}:${family.family}`}
              data-testid="state-row"
              data-feature-selected={featureSelected || undefined}
              onMouseEnter={() => hoverFeature(feature)} onMouseLeave={() => hoverFeature(null)}
              className={`flex items-center gap-2 border-b border-gray-100 px-2 py-1 text-[11px] last:border-b-0 dark:border-gray-800 ${selected ? 'bg-cyan-50 dark:bg-cyan-950/30' : ''} ${ignored ? 'opacity-50' : ''} ${featureSelected ? 'ring-2 ring-inset ring-gray-900 dark:ring-gray-100' : ''}`}
            >
              <span className="h-3 w-3 flex-shrink-0 rounded-sm" style={{ backgroundColor: consensusFamilyColor(family.family) }} />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                title="Highlight this class on the reads; shift-click selects it for Cluster, Sort and Filter (main toolbar)"
                onClick={event => {
                  if (event.shiftKey) toggleClassFeatures([feature]);
                  useConsensusViewStore.getState().select({ jobId, datasetId, family: family.family }, event.metaKey || event.ctrlKey || event.shiftKey);
                }}
              >
                <span className="font-medium text-gray-800 dark:text-gray-100">{name}</span>
                {multipleDatasets && <span className="text-gray-500"> · {datasetLabels[datasetId] ?? datasetId}</span>}
                <span className="text-gray-500"> · {Math.round(family.consensus_end - family.consensus_start).toLocaleString()} bp</span>
                <span className="text-gray-500"> · {calls.toLocaleString()} calls</span>
                {family.manual && <span className="text-violet-700 dark:text-violet-300"> · edited</span>}
                {ignored && <span className="text-amber-700 dark:text-amber-300"> · ignored</span>}
              </button>
              <button
                type="button"
                aria-pressed={filtering}
                onClick={() => onFilter(datasetId, family.family, name)}
                className={`flex-shrink-0 rounded border px-1.5 py-0.5 ${filtering
                  ? 'border-emerald-700 bg-emerald-700 text-white'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'}`}
                title={filtering ? 'Show all reads again' : 'Show only reads whose best-fit class is this one'}
              >
                {filtering ? 'Filtering' : 'Filter reads'}
              </button>
              <label className="flex flex-shrink-0 items-center gap-1 text-gray-600 dark:text-gray-300" title="Save this class to Saved (it is also compared in Co-occupancy)">
                <input
                  type="checkbox"
                  aria-label={`Save ${name}`}
                  checked={compared}
                  onChange={event => setCompared([row], event.target.checked)}
                />
                Save
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
