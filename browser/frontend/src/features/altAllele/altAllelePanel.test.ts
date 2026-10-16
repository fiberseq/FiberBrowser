import '../testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  openAltAllele: vi.fn(),
  insertionClustersInView: vi.fn(),
  removeDataset: vi.fn(),
  refresh: vi.fn(async () => {}),
}));
vi.mock('./api', () => ({ openAltAllele: api.openAltAllele, insertionClustersInView: api.insertionClustersInView }));
vi.mock('../../api/datasets', async (orig) => ({ ...(await orig<object>()), removeDataset: api.removeDataset }));
vi.mock('../../stores/panelGenomeStore', async (orig) => {
  const real = await orig<typeof import('../../stores/panelGenomeStore')>();
  real.usePanelGenomeStore.setState({ refresh: api.refresh } as never);
  return real;
});

import { useBrowserStore } from '../../stores/browserStore';
import {
  cancelAltAlleleBuild, expandSvSplitCarriers, healAltAllelePanels, openAltAllelePanel, showPanelOnAltAllele, showPanelOnReference, svSplitExpands,
  toggleInsertExpanded, useAltAlleleBuildStore,
} from './altAllelePanel';
import { closeSplitPanels } from '../../utils/splitPanels';
import type { AltAlleleLayout } from './types';
import type { PanelConfig } from '../../types';

const L: AltAlleleLayout = {
  chrom: 'chrT', ref: 15_000, insert_len: 2_000, flank_left: 3_000, flank_right: 3_000,
  name: 'chrT_15000_INS2000', length: 8_000, insert_start: 3_000, insert_end: 5_000,
};
const ALT = {
  id: 'ins_alt_15000_2000', label: 'insertion · carriers of +2,000 bp at chrT:15,000 (27)', path: '/x/carriers.bam', color: '#000',
  data_type: 'bam' as const,
  alt_allele: { source_dataset_id: 'ins', definition: { chrom: 'chrT', ref: 15_000, length: 2_010, pos: null, flank: 3000,
    include_reference: false, max_carriers: 5000, include_duplicates: false }, layout: L },
};
const OK = {
  success: true, dataset: ALT, genome_key: 'fasta:alt_abc', layout: L, locus: { chrom: L.name, start: 2_000, end: 6_000 },
  alt_allele: { ...ALT.alt_allele, meta: { sv: { t: 'I', ref: 15_000, len: 2_010 } } }, built: true,
};
const SOURCE = { id: 'ins', label: 'insertion', path: '/x/insertion.bam', color: '#111', data_type: 'bam' as const };
const panel = (id: string) => useBrowserStore.getState().panels.find(p => p.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  api.removeDataset.mockResolvedValue({ success: true });
  const p: PanelConfig = {
    id: 'panel-src', contentType: 'dataset', datasetId: 'ins', subTracks: [], collapsed: false, linkGroup: 'default', layoutRow: 0,
    stateKey: 'carriers-key', viewportOverride: { chrom: 'chrT', start: 14_000, end: 16_000 }, siteLocked: true,
  };
  useBrowserStore.setState({ datasets: [SOURCE], panels: [p], slotOrder: ['ins'], chrom: 'chrT', start: 14_000, end: 16_000 } as never);
});

describe('Show insert expanded (carriers only)', () => {
  it('switches the panel to the alt allele of the insertion in view, and back to exactly what it showed', async () => {
    api.insertionClustersInView.mockResolvedValue({ success: true, clusters: [
      { t: 'I', ref: 14_200, len: 400, carriers: 3 }, { t: 'I', ref: 15_000, len: 2_010, carriers: 27 }] });
    api.openAltAllele.mockResolvedValue(OK);
    await toggleInsertExpanded('panel-src');
    expect(api.insertionClustersInView).toHaveBeenCalledWith('ins', 'chrT', 14_000, 16_000, 300);
    expect(api.openAltAllele).toHaveBeenCalledWith(expect.objectContaining({ dataset_id: 'ins', chrom: 'chrT', ref: 15_000, length: 2_010 }));
    const alt = panel('panel-src');
    expect(alt.datasetId).toBe(ALT.id);
    expect(alt.genome).toBe('fasta:alt_abc');
    expect(alt.stateKey).toBe('panel-src~alt');
    // The view across the breakpoint, mapped (the insert in full).
    expect(alt.viewportOverride).toEqual({ chrom: L.name, start: 2_000, end: 6_000 });
    expect(alt.altAllele?.linked).toBe(true);
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['ins', ALT.id]);
    // The title says these are the carriers.
    expect(useBrowserStore.getState().datasets[1].label).toMatch(/carriers of \+2,000 bp/);

    await toggleInsertExpanded('panel-src');
    const back = panel('panel-src');
    expect(back.datasetId).toBe('ins');
    expect(back.genome).toBeUndefined();
    expect(back.stateKey).toBe('carriers-key');
    expect(back.viewportOverride).toEqual({ chrom: 'chrT', start: 14_000, end: 16_000 });
    expect(back.siteLocked).toBe(true);
    expect(back.linkGroup).toBe('default');
    expect(back.altAllele).toBeUndefined();
    expect(api.removeDataset).toHaveBeenCalledWith(ALT.id);
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['ins']);
    // One undo step that reopens it (its built BAM and its contig) and puts the panel back on it.
    const stack = useBrowserStore.getState()._historyStack;
    const step = stack[useBrowserStore.getState()._historyPointer];
    expect(step.label).toBe('Show the reference (insert collapsed)');
    expect(step.closedDatasets?.map(d => d.id)).toEqual([ALT.id]);
  });

  it('is never linked to the main view when its source is on a reference of its own', async () => {
    api.openAltAllele.mockResolvedValue(OK);
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => ({ ...p, genome: 'dm6' })) }));
    const { showPanelOnAltAllele } = await import('./altAllelePanel');
    await showPanelOnAltAllele('panel-src', { datasetId: 'ins', chrom: 'chrT', ref: 15_000, len: 2_010 });
    expect(panel('panel-src').altAllele).toMatchObject({ linked: false, sourceGenome: 'dm6' });
    await showPanelOnReference('panel-src');
    expect(panel('panel-src').genome).toBe('dm6');
  });

  it('Cancel: the panel stays as it was, the status goes, and the build that arrives later is not kept', async () => {
    let answer!: (v: unknown) => void;
    api.openAltAllele.mockReturnValue(new Promise(r => { answer = r; }));
    const done = showPanelOnAltAllele('panel-src', { datasetId: 'ins', chrom: 'chrT', ref: 15_000, len: 2_010 });
    expect(useAltAlleleBuildStore.getState().pending['panel-src']).toMatch(/Building the alternate allele/);
    cancelAltAlleleBuild('panel-src');
    expect(useAltAlleleBuildStore.getState().pending['panel-src']).toBeUndefined();
    answer(OK);
    expect(await done).toBeNull();
    expect(panel('panel-src').datasetId).toBe('ins');
    expect(panel('panel-src').altAllele).toBeUndefined();
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['ins']);
    expect(api.removeDataset).toHaveBeenCalledWith(ALT.id);
    // A later build of the panel runs as usual (its status is its own, not cleared by the cancelled one).
    api.openAltAllele.mockResolvedValue(OK);
    expect(await showPanelOnAltAllele('panel-src', { datasetId: 'ins', chrom: 'chrT', ref: 15_000, len: 2_010 })).toBe(ALT.id);
    expect(useAltAlleleBuildStore.getState().pending['panel-src']).toBeUndefined();
  });

  it('Cancel then retry: the cancelled build\'s answer (the same dataset) never closes the retry\'s', async () => {
    const answers: Array<(v: unknown) => void> = [];
    api.openAltAllele.mockImplementation(() => new Promise(r => { answers.push(r); }));
    const cluster = { datasetId: 'ins', chrom: 'chrT', ref: 15_000, len: 2_010 };
    const first = showPanelOnAltAllele('panel-src', cluster);
    cancelAltAlleleBuild('panel-src');
    const retry = showPanelOnAltAllele('panel-src', cluster);
    answers[0](OK);
    expect(await first).toBeNull();
    expect(api.removeDataset).not.toHaveBeenCalled();
    answers[1](OK);
    expect(await retry).toBe(ALT.id);
    await new Promise(r => setTimeout(r, 0));
    expect(api.removeDataset).not.toHaveBeenCalled();
    expect(panel('panel-src').datasetId).toBe(ALT.id);
  });

  it('Cancel while a new panel\'s dataset is being registered: no panel opens', async () => {
    api.openAltAllele.mockResolvedValue(OK);
    let refreshed!: () => void;
    api.refresh.mockImplementationOnce(() => new Promise<void>(r => { refreshed = r; }));
    const opening = openAltAllelePanel({ datasetId: 'ins', chrom: 'chrT', ref: 15_000, len: 2_010 }, { afterPanelId: 'panel-src' });
    await vi.waitFor(() => expect(refreshed).toBeTypeOf('function'));
    cancelAltAlleleBuild('panel-src');
    refreshed();
    expect(await opening).toBeNull();
    expect(useBrowserStore.getState().panels.map(p => p.id)).toEqual(['panel-src']);
    await vi.waitFor(() => expect(api.removeDataset).toHaveBeenCalledWith(ALT.id));
  });

  it('says why when there is no insertion in view', async () => {
    api.insertionClustersInView.mockResolvedValue({ success: true, clusters: [] });
    await toggleInsertExpanded('panel-src');
    expect(api.openAltAllele).not.toHaveBeenCalled();
    expect(panel('panel-src').datasetId).toBe('ins');
    expect(useBrowserStore.getState().error).toMatch(/No insertion of 300 bp or more in view/);
  });

  it('opens a new panel on the alt allele beside its source; back to the reference shows the source there', async () => {
    api.openAltAllele.mockResolvedValue(OK);
    const id = await openAltAllelePanel({ datasetId: 'ins', chrom: 'chrT', ref: 15_000, len: 2_010 }, { afterPanelId: 'panel-src' });
    expect(id).toBeTruthy();
    const panels = useBrowserStore.getState().panels;
    expect(panels.map(p => p.id)).toEqual(['panel-src', id]);
    expect(panel(id!).altAllele?.restore).toBeNull();
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === id ? { ...p, viewportOverride: { chrom: L.name, start: 5_100, end: 6_100 } } : p)) }));
    await showPanelOnReference(id!);
    expect(panel(id!).datasetId).toBe('ins');
    expect(panel(id!).viewportOverride).toEqual({ chrom: 'chrT', start: 15_100, end: 16_100 });
  });

  it('rebuilds a restored alt panel whose dataset did not come back', async () => {
    api.openAltAllele.mockResolvedValue({ ...OK, dataset: { ...ALT, id: 'rebuilt' } });
    useBrowserStore.setState(s => ({
      panels: [...s.panels, {
        id: 'panel-alt', contentType: 'dataset', datasetId: 'gone', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
        genome: 'fasta:alt_old', viewportOverride: { chrom: L.name, start: 3_100, end: 3_900 },
        altAllele: { cluster: { datasetId: 'ins', chrom: 'chrT', ref: 15_000, len: 2_010 }, layout: L, altDatasetId: 'gone',
          genomeKey: 'fasta:alt_old', linked: true, restore: null, flank: 3000 },
      } as PanelConfig],
    }));
    await healAltAllelePanels();
    await vi.waitFor(() => expect(panel('panel-alt').datasetId).toBe('rebuilt'));
    expect(api.openAltAllele).toHaveBeenCalledWith(expect.objectContaining({ dataset_id: 'ins', ref: 15_000, length: 2_010, flank: 3000 }));
    expect(panel('panel-alt').genome).toBe('fasta:alt_abc');
    expect(panel('panel-alt').viewportOverride).toEqual({ chrom: L.name, start: 3_100, end: 3_900 });
  });

  it('keeps a restored alt panel through a dataset refresh while its source is open', () => {
    useBrowserStore.setState(s => ({
      panels: [...s.panels, {
        id: 'panel-alt', contentType: 'dataset', datasetId: 'gone', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
        altAllele: { cluster: { datasetId: 'ins', chrom: 'chrT' }, layout: L, altDatasetId: 'gone', genomeKey: 'k', linked: true, restore: null },
      } as PanelConfig],
    }));
    useBrowserStore.getState().setDatasets([SOURCE] as never);
    expect(useBrowserStore.getState().panels.map(p => p.id)).toContain('panel-alt');
  });
});

describe('Split into panels by an SV allele (integration of features + altallele)', () => {
  const split = (id: string, keys: string[], label: string): PanelConfig => ({
    id, contentType: 'dataset', datasetId: 'ins', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
    stateKey: `ins:split-1:${keys[0]}`,
    readSubset: { groupId: 'split-1', label, colour: '#000', count: 2, sourcePanelId: 'panel-src',
      rule: { kind: 'frozen', datasetId: 'ins', groupKeys: keys, readIds: ['r1', 'r2'] } },
  } as PanelConfig);

  it('shows the Carriers panel with the insert expanded, and closes its alt dataset with the split', async () => {
    api.openAltAllele.mockResolvedValue(OK);
    useBrowserStore.setState(s => ({
      panels: [{ ...s.panels[0], collapsed: true, collapsedBySplitGroup: 'split-1' }, split('c', ['0'], 'Carriers'), split('r', ['1'], 'Reference')],
      svSplits: { 'carriers-key': { datasetId: 'ins', chrom: 'chrT', t: 'I', ref: 15_000, len: 2_010, end: 15_000, margin: 50,
        label: 'INS 2.0 kb', counts: [2, 1, 0], viewStart: 14_000, viewEnd: 16_000 } },
    }) as never);
    // The split dialog says so before it opens (SV-2).
    expect(svSplitExpands('panel-src')).toBe(true);
    await expandSvSplitCarriers('split-1', 'panel-src');
    expect(api.openAltAllele).toHaveBeenCalledTimes(1);
    expect(api.openAltAllele).toHaveBeenCalledWith(expect.objectContaining({ dataset_id: 'ins', chrom: 'chrT', ref: 15_000, length: 2_010 }));
    expect(panel('c').datasetId).toBe(ALT.id);
    expect(panel('c').altAllele?.restore.stateKey).toBe('ins:split-1:0');
    expect(panel('r').datasetId).toBe('ins');
    const push = vi.fn(useBrowserStore.getState().pushSnapshot);
    useBrowserStore.setState({ pushSnapshot: push } as never);
    await closeSplitPanels('split-1');
    expect(api.removeDataset).toHaveBeenCalledWith(ALT.id);
    expect(useBrowserStore.getState().datasets.some(d => d.id === ALT.id)).toBe(false);
    expect(useBrowserStore.getState().panels.map(p => p.id)).toEqual(['panel-src']);
    // One undo step: the panels and the alt dataset together.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1]).toMatchObject({ kind: 'layout', closedDatasets: [expect.objectContaining({ id: ALT.id })] });
  });

  it('a second close while the first is closing the alt dataset does nothing; panels gone meanwhile still drop it', async () => {
    api.openAltAllele.mockResolvedValue(OK);
    useBrowserStore.setState(s => ({
      panels: [{ ...s.panels[0], collapsed: true, collapsedBySplitGroup: 'split-1' }, split('c', ['0'], 'Carriers')],
      svSplits: { 'carriers-key': { datasetId: 'ins', chrom: 'chrT', t: 'I', ref: 15_000, len: 2_010, end: 15_000, margin: 50,
        label: 'INS 2.0 kb', counts: [2, 1, 0], viewStart: 14_000, viewEnd: 16_000 } },
    }) as never);
    await expandSvSplitCarriers('split-1', 'panel-src');
    const push = vi.fn(useBrowserStore.getState().pushSnapshot);
    useBrowserStore.setState({ pushSnapshot: push } as never);
    let release: (v: unknown) => void = () => {};
    api.removeDataset.mockReturnValueOnce(new Promise(r => { release = r; }));
    const first = closeSplitPanels('split-1');
    const second = closeSplitPanels('split-1');
    // Meanwhile the split panels go another way (an Undo).
    useBrowserStore.setState(s => ({ panels: s.panels.filter(p => p.id !== 'c') }) as never);
    release({ success: true });
    await Promise.all([first, second]);
    expect(api.removeDataset).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().datasets.some(d => d.id === ALT.id)).toBe(false);
  });

  it('drops an alt allele that finishes building after its panel closed', async () => {
    let finish: (v: unknown) => void = () => {};
    api.openAltAllele.mockReturnValue(new Promise(r => { finish = r; }));
    useBrowserStore.setState(s => ({
      panels: [s.panels[0], split('c', ['0'], 'Carriers')],
      svSplits: { 'carriers-key': { datasetId: 'ins', chrom: 'chrT', t: 'I', ref: 15_000, len: 2_010, end: 15_000, margin: 50,
        label: 'INS 2.0 kb', counts: [2, 1, 0], viewStart: 14_000, viewEnd: 16_000 } },
    }) as never);
    const building = expandSvSplitCarriers('split-1', 'panel-src');
    useBrowserStore.setState(s => ({ panels: s.panels.filter(p => p.id !== 'c') }) as never);
    finish(OK);
    await building;
    expect(api.removeDataset).toHaveBeenCalledWith(ALT.id);
    expect(useBrowserStore.getState().datasets.some(d => d.id === ALT.id)).toBe(false);
  });

  it('leaves a deletion split alone', async () => {
    useBrowserStore.setState(s => ({
      panels: [s.panels[0], split('c', ['0'], 'Carriers')],
      svSplits: { 'carriers-key': { datasetId: 'ins', chrom: 'chrT', t: 'D', ref: 15_000, len: 2_010, end: 17_010, margin: 50,
        label: 'DEL 2.0 kb', counts: [2, 1, 0], viewStart: 14_000, viewEnd: 16_000 } },
    }) as never);
    await expandSvSplitCarriers('split-1', 'panel-src');
    expect(api.openAltAllele).not.toHaveBeenCalled();
  });
});
