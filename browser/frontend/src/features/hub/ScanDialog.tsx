/**
 * The scan dialog (DESIGN §6.3): datasets, where (the view's units, a BED file, a gene list), modules, settings and
 * depth caps, what open scans already computed, and the fiberhmm-scan command that computes the same rows. A live
 * scan runs the same engine (fiberhmm.scan.run_units) into the browser's scan cache.
 */
import { useEffect, useMemo, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { pickFile } from '../../api/files';
import { planScan, scanAvailable, submitScan, type ScanPlanSummary, type ScanRequest } from './api';
import { useHubJob } from './hubJob';

const input = 'w-full rounded border border-line px-2 py-1 text-[12px] dark:border-white/15 dark:bg-white/5';
const MODULE_LABELS: Record<string, string> = { fp: 'Footprint classes (fp)', nfr: 'NFRs (nfr)', peaks: 'Accessibility peaks (peaks)', nuc: 'Nucleosome arrays (nuc)' };
const DEFAULT_MODULES = ['fp', 'nfr'];

export function ScanDialog({ onClose }: { onClose: () => void }) {
  const datasets = useBrowserStore(s => s.datasets);
  const panels = useBrowserStore(s => s.panels);
  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);
  const scannable = useMemo(() => datasets.filter(d => d.data_type === 'bam'), [datasets]);
  const shown = useMemo(() => new Set(panels.filter(p => p.contentType === 'dataset' && !p.collapsed && p.datasetId).map(p => p.datasetId!)), [panels]);
  const [chosen, setChosen] = useState<string[]>(() => scannable.filter(d => shown.has(d.id)).map(d => d.id));
  const [scope, setScope] = useState<ScanRequest['scope']>('view');
  const [bed, setBed] = useState('');
  const [genes, setGenes] = useState('');
  const [modules, setModules] = useState<string[]>(DEFAULT_MODULES);
  const [available, setAvailable] = useState<{ available: boolean; reason?: string; modules: Array<{ name: string; experimental: boolean }> } | null>(null);
  const [paramsText, setParamsText] = useState('');
  const [editJson, setEditJson] = useState(false);
  const [capDiscovery, setCapDiscovery] = useState('');
  const [capQuant, setCapQuant] = useState('');
  const [workers, setWorkers] = useState(4);
  const [plan, setPlan] = useState<ScanPlanSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const lifted = datasets.filter(d => d.data_type === 'bam_livelift');

  useEffect(() => {
    let live = true;
    scanAvailable().then(a => {
      if (!live) return;
      setAvailable(a);
      setModules(m => m.filter(x => a.modules.some(y => y.name === x)));
    }).catch(e => live && setAvailable({ available: false, reason: String(e.message ?? e), modules: [] }));
    return () => { live = false; };
  }, []);

  const request = useMemo((): ScanRequest | string => {
    if (!chosen.length) return 'Choose at least one dataset.';
    if (!modules.length) return 'Choose at least one module.';
    let parameters: Record<string, unknown> | undefined;
    if (paramsText.trim()) {
      try { parameters = JSON.parse(paramsText); } catch { return 'Settings: not valid JSON.'; }
    }
    const caps: ScanRequest['caps'] = {};
    if (capDiscovery.trim()) caps.max_discovery_molecules = Number(capDiscovery);
    if (capQuant.trim()) caps.max_quantification_molecules = Number(capQuant);
    const base = { datasets: chosen, modules, workers, ...(parameters ? { parameters } : {}), ...(Object.keys(caps).length ? { caps } : {}) };
    if (scope === 'view') return { ...base, scope, chrom, start, end };
    if (scope === 'bed') return bed.trim() ? { ...base, scope, bed: bed.trim() } : 'Give a BED file.';
    const names = genes.split(/[\s,;]+/).map(g => g.trim()).filter(Boolean);
    return names.length ? { ...base, scope: 'genes', genes: names } : 'Give gene names.';
  }, [chosen, modules, paramsText, capDiscovery, capQuant, workers, scope, chrom, start, end, bed, genes]);

  useEffect(() => {
    if (typeof request === 'string' || !available?.available) { setPlan(null); setError(typeof request === 'string' ? request : ''); return; }
    let live = true;
    const t = setTimeout(() => {
      planScan(request).then(p => { if (live) { setPlan(p); setError(''); } })
        .catch(e => { if (live) { setPlan(null); setError(String(e.message ?? e).replace(/^API error \d+: /, '')); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [request, available?.available]);

  const toCompute = plan ? Math.max(0, ...Object.values(plan.coverage).map(c => c.toCompute)) : 0;
  const unitsTotal = plan ? Math.max(...Object.values(plan.coverage).map(c => c.total)) : 0;
  const submit = async () => {
    if (typeof request === 'string') return;
    setBusy(true);
    try {
      const job = await submitScan(request);
      useHubJob.getState().track(job);
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^API error \d+: /, ''));
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    if (!plan) return;
    void navigator.clipboard?.writeText(plan.cli.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="hub-scan-title" data-testid="hub-scan-dialog"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-y-auto rounded-apple-lg border border-line/60 bg-white p-5 text-[12px] shadow-modal dark:border-white/10 dark:bg-dark-surface">
        <h2 id="hub-scan-title" className="mb-1 text-[15px] font-semibold">Scan</h2>
        <p className="mb-3 text-ink-secondary">
          Finds footprint classes, NFRs and peaks with fiberhmm-scan's engine, on whole units of the genome grid, and
          adds them to the feature hub. The command below computes the same rows from the command line.
        </p>
        {available && !available.available && <p className="mb-2 font-medium text-amber-700 dark:text-amber-300" data-testid="hub-scan-unavailable">{available.reason}</p>}
        <fieldset className="mb-2">
          <legend className="mb-1 font-medium">Datasets</legend>
          {scannable.length ? scannable.map(d => (
            <label key={d.id} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={chosen.includes(d.id)} data-testid={`hub-scan-dataset-${d.id}`}
                onChange={e => setChosen(c => e.target.checked ? [...c, d.id] : c.filter(x => x !== d.id))} /> {d.label}
            </label>
          )) : <span className="text-ink-secondary">Open a FiberHMM-called BAM first.</span>}
          {lifted.length > 0 && <p className="mt-1 text-[11px] text-ink-muted">Live-lift datasets are scanned in their own assembly: run fiberhmm-scan on their BAM and open the scan here (their reads get its per-read states).</p>}
        </fieldset>
        <fieldset className="mb-2">
          <legend className="mb-1 font-medium">Where</legend>
          <label className="mr-3 inline-flex items-center gap-1"><input type="radio" name="hub-scan-where" checked={scope === 'view'} onChange={() => setScope('view')} data-testid="hub-scan-where-view" />
            The view's units and one more each side{plan && scope === 'view' ? ` (${plan.units} units of 50 kb)` : ''}</label>
          <label className="mr-3 inline-flex items-center gap-1"><input type="radio" name="hub-scan-where" checked={scope === 'bed'} onChange={() => setScope('bed')} data-testid="hub-scan-where-bed" /> BED file</label>
          <label className="inline-flex items-center gap-1"><input type="radio" name="hub-scan-where" checked={scope === 'genes'} onChange={() => setScope('genes')} data-testid="hub-scan-where-genes" /> Genes (TSS ± 5 kb)</label>
          {scope === 'bed' && <div className="mt-1 flex gap-1">
            <input className={input} value={bed} placeholder="units.bed" onChange={e => setBed(e.target.value)} data-testid="hub-scan-bed" />
            <button type="button" className="fb-btn" onClick={() => { void pickFile('footprint_rules').then(r => { if (r.path) setBed(r.path); }).catch(() => undefined); }}>Browse…</button>
          </div>}
          {scope === 'genes' && <textarea className={`${input} mt-1`} rows={2} value={genes} placeholder="Gene names, one per line or comma-separated" onChange={e => setGenes(e.target.value)} data-testid="hub-scan-genes" />}
        </fieldset>
        <fieldset className="mb-2">
          <legend className="mb-1 font-medium">Modules</legend>
          {(available?.modules ?? []).map(m => (
            <label key={m.name} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={modules.includes(m.name)} data-testid={`hub-scan-module-${m.name}`}
                onChange={e => setModules(c => e.target.checked ? [...c, m.name] : c.filter(x => x !== m.name))} />
              {MODULE_LABELS[m.name] ?? m.name}{m.experimental ? <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">experimental</span> : null}
            </label>
          ))}
        </fieldset>
        <details className="mb-2" open={editJson} onToggle={e => setEditJson((e.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer font-medium">Settings {plan ? <span className="font-normal text-ink-muted">· {Object.entries(plan.settingsHashes).map(([m, h]) => `${m} ${h.slice(0, 8)}`).join(' · ')}</span> : null}</summary>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <label title="Molecules used to discover classes and NFRs (0 or empty: every molecule)">Discovery cap
              <input type="number" min={0} className={input} value={capDiscovery} onChange={e => setCapDiscovery(e.target.value)} data-testid="hub-scan-cap-discovery" /></label>
            <label title="Molecules used to quantify them (0 or empty: every molecule)">Quantification cap
              <input type="number" min={0} className={input} value={capQuant} onChange={e => setCapQuant(e.target.value)} data-testid="hub-scan-cap-quant" /></label>
            <label title="Units computed at the same time. Never changes a row.">Workers
              <input type="number" min={1} max={32} className={input} value={workers} onChange={e => setWorkers(Math.max(1, Number(e.target.value) || 1))} data-testid="hub-scan-workers" /></label>
          </div>
          <label className="mt-1 block">Module settings (JSON, as fiberhmm-scan --parameters; empty: defaults)
            <textarea className={`${input} font-mono`} rows={3} value={paramsText} placeholder='{"nfr": {"nfr": {"bootstrap": 200}}}' onChange={e => setParamsText(e.target.value)} data-testid="hub-scan-params" /></label>
        </details>
        {plan && <div className="mb-2 space-y-1" data-testid="hub-scan-plan">
          <div className="font-medium">{plan.where}</div>
          {Object.entries(plan.coverage).map(([m, c]) => (
            <div key={m} className="text-ink-secondary" data-testid={`hub-scan-coverage-${m}`}>
              {m}: already computed {c.precomputed + c.cached} of {c.total}{c.precomputed ? ` (${c.precomputed} by an opened scan)` : ''}{c.cached ? ` (${c.cached} by earlier scans here)` : ''} · {c.toCompute} to compute
            </div>
          ))}
          {plan.note && <div className="text-amber-700 dark:text-amber-300">{plan.note}</div>}
          <div className="mt-1 font-medium">Command line equivalent</div>
          <div className="flex items-start gap-1">
            <code className="block min-w-0 flex-1 break-all rounded bg-gray-50 px-2 py-1 font-mono text-[11px] dark:bg-white/5" data-testid="hub-scan-cli">{plan.cli.text}</code>
            <button type="button" className="fb-btn" onClick={copy} data-testid="hub-scan-cli-copy">{copied ? 'Copied' : 'Copy'}</button>
          </div>
          {plan.cli.datasets && <div className="text-[11px] text-ink-muted">scan_datasets.json: <code className="break-all font-mono">{JSON.stringify(plan.cli.datasets)}</code></div>}
          {plan.cli.parameters && <div className="text-[11px] text-ink-muted">scan_parameters.json: <code className="break-all font-mono">{JSON.stringify(plan.cli.parameters)}</code></div>}
          {plan.cli.notes.map((n, i) => <div key={i} className="text-[11px] text-ink-muted">{n}</div>)}
        </div>}
        {error && <p role="alert" className="mb-2 text-red-700 dark:text-red-300" data-testid="hub-scan-error">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="fb-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="fb-btn fb-btn-primary" disabled={busy || !plan || typeof request === 'string'} onClick={() => { void submit(); }} data-testid="hub-scan-submit">
            {busy ? 'Starting…' : !plan ? 'Scan' : toCompute ? `Scan ${toCompute} unit${toCompute === 1 ? '' : 's'}` : `Use ${unitsTotal} computed unit${unitsTotal === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
