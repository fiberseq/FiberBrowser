import '../../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { useAccessibilityStore } from '../accessibilityStore';
import * as api from '../api';
import * as coacc from '../../../api/coaccessibility';
import { AccessibilityPanel } from '../AccessibilityPanel';
import { PositionCorrelation } from './PositionCorrelation';
import { COMPLETE_JOB, NFR_RESULT } from './fixture';

vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()),
  getAccessibilityJob: vi.fn(), getAccessibilityJobs: vi.fn(), getNfrOverview: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../../../api/coaccessibility', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/coaccessibility')>()),
  getCoaccMatrixData: vi.fn(), getCoaccMetadata: vi.fn(() => new Promise(() => {})), getCoaccMatrixImageUrl: vi.fn(() => '/m.png'),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find(b => b.textContent === text)!;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const matrix = (m: number[][], n_reads: number, patch: Partial<coacc.CoaccMatrixData> = {}): coacc.CoaccMatrixData => ({
  matrix: m, coverage: m.map(r => r.map(() => 40)), chrom: 'chr19', start: 47517650, end: 47518985, bin_size: 200, n_bins: m.length,
  n_reads, normalization: 'correlation', marginal_accessibility: m.map(() => 0.4), ...patch,
});

describe('NFR pairs: Position correlation', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    vi.mocked(api.getAccessibilityJobs).mockReset().mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }] });
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue(COMPLETE_JOB);
    vi.mocked(coacc.getCoaccMatrixData).mockReset();
    useAccessibilityStore.setState({ jobId: COMPLETE_JOB.job_id, result: NFR_RESULT, panelTab: 'coaccess', pairsMode: 'elements', pairsView: 'arcs', expanded: {}, focus: null } as never);
    useBrowserStore.setState({
      chrom: 'chr19', start: 47517650, end: 47518985,
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6', path: '/a.bam' }, { id: 'ds2', label: 'napa_hia5', color: '#ef4444', path: '/b.bam' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds2', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      selectedDatasets: new Set(), clusterAssignments: {}, clusterOrder: {}, clusterFocus: {}, filteredReadIds: {},
    } as never);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('a mode of the NFR pairs tab: NFR elements or the view\'s position matrix (kept on a remount)', async () => {
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(30);
    expect(q(container, 'nfr-coaccess')).not.toBeNull();
    await click(button(container, 'Position correlation'));
    expect(useAccessibilityStore.getState().pairsMode).toBe('positions');
    expect(q(container, 'nfr-position-correlation')).not.toBeNull();
    expect(q(container, 'nfr-coaccess')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(30);
    expect(q(container, 'nfr-position-correlation')).not.toBeNull();
    await click(button(container, 'NFR elements'));
    expect(q(container, 'nfr-coaccess')).not.toBeNull();
  });

  it('A − B: two open datasets subtracted on one grid, with each one\'s reads', async () => {
    vi.mocked(coacc.getCoaccMatrixData)
      .mockResolvedValueOnce(matrix([[1, 0.5], [0.5, 1]], 2100))
      .mockResolvedValueOnce(matrix([[1, 0.8], [0.8, 1]], 950));
    await act(async () => root.render(<PositionCorrelation />));
    await click(button(container, 'A − B'));
    await wait(20);
    expect((q(container, 'coacc-diff-a') as HTMLSelectElement).value).toBe('ds1');
    expect((q(container, 'coacc-diff-b') as HTMLSelectElement).value).toBe('ds2');
    expect(q(container, 'coacc-diff-n')!.textContent).toMatch(/napa_ddda: 2,100 reads · napa_hia5: 950 reads/);
    expect(q(container, 'coacc-diff-canvas')!.getAttribute('data-max')).toBe('0.3000');   // |0.5 - 0.8|
    const [first, second] = vi.mocked(coacc.getCoaccMatrixData).mock.calls;
    expect(first.slice(0, 3)).toEqual(second.slice(0, 3));                                   // the same window
    expect(second[3]).toMatchObject({ datasetIds: ['ds2'], binSize: 200 });                  // on A's bins
  });

  it('refuses two datasets on different references', async () => {
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === 'p2' ? { ...p, genome: 'dm6' } : p)) }) as never);
    await act(async () => root.render(<PositionCorrelation />));
    await click(button(container, 'A − B'));
    expect(q(container, 'coacc-diff-refused')!.textContent).toMatch(/napa_ddda is on the main genome and napa_hia5 on dm6/);
    expect(coacc.getCoaccMatrixData).not.toHaveBeenCalled();
  });
});
