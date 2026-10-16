/**
 * "Open the reference copies" (the insertion lens's Identify): the insert's best genome copies (other hobo
 * copies, say) as read panels of the same dataset beside its carriers, each at its own locus, so the
 * chromatin at reference copies can be compared with the new insertion's. The split-into-panels limits:
 * top 4 by default, a confirmation above 8, at most 16 (utils/variantSplit.splitVerdict).
 */
import { useBrowserStore } from '../../stores/browserStore';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { generatePanelId } from '../../stores/utils';
import type { PanelConfig } from '../../types';
import type { ReferenceCopy } from './identifyModel';
import { SPLIT_HARD_LIMIT } from '../variants/variantSplit';

/** The panel the copies open beside: the insertion's Carriers panel (split or insert-expanded), else the dataset's main panel. */
export function copiesAnchor(panels: PanelConfig[], datasetId: string): PanelConfig | undefined {
  const own = panels.filter(p => p.contentType === 'dataset');
  return own.find(p => p.altAllele?.cluster.datasetId === datasetId && !p.collapsed)
    ?? own.find(p => p.datasetId === datasetId && p.readSubset?.rule.groupKeys?.length === 1 && p.readSubset.rule.groupKeys[0] === '0' && !p.collapsed)
    ?? own.find(p => p.datasetId === datasetId && !p.readSubset && !p.altAllele && !p.collapsed)
    ?? own.find(p => p.datasetId === datasetId);
}

/**
 * Where the copies go in the panel list: after the anchor, and after the rest of its split set when it is a split
 * panel (the Carriers/Reference pair stays together; usability round 3, R2b: the copies came between them).
 */
export function copiesInsertAt(panels: PanelConfig[], anchorId: string): number {
  const idx = panels.findIndex(p => p.id === anchorId);
  if (idx < 0) return panels.length;
  const anchor = panels[idx];
  const groupId = anchor.readSubset?.groupId;
  if (!groupId) return idx + 1;
  const row = anchor.layoutRow ?? 0;
  let last = idx;
  panels.forEach((p, i) => { if (i > last && p.readSubset?.groupId === groupId && (p.layoutRow ?? 0) === row) last = i; });
  return last + 1;
}

export function openReferenceCopies(lensDatasetId: string, copies: ReferenceCopy[], family: string): { groupId: string; opened: number } | { error: string } {
  if (!copies.length) return { error: 'No genome copy of the insert to open (none covers half of it away from the site).' };
  if (copies.length > SPLIT_HARD_LIMIT) return { error: `At most ${SPLIT_HARD_LIMIT} panels at a time.` };
  const store = useBrowserStore.getState();
  // The lens opened on an insert-expanded panel names its alt dataset: the copies are the source dataset's reads.
  const datasetId = store.panels.find(p => p.altAllele && p.datasetId === lensDatasetId)?.altAllele?.cluster.datasetId ?? lensDatasetId;
  const template = store.panels.find(p => p.contentType === 'dataset' && p.datasetId === datasetId && !p.readSubset && !p.altAllele);
  const anchor = copiesAnchor(store.panels, datasetId);
  if (!template || !anchor) return { error: 'Open a read panel of this dataset first.' };
  const groupId = `copies-${Date.now().toString(36)}`;
  const made: PanelConfig[] = copies.map((c, i) => {
    const pad = Math.max(1_000, Math.round((c.end - c.start) * 0.2));
    const {
      collapsedBySplitGroup: _a, collapsedByHaplotypeGroup: _b, collapsedByContactRegionGroup: _c, ...base
    } = template;
    return {
      ...base,
      id: generatePanelId(),
      stateKey: `${datasetId}:${groupId}:${i}`,
      subTracks: template.subTracks.map(t => ({ ...t })),
      collapsed: false, linkGroup: null, ownLocus: true, siteLocked: false,
      layoutRow: anchor.layoutRow ?? 0, layoutColumn: undefined, heightFraction: undefined, widthFraction: undefined,
      viewportOverride: { chrom: c.chrom, start: Math.max(0, c.start - pad), end: c.end + pad },
      // Its name in the panel's site bar (beside its location box, which gives the coordinates).
      regionLabel: `${family} copy ${i + 1} (${c.strand === '-' ? '−' : '+'}, ${c.identity.toFixed(1)}%)`,
      // Its header title (utils/panelTitle.ts): which copy, where; strand and identity follow.
      title: `${family} copy ${i + 1} (${c.chrom})`,
      titleDetail: `${c.strand === '-' ? '−' : '+'} strand, ${c.identity.toFixed(1)}% identity`,
      genomeRegionGroupId: groupId,
      readSubset: undefined, altAllele: undefined,
      contactRegionGroupId: undefined, contactRegionRole: undefined, haplotypeGroup: undefined, haplotypeSide: undefined,
    } as PanelConfig;
  });
  seedHistoryBaseline(store, 'Before opening the reference copies', 'layout');
  useBrowserStore.setState(s => {
    const panels = [...s.panels];
    panels.splice(copiesInsertAt(panels, anchor.id), 0, ...made);
    return { panels };
  });
  useBrowserStore.getState().pushSnapshot(`Open ${copies.length} reference ${copies.length === 1 ? 'copy' : 'copies'} of ${family}`, { kind: 'layout' });
  return { groupId, opened: made.length };
}

/** The reference-copy panels open now (every "Open the reference copies" of this dataset or its insert-expanded panels). */
export function openCopyPanels(panels: PanelConfig[], lensDatasetId: string): PanelConfig[] {
  const datasetId = panels.find(p => p.altAllele && p.datasetId === lensDatasetId)?.altAllele?.cluster.datasetId ?? lensDatasetId;
  return panels.filter(p => p.contentType === 'dataset' && p.datasetId === datasetId && p.genomeRegionGroupId?.startsWith('copies-'));
}

/** "Close reference copies": every copy panel of the dataset, in one undo step. Returns how many closed. */
export function closeReferenceCopies(lensDatasetId: string): number {
  const store = useBrowserStore.getState();
  const copies = openCopyPanels(store.panels, lensDatasetId);
  if (!copies.length) return 0;
  seedHistoryBaseline(store, 'Before closing the reference copies', 'layout');
  for (const p of copies) useBrowserStore.getState().removePanel(p.id);
  useBrowserStore.getState().pushSnapshot(`Close ${copies.length} reference ${copies.length === 1 ? 'copy' : 'copies'}`, { kind: 'layout' });
  return copies.length;
}
