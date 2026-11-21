/** Hub-owned data loads, independent of whether read panels are mounted. */
import type { BrowserState } from '../../stores/browserStore';
import { fetchJson } from '../../api/sharedFetch';
import type { ReadsResponse } from '../../components/tracks/read-track/types';
import { getDifferences } from '../liveLift/api';
import { rememberDifferences } from '../liveLift/differenceCache';
import { rememberHubSv } from '../variants/hubProvider';
import type { HubView } from './hubState';

export async function loadProviderInputs(s: BrowserState, view: HubView, signal: AbortSignal, isCurrent = () => true): Promise<string[]> {
  const errors: string[] = [];
  const jobs = [...s.datasets];
  const worker = async () => {
    while (jobs.length && !signal.aborted && isCurrent()) {
      const ds = jobs.shift()!;
      try {
        if (ds.data_type === 'bam_livelift' && ds.live_lift) {
          const response = await getDifferences({ datasetId: ds.id, liftKey: ds.live_lift.key, ...view,
            detailBp: Math.max(250_000, Math.ceil(view.end) - Math.floor(view.start)) }, signal);
          if (!signal.aborted && isCurrent()) rememberDifferences(response);
        } else if (ds.data_type === 'bam' && !ds.lift_source_of
          && !s.panels.some(p => p.datasetId === ds.id && p.genome && !s.panels.some(q => q.datasetId === ds.id && !q.genome))) {
          const q = new URLSearchParams({ dataset_id: ds.id, chrom: view.chrom, start: String(Math.max(0, Math.floor(view.start))),
            end: String(Math.ceil(view.end)), max_reads: '1000', spanning: 'false', include_layers: 'false',
            include_methylation: 'false', include_sv_summary: 'true', min_sv_len: '50' });
          const response = await fetchJson<ReadsResponse>(`/api/reads/compact?${q}`, { signal });
          if (!signal.aborted && isCurrent()) rememberHubSv({ datasetId: ds.id, ...view, dataChrom: view.chrom, dataStart: view.start, dataEnd: view.end,
            sv: response.sv_summary ?? null, zoomedOut: false, reads: [], isReversed: false, sidebarWidth: 0, linkedOffset: view.start,
            panScope: 'main', linked: false });
        }
      } catch (e) { if (!signal.aborted) errors.push(`${ds.label}: ${(e as Error).message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  return errors;
}
