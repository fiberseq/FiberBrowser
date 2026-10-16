import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../plugins/builtinPanels';
import { useBrowserStore } from '../../stores/browserStore';
import { useVariantsStore } from './variantsState';
import { scan, snp } from './variantsTestData';
import { SnpChannelTrack, snpScanForView, useSnpChannelShown } from './SnpChannelTrack';
import { HighlightBands } from '../../components/tracks/HighlightBands';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const SCAN = scan([snp(8000, { id: 'a' }), snp(9000, { id: 'b' }), snp(9500, { id: 'c', passes: false })]);

beforeEach(() => {
  useVariantsStore.setState({ scans: { k1: SCAN }, latest: { ds1: 'k1' }, scanning: {}, hovered: null });
  useBrowserStore.setState({
    chrom: 'chrSNP', start: 7000, end: 11000, isReversed: false,
    panels: [
      { id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [{ type: 'snps', visible: true }], collapsed: false, linkGroup: 'default', layoutRow: 0 },
      { id: 'panel-variants', contentType: 'variants', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, variants: {} },
    ],
  } as any);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('SNP channel', () => {
  it('draws the passing SNPs in view; click selects one, shift-click adds; hover is shared with the panel', () => {
    act(() => root.render(<SnpChannelTrack width={800} height={44} datasetId="ds1" panelId="p1" />));
    const ticks = () => [...container.querySelectorAll('[data-testid="snp-channel-snp"]')] as HTMLElement[];
    expect(ticks().map(t => t.dataset.snp)).toEqual(['a', 'b']);
    act(() => ticks()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => ticks()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    const variants = useBrowserStore.getState().panels.find(p => p.contentType === 'variants')?.variants;
    expect(variants?.selected).toEqual(['a', 'b']);
    expect(variants?.tab).toBe('snps');
    expect(ticks().filter(t => t.dataset.selected === 'true')).toHaveLength(2);
    act(() => ticks()[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(useVariantsStore.getState().hovered).toBe('b');
  });

  it('shows only for its dataset and a view the scan overlaps', () => {
    expect(snpScanForView(SCAN, 'chrSNP', 10_000, 12_000)).toBe(SCAN);
    expect(snpScanForView(SCAN, 'chrSNP', 11_000, 12_000)).toBeNull();
    expect(snpScanForView(SCAN, 'chr2L', 7000, 11_000)).toBeNull();
    act(() => root.render(<SnpChannelTrack width={800} height={44} datasetId="ds2" panelId="p1" />));
    expect(container.querySelector('[data-testid="snp-channel-ds2"]')).toBeNull();
  });
});

// A panel of the C>A split (chrSNP:9,001 here): its rule as variantSplit.ts writes it.
const SPLIT_SNP = { datasetId: 'ds1', chrom: 'chrSNP', id: '9000:snv:A/C', pos: 9000, kind: 'snv' as const, ref: 'C', alt: 'A', label: 'chrSNP:9,001 C>A' };
function splitPanel(extra: Record<string, unknown> = {}): PanelConfig {
  return {
    id: 'p-ref', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1:split-x:0', subTracks: [{ type: 'snps', visible: true }, { type: 'reads', visible: true }],
    collapsed: false, linkGroup: null, layoutRow: 0,
    readSubset: { groupId: 'split-x', label: 'ref C', colour: '#1f77b4', count: 60, sourcePanelId: 'p1',
      rule: { kind: 'frozen', datasetId: 'ds1', groupKeys: ['0'], readIds: [], splitSnps: [SPLIT_SNP], splitAlleles: ['C'], ...extra } },
  } as PanelConfig;
}
const withSplit = (panel: PanelConfig, variantsOpen = true) => useBrowserStore.setState(s => ({
  highlights: [], currentGenome: 'hg38', fastaPath: null,
  panels: [...s.panels.filter(p => p.contentType !== 'variants' || variantsOpen), panel],
}));

describe('a panel split by SNP allele', () => {
  it('draws the SNP it was split by, its allele as a letter, whatever its own scan found', () => {
    withSplit(splitPanel());
    // The split panel's own scan (its reads only: no SNP at the split SNP), under its key; the dataset's stays.
    const subset = scan([], { scan_key: 'k-sub', target: { datasetId: 'ds1', chrom: 'chrSNP', start: 7000, end: 11000, readIds: ['r1'], panelKey: 'ds1:split-x:0' } });
    act(() => useVariantsStore.getState().putScan(subset));
    expect(useVariantsStore.getState().latest).toEqual({ ds1: 'k1', 'ds1|ds1:split-x:0': 'k-sub' });
    act(() => root.render(<SnpChannelTrack width={800} height={44} datasetId="ds1" panelId="p-ref" />));
    const marker = container.querySelector<HTMLElement>('[data-testid="snp-channel-split"]')!;
    expect(marker.dataset.allele).toBe('C');
    expect(marker.textContent).toBe('C');
    // A filled pill in the allele's colour, a bold white 13-px letter, above the highlight washes (theirs: z-5), opaque.
    expect(marker.style.background).toBe('rgb(31, 95, 191)');
    expect(marker.className).toContain('z-[6]');
    expect(marker.className).toContain('text-white');
    expect(marker.style.fontSize).toBe('13px');
    expect(marker.style.opacity).toBe('');
    expect(marker.dataset.figureOverlayOpacity).toBe('1');
    expect('figureOverlayTop' in marker.dataset).toBe(true);
    expect(marker.querySelector<HTMLElement>('[data-figure-text]')!.dataset.figureText).toBe('C');
    // No scan ticks: just above the reads.
    expect(marker.style.bottom).toBe('1px');
    expect(marker.title).toBe('chrSNP:9,001 C>A — this panel: C (60 reads)');
    expect(container.querySelector('[data-testid="snp-channel-ds1"]')!.textContent).toContain('SNPs (1 split · C)');
    expect(container.querySelectorAll('[data-testid="snp-channel-snp"]')).toHaveLength(0);
    // The source panel still draws the dataset's scan.
    act(() => root.render(<SnpChannelTrack width={800} height={44} datasetId="ds1" panelId="p1" />));
    expect([...container.querySelectorAll<HTMLElement>('[data-testid="snp-channel-snp"]')].map(t => t.dataset.snp)).toEqual(['a', 'b']);
    expect(container.querySelector('[data-testid="snp-channel-split"]')).toBeNull();
  });

  it('shows with the Variants panel closed (a figure of the split), not away from the SNP; old rules as before', () => {
    withSplit(splitPanel(), false);
    let shown: ReturnType<typeof useSnpChannelShown> = () => false;
    function Probe() { shown = useSnpChannelShown(); return null; }
    act(() => root.render(<Probe />));
    const panels = useBrowserStore.getState().panels;
    // Only the split SNP (Variants closed: no scan ticks): the short row.
    expect(shown('ds1', 'chrSNP', 8500, 9500, panels.find(p => p.id === 'p-ref'))).toBe('split');
    expect(shown('ds1', 'chrSNP', 9500, 9900, panels.find(p => p.id === 'p-ref'))).toBe(false);
    expect(shown('ds1', 'chrSNP', 8500, 9500, panels.find(p => p.id === 'p1'))).toBe(false);
    act(() => root.render(<SnpChannelTrack width={800} height={44} datasetId="ds1" panelId="p-ref" />));
    expect(container.querySelectorAll('[data-testid="snp-channel-split"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="snp-channel-snp"]')).toHaveLength(0);
    // A split panel from an older session (no SNP fields): the scan's channel as before.
    const old = splitPanel();
    delete old.readSubset!.rule.splitSnps; delete old.readSubset!.rule.splitAlleles;
    useBrowserStore.setState(s => ({ panels: [...s.panels.filter(p => p.id !== 'p-ref'), old] }));
    expect(shown('ds1', 'chrSNP', 8500, 9500, old)).toBe(false);
    // With the Variants panel open and scan ticks in view, the full row (the pill at the lane's top, clear of them).
    useBrowserStore.setState(s => ({ panels: [...s.panels, { id: 'panel-variants', contentType: 'variants', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, variants: {} } as never] }));
    act(() => root.render(<Probe />));
    expect(shown('ds1', 'chrSNP', 7000, 11000, splitPanel())).toBe('full');
    expect(shown('ds1', 'chrSNP', 7000, 11000, old)).toBe('full');
    useBrowserStore.setState(s => ({ panels: [...s.panels.filter(p => p.id !== 'p-ref'), splitPanel()] }));
    act(() => root.render(<SnpChannelTrack width={800} height={44} datasetId="ds1" panelId="p-ref" />));
    expect(container.querySelectorAll('[data-testid="snp-channel-snp"]').length).toBeGreaterThan(0);
    expect(container.querySelector<HTMLElement>('[data-testid="snp-channel-split"]')!.style.top).toBe('18px');
  });

  it('a dashed guide runs through its reads at the SNP (in figures too); its toggle turns it off', () => {
    withSplit(splitPanel());
    const host = document.createElement('div');
    const r = createRoot(host);
    const bands = (panel: PanelConfig, guides = true) => act(() => r.render(<HighlightBands panel={panel} width={800} gutter={0} guides={guides} />));
    bands(splitPanel());
    const guide = host.querySelector<HTMLElement>('[data-testid="split-snp-guide"]')!;
    expect(guide.dataset.snp).toBe('9000:snv:A/C');
    expect(guide.style.left).toBe(`${((9000.5 - 7000) / 4000) * 800 - 0.75}px`);
    expect(guide.style.width).toBe('1.5px');
    expect(guide.style.borderLeft).toBe('1.5px dashed rgb(55, 65, 81)');
    expect(guide.style.opacity).toBe('0.7');
    expect(guide.dataset.figureOverlay).toBe('#374151');
    expect(guide.dataset.figureOverlayOpacity).toBe('0.7');
    // Not on the other rows, nor in a panel without split SNPs.
    bands(splitPanel(), false);
    expect(host.querySelector('[data-testid="split-snp-guide"]')).toBeNull();
    bands(useBrowserStore.getState().panels.find(p => p.id === 'p1')!);
    expect(host.querySelector('[data-testid="split-snp-guide"]')).toBeNull();
    // The channel's toggle.
    act(() => root.render(<SnpChannelTrack width={800} height={44} datasetId="ds1" panelId="p-ref" />));
    const toggle = container.querySelector<HTMLElement>('[data-testid="snp-channel-guide-toggle"]')!;
    expect(toggle.dataset.renderHide).toBe('true');  // hidden in render mode (renderMode.css)
    act(() => toggle.click());
    const off = useBrowserStore.getState().panels.find(p => p.id === 'p-ref')!;
    expect(off.readSubset!.rule.splitSnpGuide).toBe(false);
    bands(off);
    expect(host.querySelector('[data-testid="split-snp-guide"]')).toBeNull();
    // Left out of figure exports.
    act(() => useBrowserStore.setState({ exportInProgress: true } as never));
    expect(container.querySelector('[data-testid="snp-channel-guide-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="snp-channel-split"]')).not.toBeNull();
    act(() => useBrowserStore.setState({ exportInProgress: false } as never));
    act(() => r.unmount());
  });
});
