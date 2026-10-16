/**
 * The Variants panel's Combinations tab: the view's reads grouped by their alleles at the selected SNPs (or at every
 * informative SNP, linked ones collapsed to one tag each, or by HP tag): the observed combinations, local read-supported
 * allele patterns (not a phasing), with their read counts; rare ones merged into "Other". Two complementary
 * combinations holding most reads are labelled H1 and H2 (local labels of a diploid here), and the panel says so;
 * otherwise it says why not.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AlleleGrouping, SnpParams, SnpScan } from './api';
import { groupColour, groupingTitle, snpIdPosition } from './variantSplit';
import { AnalysisButton } from '../../components/controls/shared';
import { fetchGrouping } from './alleleActions';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { sameChrom } from '../../utils/chromAliases';
import { SV_COMBO_MAX, svOfFeature, svSelectionTitle } from './svFeatures';
import {
  saveGrouping, snpLabel, updateVariantsState, type ComboOptions, type NormalizedVariantsState,
} from './variantsState';

export function comboRequestKey(scan: SnpScan | null, combo: ComboOptions, selected: string[], svs: string[] = []): string {
  return JSON.stringify([scan?.scan_key ?? '', combo, combo.source === 'selected' ? selected : [], combo.source === 'selected' ? svs : []]);
}

export function CombosTab({ state, scan, duplicates, params, onSplit, onGroup, busy, notice }: {
  state: NormalizedVariantsState;
  scan: SnpScan | null;
  duplicates: boolean;
  params: SnpParams;
  onSplit: (grouping: AlleleGrouping, title: string) => void;
  onGroup: (grouping: AlleleGrouping, title: string) => void;
  busy: boolean;
  notice: string | null;
}) {
  const combo = state.combo;
  const selected = useMemo(() => state.selected.filter(id => scan?.snps.some(s => s.id === id)), [state.selected, scan]);
  // SVs selected as features (the SV row, the SVs tab) join the selected SNPs: patterns of SNPs and SVs together.
  const allSvs = useBrowserStore(useShallow(s => s.selectedFeatures.filter(f => f.kind === 'sv' && f.datasetId === scan?.dataset_id)));
  const svs = useMemo(() => allSvs.filter(f => !scan || !f.chrom || sameChrom(f.chrom, scan.region.chrom)), [allSvs, scan]);
  // More SVs than a combination takes: said, not some of them dropped quietly.
  const tooManySvs = svs.length > SV_COMBO_MAX;
  const svIds = svs.map(f => f.id);
  const [result, setResult] = useState<{ key: string; grouping: AlleleGrouping } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withSvs = combo.source === 'selected' && svs.length > 0;
  const key = comboRequestKey(scan, combo, selected, svIds);
  const lastKey = useRef('');
  const setCombo = (patch: Partial<ComboOptions>) => updateVariantsState({ combo: { ...combo, ...patch } });
  const canRun = Boolean(scan) && (combo.source !== 'selected' || selected.length > 0 || svs.length > 0) && (combo.source !== 'hp' || (scan?.hp.tagged ?? 0) > 0)
    && !(combo.source === 'selected' && tooManySvs);
  const describe = (id: string) => {
    const s = scan?.snps.find(x => x.id === id);
    return s ? snpLabel(s) : id;
  };

  useEffect(() => {
    if (!scan || !canRun || key === lastKey.current) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      fetchGrouping(scan, params, duplicates, {
        source: combo.source, snps: selected, partial: combo.partial, minFraction: combo.minFraction, autoPhase: combo.autoPhase,
        asCombination: true,
        ...(withSvs ? { svs: svs.map(f => ({ ...svOfFeature(f)!, name: f.label || f.id })) } : {}),
      }, ctrl.signal)
        .then(g => {
          if (ctrl.signal.aborted) return;
          lastKey.current = key;
          setLoading(false);
          setResult({ key, grouping: g });
          updateVariantsState({ grouping: saveGrouping(g, { ...combo, snps: selected }) });
        })
        .catch(err => {
          if (ctrl.signal.aborted) return;
          setLoading(false);
          setError(String((err as Error)?.message ?? err).replace(/^API error \d+: /, ''));
        });
    }, 300);
    return () => { window.clearTimeout(timer); if (!ctrl.signal.aborted) { ctrl.abort(); setLoading(false); } };
    // The request is keyed by `key` (scan, options, selection): new objects with the same content do not rerun it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, canRun, duplicates]);

  // Only the groups of this very request (scan, options, selection): a result for an earlier one is never shown or
  // used. What the session kept shows (without its read names) until this session finds the groups again.
  const grouping = canRun && result?.key === key ? result.grouping : null;
  const saved = state.grouping;
  const savedFits = Boolean(saved && canRun && saved.scan_key === scan?.scan_key && saved.request
    && saved.request.source === combo.source && saved.request.partial === combo.partial
    && saved.request.minFraction === combo.minFraction && saved.request.autoPhase === combo.autoPhase
    && (combo.source !== 'selected' || JSON.stringify(saved.request.snps) === JSON.stringify(selected)));
  const shown = grouping ?? (savedFits ? saved! : null);
  const title = shown
    ? (shown.svs?.length ? [selected.length ? groupingTitle({ ...shown, snps: selected }, 'selected', describe) : '', svSelectionTitle(svs)].filter(Boolean).join(' + ')
      : groupingTitle(shown, combo.source, describe))
    : '';
  const total = shown ? shown.groups.reduce((n, g) => n + g.count, 0) : 0;
  const live = grouping && grouping === shown;

  return (
    <div className="px-3 py-2 flex flex-col gap-2 text-[12px]" data-testid="variants-combos">
      {!scan && <div className="text-ink-muted">Find the SNPs in view first (SNPs tab).</div>}
      {scan && (
        <>
          <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <legend className="sr-only">Group the reads by</legend>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="radio" name="variants-combo-source" checked={combo.source === 'selected'} onChange={() => setCombo({ source: 'selected' })} data-testid="variants-source-selected" />
              Selected SNPs ({selected.length}){svs.length ? ` + SVs (${svs.length}: ${svSelectionTitle(svs)})` : ''}
            </label>
            <label className="flex items-center gap-1 cursor-pointer" title="Every SNP that passes the filters, with at least half the median depth; SNPs that go together (r² ≥ 0.8) count once (one tag SNP per linked block; lone SNPs only when fewer than two blocks have several). Partial coverage on: long reads seldom span them all.">
              <input type="radio" name="variants-combo-source" checked={combo.source === 'informative'} onChange={() => setCombo({ source: 'informative', partial: true })} data-testid="variants-source-informative" />
              All informative SNPs in view
            </label>
            <label className={`flex items-center gap-1 ${scan.hp.tagged ? 'cursor-pointer' : 'opacity-50'}`} title={scan.hp.tagged ? 'Reads by their HP tag (phased upstream)' : 'No read in view carries an HP tag'}>
              <input type="radio" name="variants-combo-source" disabled={!scan.hp.tagged} checked={combo.source === 'hp'} onChange={() => setCombo({ source: 'hp' })} data-testid="variants-source-hp" />
              HP tags{scan.hp.tagged ? ` (${scan.hp.tagged.toLocaleString()} reads)` : ''}
            </label>
          </fieldset>
          {combo.source !== 'hp' && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label className="flex items-center gap-1 cursor-pointer" title="Reads that miss some SNPs join the one combination they agree with (combinations are assembled from overlapping reads); off: only reads covering every SNP">
                <input type="checkbox" checked={combo.partial} onChange={e => setCombo({ partial: e.target.checked })} data-testid="variants-partial" />
                Partial coverage
              </label>
              <label className="flex items-center gap-1" title="Combinations with fewer reads (and fewer than 3) merge into Other">
                Merge under
                <input type="number" min={0} max={50} step={0.5} value={+(combo.minFraction * 100).toFixed(2)}
                  onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) setCombo({ minFraction: Math.max(0, Math.min(50, n)) / 100 }); }}
                  className="w-12 rounded border border-slate-300 bg-white px-1 py-0.5 tabular-nums dark:border-slate-600 dark:bg-slate-900" data-testid="variants-min-fraction" />
                % into Other
              </label>
              <label className="flex items-center gap-1 cursor-pointer" title="Two complementary combinations holding most reads: label them H1 / H2 (local labels for these SNPs in this view, not a phasing across loci)">
                <input type="checkbox" checked={combo.autoPhase} onChange={e => setCombo({ autoPhase: e.target.checked })} />
                Label H1 / H2 if diploid (local)
              </label>
            </div>
          )}
          {combo.source === 'selected' && selected.length === 0 && (
            <div className="text-ink-muted">Select SNPs in the SNPs tab or the SNP channel above the reads (shift-click for several), or use all informative SNPs.</div>
          )}
          {combo.source === 'selected' && tooManySvs && (
            <div className="text-red-600 dark:text-red-400" role="alert" data-testid="variants-combos-too-many-svs">
              {svs.length} SVs are selected: a combination takes {SV_COMBO_MAX} or fewer. Untick some in the SVs tab (or shift-click them in the SV row).
            </div>
          )}
          {loading && <div className="text-ink-muted" data-testid="variants-combos-loading">Grouping the reads…</div>}
          {error && <div className="text-red-600 dark:text-red-400" role="alert">{error}</div>}
          {shown && (
            <>
              <div className="text-[11px] text-ink-muted" data-testid="variants-combos-kind">
                Local read-supported allele patterns: the reads in view grouped by the alleles they carry. Not phasing.
              </div>
              <div className="text-ink-muted" data-testid="variants-combos-summary">
                {combo.source === 'hp'
                  ? `${shown.covering.toLocaleString()} of ${shown.n_reads.toLocaleString()} reads carry an HP tag.`
                  : `${title}: ${shown.distinct.toLocaleString()} distinct combination${shown.distinct === 1 ? '' : 's'}; `
                    + (shown.partial
                      ? `${(shown.placed ?? 0).toLocaleString()} of ${shown.n_reads.toLocaleString()} reads placed (${shown.covering.toLocaleString()} cover every SNP)`
                      : `${shown.covering.toLocaleString()} of ${shown.n_reads.toLocaleString()} reads cover every SNP`)
                    + (shown.threshold ? `; under ${shown.threshold.toLocaleString()} reads go in Other.` : '.')}
                {shown.tags && shown.tags.length > 0 && (
                  <span> {shown.tags.reduce((n, t) => n + t.members.length, 0).toLocaleString()} linked SNPs in {shown.tags.length} block{shown.tags.length === 1 ? '' : 's'} (one tag SNP each): {shown.tags.map(t => `${snpIdPosition(t.tag)} (${t.members.length})`).join(', ')}.</span>
                )}
              </div>
              {shown.phase && (
                <div data-testid="variants-phase" data-diploid={String(shown.phase.diploid)}
                  className={`rounded border px-2 py-1 text-[11px] ${shown.phase.diploid ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-200' : 'border-slate-200 text-ink-muted dark:border-slate-700'}`}>
                  {shown.phase.message}
                </div>
              )}
              <ul className="flex flex-col gap-0.5" data-testid="variants-combo-list">
                {shown.groups.filter(g => g.count > 0 || g.kind === 'combo').map(g => (
                  <li key={g.id} className="flex items-center gap-2" data-testid="variants-combo" data-kind={g.kind} data-count={g.count}>
                    <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: groupColour(g) }} />
                    <span className={`min-w-0 flex-1 truncate ${g.kind === 'combo' ? 'font-mono' : 'text-ink-muted'}`} title={g.label}>{g.label}</span>
                    <span className="w-24 h-1.5 rounded bg-slate-100 dark:bg-white/10 overflow-hidden" aria-hidden="true">
                      <span className="block h-full" style={{ width: `${total ? (100 * g.count) / total : 0}%`, background: groupColour(g) }} />
                    </span>
                    <span className="w-24 text-right tabular-nums">{g.count.toLocaleString()} reads</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-1.5">
                <AnalysisButton variant="soft" theme="rose" disabled={!live || busy} onClick={() => live && onSplit(grouping!, title)} data-testid="variants-combos-split"
                  title={live ? 'One read panel per combination (the top ones ticked)' : 'Finding the groups again…'}>
                  Split into panels…
                </AnalysisButton>
                <AnalysisButton disabled={!live || busy} onClick={() => live && onGroup(grouping!, title)} data-testid="variants-combos-group"
                  title="Colour this dataset's reads by combination (its read panel's clusters)">Group in this panel</AnalysisButton>
                {notice && <span className="text-ink-muted" data-testid="variants-combos-notice">{notice}</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
