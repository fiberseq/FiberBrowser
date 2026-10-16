/**
 * Accessibility (preview): motif families x variant types pooled over every NFR of one or more runs (the power fix:
 * one NFR has a handful of sites per motif). Mantel-Haenszel per cell; BH q across cells (services/accessibility_pooled).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  getAccessibilityJobs, getKmerEnrichment, getPooledMotifs, startAccessibilityBatch, type KmerRow,
  type AccessibilityJob, type MotifOptions, type PooledCell, type PooledMotifs as PooledData, type PooledStat,
} from '../api';
import { getRegionCatalog } from '../../../api/regions';
import { useBrowserStore } from '../../../stores/browserStore';
import { bp, formatQ } from '../accessibilityView';
import { AnalysisButton, AnalysisStatus } from '../../../components/controls/shared';

type Measure = 'sites' | 'open' | 'footprinted';
const MEASURES: { key: Measure; label: string }[] = [
  { key: 'footprinted', label: 'Footprinted | open' },
  { key: 'open', label: 'Open' },
  { key: 'sites', label: 'Sites (own part vs siblings)' },
];
export const POOLED_ROWS = 30;
const stars = (q: number | null | undefined) => (q == null ? '' : q <= 0.001 ? '***' : q <= 0.01 ? '**' : q <= 0.1 ? '*' : '');

/** A diverging fill for log2 ratios: fuchsia above 1, sky below; stronger with |log2|, clipped at 2. */
export function cellColor(log2: number | null | undefined): string {
  if (log2 == null || !Number.isFinite(log2)) return 'transparent';
  const a = Math.min(1, Math.abs(log2) / 2) * 0.85;
  return log2 >= 0 ? `rgba(192, 38, 211, ${a.toFixed(3)})` : `rgba(2, 132, 199, ${a.toFixed(3)})`;
}

export function PooledMotifs({ jobId }: { jobId: string | null }) {
  const { mode, pValue, relative, settings, custom, currentGenome } = useBrowserStore(useShallow(s => ({
    mode: s.motifScoreMode, pValue: s.motifPValue, relative: s.motifThreshold, settings: s.nfrMotifSettings,
    custom: s.customMotifs, currentGenome: s.currentGenome,
  })));
  const [runs, setRuns] = useState<AccessibilityJob[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set(jobId ? [jobId] : []));
  const [data, setData] = useState<PooledData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [measure, setMeasure] = useState<Measure>('footprinted');
  const [query, setQuery] = useState('');
  const [showBatch, setShowBatch] = useState(false);
  const refresh = useCallback(() => getAccessibilityJobs().then(({ jobs }) => setRuns(jobs)).catch(() => {}), []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (jobId) setPicked(p => (p.size ? p : new Set([jobId]))); }, [jobId]);
  const complete = runs.filter(j => j.status === 'complete');
  const pending = runs.filter(j => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!pending.length) return;
    const t = window.setTimeout(() => void refresh(), 3000);
    return () => window.clearTimeout(t);
  }, [pending.length, runs, refresh]);
  const options: MotifOptions = useMemo(() => ({
    ...(mode === 'relative' ? { mode, relative } : { mode, p: pValue }),
    background: settings.background, strand: settings.strand, family_similarity: settings.familySimilarity, flank: settings.flank,
    core_bp: settings.coreBp, min_reads: settings.minReads, ...(custom.length ? { custom } : {}),
  }), [mode, pValue, relative, settings, custom]);
  const run = async () => {
    setBusy(true); setError(''); setData(null);
    try {
      setData(await getPooledMotifs([...picked], options));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!data) return [];
    const byFam = new Map<string, Map<string, PooledCell>>();
    for (const c of data.cells) {
      if (!byFam.has(c.family)) byFam.set(c.family, new Map());
      byFam.get(c.family)!.set(c.type, c);
    }
    const best = (id: string) => Math.min(2, ...[...(byFam.get(id)?.values() ?? [])].map(c => c[measure].q ?? 2));
    return data.families
      .filter(f => !needle || f.name.toLowerCase().includes(needle) || f.members.some(m => m.toLowerCase().includes(needle)))
      .map(f => ({ fam: f, cells: byFam.get(f.id) ?? new Map<string, PooledCell>(), best: best(f.id) }))
      .sort((a, b) => a.best - b.best || b.fam.sites - a.fam.sites)
      .slice(0, POOLED_ROWS);
  }, [data, measure, needle]);
  const significant = data ? data.cells.filter(c => (c[measure].q ?? 1) <= 0.1).length : 0;
  return (
    <div className="space-y-2" data-testid="nfr-pooled">
      <p className="text-[11px] text-gray-500">
        One NFR holds a few sites per motif, too few for significance. Pool every NFR of the runs you pick (find variants in many
        regions with <b>Find variants in regions</b>) and compare variant types: the full opening, narrower (core), wider (extended),
        shifted, alternative registers. Motif scoring and site settings come from the motif view's Parameters.
      </p>
      <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-gray-200 p-1.5 text-[11px] dark:border-gray-700" data-testid="nfr-pooled-runs">
        {complete.length === 0 && <p className="text-gray-500">No finished run yet.</p>}
        {complete.map(j => (
          <label key={j.job_id} className="flex items-center gap-1.5">
            <input type="checkbox" checked={picked.has(j.job_id)} data-testid="nfr-pooled-run"
              onChange={e => setPicked(p => { const n = new Set(p); if (e.target.checked) n.add(j.job_id); else n.delete(j.job_id); return n; })} />
            <span className="tabular-nums">{j.request ? `${j.request.chrom}:${bp(j.request.start)}–${bp(j.request.end)}` : j.job_id.slice(0, 8)}</span>
            {j.request?.region_label && <span className="text-gray-500">{j.request.region_label}</span>}
            {j.job_id === jobId && <span className="text-[10px] text-fuchsia-600">this run</span>}
          </label>
        ))}
        {pending.length > 0 && <p className="text-[10px] text-gray-500">{pending.length} run{pending.length === 1 ? '' : 's'} queued or running…</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AnalysisButton theme="fuchsia" variant="soft" disabled={!picked.size || busy} onClick={run} data-testid="nfr-pooled-run-button">
          {busy ? 'Pooling…' : `Pool ${picked.size} run${picked.size === 1 ? '' : 's'}`}
        </AnalysisButton>
        <AnalysisButton theme="fuchsia" variant="quiet" disabled={!jobId} onClick={() => setShowBatch(v => !v)} data-testid="nfr-batch-toggle"
          title="Find variants in each region of the Regions catalogue with this run's datasets and settings">Find variants in regions…</AnalysisButton>
      </div>
      {showBatch && jobId && <BatchRegions jobId={jobId} genome={currentGenome} onStarted={() => { setShowBatch(false); void refresh(); }} />}
      <Kmers jobIds={[...picked]} />
      {busy && <AnalysisStatus kind="loading">Scanning and testing every NFR of the picked runs…</AnalysisStatus>}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {data && (
        <>
          <p className="text-[11px] text-gray-500" data-testid="nfr-pooled-summary">
            {data.nfrs} NFRs with ≥ 2 variants in {data.runs} run{data.runs === 1 ? '' : 's'}; {data.families.length} motif families;
            {' '}{significant} family × type cell{significant === 1 ? '' : 's'} at q ≤ 0.1 ({MEASURES.find(m => m.key === measure)!.label.toLowerCase()}).
          </p>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex overflow-hidden rounded border border-gray-200 dark:border-gray-700" role="radiogroup" aria-label="Measure">
              {MEASURES.map(m => (
                <button key={m.key} type="button" role="radio" aria-checked={measure === m.key} onClick={() => setMeasure(m.key)} data-testid={`nfr-pooled-measure-${m.key}`}
                  className={`px-1.5 py-px ${measure === m.key ? 'bg-fuchsia-100 font-semibold text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200' : 'text-gray-500'}`}>{m.label}</button>
              ))}
            </span>
            <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search families" aria-label="Search families"
              className="min-w-[10rem] flex-1 rounded border border-gray-200 bg-white px-1.5 py-px dark:border-gray-700 dark:bg-gray-900" />
          </div>
          <div className="overflow-x-auto">
            <table className="text-[11px] tabular-nums" data-testid="nfr-pooled-heatmap">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="pr-2 font-medium">Family</th>
                  {data.types.map(t => <th key={t} className="px-1 text-center font-medium" title={data.type_help[t]}>{t}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ fam, cells }) => (
                  <tr key={fam.id} className="border-t border-gray-100 dark:border-white/5" data-testid="nfr-pooled-row" data-family={fam.name}>
                    <td className="pr-2" title={fam.members.join(', ')}>{fam.name}{fam.members.length > 1 && <span className="ml-1 text-[10px] text-ink-secondary">+{fam.members.length - 1}</span>}</td>
                    {data.types.map(t => {
                      const c = cells.get(t);
                      const s: PooledStat | undefined = c?.[measure];
                      const ratio = s ? (s.ratio ?? s.odds_ratio) : null;
                      const shown = ratio != null ? ratio.toFixed(1) : s?.direction === 1 ? '∞' : s?.direction === -1 ? '0' : '–';
                      return (
                        <td key={t} className="h-6 w-16 border border-white px-1 text-center dark:border-gray-900" style={{ background: cellColor(s?.log2 ?? (s?.direction ? s.direction * 2 : null)) }}
                          data-testid="nfr-pooled-cell" data-type={t} data-q={s?.q ?? ''}
                          title={s && s.strata ? `${fam.name} × ${t}: ${measure === 'sites' ? 'rate ratio' : 'odds ratio'} ${shown} over ${s.strata} strata (${c!.nfrs} NFRs); p ${s.p?.toExponential(1)}, q ${formatQ(s.q)}` : 'not tested'}>
                          {s && s.strata ? <span className={(s.q ?? 1) <= 0.1 ? 'font-semibold' : 'text-gray-600 dark:text-gray-300'}>{shown}{stars(s.q)}</span> : <span className="text-gray-300">·</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-ink-secondary">
            Cells: ratio for the variant type against its siblings (fuchsia above 1, blue below); * q ≤ 0.1, ** ≤ 0.01, *** ≤ 0.001.
            {' '}{data.definitions[measure]}. {data.definitions.families}. {data.definitions.q}. Top {POOLED_ROWS} families shown; search for others.
          </p>
        </>
      )}
    </div>
  );
}

function BatchRegions({ jobId, genome, onStarted }: { jobId: string; genome: string | null; onStarted: () => void }) {
  const [regions, setRegions] = useState<{ id: string; chrom: string; start: number; end: number; label: string }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  useEffect(() => {
    if (!genome) { setRegions([]); return; }
    getRegionCatalog(genome).then(({ catalog }) => {
      const list = catalog.entries.map(e => ({ id: e.id, chrom: e.chrom, start: e.start, end: e.end, label: e.label }));
      setRegions(list);
      setPicked(new Set(list.slice(0, 50).map(r => r.id)));
    }).catch(e => setError(String((e as Error).message ?? e)));
  }, [genome]);
  const submit = async () => {
    setError('');
    try {
      const out = await startAccessibilityBatch(jobId, (regions ?? []).filter(r => picked.has(r.id)).map(({ chrom, start, end, label }) => ({ chrom, start, end, label })));
      const failed = out.jobs.filter(j => j.status === 'error');
      if (failed.length) setError(`${failed.length} region(s) refused: ${failed[0].message}`);
      onStarted();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  return (
    <div className="space-y-1 rounded border border-dashed border-gray-300 p-1.5 text-[11px] dark:border-gray-700" data-testid="nfr-batch">
      {regions == null ? <AnalysisStatus kind="loading">Regions catalogue…</AnalysisStatus> : regions.length === 0
        ? <p className="text-gray-500">The Regions catalogue for this genome is empty: add regions in the Regions panel (or detect amplicons there).</p>
        : (
          <>
            <p className="text-gray-500">Each picked region gets its own Find variants run (one after another) with this run's datasets and settings; NFRs are detected in each. Up to 50.</p>
            <div className="max-h-32 overflow-y-auto">
              {regions.map(r => (
                <label key={r.id} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={picked.has(r.id)} onChange={e => setPicked(p => { const n = new Set(p); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                  <span className="tabular-nums">{r.chrom}:{bp(r.start)}–{bp(r.end)}</span><span className="text-gray-500">{r.label}</span>
                </label>
              ))}
            </div>
            <AnalysisButton theme="fuchsia" variant="soft" disabled={!picked.size || picked.size > 50} onClick={submit} data-testid="nfr-batch-submit">
              Find variants in {picked.size} region{picked.size === 1 ? '' : 's'}
            </AnalysisButton>
          </>
        )}
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/** De novo k-mers enriched in variant-specific openings (for factors JASPAR lacks), pooled over the picked runs. */
function Kmers({ jobIds }: { jobIds: string[] }) {
  const [k, setK] = useState(6);
  const [data, setData] = useState<{ types: Record<string, { kmers: KmerRow[]; strata: { siblings: number; background: number } }>; tested: number; nfrs: number; definition: string } | null>(null);
  const [type, setType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true); setError('');
    try {
      const out = await getKmerEnrichment(jobIds, k);
      setData(out);
      setType(t => (t && out.types[t] ? t : Object.keys(out.types)[0] ?? ''));
    } catch (e) { setError(String((e as Error).message ?? e)); } finally { setBusy(false); }
  };
  const cell = (s: PooledStat) => (s.strata ? `${s.ratio != null ? `${s.ratio.toFixed(1)}×` : s.direction === 1 ? '∞' : '0×'} q ${formatQ(s.q)}` : '–');
  const rows = data?.types[type]?.kmers ?? [];
  return (
    <details className="rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-gray-700" data-testid="nfr-kmers">
      <summary className="cursor-pointer text-gray-600 dark:text-gray-300">De novo k-mers (factors JASPAR lacks)</summary>
      <div className="mt-1 space-y-1">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1">k
            <select value={k} onChange={e => setK(Number(e.target.value))} aria-label="k-mer length" className="rounded border border-gray-200 bg-white px-1 py-px dark:border-gray-700 dark:bg-gray-900">
              {[5, 6, 7, 8].map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <AnalysisButton theme="fuchsia" variant="soft" disabled={!jobIds.length || busy} onClick={run} data-testid="nfr-kmers-run">{busy ? 'Counting…' : 'Find enriched k-mers'}</AnalysisButton>
        </div>
        {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-gray-500">{data.tested.toLocaleString()} k-mers tested over {data.nfrs} NFRs, per variant type:</span>
              {Object.keys(data.types).map(t => (
                <button key={t} type="button" onClick={() => setType(t)} data-testid={`nfr-kmers-type-${t}`}
                  className={`rounded px-1.5 ${type === t ? 'bg-fuchsia-100 font-semibold text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200' : 'text-gray-500'}`}>{t}</button>
              ))}
            </div>
            {!rows.some(r => (r.siblings.q ?? 1) <= 0.1) && (
              <p className="text-gray-500" data-testid="nfr-kmers-none">No k-mer is enriched in this type's own openings against its siblings at q ≤ 0.1; the strongest are listed.</p>
            )}
            <table className="tabular-nums" data-testid="nfr-kmers-table">
              <thead className="text-left text-gray-500"><tr><th className="pr-2 font-medium">k-mer</th><th className="pr-2 font-medium">own part vs siblings</th>
                <th className="pr-2 font-medium">vs background</th><th className="font-medium">best JASPAR match</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.kmer} className="border-t border-gray-100 dark:border-white/5" data-testid="nfr-kmer-row">
                    <td className="pr-2 font-mono">{r.kmer}</td>
                    <td className={`pr-2 ${(r.siblings.q ?? 1) <= 0.1 ? 'font-semibold text-fuchsia-700 dark:text-fuchsia-300' : ''}`}>{cell(r.siblings)}</td>
                    <td className={`pr-2 ${(r.background.q ?? 1) <= 0.1 ? 'font-semibold text-fuchsia-700 dark:text-fuchsia-300' : ''}`}>{cell(r.background)}</td>
                    <td className="text-gray-500">{r.match ? `${r.match.name} (${Math.round(r.match.share * 100)}%)` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-ink-secondary">{data.definition}.</p>
          </>
        )}
      </div>
    </details>
  );
}
