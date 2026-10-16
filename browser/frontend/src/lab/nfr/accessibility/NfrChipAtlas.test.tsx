import '../../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { NfrChipAtlas } from './NfrChipAtlas';
import { useBrowserStore } from '../../../stores/browserStore';
import { CHIPATLAS_SELECTION_STORAGE_KEY, cellTypesNamedIn } from '../chipAtlasSelection';

vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()),
  getChipAtlasMetadata: vi.fn(), downloadChipAtlasMetadata: vi.fn(), startChipAtlas: vi.fn(), getChipAtlas: vi.fn(), getChipAtlasExperiments: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const data = {
  nfr: 'N1', window: [1000, 2000], spans: { V1: [1100, 1300], V2: [1500, 1700] }, variants: ['V1', 'V2'],
  pinned: { requested: ['vfl', 'Trl', 'Ibf1'], missing: ['Ibf1'], resolved: {}, substituted: {}, defaults: [], species: 'fly' },
} as unknown as api.NfrMotifs;

describe('ChIP-Atlas over an NFR', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'amp_DddB', path: '/x/amp_DddB.full.bam', color: '#000' }], chipAtlasSelections: {} } as never);
    vi.mocked(api.getChipAtlasExperiments).mockReset().mockImplementation(async (_id, factors, sel) => {
      const all = [{ key: 'S2', cell_type_class: 'Cell line', count: 4 }, { key: 'Kc167', cell_type_class: 'Cell line', count: 2 }, { key: '2-4h embryos', cell_type_class: 'Embryo', count: 3 }];
      const ok = (c: { key: string; cell_type_class: string }) => (!sel.cellTypeClasses.length || sel.cellTypeClasses.includes(c.cell_type_class)) && (!sel.cellTypes.length || sel.cellTypes.includes(c.key));
      const matching = all.filter(ok).reduce((n, c) => n + c.count, 0);
      return { present: true, genome: 'dm6', total: 9, matching, cell_type_classes: [{ key: 'Cell line', count: 6 }, { key: 'Embryo', count: 3 }],
        cell_types: all, factors: Object.fromEntries(factors.map(f => [f, matching])) };
    });
    vi.mocked(api.getChipAtlasMetadata).mockReset().mockResolvedValue({ present: true, bytes: 1, progress: { status: 'idle', message: '', loading: false } });
    vi.mocked(api.startChipAtlas).mockReset().mockResolvedValue({ id: 't1', job_id: 'j', status: 'running', done: 0, total: 2, message: '', genome: 'dm6', factors: ['vfl', 'Trl'] });
    vi.mocked(api.getChipAtlas).mockReset().mockResolvedValue({
      id: 't1', job_id: 'j', status: 'complete', done: 2, total: 2, message: 'ok', genome: 'dm6', factors: ['vfl', 'Trl'],
      factors_out: [
        { factor: 'vfl', available: 60, with_peak: 2, experiments: [{ id: 'SRX9', cell_type_class: 'Embryo', cell_type: 'c14', peaks: [[1100, 1250, '500']] },
          { id: 'SRX8', cell_type_class: 'Embryo', cell_type: 'c13', peaks: [[1120, 1260, '300']] }], overlap: { N1: { V1: 1, V2: 0, NFR: 1 } } },
        { factor: 'Trl', available: 0, with_peak: 0, experiments: [], overlap: { N1: { V1: null, V2: null, NFR: null } } },
      ],
      bound: [{ factor: 'vfl', best_share: 1, nfrs: ['N1'] }], region: { chrom: 'chr3L', start: 0, end: 3000 },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('fetches the pinned factors (not the missing ones) and lists the factors ChIP-bound here per variant', async () => {
    await act(async () => root.render(<NfrChipAtlas data={data} jobId="j" names={['V1', 'V2']} width={500} />));
    await wait(20);
    expect((q(container, 'nfr-chipatlas-factors') as HTMLInputElement).value).toBe('vfl, Trl');
    await click(q(container, 'nfr-chipatlas-start'));
    expect(api.startChipAtlas).toHaveBeenCalledWith('j', ['vfl', 'Trl'], 12, { cellTypeClasses: [], cellTypes: [] });
    await wait(1700);
    expect(q(container, 'nfr-chipatlas-bound')!.textContent).toContain('vfl (100% of experiments)');
    expect(q(container, 'nfr-chipatlas-count')!.textContent).toContain('9 of 9 match');   // no cell type in 'amp_DddB': all
    expect(q(container, 'nfr-chipatlas-bound')!.textContent).toContain('no ChIP-Atlas experiment for Trl');
    const row = container.querySelector('[data-factor="vfl"]')!;
    expect(row.textContent).toContain('2/2 with a peak');
    expect(row.textContent).toContain('100%');
  });

  it('asks before the experiment-list download', async () => {
    vi.mocked(api.getChipAtlasMetadata).mockResolvedValue({ present: false, bytes: null, progress: { status: 'idle', message: '', loading: false } });
    vi.mocked(api.downloadChipAtlasMetadata).mockReset().mockResolvedValue({ started: true });
    await act(async () => root.render(<NfrChipAtlas data={data} jobId="j" names={['V1', 'V2']} width={500} />));
    await wait(20);
    expect(q(container, 'nfr-chipatlas-metadata')!.textContent).toContain('about 340 MB');
    expect((q(container, 'nfr-chipatlas-start') as HTMLButtonElement).disabled).toBe(true);
    await click(q(container, 'nfr-chipatlas-download'));
    expect(api.downloadChipAtlasMetadata).toHaveBeenCalled();
  });

  it('filters the experiments by cell type class and cell type, shows how many match, and remembers the choice per assembly', async () => {
    await act(async () => root.render(<NfrChipAtlas data={data} jobId="j" names={['V1', 'V2']} width={500} datasetIds={['ds1']} />));
    await wait(50); await wait(400);
    expect(q(container, 'nfr-chipatlas-count')!.textContent).toContain('9 of 9 match');
    const cls = q(container, 'nfr-chipatlas-class') as HTMLSelectElement;
    await act(async () => { cls.value = 'Cell line'; cls.dispatchEvent(new Event('change', { bubbles: true })); });
    await wait(50); await wait(400);
    expect(q(container, 'nfr-chipatlas-count')!.textContent).toContain('6 of 9 match');
    expect(useBrowserStore.getState().chipAtlasSelections.dm6).toEqual({ cellTypeClasses: ['Cell line'], cellTypes: [] });
    await click(q(container, 'nfr-chipatlas-types-toggle'));
    const s2 = [...container.querySelectorAll<HTMLInputElement>('[data-testid="nfr-chipatlas-type"]')].find(x => x.dataset.type === 'S2')!;
    expect(container.querySelectorAll('[data-testid="nfr-chipatlas-type"]')).toHaveLength(2);    // the class's cell types
    await click(s2);
    await wait(50); await wait(400);
    expect(q(container, 'nfr-chipatlas-count')!.textContent).toContain('4 of 9 match');
    await click(q(container, 'nfr-chipatlas-start'));
    expect(api.startChipAtlas).toHaveBeenCalledWith('j', ['vfl', 'Trl'], 12, { cellTypeClasses: ['Cell line'], cellTypes: ['S2'] });
    expect(JSON.parse(localStorage.getItem(CHIPATLAS_SELECTION_STORAGE_KEY)!).dm6.cellTypes).toEqual(['S2']);
    // reopened: the remembered choice
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<NfrChipAtlas data={data} jobId="j2" names={['V1', 'V2']} width={500} datasetIds={['ds1']} />));
    await wait(50); await wait(400);
    expect(q(container, 'nfr-chipatlas-count')!.textContent).toContain('4 of 9 match');
  });

  it('Check peaks waits for the remembered choice (a slow experiment list does not fetch every experiment; Codex review)', async () => {
    useBrowserStore.setState({ chipAtlasSelections: { dm6: { cellTypeClasses: [], cellTypes: ['S2'] } } } as never);
    let release: () => void = () => {};
    const slow = vi.mocked(api.getChipAtlasExperiments).getMockImplementation()!;
    vi.mocked(api.getChipAtlasExperiments).mockImplementationOnce((...a) => new Promise(r => { release = () => r(slow(...a)); }));
    await act(async () => root.render(<NfrChipAtlas data={data} jobId="j3" names={['V1', 'V2']} width={500} datasetIds={['ds1']} />));
    await wait(50);
    expect((q(container, 'nfr-chipatlas-start') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    await wait(50); await wait(400);
    expect((q(container, 'nfr-chipatlas-start') as HTMLButtonElement).disabled).toBe(false);
    expect(q(container, 'nfr-chipatlas-count')!.textContent).toContain('4 of 9 match');
    await click(q(container, 'nfr-chipatlas-start'));
    expect(api.startChipAtlas).toHaveBeenCalledWith('j3', ['vfl', 'Trl'], 12, { cellTypeClasses: [], cellTypes: ['S2'] });
  });

  it('defaults to the cell types a dataset names (label or file name), else every experiment', async () => {
    expect(cellTypesNamedIn(['S2_DddB', 'run.bam'], ['S2', 'S2R+', 'Kc167'])).toEqual(['S2']);
    expect(cellTypesNamedIn(['K562_rep1'], ['K-562', 'HepG2'])).toEqual(['K-562']);
    expect(cellTypesNamedIn(['amp_DddB'], ['S2', 'Kc167'])).toEqual([]);
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'Kc167 DddB', path: '/x/a.bam', color: '#000' }] } as never);
    await act(async () => root.render(<NfrChipAtlas data={data} jobId="j" names={['V1', 'V2']} width={500} datasetIds={['ds1']} />));
    await wait(50); await wait(400);
    expect(q(container, 'nfr-chipatlas-count')!.textContent).toContain('2 of 9 match');
    expect(q(container, 'nfr-chipatlas-types-toggle')!.textContent).toContain('Kc167');
  });
});
