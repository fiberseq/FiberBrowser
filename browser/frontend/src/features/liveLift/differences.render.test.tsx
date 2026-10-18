import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DifferencesStrip } from './DifferencesStrip';
import { getDifferenceReads, getDifferences } from './api';
import { useBrowserStore } from '../../stores/browserStore';
import { useLiveLiftStore } from './store';
import { useDifferenceSelection } from './inspectionStore';
import { PanelDisplayContext } from '../../hooks/usePanelDisplayStore';
import { useLiveLiftAxis } from './useLiveLiftAxis';
import { ExpansionOverlay } from './ExpansionOverlay';
import { useReadTrackMouse } from '../../components/tracks/read-track/useReadTrackMouse';
import { useReadActionsStore } from '../../stores/readActionsStore';
import type { Dataset, PanelConfig } from '../../types';
import type { CompactRead } from '../../components/tracks/read-track/types';
import type { Difference, DifferencesResponse } from './differenceTypes';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), getDifferences: vi.fn(), getDifferenceReads: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const dataset: Dataset = { id: 'lift', label: 'Lift', path: '/source.bam', color: '#000', data_type: 'bam_livelift',
  live_lift: { key: 'key-1', manifest: 'map.json', map_label: 'map', settings: {}, haplotypes: ['h1', 'h2'], haplotype_labels: { h1: 'MAT', h2: 'PAT' } } };
const panel: PanelConfig = { id: 'mat', contentType: 'dataset', datasetId: 'lift', liftHap: 'MAT', stateKey: 'mat-state', linkGroup: null, layoutRow: 0, subTracks: [], collapsed: false };
const native: PanelConfig = { ...panel, id: 'native', datasetId: 'native', liftHap: undefined };
const diff: Difference = { id: 'MAT:src:100-2453:insertion', hap: 'h1', hap_label: 'MAT', kind: 'insertion', reason: 'source_insertion', source: 'assembly',
  t_start: 500, t_end: 500, ref_bp: 0, alt_bp: 2353, chain: 1, strand: '+', src: { contig: 'src', start: 100, end: 2453 }, grch38: '', alt: null };
const response = (items = [diff]): DifferencesResponse => ({ dataset_id: 'lift', lift_key: 'key-1', chrom: 'chr1', start: 0, end: 1000, mode: 'items', items, bins: [], bin_bp: null, novel: [] });
let host: HTMLDivElement, root: Root;
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(160); }); };
beforeEach(() => {
  vi.useFakeTimers(); vi.mocked(getDifferences).mockReset(); vi.mocked(getDifferenceReads).mockReset();
  vi.mocked(getDifferences).mockResolvedValue(response());
  vi.mocked(getDifferenceReads).mockResolvedValue({ dataset_id: 'lift', lift_key: 'key-1', chrom: 'chr1', pos: 500, end: 500, rows: [], summary: {}, capped: false, max_records: 500 });
  useLiveLiftStore.setState({ enabled: true });
  useBrowserStore.setState({ chrom: 'chr1', start: 0, end: 1000, chroms: [{ name: 'chr1', size: 100000 }], datasets: [dataset], panels: [panel, native], liveLiftExpansions: {}, isReversed: false });
  useDifferenceSelection.getState().select(null); useReadActionsStore.getState().reset();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
const renderStrip = (p = panel) => act(() => root.render(<PanelDisplayContext.Provider value={p.id}><DifferencesStrip panel={p} dataset={dataset} width={1000} /></PanelDisplayContext.Provider>));

describe('differences strip and inspection', () => {
  it('is flag gated and debounces the dataset, lift key, haplotype and view', async () => {
    useLiveLiftStore.setState({ enabled: false }); renderStrip(); await settle();
    expect(host.querySelector('[data-testid="live-lift-diff-strip"]')).toBeNull(); expect(getDifferences).not.toHaveBeenCalled();
    act(() => useLiveLiftStore.setState({ enabled: true })); await settle();
    expect(getDifferences).toHaveBeenCalledWith(expect.objectContaining({ datasetId: 'lift', liftKey: 'key-1', liftHap: 'MAT', start: 0, end: 1000 }), expect.any(AbortSignal));
    const signal = vi.mocked(getDifferences).mock.calls[0][1]!;
    act(() => useBrowserStore.setState({ start: 100, end: 1100 })); expect(signal.aborted).toBe(true);
    await settle(); expect(getDifferences).toHaveBeenCalledTimes(2);
  });
  it('renders pooled MAT/PAT lanes and an expandable +2.4 kb item', async () => {
    renderStrip({ ...panel, liftHap: undefined }); await settle();
    expect(host.textContent).toContain('MAT'); expect(host.textContent).toContain('PAT'); expect(host.textContent).toContain('+2.4 kb');
    click(host.querySelector('[data-testid="live-lift-diff-item"]')!);
    await settle();
    expect(useBrowserStore.getState().liveLiftExpansions.main[0].length).toBe(2353);
    expect(document.querySelector('[data-testid="live-lift-diff-popover"]')?.textContent).toContain('Split by carrier is unavailable');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[data-testid="live-lift-diff-popover"]')).toBeNull();
  });
  it('fetches ahead for next and moves the view, carrying the minimum-size filter', async () => {
    const next = { ...diff, id: 'next', t_start: 1700, t_end: 1700 };
    vi.mocked(getDifferences).mockResolvedValueOnce(response()).mockResolvedValue(response([next]));
    renderStrip({ ...panel, liveLiftMinBp: 50 }); await settle();
    await act(async () => { host.querySelector('[data-testid="live-lift-diff-next"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useBrowserStore.getState().start).toBe(1200); expect(useBrowserStore.getState().end).toBe(2200);
    expect(vi.mocked(getDifferences).mock.calls[1][0]).toMatchObject({ minBp: 50, start: 1000, detailBp: 10001 });
  });
  it('renders alleles and mis-phasing, and uses existing read outlines on hover without refetching reads', async () => {
    vi.mocked(getDifferenceReads).mockResolvedValue({ dataset_id: 'lift', lift_key: 'key-1', chrom: 'chr1', pos: 500, end: 501,
      rows: ['hg002', 'grch38'].map((allele, i) => ({ id: `r${i}`, molecule: `r${i}`, record: 'rec', hap_label: 'MAT', strand: 'CT', supplementary: false,
        source_pos: { contig: 'src', start: 100, end: 101 }, read_bases: i ? 'A' : 'C', hg002: 'C', grch38: 'A', allele,
        chromatin: { state: 'nucleosome', layer: 'nuc', nearest_m6a_bp: 4, orientation: '+' } })) as never,
      summary: {}, capped: false, max_records: 500 });
    vi.mocked(getDifferences).mockResolvedValue(response([{ ...diff, id: 'snv', kind: 'snv', t_end: 501, ref_bp: 1, alt_bp: 1 }]));
    renderStrip(); await settle(); click(host.querySelector('[data-testid="live-lift-diff-item"]')!); await settle();
    expect(document.querySelector('[data-testid="live-lift-misphased"]')?.textContent).toContain('1 GRCh38-allele');
    expect(document.querySelector('table')?.textContent).toContain('nucleosome (nuc) · m6A 4 bp');
    expect([...useReadActionsStore.getState().highlight!.ids]).toEqual(['r0']);
    expect(useReadActionsStore.getState().pinnedReadIds).toEqual([]);
    act(() => document.querySelectorAll('tbody tr')[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect([...useReadActionsStore.getState().highlight!.ids]).toEqual(['r1']);
  });
});

describe('badge click and sibling axes', () => {
  it('clicking a badge expands its canonical ID and the native sibling gets the same gap; collapse restores both', () => {
    let handlers: ReturnType<typeof useReadTrackMouse>;
    const badge: NonNullable<CompactRead['live_lift']>['badges'] = [[500, 'source_insertion', 2353, 2353, 'I']];
    const read: CompactRead = { id: 'r', intervals: [[0, 1000, -1000]], live_lift: { v: 1, hap_label: 'MAT', segments: [[0, 1000, 1, '+', true]],
      badges: badge, badge_ids: [diff.id], insertions: { [diff.id]: { pos: 500, length: 2353, mol_bp: 2353, src: ['src', 100, 2453], hap_label: 'MAT', orientation: '+', covered: [0, 2353], intervals: [[50, 200, 150]] } } } };
    function Mouse() {
      const { axis } = useLiveLiftAxis('chr1', 0, 1000, 1000, false);
      handlers = useReadTrackMouse({ displayReads: [read], width: 1000, height: 200, sidebarWidth: 0, regionWidth: 1000, start: 0, end: 1000, axis,
        chrom: 'chr1', datasetId: 'lift', stateKey: 'mat-state', hasCluster: false, myClusterAssignments: {}, myClusterOrder: [], myClusterFocus: null,
        mySelectedClusters: null, hasClusterFocus: false, isPanning: false, isReversed: false, fillReadHeight: false, storeReadRowHeight: 20, readScrollOffset: 0,
        readSeparatorMode: 'off', readSeparatorMinHeight: 0, readSeparatorWidth: 0, showReadTooltip: false, showCoverageHistogram: false });
      return null;
    }
    function Sibling() {
      const { axis, viewKey } = useLiveLiftAxis('chr1', 0, 1000, 1000, false);
      return <ExpansionOverlay axis={axis} viewKey={viewKey} />;
    }
    act(() => root.render(<><PanelDisplayContext.Provider value="mat"><Mouse /><Sibling /></PanelDisplayContext.Provider><PanelDisplayContext.Provider value="native"><Sibling /></PanelDisplayContext.Provider></>));
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: 1000 }); Object.defineProperty(canvas, 'clientHeight', { value: 200 });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200 } as DOMRect);
    act(() => handlers!.handleClick({ currentTarget: canvas, clientX: 501, clientY: 8, shiftKey: false, ctrlKey: false, metaKey: false } as never));
    expect(useBrowserStore.getState().liveLiftExpansions.main[0].ins_id).toBe(diff.id);
    expect(host.querySelectorAll('[data-testid="live-lift-expanded-block"]')).toHaveLength(2);
    expect(getDifferences).not.toHaveBeenCalled(); expect(getDifferenceReads).not.toHaveBeenCalled();
    click(host.querySelector('[data-testid="live-lift-expanded-collapse"]')!);
    expect(host.querySelectorAll('[data-testid="live-lift-expanded-block"]')).toHaveLength(0);
  });
});
