import { useEffect, useRef, useState } from 'react';
import { getCoaccMatrixData } from '../../../api/coaccessibility';
import type { Dataset } from '../../../types';
import { getDatasetDisplayLabel } from '../../../utils/datasetLabels';
import { divergingColor, referenceMismatch, subtractCoacc, type CoaccDifference } from '../../../utils/coaccDifference';
import { AnalysisStatus } from '../shared';
import type { CoaccMatrixSettings } from './CoaccMatrixView';

/** A dataset that can be subtracted: its reference (null: the main genome) as its panel shows it. */
export interface DiffDataset { dataset: Dataset; reference: string | null }

const bp = (n: number) => Math.round(n).toLocaleString('en-US');

/** A read scope's identity: all of it (undefined: every read). */
export function scopeSignature(ids: string[] | undefined): string {
  if (ids === undefined) return 'all';
  let h = 2166136261;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0x1f; h = Math.imul(h, 16777619);                  // a separator: ['ab', 'c'] is not ['a', 'bc']
  }
  return `${ids.length}:${(h >>> 0).toString(36)}`;
}

/**
 * Two open datasets' position x position matrices of the view, subtracted: A − B on one position grid (B is asked
 * for on A's bins), with a diverging colour scale centred on 0 (red: higher in A, blue: higher in B) and each one's
 * read count. Datasets on different references, or matrices on different grids, are refused in plain words.
 */
export function CoaccDifferenceView({ datasets, chrom, start, end, settings, readIdsForDataset, sampleSeed, size, reversed = false }: {
  datasets: DiffDataset[]; chrom: string; start: number; end: number; settings: CoaccMatrixSettings;
  readIdsForDataset: (datasetId: string) => string[] | undefined; sampleSeed?: string; size: number; reversed?: boolean;
}) {
  const ids = datasets.map(d => d.dataset.id);
  const [a, setA] = useState<string>(ids[0] ?? '');
  const [b, setB] = useState<string>(ids[1] ?? '');
  // datasets closed or opened: keep the picks that are still open, else the first two
  useEffect(() => {
    if (!ids.includes(a)) setA(ids[0] ?? '');
    if (!ids.includes(b)) setB(ids.find(id => id !== (ids.includes(a) ? a : ids[0])) ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join()]);
  const [state, setState] = useState<{ loading: boolean; error: string | null; diff: CoaccDifference | null }>({ loading: false, error: null, diff: null });
  const dsA = datasets.find(d => d.dataset.id === a), dsB = datasets.find(d => d.dataset.id === b);
  const labelA = dsA ? getDatasetDisplayLabel(dsA.dataset) : 'A', labelB = dsB ? getDatasetDisplayLabel(dsB.dataset) : 'B';
  const scopeA = a ? readIdsForDataset(a) : undefined, scopeB = b ? readIdsForDataset(b) : undefined;
  // every read id counts: a filter that swaps one read asks again
  const scopeKey = `${scopeSignature(scopeA)}|${scopeSignature(scopeB)}`;
  const refusal = datasets.length < 2 ? 'Open two datasets to subtract one matrix from the other.'
    : !dsA || !dsB ? 'Pick two datasets.'
    : a === b ? 'Pick two different datasets.'
    : referenceMismatch(dsA.reference, dsB.reference, labelA, labelB);
  useEffect(() => {
    if (refusal) { setState({ loading: false, error: null, diff: null }); return; }
    let live = true;
    // the previous difference goes at once: its labels would no longer match it (after Swap: B − A drawn as A − B)
    setState({ loading: true, error: null, diff: null });
    const options = (id: string, scope: string[] | undefined, binSize: number) => ({
      panelGenome: datasets.find(d => d.dataset.id === id)?.reference, binSize: binSize || undefined, datasetIds: [id], normalization: settings.normalization, minCoverage: settings.minCoverage,
      readIdsByDataset: scope !== undefined ? { [id]: scope } : undefined, signalType: settings.signalType, layer: settings.layer, sampleSeed,
    });
    (async () => {
      const ma = await getCoaccMatrixData(chrom, start, end, options(a, scopeA, settings.binSize));
      // B on A's bins: the same position grid (checked again below)
      const mb = await getCoaccMatrixData(chrom, start, end, options(b, scopeB, ma.bin_size));
      if (!live) return;
      const diff = subtractCoacc(ma, mb);
      setState('error' in diff ? { loading: false, error: diff.error, diff: null } : { loading: false, error: null, diff });
    })().catch(e => { if (live) setState({ loading: false, error: e instanceof Error ? e.message : String(e), diff: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusal, dsA?.reference, dsB?.reference, a, b, chrom, start, end, settings.normalization, settings.minCoverage, settings.signalType, settings.layer, settings.binSize, sampleSeed, scopeKey]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const diff = state.diff;
  const half = diff ? Math.max(diff.maxAbs, 1e-6) : 1;
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext?.('2d');
    if (!el || !ctx || !diff) return;
    const n = diff.n_bins || diff.matrix.length;
    const cell = size / Math.max(1, n);
    ctx.clearRect(0, 0, size, size);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        ctx.fillStyle = divergingColor(diff.matrix[i]?.[j] ?? null, half);
        ctx.fillRect((reversed ? n - 1 - j : j) * cell, (reversed ? n - 1 - i : i) * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
  }, [diff, half, size, reversed]);

  const picker = (value: string, set: (v: string) => void, testId: string, label: string) => (
    <label className="flex items-center gap-1">
      <span className="font-medium">{label}</span>
      <select value={value} onChange={e => set(e.target.value)} data-testid={testId}
        className="max-w-[12rem] rounded border px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900">
        {datasets.map(d => <option key={d.dataset.id} value={d.dataset.id}>{getDatasetDisplayLabel(d.dataset)}</option>)}
      </select>
    </label>
  );
  return (
    <div className="space-y-1.5 text-[11px]" data-testid="coacc-diff">
      <div className="flex flex-wrap items-center gap-2">
        {picker(a, setA, 'coacc-diff-a', 'A')}
        <span className="text-ink-muted">−</span>
        {picker(b, setB, 'coacc-diff-b', 'B')}
        <button type="button" data-testid="coacc-diff-swap" onClick={() => { setA(b); setB(a); }} title="Swap A and B"
          className="rounded px-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10">⇄</button>
      </div>
      {refusal && <AnalysisStatus kind="info" compact><span data-testid="coacc-diff-refused">{refusal}</span></AnalysisStatus>}
      {!refusal && state.loading && <AnalysisStatus kind="loading" compact>Computing both matrices…</AnalysisStatus>}
      {!refusal && state.error && <AnalysisStatus kind="error" compact><span data-testid="coacc-diff-error">{state.error}</span></AnalysisStatus>}
      {!refusal && diff && (
        <>
          <p className="text-gray-600 dark:text-gray-300" data-testid="coacc-diff-n">
            {labelA}: <span className="font-semibold tabular-nums">{diff.readsA.toLocaleString()}</span> reads · {labelB}: <span className="font-semibold tabular-nums">{diff.readsB.toLocaleString()}</span> reads
            <span className="text-ink-muted"> · {settings.normalization} · {diff.n_bins} bins of {bp(diff.bin_size)} bp</span>
          </p>
          <canvas ref={canvas} width={size} height={size} data-testid="coacc-diff-canvas" data-max={diff.maxAbs.toFixed(4)} data-bins={diff.n_bins}
            role="img" aria-label={`${labelA} minus ${labelB}, ${diff.chrom}:${bp(diff.start)}–${bp(diff.end)}`}
            style={{ width: size, height: size }} className="rounded border border-gray-200 dark:border-gray-700" />
          <div className="flex justify-between text-[10px] tabular-nums text-ink-secondary" style={{ width: size }}><span>{bp(reversed ? diff.end : diff.start)}</span><span>{bp(reversed ? diff.start : diff.end)}</span></div>
          <div className="flex items-center gap-2 text-[10px]" data-testid="coacc-diff-legend" style={{ width: size }}>
            <span style={{ color: '#1d4ed8' }}>higher in {labelB}</span>
            <span className="h-2 flex-1 rounded" style={{ background: `linear-gradient(to right, ${divergingColor(-half, half)}, ${divergingColor(0, half)}, ${divergingColor(half, half)})` }} />
            <span style={{ color: '#c2410c' }}>higher in {labelA}</span>
            <span className="tabular-nums text-ink-muted">±{half.toFixed(2)}</span>
          </div>
        </>
      )}
    </div>
  );
}
