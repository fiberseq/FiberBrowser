/** A lifted dataset's display settings after it was opened (each is part of its lift_key: caches start over). */
import { MIN_SIZES } from './differencesModel';
import { analysisMinMapq, READ_BADGE_MODES, readBadgeMode, setAnalysisMinMapq, setDifferenceRowOptions, setReadBadgeMode } from '../differences/displayOptions';
import type { LiveLiftBadgeMode } from '../../components/tracks/read-track/liveLiftCanvas';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import { updateLiftSettings, updateMoleculeProvenance, type LiftSettings, type SupplementaryDisplay } from './api';
import { CohortSettingsFields, MoleculeProvenanceFields } from './CohortSettingsFields';
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
  const [supplementaries, setSupplementaries] = useState<SupplementaryDisplay>('own_rows');
  const [hatching, setHatching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState<LiftSettings>({});
  // The Differences row (browser display options, not part of the dataset's lift settings).
  const firstPanel = useBrowserStore(st => st.panels.find(p => p.datasetId === datasetId));
  const [rowSources, setRowSources] = useState({ assembly: true, reads: false });
  const [rowMinBp, setRowMinBp] = useState(0);
  const [badges, setBadges] = useState<LiveLiftBadgeMode>('off');
  const [minMapq, setMinMapq] = useState(0);
  const nativeDatasets = useBrowserStore(s => s.datasets).filter(d => d.data_type === 'bam');
  const [nativeProvenance, setNativeProvenance] = useState<Record<string, { groups: [string, string][]; policy: 'off' | 'by_molecule' }>>({});
  useEffect(() => {
    if (!dataset) return;
    setGSplitKb(Number(s.g_split ?? 10_000) / 1000);
    setMergeKb(Number(s.window_merge ?? 50_000) / 1000);
    setAlternatives(Boolean(s.alternatives));
    setSupplementaries((s.supplementary_display as SupplementaryDisplay) ?? 'own_rows');
    setHatching(s.coverage_hatching !== false);
    setError(null);
    setAdvanced(s);
    setNativeProvenance({});
    setRowSources(firstPanel?.differenceSources ?? { assembly: true, reads: false });
    setRowMinBp(firstPanel?.liveLiftMinBp ?? 0);
    setBadges(readBadgeMode(useBrowserStore.getState()));
    setMinMapq(analysisMinMapq(useBrowserStore.getState()));
  }, [datasetId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!datasetId || !dataset) return null;
  const save = async () => {
    for (const p of useBrowserStore.getState().panels.filter(p => p.datasetId === datasetId)) {
      setDifferenceRowOptions(p.id, { sources: rowSources, minBp: rowMinBp });
    }
    setReadBadgeMode(badges);
    setAnalysisMinMapq(minMapq);
    const r = await updateLiftSettings(datasetId, {
      ...advanced,
      g_split: Math.round(gSplitKb * 1000), window_merge: Math.round(mergeKb * 1000), alternatives,
      supplementary_display: supplementaries, coverage_hatching: hatching,
    });
    if (!r.success || !r.dataset) { setError(r.error ?? 'Not saved'); return; }
    const updated = r.dataset;
    const updates = [updated];
    for (const [id, p] of Object.entries(nativeProvenance)) {
      const result = await updateMoleculeProvenance(id, p.groups, p.policy);
      if (!result.success || !result.dataset) { setError(result.error ?? 'Native provenance was not saved'); return; }
      updates.push(result.dataset);
    }
    // Folding changes cohort IDs; clear all cluster definitions from the old run.
    useBrowserStore.getState().resetClusterState();
    useBrowserStore.setState(st => ({
      datasets: st.datasets.map(d => ({ ...d, ...updates.find(u => u.id === d.id) })),
      refreshGeneration: st.refreshGeneration + 1,
    }));
    if (advanced.haplotype_mode && advanced.haplotype_mode !== s.haplotype_mode) {
      const state = useBrowserStore.getState();
      if (advanced.haplotype_mode === 'pooled') state.poolLiftHapPanels(datasetId);
      else {
        const panel = state.panels.find(p => p.datasetId === datasetId && !p.liftHap);
        if (panel && updated.live_lift) state.splitPanelByLiftHap(panel.id, updated.live_lift.haplotypes.map(h => updated.live_lift!.haplotype_labels[h] ?? h));
      }
    }
    close();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="live-lift-settings-title" data-testid="live-lift-settings-dialog"
        className="max-h-[90vh] overflow-y-auto w-full max-w-lg rounded-apple-lg border border-line/60 bg-white p-5 text-[12px] shadow-modal dark:border-white/10 dark:bg-dark-surface">
        <h2 id="live-lift-settings-title" className="mb-1 text-[15px] font-semibold">Live-lift settings: {dataset.label}</h2>
        <p className="mb-2 text-ink-secondary">Map: {dataset.live_lift?.map_label}. Changing a setting reloads this dataset's reads.</p>
        <LiftSettingsFields gSplitKb={gSplitKb} setGSplitKb={setGSplitKb} mergeKb={mergeKb} setMergeKb={setMergeKb}
          alternatives={alternatives} setAlternatives={setAlternatives} supplementaries={supplementaries}
          setSupplementaries={setSupplementaries} hatching={hatching} setHatching={setHatching} />
        <fieldset className="mt-3 border-t pt-2" data-testid="live-lift-settings-differences">
          <legend className="font-medium">Differences row</legend>
          <p className="text-ink-secondary">Also in the row's right-click menu.</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="inline-flex items-center gap-1 whitespace-nowrap"><input type="checkbox" checked={rowSources.assembly}
              onChange={e => setRowSources(v => ({ ...v, assembly: e.target.checked }))} /> Assembly differences (the map)</label>
            <label className="inline-flex items-center gap-1 whitespace-nowrap"><input type="checkbox" checked={rowSources.reads}
              onChange={e => setRowSources(v => ({ ...v, reads: e.target.checked }))} /> Read-supported edits</label>
            <label className="inline-flex items-center gap-1 whitespace-nowrap">Minimum size
              <select value={rowMinBp} onChange={e => setRowMinBp(Number(e.target.value))}>
                {MIN_SIZES.map(n => <option key={n} value={n}>{n ? `≥${n} bp` : 'All sizes'}</option>)}</select></label>
            <label className="inline-flex items-center gap-1 whitespace-nowrap">Insertions on reads
              <select data-testid="live-lift-settings-read-badges" value={badges} onChange={e => setBadges(e.target.value as LiveLiftBadgeMode)}>
                {READ_BADGE_MODES.map(m => <option key={m.mode} value={m.mode} title={m.title}>{m.label}</option>)}</select></label>
            <label className="inline-flex items-center gap-1 whitespace-nowrap" title="Leave out alignments below this mapping quality from read-difference calls. 0: no MAPQ filter (the default).">Read analysis MAPQ ≥
              <input type="number" data-testid="live-lift-settings-min-mapq" className="w-14" min={0} max={255} step={1} value={minMapq}
                onChange={e => setMinMapq(Number(e.target.value) || 0)} /></label>
          </div>
        </fieldset>
        <details className="mt-3"><summary className="cursor-pointer">Advanced</summary>
          <CohortSettingsFields settings={advanced} onChange={setAdvanced} showHaplotypeMode paths={dataset.paths ?? [dataset.path]} />
          {nativeDatasets.map(d => {
            const p = nativeProvenance[d.id] ?? { groups: d.molecule_groups ?? [], policy: d.joint_dedup ?? 'off' };
            return <fieldset key={d.id} className="mt-3 border-t pt-2"><legend>Native dataset: {d.label}</legend>
              <MoleculeProvenanceFields paths={d.paths ?? [d.path]} groups={p.groups} policy={p.policy}
                onChange={(groups, policy) => setNativeProvenance(current => ({ ...current, [d.id]: { groups, policy } }))} />
            </fieldset>;
          })}
        </details>
        {error && <div className="mt-2 text-red-600">{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="fb-btn" onClick={close}>Cancel</button>
          <button type="button" className="fb-btn fb-btn-primary" onClick={save} data-testid="live-lift-settings-save">Save</button>
        </div>
      </div>
    </div>
  );
}
