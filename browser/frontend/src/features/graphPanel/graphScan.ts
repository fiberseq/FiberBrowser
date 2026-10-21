/**
 * Peak scanning on graph node columns (graph features, item 3; services/graph_panel/scan.py).
 *
 * While a host draws its graph and the main view is on its package's target, a scan of a read-based source (the
 * toolbar's Scan, or the scan of a new view) runs on graph columns: every observation of the view (each lifted
 * haplotype on its own path, each native dataset on the target; the planner Cluster uses) adds its counts to the
 * columns it carries, so a column's signal pools every haplotype carrying it. Peaks on the target walk are target
 * spans; a peak inside an insertion comes back as a span holding the insertion's anchor, so Cluster at it clusters on
 * the inserted columns. The peaks are the rule's peaks as a linear scan's are (select them, then Cluster).
 */
import type { BrowserState } from '../../stores/browserStore';
import { registerPeakScanRunner, type PeakScanCall, type PeakScanResult } from '../../utils/peakScanExtensions';
import { graphClusterPlan } from './graphCluster';

const wire = (o: Record<string, unknown>) => {
  const { label: _label, hap: _hap, ...rest } = o;
  return rest;
};

/** The graph scan's request for this view, or null (no host drawing its graph on this view's contig). */
export function graphScanBody(state: BrowserState, call: PeakScanCall): Record<string, unknown> | null {
  const plan = graphClusterPlan(state as never, { kind: 'peaks', regions: [{ start: call.start, end: call.end, chrom: call.chrom }] });
  if (!plan || plan.refusal || !plan.observations.length) return null;
  // Panels that left the view's window on their own (another locus) are scanned by the linear path, not here.
  return {
    registration_id: plan.registration.id, revisions: plan.registration.revisions, target: plan.target,
    window: { start: call.start, end: call.end },
    observations: plan.observations.map(o => wire(o as never)),
    scan: {
      signal_source: call.source, min_width: call.minWidth, min_reads: call.minReads,
      smooth_width: call.thresholds.smoothWidth, threshold_strong: call.thresholds.thresholdStrong,
      threshold_medium: call.thresholds.thresholdMedium, threshold_weak: call.thresholds.thresholdWeak,
      threshold_rare: call.thresholds.thresholdRare, return_signal: true, sample_seed: call.sampleSeed ?? null,
    },
  };
}

export async function runGraphScan(state: BrowserState, call: PeakScanCall): Promise<PeakScanResult | null> {
  const body = graphScanBody(state, call);
  if (!body) return null;
  const response = await fetch('/api/graph/scan_peaks', { method: 'POST', credentials: 'include', signal: call.signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!response.ok) throw new Error(json?.error?.message ?? (text.slice(0, 200) || response.statusText));
  return json as PeakScanResult;
}

let registered = false;
export function registerGraphScan(): void {
  if (registered) return;
  registered = true;
  registerPeakScanRunner(runGraphScan);
}
