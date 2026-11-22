import { useBrowserStore } from '../stores/browserStore';
import type { Dataset } from '../types';

/**
 * The startup dataset list (fetched at mount) replaces the store's datasets once it arrives only if nothing replaced
 * them meanwhile. A dataset generation counts every replacement: a change of the ordered dataset IDs (an add, a close,
 * a session with datasets, crash recovery) and, explicitly, a session import or recovery even when the IDs stay the
 * same (an empty session imported over the still-empty page). A metadata refresh that only re-maps the list (the hub
 * refreshing layers) keeps the generation. Module state, not store state: undo and recovery must not rewind it.
 */
let generation = 0;

export function datasetGeneration(): number {
  return generation;
}

/** A session import or recovery replaced the datasets (called where it writes them). */
export function bumpDatasetGeneration(): void {
  generation += 1;
}

function sameIds(a: readonly Dataset[], b: readonly Dataset[]): boolean {
  return a.length === b.length && a.every((d, i) => d.id === b[i].id);
}

// Subscribed on first use, not at import: this module is imported by modules the store itself may reach.
let watching = false;
function watchDatasetIds(): void {
  if (watching) return;
  watching = true;
  useBrowserStore.subscribe((state, previous) => {
    if (state.datasets !== previous.datasets && !sameIds(state.datasets ?? [], previous.datasets ?? [])) generation += 1;
  });
}

/** Taken when the startup requests go out; `stillApplies()` once the startup list arrives. */
export function startupDatasetsGuard(): { stillApplies(): boolean } {
  watchDatasetIds();
  const atStartup = generation;
  return { stillApplies: () => generation === atStartup };
}
