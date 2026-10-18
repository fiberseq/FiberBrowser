import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { svsInView } from './api';
import { SvTab, WEAK_SV_CARRIERS, splitWeakSvs } from './SvTab';
import { DEFAULT_SNP_PARAMS } from './api';

vi.mock('./api', async importOriginal => ({ ...(await importOriginal<typeof import('./api')>()), svsInView: vi.fn() }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

const CLUSTERS = [
  { id: 'a', t: 'I' as const, ref: 9_467_039, len: 9_185, end: 9_467_039, support: 3_267, informative: 3_600 },
  { id: 'b', t: 'D' as const, ref: 9_477_821, len: 6_700, end: 9_484_521, support: 1_795, informative: 1_799 },
  { id: 'c', t: 'D' as const, ref: 9_475_177, len: 6_700, end: 9_481_877, support: 1, informative: 1_799 },
];

let container: HTMLDivElement;
let root: Root;
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => [...container.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];

beforeEach(() => {
  vi.mocked(svsInView).mockResolvedValue({ clusters: CLUSTERS, n_reads: 7_225, min_len: 50 });
  useBrowserStore.setState({
    chrom: 'chr2L', start: 9_462_000, end: 9_492_000, svMinLen: 50, selectedFeatures: [],
    datasets: [{ id: 'numb', label: 'numb', path: '/x.bam', data_type: 'bam' }],
    panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'numb', subTracks: [], collapsed: false, linkGroup: 'default', layoutRow: 0 }],
  } as any);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Variants › SVs', () => {
  it('the combined-split bar is there before anything is ticked (rows never move), its buttons disabled', async () => {
    act(() => root.render(<SvTab datasetId="numb" params={DEFAULT_SNP_PARAMS} duplicates={false} />));
    await wait(450);
    const bar = q('variants-sv-combo')!;
    expect(bar.dataset.selected).toBe('0');
    expect((q('variants-sv-combo-group') as HTMLButtonElement).disabled).toBe(true);
    // Tick the first SV by its name (the whole label toggles, not only the box).
    const rows = qa('variants-sv');
    const name = rows[0].querySelector('[data-testid="variants-sv-name"]') as HTMLElement;
    act(() => name.click());
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['I:9467039:9185']);
    // The same bar (same node, before the list), now naming it; the rows after it are the same nodes.
    expect(q('variants-sv-combo')).toBe(bar);
    expect(bar.dataset.selected).toBe('1');
    expect(qa('variants-sv')[0]).toBe(rows[0]);
    expect((q('variants-sv-combo-group') as HTMLButtonElement).disabled).toBe(false);
  });

  it('counts say of what, with an interval; weak calls fold away; Require calls at all selected SVs is on', async () => {
    act(() => root.render(<SvTab datasetId="numb" params={DEFAULT_SNP_PARAMS} duplicates={false} />));
    await wait(450);
    expect(qa('variants-sv')).toHaveLength(2);
    expect(qa('variants-sv-carriers')[0].textContent).toBe('3,267 confirmed of 3,600 informative reads · 91% (95% CI 90–92%) · 0 putative · 0 ambiguous');
    expect(qa('variants-sv-carriers')[1].textContent).toBe('1,795 confirmed of 1,799 informative reads · >99% (95% CI 99.4–>99.9%) · 0 putative · 0 ambiguous');
    expect(q('variants-sv-weak-toggle')!.textContent).toBe(`Show 1 weak call (fewer than ${WEAK_SV_CARRIERS} carriers)`);
    act(() => q('variants-sv-weak-toggle')!.click());
    expect(qa('variants-sv')).toHaveLength(3);
    expect(qa('variants-sv-carriers')[2].textContent).toContain('1 confirmed of 1,799 informative reads · <1%');
    expect((q('variants-sv-require-all-input') as HTMLInputElement).checked).toBe(true);
  });

  it('while the SVs of a new view load, the old rows are greyed and their actions disabled (round 2, N16)', async () => {
    act(() => root.render(<SvTab datasetId="numb" params={DEFAULT_SNP_PARAMS} duplicates={false} />));
    await wait(450);
    expect(q('variants-sv-list')!.dataset.stale).toBeUndefined();
    expect(q('variants-svs-refreshing')).toBeNull();
    let resolve!: (v: any) => void;
    vi.mocked(svsInView).mockReturnValue(new Promise(r => { resolve = r; }));
    act(() => useBrowserStore.setState({ start: 9_600_000, end: 9_630_000 } as any));
    expect(q('variants-sv-list')!.dataset.stale).toBe('true');
    expect(q('variants-svs-refreshing')).not.toBeNull();
    const rowButtons = [...qa('variants-sv')[0].querySelectorAll('button')] as HTMLButtonElement[];
    expect(rowButtons.length).toBeGreaterThan(0);
    expect(rowButtons.every(b => b.disabled)).toBe(true);
    expect((qa('variants-sv')[0].querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    await wait(450);
    await act(async () => { resolve({ clusters: CLUSTERS.slice(1), n_reads: 100, min_len: 50 }); });
    expect(q('variants-sv-list')!.dataset.stale).toBeUndefined();
    expect(([...qa('variants-sv')[0].querySelectorAll('button')] as HTMLButtonElement[]).some(b => !b.disabled)).toBe(true);
  });

  it('a ticked weak call stays listed', () => {
    expect(splitWeakSvs(CLUSTERS, false).shown.map(c => c.id)).toEqual(['a', 'b']);
    expect(splitWeakSvs(CLUSTERS, false, c => c.id === 'c')).toEqual({ shown: CLUSTERS, weak: 0 });
  });

  it('a selection navigated away from: where it is, Go there / Clear, and Group / Split disabled (round 3, R13/B6)', async () => {
    act(() => root.render(<SvTab datasetId="numb" params={DEFAULT_SNP_PARAMS} duplicates={false} />));
    await wait(450);
    // Tick two SVs, then navigate to where neither is.
    act(() => (qa('variants-sv')[0].querySelector('[data-testid="variants-sv-name"]') as HTMLElement).click());
    act(() => (qa('variants-sv')[1].querySelector('[data-testid="variants-sv-name"]') as HTMLElement).click());
    expect(q('variants-sv-offview')).toBeNull();
    vi.mocked(svsInView).mockResolvedValue({ clusters: [], n_reads: 10, min_len: 50 });
    act(() => useBrowserStore.setState({ start: 9_600_000, end: 9_630_000 } as any));
    await wait(450);
    const off = q('variants-sv-offview')!;
    expect(off.textContent).toContain('selected at chr2L:9,467,040–9,484,521 · not in view');
    expect((q('variants-sv-combo-group') as HTMLButtonElement).disabled).toBe(true);
    expect((q('variants-sv-combo-split') as HTMLButtonElement).disabled).toBe(true);
    // The selection wraps rather than being cut.
    expect(q('variants-sv-combo-title')!.className).not.toContain('truncate');
    // Go there: a view with both, at the current width.
    act(() => q('variants-sv-offview-go')!.click());
    const { chrom, start, end } = useBrowserStore.getState();
    expect(chrom).toBe('chr2L');
    expect(start).toBeLessThanOrEqual(9_467_039);
    expect(end).toBeGreaterThanOrEqual(9_484_521);
    expect(end - start).toBe(30_000);
    expect(q('variants-sv-offview')).toBeNull();
    expect((q('variants-sv-combo-group') as HTMLButtonElement).disabled).toBe(false);
    // Away again, Clear drops the selection.
    act(() => useBrowserStore.setState({ start: 9_600_000, end: 9_630_000 } as any));
    act(() => q('variants-sv-offview-clear')!.click());
    expect(useBrowserStore.getState().selectedFeatures).toEqual([]);
    expect(q('variants-sv-offview')).toBeNull();
  });

  it('in view is judged in the view the genotypes are read in: a dataset panel of its own (Codex review)', async () => {
    act(() => root.render(<SvTab datasetId="numb" params={DEFAULT_SNP_PARAMS} duplicates={false} />));
    await wait(450);
    act(() => (qa('variants-sv')[0].querySelector('[data-testid="variants-sv-name"]') as HTMLElement).click());
    // The main view moves away, but the dataset's panel keeps its own view over the SV.
    vi.mocked(svsInView).mockResolvedValue({ clusters: [], n_reads: 10, min_len: 50 });
    act(() => useBrowserStore.setState(s => ({ start: 9_600_000, end: 9_630_000,
      panels: s.panels.map(p => ({ ...p, viewportOverride: { chrom: 'chr2L', start: 9_462_000, end: 9_492_000 } })) }) as any));
    await wait(450);
    expect(q('variants-sv-offview')).toBeNull();
    expect((q('variants-sv-combo-group') as HTMLButtonElement).disabled).toBe(false);
  });

  it('after Split into panels by an SV, the SVs of all the reads it was split from: the split SV and its carriers', async () => {
    // The source panel hidden by its split; the Reference split panel (H1 reads, no carriers) and the Carriers panel
    // opened with the insert expanded (a dataset of its own, on its own contig, without the insertion).
    const subset = (label: string, keys: string[]) => ({ groupId: 'g1', label, colour: '#000', count: 10, sourcePanelId: 'p1',
      rule: { kind: 'frozen', datasetId: 'numb', groupKeys: keys, readIds: ['r1'] } });
    useBrowserStore.setState({
      datasets: [{ id: 'numb', label: 'numb', path: '/x.bam', data_type: 'bam' }, { id: 'alt1', label: 'INS carriers', path: '/alt.bam', data_type: 'bam' }],
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'numb', subTracks: [], collapsed: true, collapsedBySplitGroup: 'g1', linkGroup: 'default', layoutRow: 0 },
        { id: 'pc', contentType: 'dataset', datasetId: 'alt1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, stateKey: 'pc~alt',
          genome: 'contigs:alt1', viewportOverride: { chrom: 'INS_9467039', start: 0, end: 12_000 }, readSubset: subset('Carriers', ['0']) },
        { id: 'pr', contentType: 'dataset', datasetId: 'numb', subTracks: [], collapsed: false, linkGroup: 'default', layoutRow: 0, stateKey: 'pr',
          readSubset: subset('Reference', ['1']) },
      ],
      selectedDatasets: new Set(['pr']),
    } as any);
    for (const chosen of ['numb', 'alt1']) {
      vi.mocked(svsInView).mockClear();
      act(() => root.render(<SvTab key={chosen} datasetId={chosen} params={DEFAULT_SNP_PARAMS} duplicates={false} />));
      await wait(450);
      const target = vi.mocked(svsInView).mock.calls.at(-1)![0];
      expect(target).toEqual({ datasetId: 'numb', chrom: 'chr2L', start: 9_462_000, end: 9_492_000 });
      expect(qa('variants-sv')[0].dataset.sv).toBe('I:9467039:9185');
      expect(q('variants-svs-split-source')).not.toBeNull();
      // Ticking it selects the source dataset's SV (the SV row of the Reference panel is that dataset's).
      act(() => (qa('variants-sv')[0].querySelector('[data-testid="variants-sv-name"]') as HTMLElement).click());
      expect(useBrowserStore.getState().selectedFeatures.map(f => [f.datasetId, f.id])).toEqual([['numb', 'I:9467039:9185']]);
      act(() => useBrowserStore.setState({ selectedFeatures: [] } as any));
    }
  });

  it('without a split, the selected panel\'s reads as before (no source note)', async () => {
    act(() => root.render(<SvTab datasetId="numb" params={DEFAULT_SNP_PARAMS} duplicates={false} />));
    await wait(450);
    expect(vi.mocked(svsInView).mock.calls.at(-1)![0]).toMatchObject({ datasetId: 'numb', chrom: 'chr2L' });
    expect(q('variants-svs-split-source')).toBeNull();
  });
});
