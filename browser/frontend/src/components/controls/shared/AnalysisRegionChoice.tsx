import { useBrowserStore } from '../../../stores/browserStore';
import { panelGenomeLabel, usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { analysisLocusLabel, type AnalysisLocus } from '../../../utils/analysisLocus';

/**
 * The targeted panels show different regions (another locus, another
 * assembly): an analysis of one region asks which (fb-r2-integ). Choosing one
 * selects its panels, so the analysis (and what it applies) targets them.
 */
export function AnalysisRegionChoice({ loci, what, onChoose }: {
  loci: AnalysisLocus[];
  /** "Co-occupancy", "Transcription states"... */
  what: string;
  /** Default: select the panels showing the region. */
  onChoose?: (locus: AnalysisLocus) => void;
}) {
  const datasets = useBrowserStore(s => s.datasets);
  const genomes = usePanelGenomeStore(s => s.genomes);
  const choose = onChoose ?? ((locus: AnalysisLocus) => useBrowserStore.setState({ selectedDatasets: new Set(locus.panelIds) }));
  return (
    <div data-testid="analysis-region-choice" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
      <p>{what} looks at one region, and the selected panels show {loci.length}. Choose one (or select a single panel):</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {loci.map(locus => (
          <button
            key={`${locus.genome ?? ''}|${locus.chrom}:${locus.start}-${locus.end}`}
            type="button"
            data-testid="analysis-region-option"
            className="rounded border border-amber-300 bg-white px-2 py-0.5 hover:bg-amber-100 dark:border-amber-700 dark:bg-gray-900 dark:hover:bg-gray-800"
            onClick={() => choose(locus)}
          >
            {analysisLocusLabel(locus, key => panelGenomeLabel(genomes[key], key), id => datasets.find(d => d.id === id)?.label || id)}
          </button>
        ))}
      </div>
    </div>
  );
}
