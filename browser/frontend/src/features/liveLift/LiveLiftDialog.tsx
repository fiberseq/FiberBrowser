/**
 * "Add live lift…" (DESIGN_LIVE_LIFT.md §2.1): source BAM(s) aligned to another assembly, the graphlift map that
 * relates it to this genome, the haplotypes, and the display settings. The new dataset opens split into one panel per
 * haplotype unless "Pooled" is chosen (a rule per panel, so the panels follow the view).
 */
import { useEffect, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { addLiveLiftDataset, inspectLiftMap, type LiftMapInfo, type LiftSettings, type SupplementaryDisplay } from './api';
import { useLiveLiftStore } from './store';
import { CohortSettingsFields } from './CohortSettingsFields';

const input = 'w-full rounded border border-line px-2 py-1 text-[12px] dark:border-white/15 dark:bg-white/5';

export function LiveLiftDialog() {
  const open = useLiveLiftStore(s => s.dialogOpen);
  const setOpen = useLiveLiftStore(s => s.setDialogOpen);
  const [bams, setBams] = useState('');
  const [manifest, setManifest] = useState('');
  const [label, setLabel] = useState('');
  const [info, setInfo] = useState<LiftMapInfo | null>(null);
  const [haps, setHaps] = useState<string[]>([]);
  const [mode, setMode] = useState<'split' | 'pooled'>('split');
  const [gSplitKb, setGSplitKb] = useState(10);
  const [mergeKb, setMergeKb] = useState(50);
  const [alternatives, setAlternatives] = useState(false);
  const [supplementaries, setSupplementaries] = useState<SupplementaryDisplay>('own_rows');
  const [hatching, setHatching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cohortSettings, setCohortSettings] = useState<LiftSettings>({});

  useEffect(() => {
    if (!open || !manifest.trim()) { setInfo(null); return; }
    let live = true;
    const t = setTimeout(() => {
      inspectLiftMap(manifest.trim()).then(r => {
        if (!live) return;
        if (r.error) { setInfo(null); setError(r.error); return; }
        setError(null);
        setInfo(r);
        setHaps(r.haplotypes.map(h => h.key));
      }).catch(err => { if (live) { setInfo(null); setError(String(err?.message ?? err)); } });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [open, manifest]);

  if (!open) return null;
  const close = () => { setOpen(false); setError(null); };
  const submit = async () => {
    setBusy(true);
    setError(null);
    const settings: LiftSettings = {
      ...cohortSettings,
      haplotype_mode: mode, g_split: Math.round(gSplitKb * 1000), window_merge: Math.round(mergeKb * 1000),
      alternatives, supplementary_display: supplementaries, coverage_hatching: hatching,
    };
    try {
      const r = await addLiveLiftDataset({
        paths: bams.split(/\n|,/).map(p => p.trim()).filter(Boolean), manifest: manifest.trim(), haplotypes: haps,
        settings, label: label.trim() || undefined,
      });
      if (!r.success || !r.dataset) { setError(r.error ?? 'The dataset could not be opened.'); return; }
      // Split into one panel per haplotype unless Pooled (register.autoSplitNewLiftedDatasets, from its settings).
      useBrowserStore.getState().addDataset(r.dataset);
      close();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="live-lift-title" data-testid="live-lift-dialog"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-y-auto rounded-apple-lg border border-line/60 bg-white p-5 text-[12px] shadow-modal dark:border-white/10 dark:bg-dark-surface">
        <h2 id="live-lift-title" className="mb-1 text-[15px] font-semibold">Add live lift</h2>
        <p className="mb-3 text-ink-secondary">
          Draw a BAM aligned to another assembly (e.g. HG002 maternal/paternal) on this genome through a graphlift
          map. No realignment; the records are lifted as you browse.
        </p>
        <label className="mb-2 block">Source BAM file(s), one per line
          <textarea className={input} rows={2} value={bams} onChange={e => setBams(e.target.value)} data-testid="live-lift-bams" />
        </label>
        <label className="mb-2 block">Graphlift map (.graphlift.json)
          <input className={input} value={manifest} onChange={e => setManifest(e.target.value)} data-testid="live-lift-manifest" />
        </label>
        {info && (
          <fieldset className="mb-2" data-testid="live-lift-haplotypes">
            <legend className="mb-1">Haplotypes ({info.chains} chains, {info.targets.length} target contigs)</legend>
            {info.haplotypes.map(h => (
              <label key={h.key} className="mr-3 inline-flex items-center gap-1">
                <input type="checkbox" checked={haps.includes(h.key)}
                  onChange={e => setHaps(e.target.checked ? [...haps, h.key] : haps.filter(x => x !== h.key))} />
                {h.label} <span className="text-ink-secondary">({h.key})</span>
              </label>
            ))}
          </fieldset>
        )}
        <fieldset className="mb-2">
          <legend className="mb-1">Haplotype panels</legend>
          <label className="mr-3"><input type="radio" checked={mode === 'split'} onChange={() => setMode('split')} /> One panel per haplotype</label>
          <label><input type="radio" checked={mode === 'pooled'} onChange={() => setMode('pooled')} /> Pooled</label>
        </fieldset>
        <label className="mb-2 block">Name (optional)
          <input className={input} value={label} onChange={e => setLabel(e.target.value)} />
        </label>
        <details className="mb-3">
          <summary className="cursor-pointer">Advanced</summary>
          <LiftSettingsFields gSplitKb={gSplitKb} setGSplitKb={setGSplitKb} mergeKb={mergeKb} setMergeKb={setMergeKb}
            alternatives={alternatives} setAlternatives={setAlternatives} supplementaries={supplementaries}
            setSupplementaries={setSupplementaries} hatching={hatching} setHatching={setHatching} />
          <CohortSettingsFields settings={cohortSettings} onChange={setCohortSettings}
            paths={bams.split(/\n|,/).map(p => p.trim()).filter(Boolean)} />
        </details>
        {error && <div className="mb-2 whitespace-pre-wrap text-red-600" data-testid="live-lift-error">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="fb-btn" onClick={close}>Cancel</button>
          <button type="button" className="fb-btn fb-btn-primary" disabled={busy || !bams.trim() || !manifest.trim() || !haps.length}
            onClick={submit} data-testid="live-lift-add">{busy ? 'Opening…' : 'Add'}</button>
        </div>
      </div>
    </div>
  );
}

export interface LiftSettingsFieldsProps {
  gSplitKb: number; setGSplitKb: (v: number) => void;
  mergeKb: number; setMergeKb: (v: number) => void;
  alternatives: boolean; setAlternatives: (v: boolean) => void;
  supplementaries: SupplementaryDisplay; setSupplementaries: (v: SupplementaryDisplay) => void;
  hatching: boolean; setHatching: (v: boolean) => void;
}

/** The display-relevant advanced settings (§2.5; every one is part of the dataset's lift_key). */
export function LiftSettingsFields(p: LiftSettingsFieldsProps) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2" data-testid="live-lift-settings">
      <label title="A target gap at least this long splits a row's segment (the margin is never smaller)">Split at target gap (kb)
        <input type="number" min={1} max={1000} className={input} value={p.gSplitKb}
          onChange={e => p.setGSplitKb(Number(e.target.value) || 10)} data-testid="live-lift-g-split" />
      </label>
      <label title="Source windows closer than this are read together">Merge source windows (kb)
        <input type="number" min={0} max={1000} className={input} value={p.mergeKb}
          onChange={e => p.setMergeKb(Number(e.target.value) || 0)} />
      </label>
      <label className="col-span-2"><input type="checkbox" checked={p.alternatives}
        onChange={e => p.setAlternatives(e.target.checked)} /> Show alternative placements (up to 16 chains; dashed rows)</label>
      <label>Supplementary alignments
        <select className={input} value={p.supplementaries}
          onChange={e => p.setSupplementaries(e.target.value as SupplementaryDisplay)}>
          <option value="own_rows">Own rows</option>
          <option value="fold">On the primary's row</option>
          <option value="hide">Hide</option>
        </select>
      </label>
      <label className="self-end"><input type="checkbox" checked={p.hatching}
        onChange={e => p.setHatching(e.target.checked)} /> Hatch coverage without correspondence</label>
    </div>
  );
}
