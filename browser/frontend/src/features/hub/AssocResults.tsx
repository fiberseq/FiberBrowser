/**
 * One association run's results (DESIGN §7, hub A2): what the data can't answer (limits), the effect table with
 * intervals and p, the group interaction, the post-selection check, the per-pair or per-anchor list (go to, use as
 * anchors or as a read filter), M4's distance curve, and the inputs behind the numbers.
 */
import { useMemo, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { AnalysisButton } from '../../components/controls/shared/AnalysisControls';
import { asAnchors, asFilter, goToHits } from './actions';
import { downloadTextFile, formatTsv } from '../../utils/analysisExport';
import type { HubSelected } from './hubState';
import type { AssocRun } from './hubState';
import type { AssocCurve, AssocEffect, AssocInteraction, AssocRow } from './assocApi';
import { MODE_SHORT } from './assocApi';

export const fmt = (v: number | null | undefined, digits = 3): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(1);
  return Number(v.toPrecision(digits)).toLocaleString(undefined, { maximumSignificantDigits: digits });
};
export const fmtP = (p: number | null | undefined): string => {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p < 1e-4) return '< 1e-4';
  return p < 0.01 ? p.toExponential(1) : p.toFixed(p < 0.1 ? 3 : 2);
};
const ci = (e: { lo?: number | null; hi?: number | null }) => (e.lo != null && e.hi != null ? `[${fmt(e.lo)}, ${fmt(e.hi)}]` : '');

function interactionOf(run: AssocRun): Array<{ label: string; it: AssocInteraction }> {
  const res = run.result;
  if (!res) return [];
  const raw = (res.result ?? {}) as Record<string, unknown>;
  const out: Array<{ label: string; it: AssocInteraction }> = [];
  if (raw.interaction) out.push({ label: 'Group difference', it: raw.interaction as AssocInteraction });
  for (const e of res.effects ?? []) if (e.interaction) out.push({ label: e.label, it: e.interaction });
  const contrast = raw.contrast as Record<string, unknown> | undefined;
  if (contrast && Array.isArray(contrast.rows)) {
    out.push({ label: 'B by dataset: difference in log O/E (bootstrap over A clusters)', it: {
      groups: contrast.groups as string[], differences: (contrast.rows as Array<Record<string, number | string | null>>)
        .filter(r => r.group != null && r.reference != null)
        .map(r => ({ group: String(r.group), reference: String(r.reference), difference: (r.difference ?? r.log_oe_difference ?? null) as number | null,
          lo: (r.lo ?? null) as number | null, hi: (r.hi ?? null) as number | null, p_wald: (r.p ?? null) as number | null })) } });
  } else if (contrast && (contrast.message || contrast.status)) {
    out.push({ label: 'Group difference', it: { status: String(contrast.status ?? ''), note: String(contrast.message ?? '') } });
  }
  return out;
}

function Curve({ curve, dark }: { curve: Record<string, AssocCurve>; dark: boolean }) {
  const series = [
    { key: 'A->B', label: 'A → B', colour: dark ? '#9085e9' : '#6250d6' },
    { key: 'B->A', label: 'B → A', colour: dark ? '#199e70' : '#1baf7a' },
  ].filter(s => curve[s.key]?.rows?.length);
  const ds = [...new Set(series.flatMap(s => curve[s.key].rows.map(r => r.d)))].sort((a, b) => a - b);
  const values = series.flatMap(s => curve[s.key].rows.map(r => r.o_over_e)).filter((v): v is number => v != null && Number.isFinite(v));
  const [hover, setHover] = useState<{ s: string; d: number } | null>(null);
  if (!series.length || !ds.length) return <p className="text-[11px] text-ink-secondary">No distance curve (see the notes above).</p>;
  const W = 420, H = 170, L = 40, R = 52, T = 12, B = 28;
  const ymax = Math.max(1.5, ...values) * 1.08, ymin = Math.min(0.5, ...values, 1) * 0.92;
  const x = (d: number) => L + (ds.indexOf(d) / Math.max(1, ds.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
  const ticks = [ymin, 1, ymax].map(v => Number(v.toFixed(2)));
  const dLabel = (d: number) => (d === 0 ? 'overlap' : d >= 1000 ? `${d / 1000} kb` : `${d} bp`);
  return <figure className="space-y-1" data-testid="assoc-curve">
    <figcaption className="text-[11px] text-ink-secondary">Observed / expected fraction of hits with a hit within d (B fixed; A relocated within its strata), by distance. Filled points: per-d p &lt; 0.05 (descriptive; the global test is the max |z|).</figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[520px]" role="img" aria-label="Observed over expected by distance">
      {ticks.map(t => <g key={t}>
        <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={t === 1 ? 0.45 : 0.12} strokeDasharray={t === 1 ? '4 3' : undefined} />
        <text x={L - 4} y={y(t) + 3} textAnchor="end" className="fill-current text-[9px] opacity-70">{t}</text>
      </g>)}
      {ds.map(d => <text key={d} x={x(d)} y={H - 10} textAnchor="middle" className="fill-current text-[9px] opacity-70">{dLabel(d)}</text>)}
      {series.map(s => {
        const pts = curve[s.key].rows.filter(r => r.o_over_e != null && Number.isFinite(r.o_over_e));
        const last = pts[pts.length - 1];
        return <g key={s.key}>
          <polyline fill="none" stroke={s.colour} strokeWidth={2} points={pts.map(r => `${x(r.d)},${y(r.o_over_e!)}`).join(' ')} />
          {pts.map(r => <circle key={r.d} cx={x(r.d)} cy={y(r.o_over_e!)} r={4} stroke={s.colour} strokeWidth={2}
            fill={r.p_descriptive != null && r.p_descriptive < 0.05 ? s.colour : 'var(--surface-1, white)'}
            onMouseEnter={() => setHover({ s: s.key, d: r.d })} onMouseLeave={() => setHover(null)} />)}
          {last && <text x={x(last.d) + 7} y={y(last.o_over_e!) + 3} className="fill-current text-[10px]">{s.label}</text>}
        </g>;
      })}
      {hover && (() => {
        const r = curve[hover.s].rows.find(q => q.d === hover.d)!;
        const tx = Math.min(W - 150, x(hover.d) + 8);
        return <g pointerEvents="none">
          <rect x={tx} y={T} width={140} height={44} rx={4} className="fill-white stroke-gray-300 dark:fill-gray-800 dark:stroke-gray-600" />
          <text x={tx + 6} y={T + 13} className="fill-current text-[9px]">{hover.s.replace('->', ' → ')} · {dLabel(hover.d)}</text>
          <text x={tx + 6} y={T + 25} className="fill-current text-[9px]">O/E {fmt(r.o_over_e)} · obs {fmt(r.observed)} · null {fmt(r.null_mean)}</text>
          <text x={tx + 6} y={T + 37} className="fill-current text-[9px]">z {fmt(r.z)} · p {fmtP(r.p_descriptive)} · n {r.n_used}</text>
        </g>;
      })()}
    </svg>
    <table className="w-full max-w-[520px] text-[10px] tabular-nums" data-testid="assoc-curve-table">
      <thead className="text-ink-muted"><tr><th className="text-left">d</th>{series.map(s => <th key={s.key} className="text-right">{s.label} O/E (p)</th>)}</tr></thead>
      <tbody>{ds.map(d => <tr key={d}><td>{dLabel(d)}</td>{series.map(s => {
        const r = curve[s.key].rows.find(q => q.d === d);
        return <td key={s.key} className="text-right">{r ? `${fmt(r.o_over_e)} (${fmtP(r.p_descriptive)})` : '—'}</td>;
      })}</tr>)}</tbody>
    </table>
  </figure>;
}

function EffectTable({ effects, mode }: { effects: AssocEffect[]; mode: string }) {
  const rows = effects.filter(e => !e.interaction);
  if (!rows.length) return null;
  return <table className="w-full text-[11px] tabular-nums" data-testid="assoc-effects">
    <thead className="text-ink-muted"><tr>
      <th className="px-1 text-left font-medium">{mode === 'M2' ? 'Bin · statistic' : 'Effect'}</th>
      <th className="px-1 text-right font-medium">Estimate</th><th className="px-1 text-right font-medium">95% CI</th>
      <th className="px-1 text-right font-medium">p</th><th className="px-1 text-right font-medium">n</th>
    </tr></thead>
    <tbody>{rows.map(e => <tr key={e.key} className="border-t border-gray-100 dark:border-gray-800" data-testid="assoc-effect-row" data-key={e.key}
      title={e.detail ? Object.entries(e.detail).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${typeof v === 'number' ? fmt(v) : String(v)}`).join('\n') : undefined}>
      <td className="px-1 text-left">{e.label}{e.descriptive && <span className="ml-1 text-[10px] text-ink-muted">(descriptive)</span>}
        {e.scale && <span className="ml-1 text-[10px] text-ink-muted">· {e.scale}</span>}</td>
      <td className="whitespace-nowrap px-1 text-right font-medium">{fmt(e.estimate)}</td>
      <td className="whitespace-nowrap px-1 text-right text-[10px] text-ink-secondary">{ci(e)}</td>
      <td className="whitespace-nowrap px-1 text-right">{fmtP(e.p)}</td>
      <td className="px-1 text-right text-ink-secondary">{e.n ?? ''}</td>
    </tr>)}</tbody>
  </table>;
}

const PAGE = 100;

export function AssocResults({ run, onRerun, onRemove }: { run: AssocRun; onRerun: () => void; onRemove: () => void }) {
  const dark = useBrowserStore(s => s.darkMode);
  const res = run.result;
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const rows: AssocRow[] = useMemo(() => res?.anchors ?? [], [res]);
  const def = run.definition;
  const interactions = interactionOf(run);
  if (run.status !== 'complete' || !res) {
    return <div className="rounded-fb border border-red-200 bg-red-50 px-2 py-1 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200" data-testid="assoc-error">
      {run.label}: {run.error ?? run.status}
      <div className="mt-1 flex gap-1"><AnalysisButton onClick={onRerun}>Run again</AnalysisButton><AnalysisButton onClick={onRemove}>Remove</AnalysisButton></div>
    </div>;
  }
  const rowLabel = (r: AssocRow) => (def.mode === 'M1' ? `${r.a ?? ''} × ${r.b ?? ''}` : r.hitId ?? `${r.chrom}:${r.pos}`);
  const selectedRows = rows.filter(r => picked.has(r.id));
  const useRows = selectedRows.length ? selectedRows : rows.filter(r => r.q != null && r.q <= 0.1);
  // One entry per A hit (M2 lists a hit once per bin and frame; M1 once per B partner), with its span and strand.
  const entriesFor = (list: AssocRow[]): HubSelected[] => {
    const seen = new Set<string>();
    return list.flatMap(r => {
      const hitId = def.mode === 'M1' ? r.a : r.hitId;
      if (!hitId || !r.chrom || r.pos == null || seen.has(hitId)) return [];
      seen.add(hitId);
      const scan = def.a.kind === 'scan';
      const start = r.aStart ?? r.pos, end = Math.max(r.aEnd ?? r.pos + 1, start);
      return [{ setId: def.a.setId ?? 'assoc', hitId, typeId: def.a.typeId ?? 'anchors', chrom: r.chrom, start, end, anchor: r.pos,
        ...(r.aStrand === '+' || r.aStrand === '-' ? { strand: r.aStrand } : {}), label: def.mode === 'M1' ? hitId : rowLabel(r), hasStates: scan }];
    });
  };
  const goTo = (r: AssocRow) => { if (r.chrom && r.pos != null) setNotice(goToHits([{ chrom: r.chrom, start: Math.min(r.pos, r.pos2 ?? r.pos), end: Math.max(r.pos, r.pos2 ?? r.pos) + 1 }]) ?? ''); };
  const inputs = (res.inputs ?? {}) as Record<string, unknown>;
  const raw = (res.result ?? {}) as Record<string, unknown>;
  return <div className="space-y-2" data-testid="assoc-result" data-status={res.status} data-mode={res.mode}>
    <div className="flex flex-wrap items-baseline gap-x-2">
      <strong>{run.label}</strong>
      <span className="text-[11px] text-ink-muted">{MODE_SHORT[def.mode]} · unit: {res.unit} · scope: {res.scope?.kind}{res.scope?.nRegions ? ` (${res.scope.nRegions} window${res.scope.nRegions === 1 ? '' : 's'})` : ''}</span>
      <span className={`rounded-full px-1.5 text-[10px] ${res.status === 'ok' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'}`}
        data-testid="assoc-status">{res.status === 'ok' ? 'ran' : res.status === 'refused' ? 'refused' : 'nothing to test'}</span>
      <span className="ml-auto flex gap-1">
        <AnalysisButton onClick={onRerun} data-testid="assoc-rerun" disabled={Boolean(def.truncated)}
          title={def.truncated ? 'Its browser-set hits were cut when the run was kept with the session: rebuild it in the builder to run it again'
            : 'Run this definition again'}>Run again</AnalysisButton>
        <AnalysisButton onClick={() => exportRun(run)} data-testid="assoc-export">Export</AnalysisButton>
        <AnalysisButton onClick={onRemove}>Remove</AnalysisButton>
      </span>
    </div>
    {(res.limits?.length ?? 0) > 0 && <div className="rounded-fb border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="assoc-limits">
      <div className="font-medium">What this data can't answer</div>
      <ul className="ml-4 list-disc">{res.limits!.map(l => <li key={l}>{l}</li>)}</ul>
    </div>}
    {res.postSelection && <div className={`rounded-fb px-2 py-1 text-[11px] ${res.postSelection.status === 'ok' ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'}`} data-testid="assoc-post-selection">
      Post-selection check: {res.postSelection.status === 'ok' ? 'the cluster run\'s regions lie outside the tested windows and their flanks: the cluster contrast is valid here'
        : res.postSelection.status === 'refused' ? `refused: the cluster run used ${res.postSelection.overlaps?.length ?? 0} region(s) inside the tested windows` : 'post-selection: descriptive, no p-values on the group comparison'}
      {res.postSelection.note ? ` (${res.postSelection.note})` : ''}
    </div>}
    {res.effects && <EffectTable effects={res.effects} mode={res.mode} />}
    {interactions.map(({ label, it }) => <div key={label} className="rounded-fb border border-line px-2 py-1 dark:border-white/10" data-testid="assoc-interaction">
      <div className="font-medium">{label}{it.scale ? <span className="ml-1 text-[10px] font-normal text-ink-muted">· {it.scale}</span> : null}</div>
      {it.note && <div className="text-[11px] text-ink-secondary">{it.note}</div>}
      {(it.differences ?? []).map(d => <div key={`${d.group}-${d.reference}`} className="text-[11px] tabular-nums">
        {d.group} − {d.reference}: {fmt(d.difference)} {d.lo != null && d.hi != null ? `[${fmt(d.lo)}, ${fmt(d.hi)}]` : ''} · p {fmtP(d.p_wald ?? d.p_boot)}
      </div>)}
      {it.p !== undefined && it.differences && it.differences.length > 1 && <div className="text-[11px]">Overall: p {fmtP(it.p)}</div>}
      {(it.differences?.length ?? 0) > 0 && <div className="text-[10px] text-ink-muted">These libraries: groups compared within the loaded samples (no replicates declared), not a population claim.{it.variance ? ` Variance: ${it.variance}.` : ''}</div>}
    </div>)}
    {res.mode === 'M4' && res.curve && <Curve curve={res.curve} dark={dark} />}
    {rows.length > 0 && <section className="space-y-1" data-testid="assoc-rows">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{def.mode === 'M1' ? 'Pairs' : 'Anchors'}</span>
        <span className="text-[11px] text-ink-muted">{rows.length.toLocaleString()} rows{rows.length >= 5000 ? ' (first 5,000)' : ''}, by q · click a row to go there</span>
        <span className="ml-auto flex gap-1">
          <AnalysisButton disabled={!useRows.length} data-testid="assoc-use-anchors" title="Save the picked rows (else those with q ≤ 0.1) as an anchor set"
            onClick={() => setNotice(asAnchors(entriesFor(useRows), `${run.label} · ${useRows.length} rows`) ?? `Saved ${useRows.length} anchors.`)}>Use as anchors</AnalysisButton>
          <AnalysisButton disabled={!useRows.length || def.a.kind !== 'scan'} data-testid="assoc-use-filter"
            title={def.a.kind === 'scan' ? 'Keep the reads in state 1 at A of the picked rows (else those with q ≤ 0.1)' : 'Only A sets from a scan have per-read states to filter on'}
            onClick={() => { void asFilter(entriesFor(useRows), 'any').then(err => setNotice(err ?? 'Filtered the reads to A\'s members at those rows.')); }}>Use as filter</AnalysisButton>
        </span>
      </div>
      <div className="max-h-[260px] overflow-auto rounded border border-gray-200 dark:border-gray-700">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-gray-50 text-gray-500 dark:bg-gray-900"><tr>
            <th /><th className="px-1 text-left font-medium">{def.mode === 'M1' ? 'A × B' : 'Anchor'}</th><th className="px-1 text-left font-medium">Locus</th>
            {def.mode === 'M2' && <th className="px-1 text-left font-medium">Bin</th>}
            <th className="px-1 text-right font-medium">{def.mode === 'M1' ? 'OR' : 'Δ'}</th><th className="px-1 text-right font-medium">p</th>
            <th className="px-1 text-right font-medium">q</th><th className="px-1 text-right font-medium">{def.mode === 'M1' ? 'n · table' : 'n open / closed'}</th>
          </tr></thead>
          <tbody>{rows.slice(0, shown).map(r => <tr key={r.id} className="cursor-pointer border-t border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-white/5"
            onClick={() => goTo(r)} data-testid="assoc-row">
            <td className="px-1" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label="Pick this row" checked={picked.has(r.id)}
              onChange={e => setPicked(p => { const n = new Set(p); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} /></td>
            <td className="max-w-[12rem] truncate px-1" title={rowLabel(r)}>{rowLabel(r)}</td>
            <td className="whitespace-nowrap px-1">{r.chrom}:{r.pos != null ? (r.pos + 1).toLocaleString() : ''}{r.distance != null ? ` (${r.distance.toLocaleString()} bp apart)` : ''}</td>
            {def.mode === 'M2' && <td className="px-1">{r.frame ? `${r.frame} · ` : ''}{r.bin}</td>}
            <td className="px-1 text-right">{fmt(r.estimate)}</td><td className="px-1 text-right">{fmtP(r.p)}</td><td className="px-1 text-right">{fmtP(r.q)}</td>
            <td className="px-1 text-right text-ink-secondary">{def.mode === 'M1' ? `${r.n ?? ''} · ${(r.table ?? []).join('/')}` : `${r.n1 ?? ''} / ${r.n0 ?? ''}`}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {shown < rows.length && <button type="button" className="text-[11px] text-indigo-700 hover:underline dark:text-indigo-300" onClick={() => setShown(n => n + PAGE)} data-testid="assoc-rows-more">Show {Math.min(PAGE, rows.length - shown)} more</button>}
    </section>}
    {notice && <p role="status" className="text-[11px] text-ink-secondary" data-testid="assoc-notice">{notice}</p>}
    {res.cli && <div className="text-[11px]"><span className="text-ink-muted">Same analysis on the command line: </span>
      <code className="break-all">{res.cli}</code>
      <button type="button" className="ml-1 text-indigo-700 hover:underline dark:text-indigo-300" onClick={() => { void navigator.clipboard?.writeText(res.cli!); }}>Copy</button></div>}
    <details className="text-[11px]" data-testid="assoc-inputs">
      <summary className="cursor-pointer text-ink-secondary">Inputs and settings</summary>
      <InputsView inputs={inputs} raw={raw} />
    </details>
  </div>;
}

function InputsView({ inputs, raw }: { inputs: Record<string, unknown>; raw: Record<string, unknown> }) {
  const line = (k: string, v: unknown): string => {
    if (v == null) return '';
    if (typeof v !== 'object') return `${k}: ${String(v)}`;
    const o = v as Record<string, unknown>;
    if ('hits' in o || 'type' in o) {
      const counts = Object.entries((o.counts as Record<string, number>) ?? {}).map(([c, n]) => `${n} ${c.replace(/_/g, ' ')}`).join(', ');
      const notes = ((o.notes as string[]) ?? []).join('; ');
      return `${k}: ${o.label ?? o.type}${o.hits != null ? ` · ${o.hits} hits` : ''}${o.stateRows != null ? ` · ${o.stateRows} molecule states` : ''}${counts ? ` · ${counts}` : ''}${notes ? ` · ${notes}` : ''}`;
    }
    return `${k}: ${Object.entries(o).filter(([, x]) => x != null && typeof x !== 'object').map(([a, b]) => `${a} ${typeof b === 'number' ? fmt(b) : String(b)}`).join(', ')}`;
  };
  const settings = raw.settings as Record<string, unknown> | undefined;
  return <ul className="ml-4 list-disc text-ink-secondary">
    {Object.entries(inputs).map(([k, v]) => { const t = line(k, v); return t ? <li key={k}>{t}</li> : null; })}
    {settings && <li>settings: {Object.entries(settings).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k} ${String(v)}`).join(', ')}</li>}
    {typeof raw.coordinate === 'string' && <li>exposure: {raw.coordinate}</li>}
  </ul>;
}

/** The run as JSON (definition, result, inputs), and its rows as TSV. */
function exportRun(run: AssocRun) {
  const slug = `association-${run.definition.mode}-${run.id}`;
  downloadTextFile(JSON.stringify(run, null, 1), `${slug}.json`, 'application/json');
  const rows = run.result?.anchors ?? [];
  if (rows.length) {
    const keys = ['id', 'chrom', 'pos', 'pos2', 'a', 'b', 'hitId', 'frame', 'bin', 'estimate', 'lo', 'hi', 'p', 'q', 'n', 'n1', 'n0', 'distance'];
    downloadTextFile(formatTsv([keys, ...rows.map(r => keys.map(k => (r as unknown as Record<string, unknown>)[k] ?? ''))]), `${slug}.tsv`,
      'text/tab-separated-values');
  }
}
