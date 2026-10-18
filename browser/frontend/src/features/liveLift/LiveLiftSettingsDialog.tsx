/** A lifted dataset's display settings after it was opened (each is part of its lift_key: caches start over). */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import { updateLiftSettings } from './api';
import { LiftSettingsFields } from './LiveLiftDialog';

export const useLiftSettingsDialog = create<{ datasetId: string | null; open: (id: string | null) => void }>(set => ({
  datasetId: null,
  open: id => set({ datasetId: id }),
}));

export function LiveLiftSettingsDialog() {
  const datasetId = useLiftSettingsDialog(s => s.datasetId);
  const close = () => useLiftSettingsDialog.getState().open(null);
  const dataset = useBrowserStore(s => s.datasets.find(d => d.id === datasetId));
  const s = dataset?.live_lift?.settings ?? {};
  const [gSplitKb, setGSplitKb] = useState(10);
  const [mergeKb, setMergeKb] = useState(50);
  const [alternatives, setAlternatives] = useState(false);
  const [supplementaries, setSupplementaries] = useState<'own_rows' | 'hide'>('own_rows');
  const [hatching, setHatching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!dataset) return;
    setGSplitKb(Number(s.g_split ?? 10_000) / 1000);
    setMergeKb(Number(s.window_merge ?? 50_000) / 1000);
    setAlternatives(Boolean(s.alternatives));
    setSupplementaries((s.supplementary_display as 'own_rows' | 'hide') ?? 'own_rows');
    setHatching(s.coverage_hatching !== false);
    setError(null);
  }, [datasetId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!datasetId || !dataset) return null;
  const save = async () => {
    const r = await updateLiftSettings(datasetId, {
      g_split: Math.round(gSplitKb * 1000), window_merge: Math.round(mergeKb * 1000), alternatives,
      supplementary_display: supplementaries, coverage_hatching: hatching,
    });
    if (!r.success || !r.dataset) { setError(r.error ?? 'Not saved'); return; }
    const updated = r.dataset;
    useBrowserStore.setState(st => ({
      datasets: st.datasets.map(d => (d.id === updated.id ? { ...d, ...updated } : d)),
      refreshGeneration: st.refreshGeneration + 1,
    }));
    close();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="live-lift-settings-title" data-testid="live-lift-settings-dialog"
        className="w-full max-w-md rounded-apple-lg border border-line/60 bg-white p-5 text-[12px] shadow-modal dark:border-white/10 dark:bg-dark-surface">
        <h2 id="live-lift-settings-title" className="mb-1 text-[15px] font-semibold">Live-lift settings: {dataset.label}</h2>
        <p className="mb-2 text-ink-secondary">Map: {dataset.live_lift?.map_label}. Changing a setting reloads this dataset's reads.</p>
        <LiftSettingsFields gSplitKb={gSplitKb} setGSplitKb={setGSplitKb} mergeKb={mergeKb} setMergeKb={setMergeKb}
          alternatives={alternatives} setAlternatives={setAlternatives} supplementaries={supplementaries}
          setSupplementaries={setSupplementaries} hatching={hatching} setHatching={setHatching} />
        {error && <div className="mt-2 text-red-600">{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="fb-btn" onClick={close}>Cancel</button>
          <button type="button" className="fb-btn fb-btn-primary" onClick={save} data-testid="live-lift-settings-save">Save</button>
        </div>
      </div>
    </div>
  );
}
