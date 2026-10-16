import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../../stores/browserStore';
import { HaplotypeComparisonSettings } from './HaplotypeComparisonSettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('HaplotypeComparisonSettings per-view datasets', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chroms: [{ name: 'chr1_mat', size: 50000 }, { name: 'chr1_pat', size: 50000 }],
      datasets: [{ id: 'a', label: 'Sample A' }, { id: 'b', label: 'Sample B' }],
      panels: [],
      navigatorRegions: [],
    } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const setSelect = (select: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('opens View 1 with its datasets and View 2 with its own', async () => {
    await act(async () => root.render(<HaplotypeComparisonSettings embedded />));
    const [select1, select2] = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    await act(async () => { setSelect(select1, 'chr1_mat'); setSelect(select2, 'chr1_pat'); });

    const boxes = container.querySelector('[data-testid="haplotype-view-datasets"]')!.querySelectorAll('fieldset');
    const uncheck = (fieldset: Element, label: string) => [...fieldset.querySelectorAll('label')]
      .find(l => l.textContent?.includes(label))!.querySelector('input')!.click();
    await act(async () => { uncheck(boxes[0], 'Sample B'); });
    await act(async () => { uncheck(boxes[1], 'Sample A'); });

    const open = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Compare Haplotypes'))!;
    await act(async () => { open.click(); });

    const hap = useBrowserStore.getState().panels.filter(p => p.haplotypeGroup);
    expect(hap.map(p => [p.datasetId, p.haplotypeSide, p.viewportOverride?.chrom])).toEqual([
      ['a', 1, 'chr1_mat'],
      ['b', 2, 'chr1_pat'],
    ]);
    // The comparison is active: its clustering controls replace the form.
    expect(container.querySelector('[data-testid="haplotype-clustering-controls"]')).not.toBeNull();
    act(() => useBrowserStore.getState().closeHaplotypeComparison());
  });
});

describe('HaplotypeComparisonSettings region and validation (UI audit M30)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chroms: [{ name: 'chr2R', size: 25_286_936 }, { name: 'chr3R', size: 32_079_331 }],
      datasets: [{ id: 'a', label: 'Sample A' }],
      panels: [],
      navigatorRegions: [],
      chrom: 'chr2R', start: 9_974_319, end: 9_984_319,
    } as any);
  });

  afterEach(() => {
    act(() => useBrowserStore.getState().closeHaplotypeComparison());
    act(() => root.unmount());
    container.remove();
  });

  const setSelect = (select: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const compare = () => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Compare Haplotypes'))!;

  it('an empty region compares the current view, not the first 20 kb', async () => {
    await act(async () => root.render(<HaplotypeComparisonSettings embedded />));
    const [select1, select2] = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    await act(async () => { setSelect(select1, 'chr2R'); setSelect(select2, 'chr3R'); });
    await act(async () => { compare().click(); });
    const views = useBrowserStore.getState().panels.filter(p => p.haplotypeGroup).map(p => p.viewportOverride);
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect([view?.start, view?.end]).toEqual([9_974_319, 9_984_319]);
    }
    expect(views.map(v => v?.chrom).sort()).toEqual(['chr2R', 'chr3R']);
  });

  it('a validation error keeps both choices, and clears when one changes', async () => {
    await act(async () => root.render(<HaplotypeComparisonSettings embedded />));
    const [select1, select2] = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    await act(async () => { setSelect(select1, 'chr2R'); setSelect(select2, 'chr2R'); });
    await act(async () => { compare().click(); });
    expect(container.textContent).toContain('Select two different chromosomes');
    const [after1, after2] = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    expect([after1.value, after2.value]).toEqual(['chr2R', 'chr2R']);
    expect(useBrowserStore.getState().panels.some(p => p.haplotypeGroup)).toBe(false);
    await act(async () => { setSelect(after2, 'chr3R'); });
    expect(container.textContent).not.toContain('Select two different chromosomes');
    expect((container.querySelectorAll('select')[0] as HTMLSelectElement).value).toBe('chr2R');
  });
});
