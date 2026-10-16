import { createContext, useContext } from 'react';
import { useBackgroundView, type JobOwner } from '../nfrJobs';

/** Where the views below belong (a Saved entry, a tab): a result that arrives while they are closed marks it. */
export const NfrJobOwnerContext = createContext<JobOwner | null>(null);

/**
 * Load once per key (run, NFR or variant, view, options); errors are shown in place. The request belongs to the
 * panel, not to this view (utils/nfrJobs): closing the view leaves it running and its result cached by key.
 */
export function useView<T>(load: (() => Promise<T>) | null, key: string, what?: string): { data: T | null; error: string; loading: boolean } {
  const owner = useContext(NfrJobOwnerContext);
  const label = owner ? `${what ?? 'View'} · ${owner.label}` : (what ?? 'View');
  const { data, error, loading } = useBackgroundView<T>(load ? () => load() : null, key, owner ? { ...owner, label } : { label });
  return { data, error, loading };
}
