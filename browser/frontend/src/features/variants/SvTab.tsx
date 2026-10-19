import { selectNativeDifference } from '../differences/selection';
import { svScanTarget, svSourcePanel, variantScanIdentity } from './scanTarget';
/**
 * The Variants panel's SVs tab: the deletion and insertion clusters in view (as the SV band clusters them), with the
 * actions the reads' SV menu has (split the reads by the SV's allele, in this panel or into panels; open an insertion
 * in the lens), and which SNP alleles travel with each SV (its carriers vs its reference reads at every SNP).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { svLinkage, svsInView, type SnpParams, type SvClusterInView, type SvLinkage } from './api';
import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { splitBySv } from '../../utils/svAlleleSplit';
import { REQUIRE_ALL_SVS_HELP, SV_GROUP_SPLIT_NOTE, groupBySelectedSvs, splitBySelectedSvs, goToSvView, svComboView, svFeatureInView, svFeatureIs, svSelectionPlace, svSelectionTitle, toggleSvFeature } from './svFeatures';
import { svAlleleLabel } from '../../components/tracks/read-track/svDrawing';
import { targetForCluster } from '../insertion/insertionLensModel';
import { openInsertionLens } from '../insertion/insertionLensTarget';
import { AnalysisButton, CheckboxRow } from '../../components/controls/shared';
import { panelForDataset } from './useSnpScan';
import { updateVariantsState, useVariantsPanelState } from './variantsState';
import { formatShare } from '../../utils/denominators';
import { formatPctInterval } from '../../utils/proportionInterval';

function pct(x: number) { return `${Math.round(x * 100)}%`; }

/**
 * "3,267 carriers of 3,600 informative reads · 91% (95% CI 90–92%)" (round 2, N17: "3,267 of 3,600 carriers" called
 * the informative reads carriers).
 */
export function svCarriersText(carriers: number, informative: number): string {
  return `${carriers.toLocaleString()} confirmed of ${informative.toLocaleString()} informative read${informative === 1 ? '' : 's'} · ${formatPctInterval(carriers, informative)}`;
}

/** SV calls with fewer carriers than this are weak: folded under "Show weak calls" (audit VAR-4). */
export const WEAK_SV_CARRIERS = 3;

/** The calls listed, and the weak ones folded away (unless shown, or selected). */
export function splitWeakSvs<T extends { support: number; putative?: number; ambiguous?: number; conflicting?: number }>(clusters: T[], showWeak: boolean, isSelected: (c: T) => boolean = () => false, includePutative = true, includeAmbiguous = false, includeConflicting = false): { shown: T[]; weak: number } {
  const weak = clusters.filter(c => c.support + (includePutative ? c.putative ?? 0 : 0) + (includeAmbiguous ? c.ambiguous ?? 0 : 0) + (includeConflicting ? c.conflicting ?? 0 : 0) < WEAK_SV_CARRIERS && !isSelected(c));
  return { shown: showWeak ? clusters : clusters.filter(c => !weak.includes(c)), weak: weak.length };
}


export function SvTab({ datasetId: chosen, params, duplicates }: { datasetId: string; params: SnpParams; duplicates: boolean }) {
  useSplitPanelStore(s => s.reads);
  // After "Split into panels" the SVs of all the reads the split was made from (scanTarget.ts svSourcePanel): the
  // selected Reference panel has no carriers, and insert-expanded Carriers are a dataset without the insertion.
  const targetKey = useBrowserStore(s => JSON.stringify(svScanTarget(s, chosen)));
  const target = JSON.parse(targetKey) as ReturnType<typeof svScanTarget>;
  const { chrom, start, end, datasetId } = target;
  const sourcePanelId = useBrowserStore(s => svSourcePanel(s, chosen)?.panelId ?? null);
  const identity = useBrowserStore(s => variantScanIdentity(s, datasetId));
  const svMinLen = useBrowserStore(s => s.svMinLen);
  const [clusters, setClusters] = useState<SvClusterInView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const savedPolicy = useVariantsPanelState();
  const includePutative = savedPolicy?.includePutative !== false;
  const conflictOptions = useBrowserStore(s => s.svConflictOptions);
  const includeConflicting = savedPolicy?.includeConflicting === true;
  const includeAmbiguous = savedPolicy?.includeAmbiguous === true;
  const [linkage, setLinkage] = useState<Record<string, SvLinkage | 'loading' | { error: string }>>({});
  const [refresh, setRefresh] = useState(0);
  const evidencePolicy = JSON.stringify([includePutative, includeAmbiguous, includeConflicting, conflictOptions]);
  const currentEvidencePolicy = useRef(evidencePolicy);
  currentEvidencePolicy.current = evidencePolicy;
  useEffect(() => { setLinkage({}); }, [evidencePolicy]);
  // What the listed SVs were found for: while a refresh for another view (or dataset, or setting) is on its way, the
  // rows are of the old view and their actions would act on it under the new one: shown, but greyed and not
  // actionable (round 2, N16).
  const viewKey = JSON.stringify([targetKey, identity, svMinLen, duplicates, conflictOptions]);
  const currentView = useRef(viewKey);
  currentView.current = viewKey;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const stale = clusters !== null && loadedFor !== viewKey;
  // SVs selected as features (here or shift-click in the SV row): the combined split.
  const selectedSvs = useBrowserStore(useShallow(s => s.selectedFeatures.filter(f => f.kind === 'sv' && f.datasetId === datasetId)));
  const isSelected = (c: SvClusterInView) => selectedSvs.some(f => svFeatureIs(f, c, datasetId, chrom));
  // Selected SVs away from this view (navigated off, round 3: R13/B6): said with where they are, Go there / Clear, and
  // Group / Split disabled (they would read no informative reads here).
  // (The view the genotypes are read in, svGenotypeGrouping's: the main view, or the dataset panel's own.)
  useBrowserStore(s => s.panels);
  const comboView = svComboView(datasetId);
  const offView = selectedSvs.filter(f => !svFeatureInView(f, comboView));
  const place = offView.length ? svSelectionPlace(selectedSvs, comboView.end - comboView.start) : null;
  const canAct = selectedSvs.length > 0 && offView.length === 0;
  // "Require calls at all selected SVs" (on by default) = no partial genotypes.
  const [requireAll, setRequireAll] = useState(true);
  const partial = !requireAll;
  const [showWeak, setShowWeak] = useState(false);

  useEffect(() => {
    if (!datasetId || !chrom) return;
    const ctrl = new AbortController();
    setError(null);
    const timer = window.setTimeout(() => {
      svsInView(target, svMinLen, duplicates, ctrl.signal)
        .then(r => { if (!ctrl.signal.aborted) { setClusters(r.clusters); setLinkage({}); setLoadedFor(viewKey); } })
        .catch(err => { if (!ctrl.signal.aborted) setError(String((err as Error)?.message ?? err).replace(/^API error \d+: /, '')); });
    }, 400);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
    // (viewKey is these.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, refresh]);

  // Weak calls (fewer than WEAK_SV_CARRIERS carriers; aligner jitter around a real SV, mostly) fold away unless shown or ticked.
  const listed = clusters ? splitWeakSvs(clusters, showWeak, isSelected, includePutative, includeAmbiguous, includeConflicting) : { shown: [] as SvClusterInView[], weak: 0 };
  const panel = () => {
    const { panels } = useBrowserStore.getState();
    return (sourcePanelId ? panels.find(p => p.id === sourcePanelId) : undefined) ?? panelForDataset(panels, datasetId);
  };
  const splitHere = useCallback(async (c: SvClusterInView, thenPanels: boolean) => {
    const p = panel();
    if (!p) { setNotice('Open a read panel of this dataset first.'); return; }
    if (!thenPanels && p.collapsedBySplitGroup) { setNotice(SV_GROUP_SPLIT_NOTE); return; }
    const stateKey = p.stateKey ?? p.datasetId ?? p.id;
    try {
      const def = await splitBySv({ stateKey, datasetId, chrom, viewStart: start, viewEnd: end, includePutative, includeAmbiguous, includeConflicting }, c);
      if (thenPanels) {
        useSplitPanelStore.getState().request({ kind: 'frozen', panelId: p.id, title: def.label }, [p.id]);
      } else {
        setNotice(`Grouped by ${def.label}: ${def.counts[0].toLocaleString()} carriers, ${def.counts[1].toLocaleString()} reference, ${def.counts[2].toLocaleString()} not informative (all reads in view).`);
      }
    } catch (err) {
      setNotice(`Could not split the reads: ${String((err as Error)?.message ?? err)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, sourcePanelId, chrom, start, end, includePutative, includeAmbiguous, includeConflicting]);

  const loadLinkage = (c: SvClusterInView) => {
    const policy = evidencePolicy;
    setLinkage(l => ({ ...l, [c.id]: 'loading' }));
    svLinkage(target, params, duplicates, c, undefined, { includePutative, includeAmbiguous, includeConflicting })
      .then(r => { if (currentView.current === viewKey && currentEvidencePolicy.current === policy) setLinkage(l => ({ ...l, [c.id]: r })); })
      .catch(err => { if (currentView.current === viewKey && currentEvidencePolicy.current === policy) setLinkage(l => ({ ...l, [c.id]: { error: String((err as Error)?.message ?? err).replace(/^API error \d+: /, '') } })); });
  };

  return (
    <div className="px-3 py-2 flex flex-col gap-2 text-[12px]" data-testid="variants-svs">
      <label><input type="checkbox" checked={includePutative} onChange={e => updateVariantsState({ includePutative: e.target.checked })} /> Include putative carriers (uncheck for confirmed only)</label>
      <label title="A substantial part of the supporting clip aligns elsewhere"><input type="checkbox" checked={includeConflicting} onChange={e => updateVariantsState({ includeConflicting: e.target.checked })} /> Include conflicting carriers (clip aligns elsewhere)</label>
      <label><input type="checkbox" checked={includeAmbiguous} onChange={e => updateVariantsState({ includeAmbiguous: e.target.checked })} /> Include ambiguous carriers</label>
      <div className="flex items-center gap-2">
        <span className="text-ink-muted flex-1">SVs of {svMinLen.toLocaleString()} bp or more in {chrom}:{Math.round(start).toLocaleString()}–{Math.round(end).toLocaleString()}
          {sourcePanelId && <span data-testid="variants-svs-split-source"> · all reads of the split panels</span>}</span>
        <AnalysisButton onClick={() => setRefresh(n => n + 1)}>Refresh</AnalysisButton>
      </div>
      {error && <div className="text-red-600 dark:text-red-400" role="alert">{error}</div>}
      {!clusters && !error && <div className="text-ink-muted">Looking for SVs in view…</div>}
      {stale && !error && (
        <div className="text-ink-muted" role="status" data-testid="variants-svs-refreshing">
          Finding the SVs of this view… (the list below is of the previous view)
        </div>
      )}
      {clusters && clusters.length === 0 && <div className="text-ink-muted">No SVs in view.</div>}
      {/* The combined split's bar: always there (its controls disabled until an SV is ticked), so ticking the first SV
          never moves the rows under the pointer (audit Top 7 / bug 5). Notices go in its status line, for the same reason. */}
      <div className="flex flex-col gap-1 rounded border border-violet-200 bg-violet-50/60 px-2 py-1 dark:border-violet-800/50 dark:bg-violet-900/20"
        data-testid="variants-sv-combo" data-selected={selectedSvs.length}>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* The whole selection on a line of its own, wrapped rather than cut ("Selected: INS 9.2k + I…", round 3:
              R14b); the buttons below it, where they always are. */}
          <span className="w-full break-words" data-testid="variants-sv-combo-title"
            title={selectedSvs.length ? `Selected: ${svSelectionTitle(selectedSvs)}` : undefined}>
            {selectedSvs.length
              ? <>Selected: <span className="font-medium">{svSelectionTitle(selectedSvs)}</span></>
              : <span className="text-ink-muted" title="Tick 2–4 SVs below to group or split the reads by their combined genotype">Tick 2–4 SVs below</span>}
          </span>
          <AnalysisButton disabled={!canAct} onClick={() => void groupBySelectedSvs(selectedSvs, partial, { includePutative, includeAmbiguous, includeConflicting }).then(e => setNotice(e ?? `Grouped the reads by ${svSelectionTitle(selectedSvs)}.`))}
            title={offView.length ? 'The selected SVs are not in this view: Go there first' : undefined}
            data-testid="variants-sv-combo-group">Group in this panel</AnalysisButton>
          <AnalysisButton variant="soft" theme="rose" disabled={!canAct} onClick={() => void splitBySelectedSvs(selectedSvs, partial, { includePutative, includeAmbiguous, includeConflicting }).then(e => { if (e) setNotice(e); })}
            title={offView.length ? 'The selected SVs are not in this view: Go there first' : undefined}
            data-testid="variants-sv-combo-split">Split into panels…</AnalysisButton>
        </div>
        {place && (
          <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-amber-800 dark:text-amber-200" role="status" data-testid="variants-sv-offview">
            <span>
              {offView.length === selectedSvs.length ? 'selected' : `${svSelectionTitle(offView)} selected`} at <span className="tabular-nums">{place.label}</span> · not in view
            </span>
            <span className="whitespace-nowrap">
              <span aria-hidden="true">· </span>
              <button type="button" className="underline decoration-dotted hover:text-ink" data-testid="variants-sv-offview-go"
                onClick={() => goToSvView(datasetId, place.view)}>
                Go there
              </button>
              <span aria-hidden="true"> / </span>
              <button type="button" className="underline decoration-dotted hover:text-ink" data-testid="variants-sv-offview-clear"
                onClick={() => { const st = useBrowserStore.getState(); st.setSelectedFeatures(st.selectedFeatures.filter(f => !selectedSvs.includes(f))); setNotice(null); }}>
                Clear
              </button>
            </span>
          </div>
        )}
        <CheckboxRow checked={requireAll} onChange={setRequireAll} title={REQUIRE_ALL_SVS_HELP} testId="variants-sv-require-all" className="text-[11px]"
          label={<span className="font-medium">Require calls at all selected SVs</span>}
          description={requireAll ? 'Reads that miss one of them go to Not informative.' : 'Reads called at some of them are grouped too, with ? at the others.'} />
        <div className="min-h-[16px] break-words text-[11px] text-ink-muted" data-testid="variants-svs-notice" role="status">{notice ?? ''}</div>
      </div>
      {clusters && clusters.length > 0 && (
        <ul className="flex flex-col divide-y divide-slate-200 dark:divide-slate-700" data-testid="variants-sv-list"
          data-stale={stale ? 'true' : undefined} aria-busy={stale || undefined}
          aria-label={stale ? 'SVs of the previous view (refreshing)' : "SVs in view: tick to select for a combined split; each row's buttons act on that SV"}>
          {listed.shown.map(c => {
            const link = linkage[c.id];
            const label = svAlleleLabel(c.t, c.ref, c.len, chrom);
            return (
              <li key={c.id} className="py-1.5" data-testid="variants-sv" data-sv={`${c.t}:${c.ref}:${c.len}`} data-weak={c.support + (includePutative ? c.putative ?? 0 : 0) + (includeAmbiguous ? c.ambiguous ?? 0 : 0) + (includeConflicting ? c.conflicting ?? 0 : 0) < WEAK_SV_CARRIERS || undefined}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {/* The whole label (box, name, counts) ticks it, not only the box (audit Top 6 / VAR-2); the buttons stay out of it. */}
                  <CheckboxRow checked={isSelected(c)} onChange={() => toggleSvFeature(c, datasetId, chrom)} testId="variants-sv-select" className="min-w-0" disabled={stale}
                    title="Select for a combined split (2–4 SVs): the bar above, or the feature chip in the toolbar, groups or splits the reads by their genotype at the selected SVs; Combinations adds SNPs"
                    label={<>
                      <span className="font-medium" data-testid="variants-sv-name">{label}</span>{' '}
                      <span className="text-ink-secondary tabular-nums" data-testid="variants-sv-carriers"
                        title={`${formatShare(c.support, c.informative, 'informative reads carry it')} (all reads in view: carriers plus reads spanning it without it). The SV row above the reads counts the loaded reads only.`}>
                        {svCarriersText(c.support, c.informative)} · {c.putative ?? 0} putative · <span title="Supporting clip aligns elsewhere; excluded by default">{c.conflicting ?? 0} conflicting</span> · {c.ambiguous ?? 0} ambiguous
                      </span>
                    </>} />
                  <span className="flex-1" />
                  <AnalysisButton disabled={stale} onClick={() => void splitHere(c, false)} title="Colour this dataset's reads in view by allele, in its read panel: carriers, reference, not informative">Group in this panel</AnalysisButton>
                  <AnalysisButton disabled={stale} onClick={() => void splitHere(c, true)} title="One read panel per allele group (carriers, reference…)">Split into panels…</AnalysisButton>
                  <AnalysisButton disabled={stale} onClick={() => selectNativeDifference(c, datasetId, chrom, panel()?.id)}>Inspect difference</AnalysisButton>
                  {c.t === 'I' && (
                    <AnalysisButton variant="soft" theme="violet" data-testid="variants-sv-lens" disabled={stale}
                      onClick={() => openInsertionLens(targetForCluster(c, datasetId, chrom))}>
                      Open in lens
                    </AnalysisButton>
                  )}
                  <AnalysisButton variant="soft" theme="rose" onClick={() => loadLinkage(c)} disabled={stale || link === 'loading'} data-testid="variants-sv-linkage"
                    title="Which SNP alleles the carriers have and the reference reads don't (or the other way round)">
                    SNP alleles
                  </AnalysisButton>
                </div>
                {link === 'loading' && <div className="text-ink-muted mt-1">Comparing the carriers' and reference reads' SNP alleles…</div>}
                {link && typeof link === 'object' && 'error' in link && <div className="text-red-600 dark:text-red-400 mt-1">{link.error}</div>}
                {link && typeof link === 'object' && 'snps' in link && (
                  <div className="mt-1 rounded border border-slate-200 p-1.5 dark:border-slate-700" data-testid="variants-sv-linkage-result">
                    <div className="text-ink-muted">
                      {link.counts.carriers.toLocaleString()} carriers{link.carrier_evidence_counts && <> ({link.carrier_evidence_counts.confirmed} confirmed, {link.carrier_evidence_counts.putative} putative, {link.carrier_evidence_counts.conflicting ?? 0} conflicting (clip aligns elsewhere), {link.carrier_evidence_counts.ambiguous} ambiguous)</>}, {link.counts.reference.toLocaleString()} reference reads:
                      {' '}<span className="font-medium text-ink" data-testid="variants-sv-linked">{link.linked.toLocaleString()} of {link.tested.toLocaleString()} SNPs</span>
                      {' '}separate them (minor allele in ≥ 90% of one group and ≤ 10% of the other).
                    </div>
                    {link.snps.length > 0 && (
                      <table className="mt-1 w-full text-left tabular-nums text-[11px]">
                        <thead className="text-ink-muted"><tr><th className="font-medium">SNP</th><th className="font-medium">Minor allele</th><th className="font-medium">Carriers</th><th className="font-medium">Reference</th></tr></thead>
                        <tbody>
                          {link.snps.slice(0, 6).map(s => (
                            <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                              <td>{(s.pos + 1).toLocaleString()}</td>
                              <td className="font-mono">{s.alleles[1]}</td>
                              <td>{pct(s.carriers.fraction)} <span className="text-ink-muted">of {s.carriers.n.toLocaleString()}</span></td>
                              <td>{pct(s.reference.fraction)} <span className="text-ink-muted">of {s.reference.n.toLocaleString()}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {link.linked > 0 && (
                      <AnalysisButton className="mt-1" disabled={stale} onClick={() => updateVariantsState({
                        selected: link.snps.filter(s => s.linked).slice(0, 4).map(s => s.id), tab: 'snps',
                      })}>Select the linked SNPs (up to 4)</AnalysisButton>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {clusters && listed.weak > 0 && (
        <button type="button" className="self-start text-[11px] text-ink-muted underline decoration-dotted" onClick={() => setShowWeak(v => !v)}
          aria-expanded={showWeak} data-testid="variants-sv-weak-toggle">
          {showWeak ? 'Hide' : 'Show'} {listed.weak} weak call{listed.weak === 1 ? '' : 's'} (fewer than {WEAK_SV_CARRIERS} carriers)
        </button>
      )}
    </div>
  );
}
