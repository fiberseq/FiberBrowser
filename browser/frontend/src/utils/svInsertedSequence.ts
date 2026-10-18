/**
 * An insertion's inserted bases (fb-n9-sv), fetched on demand by read id and
 * query interval (GET /api/sv/insert_seq), never carried in every read
 * payload. Cached per dataset/read/interval for the hover and the copy.
 */
import { useEffect, useState } from 'react';
import { fetchJson } from '../api/sharedFetch';
import { copyText } from './clipboard';
import { useReadActionsStore } from '../stores/readActionsStore';

export interface InsertionRef {
  datasetId: string;
  chrom: string;
  readId: string;
  event: { ref: number; raw_ref?: number; q: number; len: number; seq?: string };
}

const cache = new Map<string, Promise<string>>();
const MAX_CACHED = 200;

function keyOf(r: InsertionRef): string {
  return [r.datasetId, r.chrom, r.readId, r.event.raw_ref ?? r.event.ref, r.event.q, r.event.len].join('|');
}

export function fetchInsertedSequence(r: InsertionRef): Promise<string> {
  const key = keyOf(r);
  const have = cache.get(key);
  if (have) return have;
  const params = new URLSearchParams({
    dataset_id: r.datasetId, chrom: r.chrom, ref: String(r.event.raw_ref ?? r.event.ref), read_id: r.readId,
    q: String(r.event.q), len: String(r.event.len),
  });
  const promise = fetchJson<{ seq: string }>(`/api/sv/insert_seq?${params}`).then(out => out.seq);
  promise.catch(() => cache.delete(key));
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(key, promise);
  return promise;
}

/** Copy an insertion's full inserted sequence, saying so on the panel. */
export async function copyInsertedSequence(r: InsertionRef & { stateKey: string }): Promise<boolean> {
  const notice = useReadActionsStore.getState().showNotice;
  try {
    const seq = await fetchInsertedSequence(r);
    const ok = await copyText(seq);
    notice(r.stateKey, ok ? `Inserted sequence copied (${seq.length.toLocaleString()} bp)` : 'Could not copy');
    return ok;
  } catch {
    notice(r.stateKey, 'Could not load the inserted sequence');
    return false;
  }
}

/** The first `n` inserted bases for a hover (null while loading or on failure). */
export function useInsertedBases(r: InsertionRef | null, n = 30): string | null {
  const [bases, setBases] = useState<string | null>(null);
  const key = r ? keyOf(r) : '';
  useEffect(() => {
    setBases(null);
    if (!r) return;
    if (r.event.seq) {
      setBases(r.event.seq.slice(0, n));
      return;
    }
    let live = true;
    // A short pause so a pointer sweeping across reads fetches nothing.
    const timer = window.setTimeout(() => {
      fetchInsertedSequence(r).then(seq => { if (live) setBases(seq.slice(0, n)); }).catch(() => { if (live) setBases(null); });
    }, 150);
    return () => { live = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n]);
  return bases;
}
