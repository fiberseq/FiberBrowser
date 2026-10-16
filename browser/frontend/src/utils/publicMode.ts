import { useBrowserStore } from '../stores/browserStore';
import { isPublicServerPage } from './publicServerFlag';

/** On a public server (--public): the server injects this flag into
 * index.html before any script runs, and /api/status reports it too.
 * Host-only features (Jupyter, Copilot, primers, S3, linked sessions)
 * are unavailable there and their requests are refused. */
export function isPublicMode(): boolean {
  return isPublicServerPage() || useBrowserStore.getState().publicMode === true;
}
