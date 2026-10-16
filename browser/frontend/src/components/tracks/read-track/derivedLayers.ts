import type { CompactRead } from './types';

const hydratedRead = new WeakMap<CompactRead, CompactRead>();
const hydratedReads = new WeakMap<CompactRead[], CompactRead[]>();

function hydrateNucFromPrimary(read: CompactRead): CompactRead {
  if (!read.derived_layers?.includes('nuc') || read.layers?.nuc) return read;
  const nucIntervals = (read.intervals ?? []).filter(interval => interval[2] > 0);
  if (nucIntervals.length === 0) return read;
  // Preserve lazy molecular columns when only the derived layer changes.
  const result = Object.defineProperties({}, Object.getOwnPropertyDescriptors(read)) as CompactRead;
  Object.defineProperty(result, 'layers', { enumerable: true, configurable: true, writable: true,
    value: { ...(read.layers ?? {}), nuc: { intervals: nucIntervals } },
  });
  return result;
}

export function hydrateDerivedReadLayers(reads: CompactRead[]): CompactRead[] {
  const cached = hydratedReads.get(reads);
  if (cached) return cached;
  let hydrated: CompactRead[] | null = null;
  for (let idx = 0; idx < reads.length; idx++) {
    const read = reads[idx];
    let nextRead = hydratedRead.get(read);
    if (!nextRead) {
      nextRead = hydrateNucFromPrimary(read);
      hydratedRead.set(read, nextRead);
    }
    if (nextRead === read) {
      if (hydrated) hydrated.push(read);
      continue;
    }
    if (!hydrated) hydrated = reads.slice(0, idx);
    hydrated.push(nextRead);
  }
  const result = hydrated ?? reads;
  hydratedReads.set(reads, result);
  return result;
}
