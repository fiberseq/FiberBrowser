/** Read-name sets for read requests (browser/services/read_sets.py): a subset too large for a query string. */
import { fetchJson } from './sharedFetch';

const known = new Map<string, Promise<string>>();

/** Register these names (once per content in this page) and give the set id for `filter_set`. */
export function registerReadSet(ids: string[], key: string, fresh = false): Promise<string> {
  if (fresh) known.delete(key);
  let pending = known.get(key);
  if (!pending) {
    pending = fetchJson<{ set_id: string }>('/api/read_sets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    }).then(r => r.set_id);
    pending.catch(() => known.delete(key));
    known.set(key, pending);
    if (known.size > 64) known.delete(known.keys().next().value!);
  }
  return pending;
}
