import type { Dataset } from '../types';
import { fetchJson } from './sharedFetch';

export interface DemoRegion { chrom: string; start: number; end: number }

/** The bundled demos: 'napa' (the tour's main one, DddA-seq at NAPA) and 'sv' (H1 Fiber-seq around an insertion). */
export type DemoId = 'napa' | 'sv' | (string & {});

/** One bundled demo. */
export interface DemoEntry {
  id?: DemoId;
  available: boolean;
  label: string;
  genome: string;
  region: DemoRegion;
  dataset_id: string | null;
  /** The structural-variant demo's insertion (breakpoint and length). */
  insertion?: { chrom: string; ref: number; len: number };
}

/** The main demo (or the one asked for), with every bundled demo listed (older servers: none). */
export interface DemoInfo extends DemoEntry {
  demos?: DemoEntry[];
}

const query = (demo?: DemoId) => (demo ? `?demo=${encodeURIComponent(demo)}` : '');

/** The bundled demo dataset the guided tour runs on (another bundled demo with `demo`). */
export async function getDemo(demo?: DemoId): Promise<DemoInfo> {
  return fetchJson(`/api/demo${query(demo)}`);
}

/** A tour tab's reference after loading the demo: its genome, or none when that isn't on this computer. */
export interface DemoReference { genome: string | null; has_fasta: boolean }

export async function loadDemo(demo?: DemoId): Promise<{ success: boolean; error?: string; dataset?: Dataset; dataset_id?: string; region?: DemoRegion; already_loaded?: boolean; reference?: DemoReference; demo?: DemoId }> {
  return fetchJson(`/api/demo/load${query(demo)}`, { method: 'POST' });
}
