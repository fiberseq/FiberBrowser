import { useCallback, useEffect, useState } from 'react';
import { pickFile } from '../api/files';
import { loadFasta } from '../api/reference';
import { showLoadedReference } from '../utils/referenceNavigation';
import { useBrowserStore } from '../stores/browserStore';
import { autoSaveNow } from './useAutoSave';

export interface ReferenceFileStatus {
  has_gtf: boolean;
  gene_count: number;
  fasta_error?: string | null;
}

export function useReferenceFastaLoader(
  status: ReferenceFileStatus | null,
  onRemoveGtf: () => void,
) {
  const [fastaLoading, setFastaLoading] = useState(false);
  const [fastaError, setFastaError] = useState<string | null>(null);
  const hasFasta = useBrowserStore(s => s.hasFasta);
  const fastaPath = useBrowserStore(s => s.fastaPath);
  const setHasFasta = useBrowserStore(s => s.setHasFasta);
  const setFastaPath = useBrowserStore(s => s.setFastaPath);
  const setCurrentGenome = useBrowserStore(s => s.setCurrentGenome);

  useEffect(() => {
    if (status?.fasta_error) {
      setFastaError(prev => prev ?? status.fasta_error ?? null);
    }
  }, [status?.fasta_error]);

  const handleLoadFasta = useCallback(async () => {
    setFastaLoading(true);
    setFastaError(null);
    try {
      const picked = await pickFile('fasta');
      if (!picked.success || !picked.path) {
        setFastaLoading(false);
        return;
      }

      const res = await loadFasta(picked.path);
      if (res.success) {
        setHasFasta(true);
        setFastaPath(res.path || picked.path);
        setCurrentGenome(res.inferred_genome ?? null);
        if (status?.has_gtf) {
          onRemoveGtf();
        }
        void showLoadedReference();
        setTimeout(() => { void autoSaveNow(); }, 500);
      } else {
        setFastaError(res.error || 'Failed to load FASTA');
      }
    } catch (e) {
      setFastaError(e instanceof Error ? e.message : 'Failed to load FASTA');
    } finally {
      setFastaLoading(false);
    }
  }, [onRemoveGtf, setCurrentGenome, setFastaPath, setHasFasta, status?.has_gtf]);

  return {
    fastaLoading,
    fastaError,
    fastaPath,
    hasFasta,
    handleLoadFasta,
    setFastaError,
  };
}
