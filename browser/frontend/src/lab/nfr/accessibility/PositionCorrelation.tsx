import { useLocusGenes } from '../../../hooks/useLocusGenes';
import { panelReversed } from '../../../hooks/usePanelDisplayStore';
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { useCoaccStore } from '../../../stores/coaccStore';
import { useContainerWidth } from '../../../hooks/useContainerWidth';
import { AnalysisToggleGroup } from '../../../components/controls/shared';
import { CoaccMatrixView, coaccMatrixSize, type CoaccMatrixSettings } from '../../../components/controls/co-accessibility/CoaccMatrixView';
import { CoaccDifferenceView, type DiffDataset } from '../../../components/controls/co-accessibility/CoaccDifferenceView';
import { useCoaccScope } from '../../../components/controls/co-accessibility/useCoaccScope';
import type { CoaccMetadata } from '../../../api/coaccessibility';

/**
 * NFR pairs, Position correlation: the Co-accessibility panel's position x position matrix of the view (every pair of
 * positions compared on the same molecules), from the same server and with its settings, for the targeted datasets
 * combined or one per dataset; or two open datasets subtracted (A − B on one position grid). A position view beside
 * the element view: the NFR elements are the panel's own tests, these are raw agreement values.
 */
export function PositionCorrelation({ isFullView = false, locus, regionsDiffer = false }: {
  isFullView?: boolean;
  /** The NFR panel's resolved analysis locus (a panel at its own locus in Per panel mode); absent: the main view. */
  locus?: { chrom: string; start: number; end: number; genome?: string | null; panelIds?: string[] } | null;
  /** The targeted panels show different regions: nothing to compute until one is chosen (the header offers it). */
  regionsDiffer?: boolean;
}) {
  const view0 = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end })));
  const { chrom, start, end } = locus ?? view0;
  const { datasets, panels, sampleSeed } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets, panels: s.panels, sampleSeed: s.analysisSampleSeed,
  })));
  const genome = locus?.genome ?? null;
  const reversed = useBrowserStore(s => panelReversed(s, locus?.panelIds?.[0] ?? null));
  const genes = useLocusGenes(chrom, start, end, genome);
  const settings: CoaccMatrixSettings = useCoaccStore(useShallow(s => ({
    normalization: s.coaccNormalization, scaling: s.coaccScaling, colormap: s.coaccColormap, minCoverage: s.coaccMinCoverage,
    binSize: s.coaccBinSize, signalType: s.coaccSignalType, layer: s.coaccLayer,
  })));
  const setNormalization = useCoaccStore(s => s.setCoaccNormalization);
  const scope = useCoaccScope();
  const [view, setView] = useState<'matrix' | 'diff'>('matrix');
  const [perDataset, setPerDataset] = useState(false);
  const [metadata, setMetadata] = useState<CoaccMetadata | null>(null);
  const [width, ref] = useContainerWidth(320);
  // Each open dataset with the reference its panel is on (a panel of its own assembly; else the main genome).
  const diffDatasets: DiffDataset[] = useMemo(() => datasets.map(dataset => ({
    dataset,
    reference: panels.find(p => p.contentType === 'dataset' && p.datasetId === dataset.id && p.genome)?.genome ?? null,
  })), [datasets, panels]);
  const ids = scope.targetDatasetIds.length ? scope.targetDatasetIds : datasets.map(d => d.id);
  const size = coaccMatrixSize(width, { fullView: isFullView, perDataset, viewportHeight: typeof window !== 'undefined' ? window.innerHeight : Infinity });
  if (!datasets.length) return <p className="text-[11px] text-gray-500">Open a dataset to see its position matrix.</p>;
  if (regionsDiffer) return <p className="text-[11px] text-gray-500" data-testid="nfr-poscorr-regions-differ">The targeted panels show different regions: choose one (above) to see its position matrix.</p>;
  return (
    <div ref={ref} className="space-y-2 text-[11px]" data-testid="nfr-position-correlation">
      <p className="text-ink-muted">Every pair of positions in the view, compared on the same molecules: how often the two share a state ({settings.signalType === 'accessibility' && !settings.layer ? 'accessible' : settings.layer ?? settings.signalType}). The Co-accessibility panel's matrix and settings; a difference of two datasets shows where they disagree.</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <AnalysisToggleGroup theme="fuchsia" value={view} onChange={v => v && setView(v)}
          options={[{ value: 'matrix', label: 'Matrix' }, { value: 'diff', label: 'A − B' }]} />
        <label className="flex items-center gap-1" title="Raw: the share of molecules on which the two positions agree; correlation: centred on what their openness alone gives">
          Values
          <select value={settings.normalization} onChange={e => setNormalization(e.target.value as never)} data-testid="nfr-poscorr-values"
            className="rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900">
            <option value="correlation">correlation</option>
            <option value="raw">raw</option>
            {settings.normalization !== 'correlation' && settings.normalization !== 'raw' && <option value={settings.normalization}>{settings.normalization}</option>}
          </select>
        </label>
        {view === 'matrix' && ids.length > 1 && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={perDataset} onChange={e => setPerDataset(e.target.checked)} data-testid="nfr-poscorr-per-dataset" /> One per dataset
          </label>
        )}
      </div>
      {view === 'matrix' ? (
        <CoaccMatrixView genome={genome} reversed={reversed} chrom={chrom} start={start} end={end} datasets={datasets} datasetIds={ids} perDataset={perDataset && ids.length > 1}
          settings={settings} readIds={scope.effectiveReadIdsByDataset ? undefined : scope.effectiveReadIds} readIdsByDataset={scope.effectiveReadIdsByDataset}
          readIdsForDataset={scope.readIdsForDataset} singleMaxSize={size} multiMaxSize={size} genes={genes}
          metadata={metadata} onMetadata={setMetadata} />
      ) : (
        <CoaccDifferenceView reversed={reversed} datasets={diffDatasets} chrom={chrom} start={start} end={end} settings={settings}
          readIdsForDataset={scope.readIdsForDataset} sampleSeed={sampleSeed} size={Math.min(size, 560)} />
      )}
    </div>
  );
}
