/**
 * The read pool each read panel computed its metaprofiles from (ReadTrack: the profile reads, after the duplicate,
 * QC-fail, signal and quality rules), by panel state key, with the view they were computed over. Quantify a window
 * reads it, so its numbers come from the same reads, filters and spans as the curves beside it. A plain module map
 * (not store state: it holds the reads themselves); e2e runs can read it.
 */
import type { CompactRead } from '../components/tracks/read-track/types';

export interface ProfileReadPool { reads: CompactRead[]; chrom: string; start: number; end: number; resolution: number; version: number;
  /** The extra layers the panel fetched (layer_names) and whether it fetched marks: Quantify reads a fresh sample for
   *  any other layer rather than count zeros. Absent: unknown (every channel the reads carry counts). */
  layers?: readonly string[]; marks?: boolean }

const pools = new Map<string, ProfileReadPool>();
const listeners = new Set<() => void>();
let version = 0;

export function setProfileReadPool(stateKey: string, p: Omit<ProfileReadPool, 'version'>): void {
  const cur = pools.get(stateKey);
  if (cur && cur.reads === p.reads && cur.chrom === p.chrom && cur.start === p.start && cur.end === p.end) return;
  pools.set(stateKey, { ...p, version: ++version });
  for (const fn of listeners) fn();
}

/** The panel's curves no longer come from a local read pool (a server profile): forget it, so Quantify reads afresh. */
export function clearProfileReadPool(stateKey: string): void {
  if (!pools.delete(stateKey)) return;
  version++;
  for (const fn of listeners) fn();
}

export const getProfileReadPool = (stateKey: string): ProfileReadPool | undefined => pools.get(stateKey);
export const profileReadPoolVersion = (): number => version;

export function onProfileReadPool(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
