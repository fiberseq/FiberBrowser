import { useCallback, useEffect, useState } from 'react';
import { buildPrimerBlastDb, getPrimerConfig, pickFilePrimer, setPrimerConfig, type BlastToolSummary } from '../api/primers';
import { useBrowserStore } from '../stores/browserStore';
import { BLAST_DB_KEY, syncPrimerConfigFromStorage } from '../utils/primerConfigSync';
import { isPublicMode } from '../utils/publicMode';

function saveBlastDbPath(path: string | null) {
  try {
    if (path) localStorage.setItem(BLAST_DB_KEY, path);
    else localStorage.removeItem(BLAST_DB_KEY);
  } catch {
    // localStorage may be unavailable in embedded/private contexts.
  }
}

function pathLabel(path: string | null | undefined) {
  return path ? path.split('/').pop() || path : null;
}

export function usePrimerBlastConfig() {
  const currentGenome = useBrowserStore(s => s.currentGenome);
  const setPrimerError = useBrowserStore(s => s.setPrimerError);
  const [blastDbChoices, setBlastDbChoices] = useState<string[] | null>(null);
  const [blastWarning, setBlastWarning] = useState<string | null>(null);
  const [blastSetupBusy, setBlastSetupBusy] = useState(false);
  const [blastSetupMessage, setBlastSetupMessage] = useState<string | null>(null);
  const [blastTool, setBlastTool] = useState<BlastToolSummary | null>(null);

  useEffect(() => {
    if (isPublicMode()) return;
    let cancelled = false;
    getPrimerConfig()
      .then(config => {
        if (!cancelled) setBlastTool(config.blast_tool ?? null);
        return syncPrimerConfigFromStorage(config);
      })
      .then(result => {
        if (!cancelled) setBlastWarning(result.warning);
      })
      .catch(() => {
        if (!cancelled) setPrimerError('Failed to refresh BLAST DB');
      });
    return () => {
      cancelled = true;
    };
  }, [currentGenome, setPrimerError]);

  const selectBlastDb = useCallback(async (dbPath: string) => {
    const configResult = await setPrimerConfig(undefined, dbPath);
    if (configResult.success) {
      const state = useBrowserStore.getState();
      const resolvedDb = configResult.blast_db || null;
      state.setPrimerConfig(state.primer.configFasta, resolvedDb);
      saveBlastDbPath(resolvedDb || dbPath);
      setBlastWarning(configResult.blast_db_warning ?? null);
      setBlastDbChoices(null);
      setBlastSetupMessage(`Using BLAST DB: ${pathLabel(resolvedDb || dbPath)}`);
    } else {
      setPrimerError(configResult.message || 'Failed to set BLAST DB');
    }
  }, [setPrimerError]);

  const handlePickBlast = useCallback(async () => {
    const result = await pickFilePrimer('blast');
    if (result.success && result.path) {
      await selectBlastDb(result.path);
    } else if (result.success && result.databases && result.databases.length > 0) {
      setBlastDbChoices(result.databases);
      setBlastSetupMessage('Select the BLAST database that matches the loaded genome.');
    } else if (!result.success && result.message && !('cancelled' in result && result.cancelled)) {
      setPrimerError(result.message);
      setBlastSetupMessage(result.message);
    }
  }, [selectBlastDb, setPrimerError]);

  const buildBlastDbFromFasta = useCallback(async (force = false) => {
    setBlastSetupBusy(true);
    setBlastSetupMessage(force ? 'Rebuilding BLAST DB from loaded FASTA...' : 'Building BLAST DB from loaded FASTA...');
    try {
      const configResult = await buildPrimerBlastDb(force);
      if (configResult.success) {
        const state = useBrowserStore.getState();
        const resolvedDb = configResult.blast_db || null;
        state.setPrimerConfig(configResult.fasta || state.primer.configFasta, resolvedDb);
        saveBlastDbPath(resolvedDb);
        setBlastWarning(configResult.blast_db_warning ?? null);
        setBlastDbChoices(null);
        const label = pathLabel(resolvedDb);
        setBlastSetupMessage(configResult.created ? `Built local BLAST DB${label ? `: ${label}` : ''}.` : `Using existing local BLAST DB${label ? `: ${label}` : ''}.`);
      } else {
        const message = configResult.message || 'Failed to build BLAST DB from loaded FASTA';
        setPrimerError(message);
        setBlastSetupMessage(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build BLAST DB from loaded FASTA';
      setPrimerError(message);
      setBlastSetupMessage(message);
    } finally {
      setBlastSetupBusy(false);
    }
  }, [setPrimerError]);

  return {
    blastDbChoices,
    blastSetupBusy,
    blastSetupMessage,
    blastWarning,
    blastTool,
    buildBlastDbFromFasta,
    handlePickBlast,
    selectBlastDb,
    setBlastDbChoices,
    setBlastWarning,
  };
}
