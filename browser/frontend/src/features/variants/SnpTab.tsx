/**
 * The Variants panel's SNPs tab: the SNPs (and small indels) in the view, their counts, minor-allele fraction,
 * strands and (DAF data) whether they are DAF-safe; select some (click, shift-click for several, here or in the SNP
 * channel above the reads) and split the reads by their allele (one SNP: ref / alt) or combination (several).
 */
import { useRef, useState } from 'react';
import type { Snp, SnpParams, SnpScan } from './api';
import { AnalysisButton, AnalysisSelect } from '../../components/controls/shared';
import type { ScanStatus } from './useSnpScan';
import {
  nextSnpSelection, shownSnps, snpChange, tableSnpSelection, updateVariantsState, useVariantsStore, type NormalizedVariantsState,
} from './variantsState';

const MAX_ROWS = 400;

function pct(x: number): string {
  return `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
}

function NumberField({ label, value, step, min, max, onChange, title, testId }: {
  label: string; value: number; step: number; min: number; max: number; onChange: (n: number) => void; title?: string; testId?: string;
}) {
  return (
    <label className="flex items-center gap-1" title={title}>
      <span className="text-ink-muted">{label}</span>
      <input type="number" value={value} step={step} min={min} max={max} data-testid={testId}
        onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n))); }}
        className="w-14 rounded border border-slate-300 bg-white px-1 py-0.5 tabular-nums dark:border-slate-600 dark:bg-slate-900" />
    </label>
  );
}

export function scanSummary(scan: SnpScan, passingOnly: boolean): string {
  const shown = shownSnps(scan, passingOnly);
  const snvs = shown.filter(s => s.kind === 'snv').length;
  const indels = shown.length - snvs;
  const failing = scan.snps.length - scan.snps.filter(s => s.passes).length;
  const parts = [`${snvs.toLocaleString()} SNP${snvs === 1 ? '' : 's'}${indels ? ` and ${indels} small indel${indels === 1 ? '' : 's'}` : ''}`,
    `${scan.n_reads.toLocaleString()} reads (median depth ${Math.round(scan.median_depth).toLocaleString()})`];
  if (passingOnly && failing) parts.push(`${failing} more fail a filter`);
  if (scan.fixed) parts.push(`${scan.fixed.toLocaleString()} fixed difference${scan.fixed === 1 ? '' : 's'} from the reference (every read; not informative)`);
  return parts.join(' · ');
}

export function SnpTab({ state, scan, status, onScan, onCancel, onSplit, onGroup, busy, notice }: {
  state: NormalizedVariantsState;
  scan: SnpScan | null;
  status: ScanStatus;
  onScan: () => void;
  onCancel: () => void;
  onSplit: (ids: string[]) => void;
  onGroup: (ids: string[]) => void;
  busy: boolean;
  notice: string | null;
}) {
  const [showFilters, setShowFilters] = useState(false);
  // SNPs and small indels share the table: show both, or one kind (audit VAR-5).
  const [kind, setKind] = useState<'all' | 'snv' | 'indel'>('all');
  const anchor = useRef<string | null>(null);
  const hovered = useVariantsStore(s => s.hovered);
  const params = state.params;
  const setParams = (patch: Partial<SnpParams>) => updateVariantsState({ params: { ...params, ...patch } });
  const passing = shownSnps(scan, state.passingOnly);
  const rows = kind === 'all' ? passing : passing.filter(s => (kind === 'snv') === (s.kind === 'snv'));
  const nIndels = passing.filter(s => s.kind !== 'snv').length;
  const selected = state.selected.filter(id => scan?.snps.some(s => s.id === id));
  const daf = scan?.mode === 'daf';
  const strandNames = daf ? ['CT', 'GA'] : ['fwd', 'rev'];
  // Plain click: this one; Cmd/Ctrl: add or remove it; Shift: the range from the last clicked row.
  const click = (snp: Snp, e: React.MouseEvent | React.KeyboardEvent) => {
    const mode = e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'add' : 'single';
    updateVariantsState({ selected: tableSnpSelection(state.selected, snp.id, mode, rows.slice(0, MAX_ROWS).map(r => r.id), anchor.current) });
    anchor.current = snp.id;
  };
  const toggle = (snp: Snp) => { updateVariantsState({ selected: nextSnpSelection(state.selected, snp.id, true) }); anchor.current = snp.id; };

  return (
    <div className="px-3 py-2 flex flex-col gap-2 text-[12px]" data-testid="variants-snps">
      <div className="flex flex-wrap items-center gap-2">
        <AnalysisButton variant="primary" theme="rose" onClick={onScan} disabled={status.kind === 'scanning'} data-testid="variants-scan">
          {status.kind === 'scanning' ? 'Scanning…' : 'Find SNPs in view'}
        </AnalysisButton>
        {status.kind === 'scanning' && <AnalysisButton onClick={onCancel}>Cancel</AnalysisButton>}
        <label className="flex items-center gap-1 cursor-pointer" title="Scan again when the view changes (after a short pause; a scan still running is cancelled)">
          <input type="checkbox" checked={state.autoScan} onChange={e => updateVariantsState({ autoScan: e.target.checked })} data-testid="variants-auto" />
          Auto
        </label>
        <button type="button" className="text-ink-muted underline decoration-dotted" onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters}>
          Filters: MAF ≥ {params.min_maf}, depth ≥ {params.min_depth}{params.both_strands ? ', both strands' : ''}
        </button>
      </div>
      {showFilters && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border border-slate-200 p-2 dark:border-slate-700" data-testid="variants-filters">
          <NumberField label="MAF ≥" value={params.min_maf} step={0.01} min={0} max={0.5} onChange={v => setParams({ min_maf: v })}
            title="Minor-allele fraction: the second most common allele's share of the reads there" testId="variants-min-maf" />
          <NumberField label="Depth ≥" value={params.min_depth} step={1} min={1} max={100000} onChange={v => setParams({ min_depth: Math.round(v) })} testId="variants-min-depth" />
          <label className="flex items-center gap-1 cursor-pointer" title="The minor allele on both strands (2+ reads each; DAF data: both conversion directions)">
            <input type="checkbox" checked={params.both_strands} onChange={e => setParams({ both_strands: e.target.checked })} /> Both strands
          </label>
          <NumberField label="Base Q ≥" value={params.min_bq} step={1} min={0} max={93} onChange={v => setParams({ min_bq: Math.round(v) })} />
          <NumberField label="MapQ ≥" value={params.min_mapq} step={1} min={0} max={255} onChange={v => setParams({ min_mapq: Math.round(v) })} />
          <AnalysisSelect label="Data" value={params.mode} onChange={v => setParams({ mode: v })}
            title="DAF-seq (DddA / DddB): C>T and G>A on the deaminated strand look like SNPs; only DAF-safe calls pass. Auto: from the dataset's chemistry, else its reads."
            options={[{ value: 'auto', label: 'Auto' }, { value: 'basecall', label: 'Basecalls (m6A Fiber-seq)' }, { value: 'daf', label: 'DAF-seq (DAF-safe)' }]} />
        </div>
      )}
      {status.kind === 'too-wide' && <div className="text-ink-muted" data-testid="variants-too-wide">{status.message}</div>}
      {status.kind === 'error' && <div className="text-red-600 dark:text-red-400" role="alert">{status.message}</div>}
      {scan && (
        <div className="text-ink-muted" data-testid="variants-summary">
          {scanSummary(scan, state.passingOnly)}
          {scan.reference === 'none' && <span> · no reference loaded: the major allele stands in for “ref”</span>}
          {daf && scan.reference === 'none' && (
            <span className="text-amber-700 dark:text-amber-300" data-testid="variants-daf-noref"> · without the reference the reads’
              conversion directions are unknown, so no C&gt;T / G&gt;A call can be DAF-safe: load the genome</span>
          )}
          {daf
            ? <span className="text-amber-700 dark:text-amber-300" data-testid="variants-daf-note"> · DAF-seq: C&gt;T / G&gt;A calls must show on both conversion directions to be DAF-safe ({scan.directions.CT.toLocaleString()} CT, {scan.directions.GA.toLocaleString()} GA reads; {scan.daf_policy})</span>
            : <span> · basecalls ({scan.chemistry ?? 'Fiber-seq'})</span>}
          {scan.hp.tagged > 0 && <span> · {scan.hp.tagged.toLocaleString()} reads carry HP tags</span>}
        </div>
      )}
      {scan && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-ink-muted" data-testid="variants-selected">
            {selected.length ? `${selected.length} selected` : 'Select SNPs: click; Shift-click selects a range, ⌘/Ctrl-click adds one (in the SNP channel above the reads, Shift-click adds)'}
          </span>
          <AnalysisButton variant="soft" theme="rose" disabled={!selected.length || busy} onClick={() => onSplit(selected)} data-testid="variants-split"
            title={selected.length === 1 ? 'One read panel per allele: ref, alt (and other alleles)' : 'One read panel per combination of the selected SNPs\' alleles'}>
            Split into panels…
          </AnalysisButton>
          <AnalysisButton disabled={!selected.length || busy} onClick={() => onGroup(selected)} data-testid="variants-group"
            title="Colour this dataset's reads by allele (its read panel's clusters)">Group in this panel</AnalysisButton>
          {selected.length > 0 && <AnalysisButton onClick={() => updateVariantsState({ tab: 'combos', combo: { ...state.combo, source: 'selected' } })}>Combinations</AnalysisButton>}
          {selected.length > 0 && <AnalysisButton variant="quiet" onClick={() => updateVariantsState({ selected: [] })}>Clear</AnalysisButton>}
          <span className="ml-auto flex items-center gap-2">
            {(nIndels > 0 || kind !== 'all') && (
              <span data-testid="variants-kind-filter">
                <AnalysisSelect label="Show" value={kind} onChange={v => setKind(v as 'all' | 'snv' | 'indel')}
                  title="SNPs and small indels share the table: show both, or one kind"
                  options={[{ value: 'all', label: `All (${passing.length})` }, { value: 'snv', label: `SNPs (${passing.length - nIndels})` }, { value: 'indel', label: `Indels (${nIndels})` }]} />
              </span>
            )}
            <label className="flex items-center gap-1 cursor-pointer text-ink-muted">
              <input type="checkbox" checked={!state.passingOnly} onChange={e => updateVariantsState({ passingOnly: !e.target.checked })} data-testid="variants-show-failing" />
              Show calls failing a filter
            </label>
          </span>
        </div>
      )}
      {notice && <div className="text-ink-muted" data-testid="variants-notice">{notice}</div>}
      {scan && rows.length === 0 && <div className="text-ink-muted">{passing.length ? `No ${kind === 'indel' ? 'indels' : 'SNPs'} in this view: show All.` : 'No SNPs pass the filters in this view.'}</div>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left tabular-nums text-[11px]" data-testid="variants-table">
            <thead className="text-ink-muted">
              <tr>
                <th className="w-5" />
                <th className="font-medium">Position</th>
                <th className="font-medium">Change</th>
                <th className="font-medium" title="Reads with each allele (- deletion)">Counts</th>
                <th className="font-medium">Depth</th>
                <th className="font-medium" title="Minor-allele fraction">MAF</th>
                <th className="font-medium" title={daf ? 'Minor-allele reads in CT / GA conversion-direction reads' : 'Minor-allele reads on forward / reverse reads'}>
                  {strandNames.join(' / ')}
                </th>
                {daf && <th className="font-medium">DAF-safe</th>}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map(snp => {
                const isSel = state.selected.includes(snp.id);
                const s0 = snp.strands[strandNames[0]], s1 = snp.strands[strandNames[1]];
                return (
                  <tr key={snp.id} data-testid="variants-row" data-snp={snp.id} data-selected={isSel || undefined}
                    data-hovered={hovered === snp.id || undefined} tabIndex={0} aria-selected={isSel}
                    className={`cursor-pointer border-t border-slate-200 dark:border-slate-700 ${isSel ? 'bg-rose-50 dark:bg-rose-900/20' : hovered === snp.id ? 'bg-slate-50 dark:bg-white/5' : ''} ${snp.passes ? '' : 'text-ink-muted'}`}
                    onClick={e => click(snp, e)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(snp, e); } }}
                    onMouseEnter={() => useVariantsStore.getState().setHovered(snp.id)}
                    onMouseLeave={() => useVariantsStore.getState().setHovered(null)}>
                    <td onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={isSel} onChange={() => toggle(snp)} aria-label={`Select ${snp.id}`} />
                    </td>
                    <td>{(snp.pos + 1).toLocaleString()}</td>
                    <td className="font-mono">{snpChange(snp)}{snp.kind !== 'snv' && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-600 dark:bg-white/10 dark:text-slate-300">indel</span>}</td>
                    <td className="font-mono">{Object.entries(snp.counts).map(([a, n]) => `${a}:${n.toLocaleString()}`).join(' ')}</td>
                    <td>{snp.depth.toLocaleString()}{snp.low_depth && <span className="text-amber-600" title="Under half the view's median depth (a repeat, a breakpoint?)"> ▾</span>}</td>
                    <td>{pct(snp.maf)}</td>
                    <td title={snp.strand_balance == null ? undefined : `${pct(snp.strand_balance)} of the minor allele on ${strandNames[0]}`}
                      className={snp.both_strands ? '' : 'text-amber-700 dark:text-amber-300'}>
                      {s0?.minor ?? 0} / {s1?.minor ?? 0}{snp.both_strands ? '' : ' (one strand)'}
                    </td>
                    {daf && (
                      <td title={snp.daf_reason} data-testid="variants-daf-safe" data-safe={String(snp.daf_safe)}>
                        {snp.daf_safe === true ? <span className="text-emerald-700 dark:text-emerald-300">safe</span>
                          : snp.daf_safe === false ? <span className="text-amber-700 dark:text-amber-300">deamination?</span> : '—'}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > MAX_ROWS && <div className="text-ink-muted mt-1">First {MAX_ROWS} of {rows.length.toLocaleString()} shown; zoom in for the rest.</div>}
        </div>
      )}
      {!scan && status.kind !== 'scanning' && status.kind !== 'too-wide' && status.kind !== 'error' && (
        <div className="text-ink-muted">Find the SNPs in the view: allele counts per position from the reads (bases and alignments), minor-allele fraction, strands and base quality. Then split the reads by an allele, or by the combination of several SNPs’ alleles (local read-supported allele patterns, not phasing).</div>
      )}
    </div>
  );
}

