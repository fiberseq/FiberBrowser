import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getConsensusSchema: vi.fn(),
  getConsensusJobs: vi.fn(),
  getConsensusJob: vi.fn(),
  startConsensus: vi.fn(),
}));
vi.mock('../../../api/consensusWorkflow', async (orig) => ({ ...(await orig<typeof import('../../../api/consensusWorkflow')>()), ...api }));

import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import { useClassRegionOutlineStore } from '../../../stores/classRegionOutlineStore';
import { serializeState, deserializeSavedState } from '../../../stores/historySlice';
import { useSettingsHistory } from '../../../hooks/useSettingsHistory';
import { HighlightBands } from '../../tracks/HighlightBands';
import { formatRecallerTableTsv } from '../../../utils/recallerTable';
import { DEFAULT_CLASS_REGION_MODE, classRegionLine, savedRegionAt, shortClassRegionBp } from '../../../utils/classRegion';
import { ConsensusTools } from './ConsensusTools';
import { findFootprintClassesInView } from '../../../utils/analysisCommands';
import { applyImportedState } from '../../../api/session';
import type { PanelConfig } from '../../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-n5-classregion: the Find classes card says which region it analyses
 * (the selected peak, the view, a saved region), lets the user choose,
 * outlines it on the targeted panels, and warns when it is short.
 */
const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam', consensus_chemistry: 'ddda' });
const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;
const VIEW = { chrom: 'chr19', start: 47_517_000, end: 47_521_000 };
const PEAK = { absStart: 47_518_060, absEnd: 47_518_500 };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  api.getConsensusSchema.mockReset().mockResolvedValue({ schema: 'x', cr_mode: 'lattice_recaller', groups: {}, layers: {}, display_defaults: {} });
  api.getConsensusJobs.mockReset().mockResolvedValue({ jobs: [], active_job: null });
  api.getConsensusJob.mockReset().mockImplementation(() => new Promise(() => {})); // a run stays in progress
  api.startConsensus.mockReset().mockImplementation(async (request: Record<string, unknown>) => ({
    job_id: 'j1', status: 'queued', request: { ...request, chemistry_overrides: {} }, filters: {}, created_at: 1 }));
  usePanelGenomeStore.setState({ genomes: {}, assignments: {} });
  useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {} } as never);
  useClassRegionOutlineStore.setState({ outline: null, heldForJob: null });
  useBrowserStore.setState({
    ...VIEW, currentGenome: 'hg38', datasets: [ds('a')] as never, selectedDatasets: new Set(['pa']),
    panels: [panel('pa', 'a')], classRegionMode: DEFAULT_CLASS_REGION_MODE,
    _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

async function mount(peaks: { absStart: number; absEnd: number }[] = [PEAK], datasetIds = ['a']) {
  await act(async () => { root.render(<div data-panel-content-type="footprint-analysis"><ConsensusTools datasetIds={datasetIds} peaks={peaks} /></div>); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const line = () => q('class-region-line')?.textContent;
const run = async () => { await act(async () => { q('run-lattice-consensus')!.click(); }); };

describe('Find classes: which region', () => {
  it('says plainly which region the next run analyses, before it runs (the view by default)', async () => {
    await mount();
    expect(DEFAULT_CLASS_REGION_MODE).toBe('view');
    expect(line()).toBe('Analyses: chr19:47,517,000–47,521,000 · 4,000 bp · this view');
    expect(q('class-region-view')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('class-region-short')).toBeNull();
  });

  it('Selected peaks: the line names the peak, the run sends exactly the peak, and it is short', async () => {
    await mount();
    await act(async () => { q('class-region-peaks')!.click(); });
    expect(useBrowserStore.getState().classRegionMode).toBe('peaks');
    expect(line()).toBe('Analyses: chr19:47,518,060–47,518,500 · 440 bp · the selected peak');
    expect(q('class-region-short')?.textContent).toContain('Short region: classes near its edges may be missed — try This view.');
    await run();
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({
      chrom: 'chr19', start: 47_518_060, end: 47_518_500, region_source: 'peaks', region_label: 'the selected peak' }));
  });

  it('switching to This view sends the view', async () => {
    useBrowserStore.setState({ classRegionMode: 'peaks' } as never);
    await mount();
    await act(async () => { q('class-region-view')!.click(); });
    expect(useBrowserStore.getState().classRegionMode).toBe('view');
    await run();
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({ ...VIEW, region_source: 'view' }));
  });

  it('Selected peaks with no peak selected: uses the view and says why', async () => {
    useBrowserStore.setState({ classRegionMode: 'peaks' } as never);
    await mount([]);
    expect(line()).toBe('Analyses: chr19:47,517,000–47,521,000 · 4,000 bp · this view (no peak selected)');
    expect((q('class-region-peaks') as HTMLButtonElement).disabled).toBe(false); // the current choice stays visible
  });

  it('offers the saved region at this locus and analyses it', async () => {
    useRegionCatalogStore.setState({
      sync: { hg38: 'local' },
      catalogs: { hg38: { version: 1, genome: 'hg38', categories: [{ id: 'c', name: 'Mine' }],
        entries: [{ id: 'r1', chrom: 'chr19', start: 47_516_500, end: 47_520_500, label: 'NAPA', category: 'c', source: 'saved' }] } },
    } as never);
    await mount();
    await act(async () => { q('class-region-region')!.click(); });
    expect(line()).toBe('Analyses: chr19:47,516,500–47,520,500 · 4,000 bp · saved region NAPA');
    await run();
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({ start: 47_516_500, end: 47_520_500, region_source: 'region' }));
  });

  it('no saved region here: no Saved region choice', async () => {
    await mount();
    expect(q('class-region-region')).toBeNull();
  });

  it('outlines the region on the targeted panels while the card is open, and clears it when closed', async () => {
    useBrowserStore.setState({ classRegionMode: 'peaks' } as never);
    await mount();
    expect(useClassRegionOutlineStore.getState().outline).toMatchObject({ chrom: 'chr19', start: 47_518_060, end: 47_518_500, genome: null, datasetIds: ['a'] });
    act(() => root.unmount());
    expect(useClassRegionOutlineStore.getState().outline).toBeNull();
    root = createRoot(host);
  });

  it('the choice is a session setting with undo', () => {
    vi.useFakeTimers();
    function Host() { useSettingsHistory(); return null; }
    const box = document.createElement('div');
    const r = createRoot(box);
    act(() => r.render(<Host />));
    act(() => { useBrowserStore.getState().setClassRegionMode('peaks'); vi.advanceTimersByTime(900); });
    expect(useBrowserStore.getState()._historyStack.map(s => s.label)).toEqual(['Before find classes in: this view', 'Find classes in: Selected peaks']);
    expect(serializeState(useBrowserStore.getState()).classRegionMode).toBe('peaks');
    act(() => { useBrowserStore.getState().undo(); });
    expect(useBrowserStore.getState().classRegionMode).toBe('view');
    expect(deserializeSavedState({ ...serializeState(useBrowserStore.getState()), classRegionMode: 'nonsense' }).classRegionMode).toBe('view');
    act(() => r.unmount());
  });
});

describe('the class region outline', () => {
  it('is drawn dashed over the panels of the analysed datasets only, not in figures', () => {
    useClassRegionOutlineStore.setState({ outline: { chrom: 'chr19', start: 47_518_000, end: 47_519_000, genome: null, genomeKey: 'hg38', datasetIds: ['a'], label: 'Find classes' } });
    const box = document.createElement('div');
    const r = createRoot(box);
    act(() => r.render(<>
      <HighlightBands panel={panel('pa', 'a')} width={400} gutter={0} labels />
      <HighlightBands panel={panel('pb', 'b')} width={400} gutter={0} />
    </>));
    const outlines = box.querySelectorAll<HTMLElement>('[data-testid="class-region-outline"]');
    expect(outlines).toHaveLength(1);
    expect(outlines[0].className).toContain('border-dashed');
    expect(outlines[0].style.left).toBe('100px'); // (47,518,000 − 47,517,000) / 4,000 × 400
    expect(outlines[0].style.width).toBe('100px');
    expect(outlines[0].hasAttribute('data-figure-overlay')).toBe(false);
    act(() => r.unmount());
  });
});

describe('class region helpers', () => {
  it('formats the line, the short threshold and the saved region at a locus', () => {
    expect(classRegionLine({ chrom: 'chr19', start: 47_518_060, end: 47_518_500 }, 'the selected peak'))
      .toBe('chr19:47,518,060–47,518,500 · 440 bp · the selected peak');
    expect(shortClassRegionBp(350)).toBe(700);
    expect(shortClassRegionBp(undefined)).toBe(700);
    const e = (id: string, start: number, end: number) => ({ id, chrom: 'chr19', start, end, label: id, category: 'c', source: 'saved' as const });
    expect(savedRegionAt([e('far', 1, 100), e('big', 47_000_000, 48_000_000), e('fit', 47_517_000, 47_521_000)], VIEW)?.id).toBe('fit');
    expect(savedRegionAt([e('far', 1, 100)], VIEW)).toBeNull();
  });

  it('exported class tables name the analysed region first', () => {
    const tsv = formatRecallerTableTsv([], [], r => r.family, ['analysed: chr19:47,518,060–47,518,500 · 440 bp · the selected peak']);
    expect(tsv.split('\n')[0]).toBe('# analysed: chr19:47,518,060–47,518,500 · 440 bp · the selected peak');
    expect(tsv.split('\n')[1].startsWith('class\tclass_id')).toBe(true);
  });
});

/** Codex review of fb-n5-classregion: the cases it reproduced. */
describe('Find classes region: review regressions', () => {
  const typeStart = async (value: number) => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Consensus start (0-based)"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('"Find classes in this view" sends the view even when Selected peaks was shown', async () => {
    useBrowserStore.setState({ classRegionMode: 'peaks' } as never);
    await mount();
    expect(line()).toContain('the selected peak');
    // Not inside one act(): the command waits for the card to render the view first.
    const done = findFootprintClassesInView();
    for (let i = 0; i < 20 && !api.startConsensus.mock.calls.length; i++) await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    await act(async () => { await done; });
    expect(api.startConsensus).toHaveBeenCalledTimes(1);
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({ ...VIEW, region_source: 'view' }));
  });

  it('coordinates typed by hand are dropped by undo/redo (same choice) and by a session import', async () => {
    await mount();
    await typeStart(47_518_000);
    expect(line()).toBe('Analyses: chr19:47,518,000–47,521,000 · 3,000 bp · coordinates set by hand');
    await act(async () => { useBrowserStore.setState({ _lastRestoreTime: Date.now() } as never); });
    expect(line()).toContain('· this view');
    await typeStart(47_518_000);
    await act(async () => { applyImportedState({ datasets: [], frontend: { sessionName: 'old' } }); });
    expect(line()).toContain('· this view');
  });

  it('a session saved before the choice existed opens with the default, not the open session\'s', () => {
    useBrowserStore.setState({ classRegionMode: 'peaks' } as never);
    applyImportedState({ datasets: [], frontend: { sessionName: 'old' } });
    expect(useBrowserStore.getState().classRegionMode).toBe(DEFAULT_CLASS_REGION_MODE);
    applyImportedState({ datasets: [], frontend: { classRegionMode: 'region' } });
    expect(useBrowserStore.getState().classRegionMode).toBe('region');
  });

  it('while a run is in progress the card names the run\'s region, not where the view moved', async () => {
    await mount();
    await run();
    await act(async () => { useBrowserStore.setState({ start: 47_527_000, end: 47_531_000 } as never); });
    expect(line()).toBe('Analyses: chr19:47,517,000–47,521,000 · 4,000 bp · this view');
    expect(useClassRegionOutlineStore.getState().outline).toMatchObject({ start: 47_517_000, end: 47_521_000, label: 'Finding classes' });
  });

  it('a held outline is never drawn on another reference', () => {
    useClassRegionOutlineStore.setState({ outline: { chrom: 'chr19', start: 47_518_000, end: 47_519_000, genome: null, genomeKey: 'hg19', datasetIds: ['a'], label: 'Find classes' } });
    const box = document.createElement('div');
    const r = createRoot(box);
    act(() => r.render(<HighlightBands panel={panel('pa', 'a')} width={400} gutter={0} />));
    expect(box.querySelector('[data-testid="class-region-outline"]')).toBeNull(); // the main genome is hg38
    act(() => r.unmount());
  });

  it('panels at different loci: after choosing one, its saved region can be chosen', async () => {
    useBrowserStore.setState({
      datasets: [ds('a'), ds('b')] as never, selectedDatasets: new Set(),
      panels: [panel('pa', 'a'), panel('pb', 'b', { navOwn: true, viewportOverride: { chrom: 'chr3', start: 5_000, end: 6_000 } })],
    } as never);
    useRegionCatalogStore.setState({
      sync: { hg38: 'local' },
      catalogs: { hg38: { version: 1, genome: 'hg38', categories: [{ id: 'c', name: 'Mine' }],
        entries: [{ id: 'r1', chrom: 'chr3', start: 4_800, end: 6_200, label: 'AMP', category: 'c', source: 'saved' }] } },
    } as never);
    await mount([], ['a', 'b']);
    expect(q('consensus-region-choice')).not.toBeNull();
    await act(async () => { host.querySelectorAll<HTMLButtonElement>('[data-testid="consensus-region-option"]')[1].click(); });
    expect(line()).toBe('Analyses: chr3:5,000–6,000 · 1,000 bp · the view of b');
    await act(async () => { q('class-region-region')!.click(); });
    expect(q('consensus-region-choice')).toBeNull();
    await run();
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({ chrom: 'chr3', start: 4_800, end: 6_200, region_source: 'region' }));
  });
});

it('runs the selected oriented windows through the registered entry point', async () => {
  const { registerRegionAnalysis } = await import('../../../utils/regionAnalysis');
  const { rigidMatchedRegions } = await import('../../../utils/matchedRegions');
  const runner = vi.fn().mockImplementation(api.startConsensus);
  registerRegionAnalysis({run:runner,link:vi.fn()});
  const s=useBrowserStore.getState();
  const id=s.upsertMatchedGroup({name:'Pair',regions:rigidMatchedRegions([
    {index:0,layer:0,chrom:'chr19',start:47517500,end:47517800},
    {index:1,layer:0,chrom:'chr19',start:47519500,end:47519800},
  ],'chr19')});
  s.selectMatchedGroup(id);
  s.reverseMatchedRegion(useBrowserStore.getState().peaksByRule[id][1].index);
  await mount();
  await act(async()=>q('class-region-matched')!.click());
  expect(line()).toContain('Pair');
  await run();
  expect(runner).toHaveBeenCalledWith(expect.objectContaining({region_source:'matched',region_windows:[
    expect.objectContaining({start:47517500,end:47517800,strand:'+',dataset_id:'a'}),
    expect.objectContaining({start:47519500,end:47519800,strand:'-',dataset_id:'a'}),
  ]}));
});
