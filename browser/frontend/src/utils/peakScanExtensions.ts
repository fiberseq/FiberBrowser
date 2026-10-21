/**
 * Peak scan runners (graph features): a pack can scan a rule's read-based source its own way for the main view (the
 * graph panel scans node columns while a host draws its graph). A runner answers null when it does not apply, and
 * the linear scan runs as before.
 */
import type { BrowserState } from '../stores/browserStore';
import type { ScanPeaksResponse } from '../api/peaks';

export interface PeakScanCall {
  chrom: string; start: number; end: number;
  /** The server's read-based signal source (accessibility, fire, layer:<name>, a modification). */
  source: string;
  minWidth: number; minReads: number;
  thresholds: { smoothWidth: number; thresholdStrong: number; thresholdMedium: number; thresholdWeak: number; thresholdRare: number };
  sampleSeed?: string;
  signal?: AbortSignal;
}

/** A scan's result as the linear scan's response, with each peak's graph part when the runner knows it. */
export type PeakScanResult = Omit<ScanPeaksResponse, 'peaks'> & { peaks: Array<ScanPeaksResponse['peaks'][number] & { graph?: { kind: string; label?: string } }> };

type Runner = (state: BrowserState, call: PeakScanCall) => Promise<PeakScanResult | null>;
const runners: Runner[] = [];

export function registerPeakScanRunner(run: Runner): void { runners.push(run); }

/** The first registered runner's result for this scan, or null (the linear scan). */
export async function extendedPeakScan(state: BrowserState, call: PeakScanCall): Promise<PeakScanResult | null> {
  for (const run of runners) {
    const out = await run(state, call);
    if (out) return out;
  }
  return null;
}
