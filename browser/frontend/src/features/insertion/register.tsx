/**
 * The insertion lens (with Identify and the reference copies): its panel, its items on the reads' and the SV row's
 * menus, and the SV row's "Insertion lens panel" item. Supported (not a Preview feature).
 */
import { lazy } from 'react';
import { registerAnalysisPanel, registerPanelMigration } from '../../plugins/registry';
import { extendTrackMenu, openPanelItem } from '../../components/tracks/trackRegistry';
import { item, registerReadMenuContribution } from '../../components/tracks/read-track/readMenuModel';
import { registerMenuIcon } from '../../components/tracks/read-track/ReadContextMenu';
import { registerFullReadAnalysis } from '../../components/tracks/read-track/ReadSampleNotice';
import { InsertionLens } from '../icons';
import { INSERTION_LENS_PANEL, isSeek, openInsertionLens } from './insertionLensTarget';
import { datasetIdentity, rememberPanelFields } from '../panelMemory';
import { targetForCluster } from './insertionLensModel';
import type { SvLike } from '../variants/svFeatures';

const LazyInsertionLens = lazy(() => import('./InsertionLensPanel').then(m => ({ default: m.InsertionLensPanel })));

const isInsertion = (c: { t: string } | null | undefined): c is SvLike => c?.t === 'I';

export function registerInsertionLens(): void {
  registerAnalysisPanel({
    contentType: INSERTION_LENS_PANEL,
    label: 'Insertion lens',
    shortLabel: 'Lens',
    // Lime (lime-700): apart from the Analyze group's purples, pinks, greens and blues on the rail; white on it is
    // over 4.5:1.
    headerColor: '#4d7c0f',
    component: LazyInsertionLens,
    icon: InsertionLens,
    description: 'The chromatin inside a large insertion: its carrier reads in insertion coordinates, consensus and profiles; Identify gives candidate TE families and genome copies of the insert',
    group: 'analysis',
    stripOrder: 7,
    settingsTargets: ['Read Display'],
    sessionKeys: ['panels[].insertionLens', 'panels[].insertionIdentify'],
    apiEndpoints: ['/api/insertions/clusters', '/api/insertions/lens', '/api/insertions/identify', '/api/insertions/te_library'],
  });
  // 3.0 development builds kept the lens as the Variants panel's last tab: such a panel's lens and Identify results
  // go to a lens panel of their own, its SNP state stays with Variants. The panel it was showing keeps its id (the full
  // view and the selection refer to it); the other one is added minimized, with an id of its own.
  registerPanelMigration(panel => {
    if (panel.contentType !== 'variants') return null;
    const { insertionLens, insertionIdentify, variants, ...rest } = panel as typeof panel & {
      insertionLens?: unknown; insertionIdentify?: unknown; variants?: { tab?: string } & Record<string, unknown>;
    };
    if (insertionLens == null && insertionIdentify == null) return null;
    const onLens = variants?.tab === 'lens' || (!variants?.tab && insertionLens != null);
    const lens = { ...rest, contentType: INSERTION_LENS_PANEL,
      ...(insertionLens != null ? { insertionLens } : {}), ...(insertionIdentify != null ? { insertionIdentify } : {}) };
    const { tab: _tab, ...variantsState } = variants ?? {};
    const hasVariants = Object.keys(variantsState).length > 0;
    const snps = { ...rest, contentType: 'variants', ...(hasVariants ? { variants: variantsState } : {}) };
    if (onLens) return hasVariants ? [lens, { ...snps, id: `${String(panel.id)}-variants`, collapsed: true }] : lens;
    return [snps, { ...lens, id: `${String(panel.id)}-lens`, collapsed: true }];
  });
  // Closing the lens (or the splits around it) keeps its insertion and Identify result for its next open (VAR-7).
  rememberPanelFields(INSERTION_LENS_PANEL, ['insertionLens', 'insertionIdentify'], p => Boolean(p.insertionLens && !isSeek(p.insertionLens)),
    (kept, state) => datasetIdentity((kept.insertionLens as { datasetId?: string } | undefined)?.datasetId, state));
  registerMenuIcon('insertion', InsertionLens);
  // The insertion lens reads every alignment of the view (the sampled-reads notice says so).
  registerFullReadAnalysis('the insertion lens', 30);
  // The panel itself (its last insertion, Insertions in view, Identify), named apart from "Open this insertion in the
  // lens" just above it on an insertion (round 2, VAR-11: "Open insertion lens" / "Insertion lens (Identify)").
  extendTrackMenu('sv', () => [openPanelItem(INSERTION_LENS_PANEL, 'Insertion lens panel',
    'Open the Insertion lens panel: its last insertion, Insertions in view, and Identify')]);

  // The insertion lens from the reads (the insertion nearest the click) and from an insertion of the SV row.
  registerReadMenuContribution({
    id: 'insertion-lens',
    readItems: ctx => (ctx.bamReads ? [item('ext:insertion-lens', 'Open insertion lens', 'ext:insertion', {
      title: 'The chromatin inside the insertion nearest the click (50 bp or more, within 300 bp): its carrier reads in insertion coordinates',
    })] : []),
    svClusterItems: sv => (sv.insertion && sv.bamReads ? [item('ext:insertion-lens', 'Open this insertion in the lens', 'ext:insertion', {
      title: 'The chromatin inside this insertion: its carrier reads (clipped ones included) in insertion coordinates',
    })] : []),
    svHint: cluster => (cluster.t === 'I' ? 'insertion lens' : null),
    run: (_action, ctx) => {
      // On an insertion of the SV summary: that cluster, so the lens has the reads "Split by this SV" groups.
      // Elsewhere: the one nearest the click.
      const sv = ctx.svClusters.find(isInsertion);
      if (sv) openInsertionLens(targetForCluster(sv, ctx.datasetId, ctx.chrom), ctx.panelId);
      else if (ctx.genomePos != null) openInsertionLens({ datasetId: ctx.datasetId, chrom: ctx.chrom, pos: Math.round(ctx.genomePos), seek: true }, ctx.panelId);
    },
  });
}
