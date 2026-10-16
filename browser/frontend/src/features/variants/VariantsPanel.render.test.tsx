import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../plugins/builtinPanels';
import { useBrowserStore } from '../../stores/browserStore';
import { groupByAlleles, scanSnps } from './api';
import { openInsertionLens } from '../insertion/insertionLensTarget';
import { VariantsPanel } from './VariantsPanel';
import { scan, snp } from './variantsTestData';
import { updateVariantsState, useVariantsStore } from './variantsState';

vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  scanSnps: vi.fn(), groupByAlleles: vi.fn(), svsInView: vi.fn(() => new Promise(() => {})),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

const SNPS = [snp(8000, { id: '8000:snv:T/G', ref: 'T', alleles: ['G', 'T'], alt: 'G' }), snp(9000, { id: '9000:snv:A/G' })];

function grouping(counts: number[]) {
  const groups = counts.map((n, i) => ({ id: i, key: `K${i}`, label: `K${i}`, alleles: [], count: n, kind: 'combo' as const }));
  const assignments: Record<string, number> = {};
  groups.forEach(g => { for (let r = 0; r < g.count; r++) assignments[`${g.key}/${r}`] = g.id; });
  return { groups, assignments, n_reads: 32, covering: 32, threshold: 3, distinct: counts.length, snps: SNPS.map(s => s.id), phase: null,
    tags: null, scan_key: 'k1', dataset_id: 'ds1', region: { chrom: 'chrSNP', start: 7000, end: 11000 }, mode: 'basecall' };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.mocked(scanSnps).mockReset();
  vi.mocked(groupByAlleles).mockReset();
  vi.mocked(scanSnps).mockResolvedValue(scan(SNPS));
  useVariantsStore.setState({ scans: {}, latest: {}, scanning: {}, hovered: null });
  useBrowserStore.setState({
    chrom: 'chrSNP', start: 7000, end: 11000, showDuplicateReads: false, _historyStack: [], _historyPointer: -1,
    datasets: [{ id: 'ds1', label: 'snp_demo', path: '/x.bam', data_type: 'bam' }],
    panels: [
      { id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [{ type: 'reads', visible: true }], collapsed: false, linkGroup: 'default', layoutRow: 0 },
      { id: 'panel-variants', contentType: 'variants', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
    ],
  } as any);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];

describe('Variants panel', () => {
  it('Clear empties the scan and the selection (and forgets them for the next open)', async () => {
    act(() => root.render(<VariantsPanel />));
    await wait(650);
    act(() => qa('variants-row')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(q('variants-table')).not.toBeNull();
    act(() => q('variants-clear')!.click());
    expect(q('variants-table')).toBeNull();
    expect(useBrowserStore.getState().panels.find(p => p.contentType === 'variants')?.variants).toBeUndefined();
  });

  it('the header names the SNP scan of this region as such on every tab, and one of another view as the last (round 2 N16, round 3 R14d)', async () => {
    act(() => root.render(<VariantsPanel />));
    await wait(650);
    const region = () => q('variants-region')!;
    expect(region().textContent).toMatch(/^· SNP scan for this region: chrSNP:7,001–11,000/);
    expect(region().dataset.stale).toBeUndefined();
    act(() => updateVariantsState({ tab: 'svs' }));
    expect(region().textContent).toMatch(/^· SNP scan for this region: chrSNP:7,001–11,000/);
    // Another view since: the last scan, said so.
    act(() => useBrowserStore.setState({ start: 20_000, end: 24_000 } as any));
    expect(region().textContent).toMatch(/^· Last SNP scan \(another view\): chrSNP:7,001–11,000/);
    expect(region().dataset.stale).toBe('true');
    act(() => useBrowserStore.setState({ start: 7000, end: 11000 } as any));
    // (The panel remembers its tab for the next open: back to SNPs for the tests after this one.)
    act(() => updateVariantsState({ tab: 'snps' }));
  });

  it('uses the selected panel region for all dataset layouts', () => {
    act(() => root.render(<VariantsPanel />));
    expect(q('variants-scope')?.textContent).toBe('· selected panel region');
    act(() => useBrowserStore.setState(s => ({ panels: [...s.panels, { id: 'p2', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false,
      linkGroup: null, layoutRow: 0, readSubset: { groupId: 'g', label: 'Carriers', colour: '#f00', count: 1, sourcePanelId: 'p1', rule: { kind: 'frozen', datasetId: 'ds1', groupKeys: ['0'] } } }] }) as any));
    expect(q('variants-scope')?.textContent).toBe('· selected panel region');
  });

  it('scans the view (debounced, once), lists the SNPs, and selects with click and shift-click', async () => {
    act(() => root.render(<VariantsPanel />));
    expect(scanSnps).not.toHaveBeenCalled();
    await wait(650);
    expect(scanSnps).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scanSnps).mock.calls[0][0]).toEqual({ datasetId: 'ds1', chrom: 'chrSNP', start: 7000, end: 11000 });
    expect(qa('variants-row').map(r => r.dataset.snp)).toEqual(['8000:snv:T/G', '9000:snv:A/G']);
    expect(q('variants-summary')?.textContent).toContain('2 SNPs');
    act(() => qa('variants-row')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => qa('variants-row')[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    const panel = useBrowserStore.getState().panels.find(p => p.contentType === 'variants');
    expect(panel?.variants?.selected).toEqual(['8000:snv:T/G', '9000:snv:A/G']);
    expect(panel?.variants?.scan?.snps).toHaveLength(2);   // kept for the session
    expect(q('variants-selected')?.textContent).toBe('2 selected');
    // A pan: scanned again after the pause, the pending one cancelled.
    act(() => useBrowserStore.setState({ start: 7100 } as any));
    act(() => useBrowserStore.setState({ start: 7200 } as any));
    await wait(650);
    expect(scanSnps).toHaveBeenCalledTimes(2);
    expect(vi.mocked(scanSnps).mock.calls[1][0].start).toBe(7200);
  });

  it('splits the selected SNPs by combination: the panel count, a warning over the limit, then the panels', async () => {
    vi.mocked(groupByAlleles).mockResolvedValue(grouping([14, 10, 8]) as any);
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.contentType === 'variants' ? { ...p, variants: { selected: SNPS.map(x => x.id) } } : p)) }));
    act(() => root.render(<VariantsPanel />));
    await wait(650);
    await act(async () => { q('variants-split')!.click(); });
    await wait(10);
    expect(vi.mocked(groupByAlleles).mock.calls[0][3]).toMatchObject({ source: 'selected', snps: SNPS.map(x => x.id), asCombination: true });
    const dialog = document.querySelector('[data-testid="variant-split-dialog"]')!;
    expect(dialog.querySelector('h2')?.textContent).toBe('Split into panels by 8,001/9,001');
    expect(qa('variant-split-row').map(r => r.textContent)).toEqual(['K014 reads', 'K110 reads', 'K28 reads']);
    expect(document.querySelector('[data-testid="variant-split-count"]')?.getAttribute('data-verdict')).toBe('ok');
    expect(document.querySelector('[data-testid="variant-split-count"]')?.textContent).toContain('Opens 3 panels');
    // Ask before more than 2 panels.
    const limit = document.querySelector('[data-testid="variant-split-soft-limit"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(limit, '2');
      limit.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="variant-split-count"]')?.getAttribute('data-verdict')).toBe('confirm');
    const open = () => (document.querySelector('[data-testid="variant-split-open"]') as HTMLButtonElement);
    act(() => open().click());
    expect(document.querySelector('[data-testid="variant-split-confirm"]')?.textContent).toContain('Open 3 panels?');
    expect(useBrowserStore.getState().panels.filter(p => p.readSubset)).toHaveLength(0);
    act(() => open().click());
    const split = useBrowserStore.getState().panels.filter(p => p.readSubset);
    expect(split.map(p => [p.readSubset!.label, p.readSubset!.count, p.readSubset!.rule.kind])).toEqual([
      ['8,001/9,001 · K0', 14, 'frozen'], ['8,001/9,001 · K1', 10, 'frozen'], ['8,001/9,001 · K2', 8, 'frozen']]);
    expect(split[1].readSubset!.rule.readIds).toHaveLength(10);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p1')?.collapsed).toBe(true);
    expect(document.querySelector('[data-testid="variant-split-dialog"]')).toBeNull();
    expect(useBrowserStore.getState().panels.find(p => p.contentType === 'variants')?.variants?.splitSoftLimit).toBe(2);
  });

  it('refuses a split over the hard limit', async () => {
    vi.mocked(groupByAlleles).mockResolvedValue(grouping(Array.from({ length: 20 }, (_, i) => 40 - i)) as any);
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.contentType === 'variants' ? { ...p, variants: { selected: SNPS.map(x => x.id) } } : p)) }));
    act(() => root.render(<VariantsPanel />));
    await wait(650);
    await act(async () => { q('variants-split')!.click(); });
    await wait(10);
    // The top 4 of 20 ticked by default: 4 panels.
    expect(document.querySelector('[data-testid="variant-split-count"]')?.textContent).toContain('Opens 4 panels');
    const top = document.querySelector('[data-testid="variant-split-top"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(top, '18');
      top.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="variant-split-count"]')?.getAttribute('data-verdict')).toBe('refuse');
    expect((document.querySelector('[data-testid="variant-split-open"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Combinations: groups the reads once per request, lists them, and stops saying it is grouping', async () => {
    vi.mocked(groupByAlleles).mockResolvedValue({ ...grouping([14, 10, 8]), phase: { diploid: false, message: 'Not a two-haplotype pattern' } } as any);
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.contentType === 'variants' ? { ...p, variants: { tab: 'combos', selected: SNPS.map(x => x.id) } } : p)) }));
    act(() => root.render(<VariantsPanel />));
    await wait(650);   // the scan
    await wait(400);   // the grouping (debounced)
    expect(groupByAlleles).toHaveBeenCalledTimes(1);
    expect(qa('variants-combo').filter(e => e.dataset.kind === 'combo').map(e => e.dataset.count)).toEqual(['14', '10', '8']);
    expect(q('variants-combos-loading')).toBeNull();
    expect(q('variants-phase')?.textContent).toContain('Not a two-haplotype');
    // Saved for the session (without read names).
    const saved = useBrowserStore.getState().panels.find(p => p.contentType === 'variants')?.variants?.grouping;
    expect(saved?.groups).toHaveLength(3);
    expect(saved && 'assignments' in saved).toBe(false);
    await wait(400);
    expect(groupByAlleles).toHaveBeenCalledTimes(1);
  });

  it('never shows or splits by the groups of an earlier selection', async () => {
    vi.mocked(groupByAlleles).mockResolvedValueOnce(grouping([14, 10, 8]) as any).mockReturnValue(new Promise(() => {}));
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.contentType === 'variants' ? { ...p, variants: { tab: 'combos', selected: SNPS.map(x => x.id) } } : p)) }));
    act(() => root.render(<VariantsPanel />));
    await wait(650);   // the scan (act flushes its render when it ends)
    await wait(400);   // the grouping
    expect(qa('variants-combo').filter(e => e.dataset.kind === 'combo')).toHaveLength(3);
    // One SNP deselected: the three combinations were for two SNPs. Not shown, not splittable, while the new ones load.
    act(() => useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.contentType === 'variants' ? { ...p, variants: { ...p.variants, selected: [SNPS[0].id] } } : p)) })));
    await wait(400);
    expect(groupByAlleles).toHaveBeenCalledTimes(2);
    expect(qa('variants-combo')).toHaveLength(0);
    expect(q('variants-combos-split')).toBeNull();
  });

  it('a new view cancels a manual scan (Auto off) and drops its result', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(scanSnps).mockImplementation((_t, _p, _d, s) => { signal = s; return new Promise(() => {}); });
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.contentType === 'variants' ? { ...p, variants: { autoScan: false } } : p)) }));
    act(() => root.render(<VariantsPanel />));
    await act(async () => { q('variants-scan')!.click(); });
    expect(signal?.aborted).toBe(false);
    act(() => useBrowserStore.setState({ start: 7500 } as any));
    expect(signal?.aborted).toBe(true);
  });

  it('is supported (no Preview mark): its known limitations (local patterns, not phasing) and no lens tab (the lens is its own panel)', async () => {
    act(() => root.render(<VariantsPanel />));
    expect(q('variants-panel')?.dataset.tab).toBe('snps');
    expect(q('variants-limitations')?.textContent).toMatch(/Known limitations/);
    expect(q('variants-limitations')?.textContent).toMatch(/local read-supported patterns/);
    expect(q('variants-limitations')?.textContent).not.toMatch(/Leaving Preview/);
    expect(q('preview-limitations')).toBeNull();
    expect(container.querySelectorAll('[data-testid="preview-badge"]')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Insertion lens/);
    act(() => openInsertionLens({ datasetId: 'ds1', chrom: 'chrSNP', pos: 9000, seek: true }));
    expect(q('variants-panel')?.dataset.tab).toBe('snps');
    expect(useBrowserStore.getState().panels.find(p => p.contentType === 'insertion-lens')?.insertionLens).toMatchObject({ pos: 9000 });
  });

  it('restores a saved scan without scanning again when Auto is off', async () => {
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.contentType === 'variants' ? { ...p, variants: { autoScan: false, scan: scan(SNPS), selected: ['9000:snv:A/G'] } } : p)) }));
    act(() => root.render(<VariantsPanel />));
    await wait(650);
    expect(scanSnps).not.toHaveBeenCalled();
    expect(qa('variants-row')).toHaveLength(2);
    expect(qa('variants-row')[1].dataset.selected).toBe('true');
  });

  it('with no BAM open, the one empty-state wording (round 3, R12)', () => {
    useBrowserStore.setState({ datasets: [], panels: [{ id: 'v', contentType: 'variants', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }] } as any);
    act(() => root.render(<VariantsPanel />));
    expect(q('variants-empty')?.textContent).toContain('Open a BAM or choose one in the Library');
  });
});


it('a signal-filter change cancels the old scan and refetches the same panel', async () => {
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.contentType === 'variants' ? { ...p, variants: { autoScan: true } } : p) }));
  let answer!: (value: ReturnType<typeof scan>) => void;
  vi.mocked(scanSnps).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  act(() => root.render(<VariantsPanel />));
  await wait(650);
  const oldSignal = vi.mocked(scanSnps).mock.calls[0][3]!;
  act(() => useBrowserStore.getState().setSignalFilters({ requireDetectable: true }));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => { answer(scan(SNPS, { scan_key: 'obsolete' })); });
  expect(useVariantsStore.getState().scans.obsolete).toBeUndefined();
  await wait(650);
  expect(scanSnps).toHaveBeenCalledTimes(2);
  expect(useVariantsStore.getState().latest.ds1).toBeTruthy();
});
