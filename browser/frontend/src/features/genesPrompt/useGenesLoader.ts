import { useCallback, useRef, useState } from 'react';
import { uploadFile } from '../../api/files';
import { loadGtf } from '../../api/reference';
import { useBrowserStore } from '../../stores/browserStore';
import { useGenomeCheckStore } from '../../stores/genomeCheckStore';
import { resetRegistryAnnotation } from '../../utils/annotationReset';
import type { GenesPrompt } from './genesPrompt';

/** Runs a genes prompt's action: busy while it loads, the error (with Retry) when it fails. */
export function useGenesLoader(prompt: GenesPrompt | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const download = useCallback(async () => {
    if (!prompt || prompt.kind !== 'download') return;
    setBusy(true);
    setError(null);
    const res = await resetRegistryAnnotation(prompt.genomeId);
    setBusy(false);
    if (!res.success) setError(res.error ?? `Could not load ${prompt.genomeId} genes`);
  }, [prompt]);

  const upload = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadFile(file);
      if (!uploaded?.success || !uploaded.path) throw new Error('Could not upload the annotation');
      const res = await loadGtf(uploaded.path);
      if (!res.success) throw new Error(res.message || 'Could not load the annotation');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the annotation');
    } finally {
      setBusy(false);
      useBrowserStore.getState().triggerRefresh();
      void useGenomeCheckStore.getState().refresh();
    }
  }, []);

  const start = useCallback(() => {
    if (!prompt) return;
    if (prompt.kind === 'download') void download();
    else fileInput.current?.click();
  }, [prompt, download]);

  return { busy, error, start, upload, fileInput };
}
