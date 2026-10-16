import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCoaccMatrixData, type CoaccMatrixData } from '../../../api/coaccessibility';
import { divergingColor, gridMismatch, referenceMismatch, subtractCoacc } from '../../../utils/coaccDifference';
import { CoaccDifferenceView, scopeSignature } from './CoaccDifferenceView';

vi.mock('../../../api/coaccessibility', () => ({ getCoaccMatrixData: vi.fn() }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const data = (matrix: (number | null)[][], patch: Partial<CoaccMatrixData> = {}): CoaccMatrixData => ({
  matrix, coverage: matrix.map(r => r.map(() => 30)), chrom: 'chr3L', start: 1000, end: 1300, bin_size: 100, n_bins: matrix.length,
  n_reads: 500, normalization: 'raw', marginal_accessibility: matrix.map(() => 0.5), ...patch,
});

describe('A − B of two position matrices', () => {
  it('subtracts cell by cell on one grid: the sign says which is higher, empty cells stay empty', () => {
    const a = data([[1, 0.6, 0.2], [0.6, 1, null], [0.2, null, 1]], { n_reads: 812 });
    const b = data([[1, 0.4, 0.5], [0.4, 1, 0.3], [0.5, 0.3, 1]], { n_reads: 377 });
    const d = subtractCoacc(a, b);
    if ('error' in d) throw new Error(d.error);
    expect(d.matrix[0][1]).toBeCloseTo(0.2);              // higher in A
    expect(d.matrix[0][2]).toBeCloseTo(-0.3);             // higher in B
    expect(d.matrix[0][0]).toBe(0);
    expect(d.matrix[1][2]).toBeNull();
    expect(d.maxAbs).toBeCloseTo(0.3);
    expect([d.readsA, d.readsB]).toEqual([812, 377]);
    expect(d.matrix[1][0]).toBe(d.matrix[0][1]);          // still symmetric
  });
  it('refuses matrices not on the same positions, in plain words', () => {
    const a = data([[1, 0], [0, 1]]);
    expect(gridMismatch(a, data([[1, 0], [0, 1]], { bin_size: 50, n_bins: 2 }))).toMatch(/binned differently/);
    expect(gridMismatch(a, data([[1, 0], [0, 1]], { start: 1100 }))).toMatch(/different positions/);
    expect(gridMismatch(a, data([[1, 0], [0, 1]], { chrom: 'chr2L' }))).toMatch(/different chromosomes/);
    expect(subtractCoacc(a, data([[1]], { n_bins: 2 }))).toEqual({ error: expect.stringContaining("can't be subtracted") });
    expect(referenceMismatch('dm6', 'hg38', 'ind', 'napa')).toMatch(/ind is on dm6 and napa on hg38/);
    expect(referenceMismatch(null, undefined, 'a', 'b')).toBeNull();
  });
  it('a diverging scale centred on 0', () => {
    expect(divergingColor(0, 1)).toBe('rgb(255, 255, 255)');
    expect(divergingColor(1, 1)).toBe('rgb(194, 65, 12)');
    expect(divergingColor(-2, 1)).toBe('rgb(29, 78, 216)');
  });
});

describe('a read scope\'s identity (Codex review)', () => {
  it('changes with any read, not only the first few or the count', () => {
    expect(scopeSignature(['r1', 'r2', 'r3', 'r4'])).not.toBe(scopeSignature(['r1', 'r2', 'r3', 'r5']));
    expect(scopeSignature(['ab', 'c'])).not.toBe(scopeSignature(['a', 'bc']));
    expect(scopeSignature(['r1'])).toBe(scopeSignature(['r1']));
    expect(scopeSignature(undefined)).toBe('all');
    expect(scopeSignature([])).not.toBe('all');
  });
});

describe('the difference view', () => {
  let container: HTMLDivElement; let root: Root;
  const ds = (id: string, reference: string | null = null) => ({ dataset: { id, label: id, path: `/${id}.bam`, color: '#000' }, reference });
  const settings = { normalization: 'raw', scaling: 'linear', colormap: 'fall', minCoverage: 20, binSize: 0, signalType: 'accessibility', layer: null };
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); vi.mocked(getCoaccMatrixData).mockReset(); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const render = async (datasets: ReturnType<typeof ds>[]) => {
    await act(async () => root.render(<CoaccDifferenceView datasets={datasets} chrom="chr3L" start={1000} end={1300} settings={settings}
      readIdsForDataset={id => (id === 'b' ? ['r1', 'r2'] : undefined)} size={200} />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  };

  it('picks the first two datasets, asks B on A\'s bins, and shows A − B with each one\'s reads', async () => {
    vi.mocked(getCoaccMatrixData)
      .mockResolvedValueOnce(data([[1, 0.6], [0.6, 1]], { n_reads: 812, bin_size: 150, n_bins: 2 }))
      .mockResolvedValueOnce(data([[1, 0.2], [0.2, 1]], { n_reads: 377, bin_size: 150, n_bins: 2 }));
    await render([ds('a'), ds('b'), ds('c')]);
    expect((container.querySelector('[data-testid="coacc-diff-a"]') as HTMLSelectElement).value).toBe('a');
    expect((container.querySelector('[data-testid="coacc-diff-b"]') as HTMLSelectElement).value).toBe('b');
    const calls = vi.mocked(getCoaccMatrixData).mock.calls;
    expect(calls[0][3]).toMatchObject({ datasetIds: ['a'], normalization: 'raw', binSize: undefined });
    expect(calls[1][3]).toMatchObject({ datasetIds: ['b'], binSize: 150, readIdsByDataset: { b: ['r1', 'r2'] } });
    expect(container.querySelector('[data-testid="coacc-diff-n"]')!.textContent).toMatch(/a: 812 reads · b: 377 reads/);
    expect(container.querySelector('[data-testid="coacc-diff-canvas"]')!.getAttribute('data-max')).toBe('0.4000');
    expect(container.querySelector('[data-testid="coacc-diff-legend"]')!.textContent).toContain('higher in a');
  });

  it('Swap clears the old difference at once (its labels would not match it) and asks again', async () => {
    vi.mocked(getCoaccMatrixData)
      .mockResolvedValueOnce(data([[1, 0.6], [0.6, 1]], { n_reads: 812 }))
      .mockResolvedValueOnce(data([[1, 0.2], [0.2, 1]], { n_reads: 377 }))
      .mockImplementation(() => new Promise(() => {}));
    await render([ds('a'), ds('b')]);
    expect(container.querySelector('[data-testid="coacc-diff-canvas"]')).not.toBeNull();
    await act(async () => { (container.querySelector('[data-testid="coacc-diff-swap"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="coacc-diff-canvas"]')).toBeNull();
    expect(container.querySelector('[data-testid="coacc-diff-n"]')).toBeNull();
    expect(vi.mocked(getCoaccMatrixData).mock.calls[2][3]).toMatchObject({ datasetIds: ['b'] });
  });

  it('refuses datasets on different references, and one dataset alone', async () => {
    await render([ds('a', 'dm6'), ds('b', 'hg38')]);
    expect(container.querySelector('[data-testid="coacc-diff-refused"]')!.textContent).toMatch(/a is on dm6 and b on hg38/);
    expect(getCoaccMatrixData).not.toHaveBeenCalled();
    await render([ds('a')]);
    expect(container.querySelector('[data-testid="coacc-diff-refused"]')!.textContent).toMatch(/Open two datasets/);
  });

  it('says so when the server answers on another grid', async () => {
    vi.mocked(getCoaccMatrixData)
      .mockResolvedValueOnce(data([[1, 0], [0, 1]], { bin_size: 150, n_bins: 2 }))
      .mockResolvedValueOnce(data([[1, 0, 0], [0, 1, 0], [0, 0, 1]], { bin_size: 100, n_bins: 3 }));
    await render([ds('a'), ds('b')]);
    expect(container.querySelector('[data-testid="coacc-diff-error"]')!.textContent).toMatch(/binned differently/);
    expect(container.querySelector('[data-testid="coacc-diff-canvas"]')).toBeNull();
  });
});
