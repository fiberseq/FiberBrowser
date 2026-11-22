/**
 * The output of a quantification (the card under the metaprofiles and the Plots card draw this one component): bars or
 * lines (QuantChart) or a table with n reads per group, the values and intervals, enrichment, the comparison with the
 * reference and, per measure, the test of equal shares (BH-adjusted across measures); sorting; TSV.
 * Clicking a bar or a row picks that measure × group (the card links it back to the reads).
 */
import { useMemo } from 'react';
import { quantOrder, quantTsv, shownOf, type QuantResult } from './engine';
import { QuantChart } from './QuantChart';
import type { QuantSort, QuantSpec } from './spec';
import { axisLabelOf, pText, rawUnitOf } from './labels';

const fmt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));
const ci = (lo: number | null, hi: number | null) => (lo == null || hi == null ? '' : ` [${fmt(lo)}, ${fmt(hi)}]`);

const seg = 'rounded border px-1.5 py-0.5 text-[11px]';
const on = 'border-cyan-500 bg-cyan-50 text-cyan-900 dark:bg-cyan-950/50 dark:text-cyan-100';
const off = 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800';

export function QuantResultView({ result, spec, width, dark = false, measuresText, filename, onDisplay, selected = null, onPick }: {
  result: QuantResult; spec: QuantSpec; width: number; dark?: boolean; measuresText: string; filename: string;
  onDisplay: (patch: Partial<Pick<QuantSpec, 'chart' | 'view' | 'sort'>>) => void;
  selected?: { measure: string; group: string } | null;
  onPick?: (measure: string, group: string) => void;
}) {
  const tsv = useMemo(() => () => quantTsv(result, [measuresText]), [result, measuresText]);
  const order = useMemo(() => quantOrder(result, spec), [result, spec]);
  const groups = new Map(result.groups.map(g => [g.id, g]));
  const tested = result.measures.filter(m => result.tests[m.id]);
  return (
    <div className="flex flex-col gap-1.5" data-testid="quant-result" data-groups={result.groups.length} data-measures={result.measures.length}>
      <div className="text-[11px] text-ink-primary dark:text-gray-100" data-testid="quant-measures">{measuresText}</div>
      <div className="flex flex-wrap items-center gap-1" data-testid="quant-display">
        {(['bar', 'line'] as const).map(c => (
          <button key={c} type="button" className={`${seg} ${spec.view === 'chart' && spec.chart === c ? on : off}`} data-testid={`quant-show-${c}`}
            title={c === 'bar' ? 'Grouped bars with 95% whiskers' : 'Lines across the groups (ordered groups: datasets or time points)'}
            onClick={() => onDisplay({ view: 'chart', chart: c })}>{c === 'bar' ? 'Bars' : 'Lines'}</button>
        ))}
        <button type="button" className={`${seg} ${spec.view === 'table' ? on : off}`} data-testid="quant-show-table" onClick={() => onDisplay({ view: 'table' })}>Table</button>
        <label className="ml-2 flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">Sort
          <select className="input-tool min-h-0 py-0.5 text-[11px]" value={spec.sort} data-testid="quant-sort" aria-label="Sort"
            onChange={e => onDisplay({ sort: e.target.value as QuantSort })}>
            <option value="panel">panel order</option>
            <option value="value">groups by value</option>
            <option value="enrichment">groups by enrichment</option>
            <option value="spread">measures by spread across groups</option>
          </select>
        </label>
        <button type="button" className={`ml-auto ${seg} ${off}`} data-testid="quant-tsv" title="Export the table (n reads per group, values, intervals, enrichment, comparison, tests) as TSV"
          onClick={() => downloadText(tsv(), `${filename}.tsv`)}>TSV</button>
      </div>
      {tested.length > 0 && (
        <div className="text-[11px] text-gray-700 dark:text-gray-200" data-testid="quant-tests">
          Equal shares across groups ({result.tests[tested[0].id]!.method === 'g' ? 'likelihood-ratio G' : 'chi-squared'}{spec.adjust === 'bh' && tested.length > 1 ? ', BH q across measures' : ''}):{' '}
          {tested.map(m => { const t = result.tests[m.id]!; return <span key={m.id} className="mr-2" data-testid="quant-test" data-measure={m.id}>{m.label} p = {pText(t.p)}{spec.adjust === 'bh' && tested.length > 1 ? `, q = ${pText(t.q)}` : ''}</span>; })}
        </div>
      )}
      {spec.view === 'chart' ? (
        <QuantChart result={result} spec={spec} width={width} dark={dark} filename={filename} tsv={tsv} selected={selected} onPick={onPick} />
      ) : (
        <div className="max-h-80 overflow-auto rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-[11px]" data-testid="quant-table">
            <thead className="sticky top-0 bg-gray-50 text-left dark:bg-gray-800">
              <tr><th className="px-1.5 py-0.5">Measure</th><th className="px-1.5">Group</th><th className="px-1.5 text-right">n reads</th>
                <th className="px-1.5 text-right">Value [95%]</th>
                {spec.value === 'enrichment' && <th className="px-1.5 text-right">Enrichment [95%]</th>}
                {spec.compare !== 'off' && <th className="px-1.5 text-right">vs reference [95%]</th>}</tr>
            </thead>
            <tbody>
              {order.measures.flatMap(mid => {
                const m = result.measures.find(x => x.id === mid)!;
                return order.groups.map(gid => {
                  const c = result.cells.find(x => x.measure === mid && x.group === gid);
                  if (!c) return null;
                  const sel = selected?.measure === mid && selected.group === gid;
                  return (
                    <tr key={`${mid}|${gid}`} data-testid="quant-row" data-low={c.low ? 'true' : 'false'} data-measure={mid} data-group={gid}
                      className={`${c.low ? 'text-gray-400 dark:text-gray-500' : ''} ${sel ? 'bg-amber-50 dark:bg-amber-950/40' : ''} ${onPick ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800' : ''}`}
                      title={c.low ? `Few reads (n = ${c.n}): shown, not hidden` : onPick ? 'Show these reads in the panel' : undefined}
                      onClick={() => onPick?.(mid, gid)}>
                      <td className="px-1.5 py-0.5">{m.label}<span className="text-ink-muted"> · {rawUnitOf(m, spec)}</span></td>
                      <td className="px-1.5"><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: groups.get(gid)?.color ?? '#999' }} />{groups.get(gid)?.title ?? gid}</td>
                      <td className="px-1.5 text-right tabular-nums">{c.n ?? '–'}{c.k != null ? ` (${Math.round(c.k)} in)` : ''}{c.low ? ' · few' : ''}</td>
                      <td className="px-1.5 text-right tabular-nums">{fmt(c.value)}{ci(c.lo, c.hi)}</td>
                      {spec.value === 'enrichment' && <td className="px-1.5 text-right tabular-nums">{m.baseline ? `${fmt(c.enrich)}${ci(c.enrichLo, c.enrichHi)}` : 'raw (no enrichment)'}</td>}
                      {spec.compare !== 'off' && <td className="px-1.5 text-right tabular-nums">{gid === result.reference ? 'reference' : `${fmt(c.cmp)}${ci(c.cmpLo, c.cmpHi)}`}</td>}
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="sr-only" data-testid="quant-axis">{result.measures.map(m => axisLabelOf(m, spec)).join(' | ')}</div>
      <span hidden data-testid="quant-shown" data-values={JSON.stringify(result.cells.map(c => shownOf(c, spec, result.measures.find(m => m.id === c.measure)!).v))} />
    </div>
  );
}

function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/tab-separated-values' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
