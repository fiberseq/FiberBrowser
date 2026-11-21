import { useBrowserStore } from '../../../stores/browserStore';
import type { FirstPaintInfo, WorkingSampling } from './types';
import { usePerformanceStore } from '../../../stores/performanceStore';

const fmt = (n: number) => n.toLocaleString();

/** Analyses that read every alignment of the view (not the sample), in the order the notice names them. */
const fullReadAnalyses: { name: string; order: number }[] = [{ name: 'Find classes', order: 10 }, { name: 'the SV split', order: 20 }];

/** A plugin pack's analysis that reads every alignment, named in the sampled-reads notice. */
export function registerFullReadAnalysis(name: string, order: number): void {
  fullReadAnalyses.push({ name, order });
  fullReadAnalyses.sort((a, b) => a.order - b.order);
}

function namedList(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}

/** "N of M reads loaded (sampled)" for a deep view's server sample, with "Load all" (round 3, R10: its scope said). */
export function sampleNoticeText(sampling: WorkingSampling): { text: string; title: string } {
  const per = Math.round(1 / Math.max(1e-9, sampling.fraction));
  return {
    text: `${fmt(sampling.kept)} of ${fmt(sampling.total)} reads loaded (sampled)`,
    title: `This view has ${fmt(sampling.total)} reads (alignments, before the read filters); ${fmt(sampling.kept)} were loaded (1 in ${per}, chosen by read name,`
      + ' so the same reads stay in as you pan and zoom). The reads drawn, the aggregate profile and the SV band\'s'
      + ' counts come from these (as do analyses of the reads shown); analyses that load the view themselves use every read in it,'
      + ` and ${namedList(fullReadAnalyses.map(a => a.name))} read every alignment.`,
  };
}

/** "Showing 1,000 of ~4,640 reads, loading the rest…" while a cold deep view's full set loads (services/first_paint.py). */
export function firstPaintNoticeText(firstPaint: FirstPaintInfo): { text: string; title: string } {
  return {
    text: `Showing ${fmt(firstPaint.shown)} of ~${fmt(firstPaint.total_estimate)} reads, loading the rest…`,
    title: 'The reads drawn are the ones this view keeps. The rest of its reads are still loading:'
      + ' the read counts are estimates and the SV band waits for them. Cluster, Sort, Analyse and scans load'
      + ' every read in view themselves, so they wait for the rest too.',
  };
}

/**
 * Bottom-right chip of a read panel whose reads the server sampled (a deep
 * BAM view), or which loads every read on request ("Load all"), or whose
 * first paint is showing while the rest of the view loads.
 */
export function ReadSampleNotice({ datasetId, sampling, firstPaint = null }: {
  datasetId: string; sampling: WorkingSampling | null; firstPaint?: FirstPaintInfo | null;
}) {
  const lowMemory = usePerformanceStore(s => s.info?.effective === 'low');
  const loadAll = useBrowserStore(s => Boolean(s.loadAllReads?.[datasetId]));
  const setLoadAllReads = useBrowserStore(s => s.setLoadAllReads);
  const exporting = useBrowserStore(s => s.exportInProgress);
  const base = 'absolute bottom-0 right-1 z-20 flex items-center gap-1 rounded-t bg-white/90 px-1 text-[11px] text-gray-600 dark:bg-gray-900/90 dark:text-gray-300';
  if (!exporting && firstPaint) {
    const { text, title } = firstPaintNoticeText(firstPaint);
    return (
      <div className={base} data-testid={`read-first-paint-notice-${datasetId}`} title={title}>
        <span>{text}</span>
      </div>
    );
  }
  if (exporting || (!sampling && !loadAll)) return null;
  if (!sampling) {
    return (
      <div className={base} data-testid={`read-sample-notice-${datasetId}`} data-sampled="false">
        <span>All reads loaded</span>
        <button type="button" className="text-blue-600 hover:underline dark:text-blue-300"
          title="Back to a sample of this view's reads (faster on deep views)"
          onClick={() => setLoadAllReads(datasetId, false)} data-testid="read-sample-resample">Sample</button>
      </div>
    );
  }
  const { text, title } = sampleNoticeText(sampling);
  const slower = Math.round(1 / Math.max(1e-9, sampling.fraction));
  return (
    <div className={base} data-testid={`read-sample-notice-${datasetId}`} data-sampled="true" title={lowMemory
      ? 'Low memory uses sampled reads and caps analysis working sets. Choose Standard or High performance in Settings to load every read.' : title}>
      <span>{text}</span>
      {lowMemory ? <span data-testid="performance-sampled-note">· Low memory</span> :
      <button type="button" className="text-blue-600 hover:underline dark:text-blue-300"
        title={`Load all ${fmt(sampling.total)} reads in view: about ${slower}x the time and memory of the sample`}
        onClick={() => setLoadAllReads(datasetId, true)} data-testid="read-sample-load-all">Load all</button>}
    </div>
  );
}
