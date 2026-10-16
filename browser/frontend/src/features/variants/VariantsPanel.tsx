import { datasetPanelView } from '../../utils/panelScope';
/**
 * The Variants panel: SNPs, SNP combinations (local read-supported allele patterns) and SVs for the
 * view, and the reads split by allele. The insertion lens is its own panel ('insertion-lens'); the SVs tab opens it.
 */
import { useEffect, useMemo, useState } from 'react';
import { forgetPanelMemory, restorePanelFields } from '../panelMemory';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import type { AlleleGrouping, Snp } from './api';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import { AnalysisButton, AnalysisPanelShell, AnalysisSelect } from '../../components/controls/shared';
import { HowItWorks } from '../../components/ui/HowItWorks';
import { APP_COMMAND_INFO, hasAppCommand, runAppCommand, type AppCommandName } from '../../utils/appCommands';
import { selectionTitle } from './variantSplit';
import { fetchGrouping, groupDatasetPanel } from './alleleActions';
import { CombosTab } from './CombosTab';
import { SnpTab } from './SnpTab';
import { SvTab } from './SvTab';
import { chooseDataset, useSnpScan, variantDatasets } from './useSnpScan';
import { VariantSplitDialog } from './VariantSplitDialog';
import {
  normalizeVariantsState, scanFor, snpLabel, updateVariantsState, useVariantsPanelState, useVariantsStore, type VariantsTab,
} from './variantsState';

const TABS: { key: VariantsTab; label: string }[] = [
  { key: 'snps', label: 'SNPs' },
  { key: 'combos', label: 'Combinations' },
  { key: 'svs', label: 'SVs' },
];

/** A command this page can run (registered, and available here: no Library on a public server). */
function commandOffered(name: AppCommandName): boolean {
  return hasAppCommand(name) && (APP_COMMAND_INFO[name]?.available?.() ?? true);
}

/** What the panel's calls and patterns are and are not (folded: one line until opened). */
const VARIANTS_LIMITATIONS = [
  'Allele combinations are local read-supported patterns: reads that span the selected sites, grouped by the alleles they carry. They are not a phasing of the genome, and reads that miss a site fall in "Not informative" (or carry "?" with partial on).',
  'The H1/H2 labels of a two-pattern diploid result are local too: they name the two patterns in this view, not haplotypes shared with any other locus.',
  'SNP calls come from the reads in view (no population prior): low depth, strand bias and, on DAF-seq data, deamination-like changes are flagged, not removed.',
  'Splits of more than 8 groups ask first, and at most 16 open.',
];

function VariantsLimitationsNote() {
  return (
    <div className="w-full" data-testid="variants-limitations">
      <HowItWorks summary="Known limitations" testId="variants-limitations-details">
        <ul className="list-disc space-y-0.5 pl-4">
          {VARIANTS_LIMITATIONS.map(text => <li key={text}>{text}</li>)}
        </ul>
      </HowItWorks>
    </div>
  );
}

export function VariantsPanel({ isFullView }: { isFullView?: boolean }) {
  const raw = useVariantsPanelState();
  const state = useMemo(() => normalizeVariantsState(raw), [raw]);
  // Opened again: its last tab, scan and selection (audit VAR-7), while the dataset it scanned is open. Clear forgets.
  useEffect(() => {
    if (raw) return;
    restorePanelFields('variants');
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const clearAnalysis = () => {
    forgetPanelMemory('variants');
    reset();
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.contentType === 'variants' ? { ...p, variants: undefined } : p)) }));
  };
  const tab: VariantsTab = state.tab;

  const { panels, datasets } = useBrowserStore(useShallow(s => ({ panels: s.panels, datasets: s.datasets })));
  const choices = useMemo(() => variantDatasets(panels, datasets), [panels, datasets]);
  const datasetId = chooseDataset(state.datasetId, choices);
  const { target, status, scanNow, cancel, reset, duplicates, scanKey } = useSnpScan({
    datasetId, params: state.params, autoScan: state.autoScan, active: tab === 'snps' || tab === 'combos',
  });
  const store = useVariantsStore(useShallow(s => ({ scans: s.scans, latest: s.latest })));
  const scan = useMemo(() => {
    // (The selected panel's own scan when it shows some of the reads: a split panel's.)
    const s = status.kind === 'done' ? status.scan : scanFor(datasetId, store, raw, target?.readIds ? target.panelKey : undefined);
    return s && s.dataset_id === datasetId ? s : null;
  }, [status, datasetId, store, raw, target]);

  // Is the scan of the view on screen? (Its region is the view's, as useSnpScan asks for it.)
  const view = useBrowserStore(useShallow(s => { const v = datasetPanelView(s, datasetId); return { chrom: v.chrom, start: v.start, end: v.end, genome: v.genome }; }));
  // (On every tab: the SVs tab said "Last SNP scan:" of a scan of this very view, round 3: R14d.)
  const scanIsView = Boolean(scan && (!scan.clientKey || scan.clientKey === scanKey) && scan.region.chrom === view.chrom
    && Math.abs(scan.region.start - Math.floor(view.start)) <= 1 && Math.abs(scan.region.end - Math.ceil(view.end)) <= 1);

  // (With the scan's calls: which allele of each SNP is the reference, for the split panels' SNP channel.)
  const [split, setSplit] = useState<{ grouping: AlleleGrouping; title: string; snps?: Snp[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const say = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(n => (n === text ? null : n)), 6000);
  };
  const describe = (id: string) => {
    const s = scan?.snps.find(x => x.id === id);
    return s ? snpLabel(s, scan?.region.chrom) : id;
  };

  /** Selected SNPs: one splits ref / alt, several by their combination. */
  const groupSelected = async (ids: string[], then: 'split' | 'group') => {
    if (!scan || !ids.length) return;
    setBusy(true);
    try {
      const grouping = await fetchGrouping(scan, state.params, duplicates, {
        source: 'selected', snps: ids, partial: state.combo.partial, minFraction: state.combo.minFraction,
        autoPhase: state.combo.autoPhase, asCombination: ids.length > 1,
      });
      const title = selectionTitle(ids, describe);
      if (then === 'split') setSplit({ grouping, title, snps: scan.snps });
      else say(groupDatasetPanel(grouping, title));
    } catch (err) {
      say(`Could not group the reads: ${String((err as Error)?.message ?? err).replace(/^API error \d+: /, '')}`);
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-[12px]">
      <VariantsLimitationsNote />
      {choices.length > 1 ? (
        <AnalysisSelect label="Dataset" value={datasetId} onChange={v => updateVariantsState({ datasetId: String(v) })}
          options={choices.map(d => ({ value: d.id, label: getDatasetDisplayLabel(d) }))} />
      ) : choices.length === 1 ? (
        <span className="text-ink-muted">{getDatasetDisplayLabel(choices[0])}</span>
      ) : (
        // The one empty-state wording (round 3, R12), with the ways to do it.
        <span className="flex w-full flex-wrap items-center gap-1.5" data-testid="variants-empty">
          <span className="text-ink-muted">Open a BAM or choose one in the Library</span>
          {commandOffered('open-file') && (
            <AnalysisButton onClick={() => runAppCommand('open-file')} data-testid="variants-empty-open">Open…</AnalysisButton>
          )}
          {commandOffered('library') && (
            <AnalysisButton variant="soft" onClick={() => runAppCommand('library')} data-testid="variants-empty-library">Library</AnalysisButton>
          )}
        </span>
      )}
      {choices.length > 0 && (
        <span className="text-ink-muted" data-testid="variants-scope"
          title="Uses this dataset's selected panel: its region, reference and read group. With no selection, uses its active panel.">
          · selected panel region
        </span>
      )}
      {scan && (
        // The SNP scan's region and time, named for what it is: of this region (current), or the last one, of another
        // view (round 2, N16; round 3, R14d: "Last SNP scan" read as stale while it was current).
        <span className="text-ink-muted tabular-nums" data-testid="variants-region" data-stale={scanIsView ? undefined : 'true'}
          title={scanIsView ? 'The region the SNPs were found in (this view)' : 'The SNPs and combinations are from this earlier scan of another view; the SNPs tab scans this view'}>
          · {scanIsView ? 'SNP scan for this region: ' : 'Last SNP scan (another view): '}{scan.region.chrom}:{(scan.region.start + 1).toLocaleString()}–{scan.region.end.toLocaleString()}
          {scan.cached ? ' (cached)' : scan.elapsed_ms ? ` (${(scan.elapsed_ms / 1000).toFixed(1)} s)` : ''}
        </span>
      )}
      {raw && (scan || state.selected.length > 0) && (
        <button type="button" className="ml-auto text-[11px] text-ink-secondary underline decoration-dotted" onClick={clearAnalysis}
          data-testid="variants-clear" title="Clear the scan, the selection and the combinations (closing the panel keeps them for its next open)">
          Clear
        </button>
      )}
    </div>
  );

  return (
    <AnalysisPanelShell
      tabs={TABS}
      activeTab={tab}
      onTabChange={t => updateVariantsState({ tab: t })}
      theme="rose"
      className="flex flex-col h-full"
      tabBarClassName="px-2"
      bodyMode="fill"
      isFullView={isFullView}
      header={header}
    >
      <div data-testid="variants-panel" data-tab={tab}>
        {tab === 'snps' && (
          <SnpTab state={state} scan={scan} status={status} onScan={scanNow} onCancel={cancel} busy={busy} notice={notice}
            onSplit={ids => void groupSelected(ids, 'split')} onGroup={ids => void groupSelected(ids, 'group')} />
        )}
        {tab === 'combos' && (
          <CombosTab state={state} scan={scan} duplicates={duplicates} params={state.params} busy={busy} notice={notice}
            onSplit={(grouping, title) => setSplit({ grouping, title, snps: scan?.snps })}
            onGroup={(grouping, title) => say(groupDatasetPanel(grouping, title))} />
        )}
        {tab === 'svs' && <SvTab datasetId={datasetId} params={state.params} duplicates={duplicates} />}
      </div>
      {split && (
        <VariantSplitDialog grouping={split.grouping} datasetId={split.grouping.dataset_id} title={split.title} snps={split.snps}
          softLimit={state.splitSoftLimit} onSoftLimit={n => updateVariantsState({ splitSoftLimit: n })}
          onClose={() => setSplit(null)} onOpened={n => say(`Opened ${n} panel${n === 1 ? '' : 's'} by ${split.title}.`)} />
      )}
    </AnalysisPanelShell>
  );
}

export default VariantsPanel;
