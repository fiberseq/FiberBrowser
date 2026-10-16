import { getPrimerConfig, setPrimerConfig, type PrimerConfigResponse } from '../api/primers';
import { useBrowserStore } from '../stores/browserStore';
import { isPublicMode } from './publicMode';

export const BLAST_DB_KEY = 'fiberhmm_blast_db';

function getSavedBlastDb(): string | null {
  try {
    return localStorage.getItem(BLAST_DB_KEY);
  } catch {
    return null;
  }
}

function setSavedBlastDb(path: string | null) {
  try {
    if (path) localStorage.setItem(BLAST_DB_KEY, path);
    else localStorage.removeItem(BLAST_DB_KEY);
  } catch {
    // localStorage can be unavailable in private/embedded contexts.
  }
}

export interface PrimerConfigSyncResult {
  config: PrimerConfigResponse;
  warning: string | null;
}

export async function syncPrimerConfigFromStorage(
  initialConfig?: PrimerConfigResponse | null,
): Promise<PrimerConfigSyncResult> {
  if (isPublicMode()) {
    // Primer design runs BLAST on the host: not offered on a public server.
    return { config: initialConfig ?? ({} as PrimerConfigResponse), warning: null };
  }
  const savedBlast = getSavedBlastDb();
  let config = initialConfig ?? await getPrimerConfig();

  if (savedBlast && !config.blast_db) {
    const restored = await setPrimerConfig(undefined, savedBlast);
    if (restored.success === false) {
      setSavedBlastDb(null);
      useBrowserStore.getState().setPrimerError(restored.message || 'Failed to restore BLAST DB');
      config = {
        ...config,
        blast_db: null,
        blast_db_warning: restored.message || 'Saved BLAST DB could not be restored',
      };
    } else {
      config = restored;
    }
  }

  const blastDb = config.blast_db ?? null;
  useBrowserStore.getState().setPrimerConfig(config.fasta ?? null, blastDb);
  if (blastDb) setSavedBlastDb(blastDb);

  return {
    config,
    warning: config.blast_db_warning ?? null,
  };
}
