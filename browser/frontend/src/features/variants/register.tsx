/**
 * The Variants panel (SNPs, SNP combinations and SVs, the reads split by allele), its SNP channel
 * over the reads, and SVs as selectable features (multi-SV and mixed SNP+SV splits).
 */
import { lazy, useState } from 'react';
import { registerAnalysisPanel } from '../../plugins/registry';
import { declareContribution } from '../../plugins/packRegistry';
import { registerBrowserHost } from '../../plugins/browserHosts';
import { registerSplitHooks } from '../../utils/panelExtensions';
import { datasetIdentity, rememberPanelFields } from '../panelMemory';
import { registerTrackKind, extendTrackMenu, openPanelItem, rowHeight } from '../../components/tracks/trackRegistry';
import { registerTrackRenderer } from '../../components/tracks/trackRenderers';
import { registerSvRowSelection } from '../../components/tracks/svRowSelection';
import { CHIP_BTN } from '../../components/controls/FeatureSelectionChip';
import { registerFeatureKind, type FeatureRef } from '../../stores/featureStore';
import { registerSvHubProvider } from './hubProvider';
import { useBrowserStore } from '../../stores/browserStore';
import { Variants } from '../icons';
import { FEATURE_PANEL_FIELDS } from '../types';
import { SNP_CHANNEL_HEADER, SNP_CHANNEL_HEIGHT, SNP_CHANNEL_SPLIT_HEIGHT, SnpChannelTrack, useSnpChannelShown } from './SnpChannelTrack';
import { SvComboHost } from './SvComboHost';
import {
  REQUIRE_ALL_SVS_HELP, svComboPanel, svOfFeature, groupBySelectedSvs, splitBySelectedSvs, svFeatureIs, svSelectionTitle, toggleSvFeature, type SvLike,
} from './svFeatures';

const LazyVariants = lazy(() => import('./VariantsPanel').then(m => ({ default: m.VariantsPanel })));

/** SVs and other features (footprint classes, ...) also selected: their reads' states are of different kinds. */
const SV_MIXED = 'SVs and other features (footprint classes, ...) can’t be combined: clear one kind (× on the feature chip), or split by the SVs with the chip’s buttons.';
const SV_SORT_FILTER = 'Sort and Filter by features work on footprint classes and other region features; for SVs use the feature chip’s Group in this panel (then sort or filter by group) or Split into panels.';

/** The selection chip's buttons when SVs are selected: split by their combined genotype. */
function SvFeatureChip({ features, all }: { features: FeatureRef[]; all: FeatureRef[] }) {
  // "Require calls at all selected SVs" (on by default; off = partial genotypes, ? at the SVs a read misses).
  const [requireAll, setRequireAll] = useState(true);
  const partial = !requireAll;
  const svs = features;
  // With SVs, the chip's buttons split by the SVs only: another feature also selected is left out (said so).
  const others = all.length - svs.length;
  const svOnly = others ? ` (only the SVs: the ${others} other feature${others === 1 ? '' : 's'} also selected ${others === 1 ? 'is' : 'are'} left out)` : '';
  const fail = (error: string | null) => { if (error) useBrowserStore.getState().setError(error); };
  return (
    <>
      <button type="button" data-testid="feature-sv-group" className={CHIP_BTN}
        title={`Group this panel's reads by their genotype at ${svSelectionTitle(svs)} (carrier + / reference − at each)${svOnly}`}
        onClick={() => { void groupBySelectedSvs(all, partial).then(fail); }}>
        Group in this panel
      </button>
      <label className="flex cursor-pointer items-center gap-0.5 text-[10px] text-gray-600 dark:text-gray-300"
        title={`Require calls at all selected SVs. ${REQUIRE_ALL_SVS_HELP}`}>
        <input type="checkbox" className="h-3 w-3" checked={requireAll} onChange={e => setRequireAll(e.target.checked)} data-testid="feature-sv-require-all"
          aria-label="Require calls at all selected SVs" />
        all SVs
      </label>
      <button type="button" data-testid="feature-split-panels" className={CHIP_BTN}
        title={`Split into panels: one read panel per genotype at ${svSelectionTitle(svs)} (the top 4 ticked; asks above 8, at most 16)${svOnly}`}
        onClick={() => { void splitBySelectedSvs(all, partial).then(fail); }}>
        Split into panels
      </button>
    </>
  );
}

/** The selected SVs a closing split was made by (the SVs its rule records): out of the selection; other features stay. */
export function clearSvSelectionOfSplit(panels: { readSubset?: { rule?: { splitSvs?: { datasetId: string; chrom: string; id: string }[] } } }[]): void {
  const made = panels.find(p => p.readSubset?.rule?.splitSvs?.length)?.readSubset?.rule?.splitSvs;
  if (!made) return;
  const store = useBrowserStore.getState();
  const bySplit = (f: FeatureRef) => f.kind === 'sv' && made.some(sv => {
    const own = svOfFeature({ ...f, id: sv.id });
    return own != null && svFeatureIs(f, own, sv.datasetId, sv.chrom);
  });
  if (!store.selectedFeatures.some(bySplit)) return;
  store.setSelectedFeatures(store.selectedFeatures.filter(f => !bySplit(f)));
}

export function registerVariants(): void {
  registerSvHubProvider();
  registerAnalysisPanel({
    contentType: 'variants',
    label: 'Variants',
    shortLabel: 'Variants',
    // Pink (pink-600): apart from Read Stats' violet and Cluster features'
    // purple on the rail (their tiles were indistinguishable at #a855f7), and
    // from the other tiles of the Analyze group; white on it is 4.6:1 without darkening.
    headerColor: '#db2777',
    component: LazyVariants,
    icon: Variants,
    description: 'SNPs in view and their local read-supported allele patterns, SVs; split the reads by allele into panels or groups',
    group: 'analysis',
    stripOrder: 7.1,
    settingsTargets: ['Read Display'],
    sessionKeys: ['panels[].variants'],
    apiEndpoints: ['/api/variants/snps', '/api/variants/alleles', '/api/variants/svs', '/api/variants/sv_linkage'],
  });
  for (const field of FEATURE_PANEL_FIELDS) declareContribution('panelFields', field);
  // Closing Variants keeps its tab, scan and selection for its next open (VAR-7); its Clear forgets them.
  rememberPanelFields('variants', ['variants'], p => Boolean(p.variants && Object.keys(p.variants).length), (kept, state) => {
    const v = kept.variants as { datasetId?: string; scan?: { dataset_id?: string } } | undefined;
    // No dataset named yet (the panel's first BAM): the first dataset open then.
    return datasetIdentity(v?.datasetId || v?.scan?.dataset_id || state.datasets.find(d => d.data_type === 'bam')?.id, state);
  });

  // The SNP channel of the Variants panel: above the SV and coverage rows and the reads.
  registerTrackKind({
    type: 'snps', label: 'SNPs (Variants)', defaultHeight: 44, minHeight: 18, maxHeight: 240, builtin: true,
    shownWhen: 'after a Variants scan',
    menu: () => [openPanelItem('variants', 'Variants')],
    defaultPlacement: { before: ['sv', 'coverage', 'reads'], requires: 'reads' },
  });
  registerTrackRenderer({
    type: 'snps',
    // A Variants panel scan of this panel's dataset over its view, or the SNPs a split panel was made by (render and
    // layout alike).
    useHeight: () => {
      const shown = useSnpChannelShown();
      return ({ datasetId, view, track, panel }) => {
        const layout = shown(datasetId, view.chrom, view.start, view.end, panel);
        if (!layout) return null;
        // (Only a split panel's SNPs, no scan ticks: a short row, the allele pill just above the reads.)
        return track.collapsed ? SNP_CHANNEL_HEADER : rowHeight(track, layout === 'split' ? SNP_CHANNEL_SPLIT_HEIGHT : SNP_CHANNEL_HEIGHT);
      };
    },
    render: ({ panel, track, datasetId, width, height, sidebarWidth }) => {
      const vpo = panel.viewportOverride;
      return <SnpChannelTrack width={width} height={height} datasetId={datasetId!} panelId={panel.id} collapsed={!!track.collapsed}
        sidebarWidth={sidebarWidth} {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end } : {})} />;
    },
  });
  extendTrackMenu('sv', () => [openPanelItem('variants', 'Variants (SNPs, SVs)')]);

  // SVs as selectable features: shift-click on the SV row, the Variants panel's SVs tab; two to four of them split the
  // reads by their combined genotype.
  registerFeatureKind({
    kind: 'sv', typeId: 'var.sv', perDataset: true, keyedByChrom: true, layerLabel: 'SV genotype', noun: 'SVs',
    stateNote: 'SVs: carrier or reference at each',
    // An insertion is a boundary: stored refs keep [ref, ref+1) (3.0.x sessions), the hub reads them as zero width
    // at ref. A 1 bp deletion [ref, ref+1) is a real interval and stays as it is.
    zeroWidth: true,
    hubSpan: f => {
      const sv = svOfFeature(f);
      return sv?.t === 'I' ? { start: sv.ref, end: sv.ref } : null;
    },
    // An SV is not a region to cluster on (its genotype splits the reads: Cluster combinatorial, the chip).
    regionMode: () => null,
    actions: {
      cluster: features => groupBySelectedSvs(features), sortFilter: SV_SORT_FILTER, mixed: SV_MIXED, Chip: SvFeatureChip,
      // The panel the genotypes are read in and grouped (svComboPanel: the dataset's own, not a split's or a copy's).
      groupsPanel: features => (features[0]?.datasetId ? svComboPanel(features[0].datasetId)?.id : undefined),
    },
  });
  registerSvRowSelection({
    selected: (features, datasetId) => features.filter(f => f.kind === 'sv' && f.datasetId === datasetId),
    matches: (f, cluster, datasetId, chrom) => svFeatureIs(f, cluster as SvLike, datasetId, chrom),
    toggle: (cluster, datasetId, chrom) => toggleSvFeature(cluster as SvLike, datasetId, chrom),
  });
  // The combined-SV genotype split's panel-count dialog (opened from the feature chip or the SV row).
  registerBrowserHost('sv-combo', SvComboHost, { interactiveOnly: true });
  // Closing a split by the selected SVs takes their feature chip with it (audit SV-9): the chip named the split.
  registerSplitHooks({ closing: panels => { clearSvSelectionOfSplit(panels); return null; } });
}
