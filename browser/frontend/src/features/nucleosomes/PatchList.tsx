/**
 * Patches (DESIGN §6.3, NUC §13.1): recurrence patches of each per-molecule kind (regular, disordered, undersized,
 * missing; FiberHMM's depth-aware shift-within-read test with FDR) and phased / fuzzy patches, from the open scans
 * that ran the nuc module, in view. Each observation scores each patch with its own molecules (the fraction and
 * the same recurrence test, BH q-values per observation and kind; /api/nuc/patches), so panels compare side by side.
 * "Find patches in view" runs the nuc scan over the view (the hub's live scan: same engine as fiberhmm-scan); a BED
 * or gene list is a scan from the Feature hub, whose patches list here wherever the view goes.
 */
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { scanHits, submitScan, type ScanHit } from '../hub/api';
import { useHubData } from '../hub/hubData';
import { useHubJob } from '../hub/hubJob';
import { goToHits } from '../hub/actions';
import { nucPatches, type NucCategory, type NucPatchScore } from './api';
import { observationDatasets, observationsKey } from './planner';
import type { NucObservation, NucPanelState } from './types';

export const PATCH_TYPES: Array<{ key: string; label: string; color: string; category?: NucCategory }> = [
  { key: 'regular', label: 'regular', color: '#15803d', category: { kind: 'segment', state: 'regular' } },
  { key: 'disordered', label: 'disordered', color: '#ea580c', category: { kind: 'segment', state: 'disordered' } },
  { key: 'undersized', label: 'undersized', color: '#f59e0b', category: { kind: 'event', name: 'undersized' } },
  { key: 'missing', label: 'missing nucleosome', color: '#dc2626', category: { kind: 'event', name: 'missing' } },
  { key: 'phased', label: 'phased', color: '#2563eb' },
  { key: 'fuzzy', label: 'fuzzy / dephased', color: '#7c3aed' },
];
const TYPE = Object.fromEntries(PATCH_TYPES.map(t => [t.key, t]));
const typeOf = (h: ScanHit) => h.typeId.replace(/^nuc\.patch\./, '');
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const sci = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v < 0.001 ? v.toExponential(0) : v.toFixed(3));

export interface PatchRow { key: string; scanId: string; hit: ScanHit; type: string }

/** The scan's own score of a patch: the pooled fraction (recurrence), R − null (phased) or dispersion (fuzzy). */
function scanScore(row: PatchRow): string {
  const h = row.hit;
  if (row.type === 'phased') return h.score == null ? '—' : `R−null ${h.score.toFixed(2)}`;
  if (row.type === 'fuzzy') return h.score == null ? '—' : `σ ${Math.round(h.score)} bp`;
  return pct(h.score);
}

export function PatchList({ observations, settings, setSettings, onSelect, revision }: {
  observations: NucObservation[]; settings: NucPanelState; setSettings: (patch: Partial<NucPanelState>) => void;
  onSelect: (obs: NucObservation, category: NucCategory) => void;
  /** The panel's outputs revision (a compute, opened scans, the datasets' content, the duplicates policy). */
  revision: string;
}) {
  const view = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end })));
  const includeDuplicates = useBrowserStore(s => Boolean(s.showDuplicateReads));
  const scans = useHubData(s => s.scans);
  const nucScans = useMemo(() => scans.filter(s => s.modules?.nuc && (!s.frame || s.frame.kind === 'linear')), [scans]);
  const scanJob = useHubJob(s => s.job);
  const hidden = new Set(settings.patchTypesHidden ?? []);
  const [rows, setRows] = useState<PatchRow[]>([]);
  const [scores, setScores] = useState<Record<string, Record<string, NucPatchScore>>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const scansKey = nucScans.map(s => `${s.scanId}:${s.manifestDigest}`).join(',');

  useEffect(() => {
    if (!nucScans.length || !view.chrom) { setRows([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      Promise.all(nucScans.map(s => scanHits(s.scanId, 'nuc', view.chrom, view.start, view.end, undefined, ctl.signal)
        .then(r => r.hits.filter(h => h.typeId.startsWith('nuc.patch.')).map(h => ({ key: `${s.scanId}|${h.hitId}`, scanId: s.scanId, hit: h, type: typeOf(h) })))))
        .then(all => { if (!ctl.signal.aborted) { setRows(all.flat().sort((a, b) => a.hit.start - b.hit.start || a.type.localeCompare(b.type))); setError(''); } })
        .catch(e => { if (!ctl.signal.aborted) setError(String(e?.message ?? e)); });
    }, 300);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [scansKey, view.chrom, view.start, view.end]);   // eslint-disable-line react-hooks/exhaustive-deps

  const shown = rows.filter(r => !hidden.has(r.type));
  // The whole observation scope (membership, windows) and the outputs' revision: scores follow every change.
  const obsKey = `${observationsKey(observations)}|${revision}`;
  const rowsKey = shown.map(r => r.key).join(',');
  useEffect(() => {
    const scored = shown.filter(r => TYPE[r.type]?.category);
    setScores({});
    if (!scored.length || !observations.length) return;
    const ctl = new AbortController();
    setLoading(true);
    nucPatches(observations, scored.slice(0, 500).map(r => ({ key: r.key, type: r.type, chrom: r.hit.chrom, start: r.hit.start, end: r.hit.end })),
      includeDuplicates, ctl.signal)
      .then(res => { if (!ctl.signal.aborted) setScores(Object.fromEntries(res.observations.map(o => [o.obsId, o.patches]))); })
      .catch(e => { if (!ctl.signal.aborted) setError(String(e?.message ?? e)); })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [rowsKey, obsKey, includeDuplicates]);   // eslint-disable-line react-hooks/exhaustive-deps

  const scanLive = scanJob && ['queued', 'running', 'cancelling'].includes(scanJob.status);
  // Live scans read datasets on this genome; a live-lift dataset is scanned in its own assembly (fiberhmm-scan on its
  // BAM, then open the scan), so it is left out here. Its columns still score every patch with their own molecules.
  const datasets = useBrowserStore(s => s.datasets);
  const isLifted = (id: string) => datasets.find(x => x.id === id)?.data_type === 'bam_livelift';
  const scannable = observationDatasets(observations).filter(id => !isLifted(id));
  const leftOut = observationDatasets(observations).filter(isLifted);
  const findInView = async () => {
    setError('');
    if (!scannable.length) {
      setError('Live-lift datasets are scanned in their own assembly: run fiberhmm-scan on the BAM and open the scan in the Feature hub.');
      return;
    }
    try {
      const job = await submitScan({ datasets: scannable, scope: 'view', chrom: view.chrom, start: view.start, end: view.end,
        modules: ['nuc'], include_duplicates: includeDuplicates, ...(settings.parameters ? { parameters: { nuc: settings.parameters } } : {}) });
      useHubJob.getState().track(job);
    } catch (e) { setError(String((e as Error)?.message ?? e)); }
  };
  const openHub = () => {
    useBrowserStore.getState().openAnalysisPanel('feature-hub');
  };

  return <section className="space-y-1" data-testid="nuc-patches">
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="font-medium text-ink-secondary">Patches</span>
      {PATCH_TYPES.map(t => <label key={t.key} className="flex items-center gap-0.5" title={`Show ${t.label} patches`}>
        <input type="checkbox" checked={!hidden.has(t.key)} data-testid={`nuc-patch-type-${t.key}`}
          onChange={e => setSettings({ patchTypesHidden: e.target.checked ? [...hidden].filter(x => x !== t.key) : [...hidden, t.key] })} />
        <span className="inline-block h-2 w-2 rounded-sm" style={{ background: t.color }} />{t.label}</label>)}
      <button type="button" className="ml-auto rounded border border-line px-1.5 py-0.5 disabled:opacity-50 dark:border-white/10" data-testid="nuc-find-patches"
        disabled={Boolean(scanLive) || !observations.length}
        title={`Run the nuc scan over the view (the Feature hub's live scan, the same engine as fiberhmm-scan): recurrence, phased and fuzzy patches${leftOut.length ? '. Live-lift datasets are scanned in their own assembly (fiberhmm-scan on the BAM); their columns still score every patch' : ''}`}
        onClick={() => { void findInView(); }}>{scanLive ? `Scanning… ${scanJob?.progress?.fraction != null ? `${Math.round(scanJob.progress.fraction * 100)}%` : ''}` : 'Find patches in view'}</button>
      <button type="button" className="rounded border border-line px-1.5 py-0.5 dark:border-white/10" onClick={openHub} data-testid="nuc-open-hub"
        title="Scan a BED file or gene list, or list a scan's patches genome-wide, in the Feature hub">Feature hub…</button>
    </div>
    {error && <p className="text-[11px] text-red-700 dark:text-red-300" role="status">{error}</p>}
    {!nucScans.length && <p className="text-[11px] text-ink-secondary">No nucleosome scan is open: Find patches in view, or open a scan with the nuc module in the Feature hub.</p>}
    {nucScans.length > 0 && !shown.length && <p className="text-[11px] text-ink-secondary" data-testid="nuc-no-patches">No patches in view{hidden.size ? ' of the shown types' : ''}.</p>}
    {shown.length > 0 && <div className="max-h-72 overflow-auto">
      <table className="w-full text-[11px]" data-testid="nuc-patch-table">
        <thead className="sticky top-0 bg-surface text-ink-muted dark:bg-surface-dark">
          <tr>
            <th className="px-1 text-left">Type</th>
            <th className="px-1 text-left">Locus</th>
            <th className="px-1 text-right">Width</th>
            <th className="px-1 text-right" title="Regular patches: mean q̂ of the regular segments; phased and fuzzy: period">q̂ · P</th>
            <th className="px-1 text-right" title="The scan's score over all its molecules: pooled fraction (recurrence), R − null (phased), dispersion (fuzzy)">Scan</th>
            {observations.map(o => <th key={o.obsId} className="px-1 text-right" title={`${o.label}: fraction of its measured bases with the kind · BH q of its own recurrence test (click: highlight its molecules with the kind in the patch)`}>
              <span className="mr-0.5 inline-block h-2 w-2 rounded-sm" style={{ background: o.color }} />{o.label}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map(r => {
            const t = TYPE[r.type];
            const qh = r.hit.module?.q_hat;
            const P = r.hit.module?.P;
            return <tr key={r.key} className="border-t border-gray-100 dark:border-gray-800" data-testid="nuc-patch-row" data-type={r.type}>
              <td className="whitespace-nowrap px-1"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: t?.color ?? '#999' }} />{t?.label ?? r.type}
                {r.hit.flags.includes('open_end') && <span className="ml-1 text-ink-muted" title="Continues past the scanned zone">…</span>}</td>
              <td className="whitespace-nowrap px-1">{r.hit.chrom}:{(r.hit.start + 1).toLocaleString()}</td>
              <td className="px-1 text-right">{((r.hit.end - r.hit.start) / 1000).toFixed(1)} kb</td>
              <td className="px-1 text-right">{qh !== '' && qh != null ? Number(qh).toFixed(0) : P !== '' && P != null ? `P ${Number(P).toFixed(0)}` : '—'}</td>
              <td className="whitespace-nowrap px-1 text-right">{scanScore(r)}</td>
              {observations.map(o => {
                const sc = scores[o.obsId]?.[r.key];
                if (!t?.category) {
                  // Phased and fuzzy patches: the scan's own per-dataset values (R − null, coherence of phases).
                  // The scan scores whole datasets: only a column of the whole dataset (no read scope, haplotype or
                  // strand) shows its value.
                  const whole = o.kind === 'linear' && !o.readIds && !o.strand && !o.liftHap;
                  const group = whole ? nucScans.find(x => x.scanId === r.scanId)?.datasets.find(d => d.dataset === o.datasetId)?.scanDataset : undefined;
                  const raw = group ? r.hit.raw?.[group] : undefined;
                  const val = raw?.[r.type === 'phased' ? 'R_minus_null' : 'coherence']?.v ?? null;
                  return <td key={o.obsId} className="px-1 text-right text-ink-secondary" data-testid="nuc-patch-scan-value"
                    title={!whole ? 'The scan scores whole datasets; this column is a subset (reads, haplotype or strand)'
                      : r.type === 'phased' ? "The scan's R − null for this dataset" : "The scan's coherence of this dataset's phases (1: all in phase)"}>
                    {val == null ? '—' : `${r.type === 'phased' ? 'R−null' : 'coh.'} ${val.toFixed(2)}`}</td>;
                }
                if (!sc) return <td key={o.obsId} className="px-1 text-right text-ink-muted">{loading ? '…' : ''}</td>;
                if (sc.error) return <td key={o.obsId} className="px-1 text-right text-amber-700 dark:text-amber-300" title={sc.error}>n/a</td>;
                return <td key={o.obsId} className="whitespace-nowrap px-1 text-right" data-testid="nuc-patch-score">
                  <button type="button" className={`hover:underline ${sc.significant ? 'font-semibold' : 'text-ink-secondary'}`}
                    title={[`${sc.n ?? 0} molecules measured over at least half the patch`, `fraction ${pct(sc.fraction)} (expected under the shift null ${pct(sc.expected)})`,
                      `p ${sci(sc.p)} · q ${sci(sc.q)}${sc.significant ? ' (recurrent at FDR 5%)' : ''}`, sc.notComputed ? `${sc.notComputed} molecules not computed yet` : '',
                      'click: highlight these molecules'].filter(Boolean).join('\n')}
                    onClick={() => onSelect({ ...o, chrom: r.hit.chrom, start: r.hit.start, end: r.hit.end }, { ...t.category!, scope: 'patch' } as NucCategory)}>
                    {pct(sc.fraction)}<span className="text-ink-muted"> · q {sci(sc.q)}</span></button></td>;
              })}
              <td className="px-1"><button type="button" aria-label="Go to the patch" className="text-ink-muted hover:text-ink" data-testid="nuc-patch-go"
                onClick={() => { goToHits([{ chrom: r.hit.chrom, start: r.hit.start, end: r.hit.end }]); }}>▶</button></td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
  </section>;
}
