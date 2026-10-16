import './testSetup';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { INSERTION_LENS_PANEL, openInsertionLens } from './insertion/insertionLensTarget';
import { forgetPanelMemory, rememberedPanelFields, resetPanelMemory, restorePanelFields } from './panelMemory';
import { useIdentifyStore } from './insertion/identifyStore';

const TARGET = { datasetId: 'numb', chrom: 'chr2L', ref: 9_467_038, len: 9_185, flank: 1000 } as never;
const lens = () => useBrowserStore.getState().panels.find(p => p.contentType === INSERTION_LENS_PANEL);

beforeEach(() => {
  resetPanelMemory();
  useBrowserStore.setState({ panels: [], datasets: [{ id: 'numb', label: 'numb', data_type: 'bam', path: '/a/numb.bam' }], _historyStack: [], _historyPointer: -1 } as never);
});

describe('closing the lens is not clearing it (audit VAR-7 / bug 3)', () => {
  it('the last insertion and its Identify result come back when the lens opens again', () => {
    openInsertionLens(TARGET);
    const saved = { 'numb|chr2L|9467038|9185': { seqSha: 'x', at: 'now', result: { summary: 'roo' } } } as never;
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === lens()!.id ? { ...p, insertionIdentify: saved } : p)) }));
    useIdentifyStore.setState({ entries: { 'numb|chr2L|9467038|9185': { status: 'done', progress: 1, message: 'Done', unseen: false } } });
    // Closed (with the splits around it, say), then opened from the rail: empty until the panel restores it.
    useBrowserStore.getState().closeAnalysisPanel(lens()!.id);
    expect(lens()).toBeUndefined();
    useBrowserStore.getState().openAnalysisPanel(INSERTION_LENS_PANEL);
    expect(lens()!.insertionLens).toBeUndefined();
    expect(restorePanelFields(INSERTION_LENS_PANEL)).toBe(true);
    expect(lens()!.insertionLens).toEqual({ ...(TARGET as object), genome: null, reversed: false });
    expect(lens()!.insertionIdentify).toEqual(saved);
    // The Identify job store kept its result under the same key.
    expect(useIdentifyStore.getState().entries['numb|chr2L|9467038|9185'].status).toBe('done');
  });

  it('never over what the lens shows, never for a closed dataset, and not after Clear', () => {
    openInsertionLens(TARGET);
    const other = { ...(TARGET as object), ref: 1 } as never;
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === lens()!.id ? { ...p, insertionLens: other } : p)) }));
    expect(restorePanelFields(INSERTION_LENS_PANEL)).toBe(false);
    useBrowserStore.getState().closeAnalysisPanel(lens()!.id);
    useBrowserStore.getState().openAnalysisPanel(INSERTION_LENS_PANEL);
    useBrowserStore.setState({ datasets: [] } as never);
    expect(restorePanelFields(INSERTION_LENS_PANEL)).toBe(false);
    // The same dataset id for other files (another session): not its lens either.
    useBrowserStore.setState({ datasets: [{ id: 'numb', label: 'numb', data_type: 'bam', path: '/b/other.bam' }] } as never);
    expect(restorePanelFields(INSERTION_LENS_PANEL)).toBe(false);
    forgetPanelMemory(INSERTION_LENS_PANEL);
    expect(rememberedPanelFields(INSERTION_LENS_PANEL)).toBeNull();
    // A seek (a click position the panel resolves) is not worth keeping.
    openInsertionLens({ datasetId: 'numb', chrom: 'chr2L', pos: 5, seek: true });
    expect(rememberedPanelFields(INSERTION_LENS_PANEL)).toBeNull();
  });

  it('Variants keeps its tab, scan and selection the same way', () => {
    useBrowserStore.getState().openAnalysisPanel('variants');  // previews off: Variants is not a Preview panel
    const id = useBrowserStore.getState().panels.find(p => p.contentType === 'variants')!.id;
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === id ? { ...p, variants: { tab: 'svs', selected: ['a'] } } : p)) }));
    useBrowserStore.getState().closeAnalysisPanel(id);
    useBrowserStore.getState().openAnalysisPanel('variants');
    expect(restorePanelFields('variants')).toBe(true);
    expect(useBrowserStore.getState().panels.find(p => p.contentType === 'variants')?.variants).toEqual({ tab: 'svs', selected: ['a'] });
  });
});
