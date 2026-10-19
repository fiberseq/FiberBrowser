import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DifferencesStrip } from './DifferencesStrip';
import { getDifferenceReads, getDifferences } from './api';
import { useBrowserStore } from '../../stores/browserStore';
import { useLiveLiftStore } from './store';
import { expandDifference, selectMapGap, selectReadDifference, useDifferenceSelection } from './inspectionStore';
import { clearDifferenceCache, rememberDifferences } from './differenceCache';
import { PanelDisplayContext } from '../../hooks/usePanelDisplayStore';
import { useLiveLiftAxis } from './useLiveLiftAxis';
import { ExpansionOverlay } from './ExpansionOverlay';
import { makeAxis } from './axis';
import { useReadTrackMouse } from '../../components/tracks/read-track/useReadTrackMouse';
import { SvTooltip } from '../../components/tracks/read-track/SvTooltip';
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
  clearDifferenceCache();
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
  it('shows the selected parent first, an agreeing other-parent summary, and only a haplotype chip without st', async () => {
    const snv: Difference = { ...diff, id: 'MAT:src:100-101:snv', kind: 'snv', t_end: 501, ref_bp: 1, alt_bp: 1, grch38: 'A', alt: null };
    const row = { id: 'mat', molecule: 'mat', record: 'record', hap_label: 'MAT', strand: null, supplementary: false,
      source_pos: { contig: 'src', start: 100, end: 101 }, read_bases: 'C', hg002: 'C', grch38: 'A', allele: 'hg002' as const,
      chromatin: { state: 'none' as const, layer: null, nearest_m6a_bp: null, orientation: '+' as const } };
    vi.mocked(getDifferences).mockResolvedValue(response([snv]));
    vi.mocked(getDifferenceReads).mockResolvedValue({ dataset_id: 'lift', lift_key: 'key-1', chrom: 'chr1', pos: 500, end: 501,
      rows: [...Array.from({ length: 35 }, (_, i) => ({ ...row, id: `pat-${i}`, molecule: `pat-${i}`, hap_label: 'PAT',
        read_bases: 'A', hg002: 'A', allele: 'same_as_grch38' as const })), row], summary: {}, capped: false, max_records: 500 });
    renderStrip(); await settle(); click(host.querySelector('[data-testid="live-lift-diff-item"]')!); await settle();
    expect(getDifferenceReads).toHaveBeenCalledWith(expect.objectContaining({ itemId: snv.id, liftHap: 'MAT' }), expect.any(AbortSignal));
    const first = document.querySelector('tbody tr')!;
    expect(first.getAttribute('data-hap')).toBe('MAT'); expect(first.getAttribute('data-allele')).toBe('hg002');
    expect(first.children[1].textContent).toBe('● MAT');
    expect(document.querySelector('[data-testid="live-lift-other-hap-summary"]')?.textContent).toBe('PAT: no difference here, 35 reads agree with GRCh38');
    expect(document.querySelector('[data-testid="live-lift-misphased"]')).toBeNull();
    expect(document.querySelector('table')?.textContent).not.toContain('/ ?');
    expect(document.querySelector('[data-testid="live-lift-diff-popover"]')?.textContent).toContain('GRCh38: A · HG002: C');
  });
  it('renders insertion previews with their full length and identity separately from carriage', async () => {
    vi.mocked(getDifferenceReads).mockResolvedValue({ dataset_id: 'lift', lift_key: 'key-1', chrom: 'chr1', pos: 500, end: 500,
      rows: [{ id: 'noisy', molecule: 'noisy', record: 'record', hap_label: 'MAT', strand: null, supplementary: false,
        source_pos: { contig: 'src', start: 100, end: 2453 }, read_bases: 'A'.repeat(60), read_bases_length: 2350,
        hg002: null, grch38: '', allele: 'hg002', carries_insertion: true, mol_bp: 2350, identity: 97.3,
        chromatin: { state: 'none', layer: null, nearest_m6a_bp: null, orientation: '+' } }], summary: {}, capped: false, max_records: 500 });
    renderStrip(); await settle(); click(host.querySelector('[data-testid="live-lift-diff-item"]')!); await settle();
    expect(document.querySelector('table')?.textContent).toContain('(2,350 bp)');
    expect(document.querySelector('table')?.textContent).toContain('97.3%');
  });
});

describe('badge click and sibling axes', () => {
  it('clicking a collapsed badge expands its canonical ID and the native sibling gets the same gap; collapse restores both', () => {
    rememberDifferences(response());
    let handlers: ReturnType<typeof useReadTrackMouse>;
    const badge: NonNullable<CompactRead['live_lift']>['badges'] = [[500, 'source_insertion', 2353, 2353, 'I']];
    const read: CompactRead = { id: 'r', intervals: [[0, 1000, -1000]], live_lift: { v: 1, hap_label: 'MAT', segments: [[0, 1000, 1, '+', true]],
      badges: badge, badge_ids: [diff.id], insertions: {} } };
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
    expect(useDifferenceSelection.getState().selection).toBeNull();
    expect(getDifferences).toHaveBeenCalledWith(expect.objectContaining({ start: diff.t_start, end: diff.t_start + 1 })); expect(getDifferenceReads).not.toHaveBeenCalled();
    click(host.querySelector('[data-testid="live-lift-expanded-collapse"]')!);
    expect(host.querySelectorAll('[data-testid="live-lift-expanded-block"]')).toHaveLength(0);
    act(() => handlers!.handleContextMenu({ currentTarget: canvas, clientX: 501, clientY: 8, preventDefault() {}, stopPropagation() {} } as never));
    expect(useDifferenceSelection.getState().selection?.difference).toEqual(diff);
    expect(host.querySelectorAll('[data-testid="live-lift-expanded-block"]')).toHaveLength(0);
  });
  const read: CompactRead = { id: 'tiny', intervals: [], live_lift: { v: 1, hap_label: 'MAT', source: { contig: 'src', start: 0, end: 3000, orientation: 'forward' },
    segments: [], badges: [[500, 'source_insertion', 1, 1, 'I']], badge_ids: ['MAT:src:100-101:insertion'] } };
  const canonical: Difference = { ...diff, id: read.live_lift!.badge_ids![0], alt_bp: 1, src: { contig: 'src', start: 100, end: 101 }, grch38: '', alt: 'C' };
  const selectBadge = () => selectReadDifference(read, read.live_lift!.badges![0], 500, { datasetId: 'lift', stateKey: 'mat-state', chrom: 'chr1', start: 0 });
  it('uses the strip map item for a badge instead of inventing coordinates and alleles', async () => {
    vi.mocked(getDifferences).mockResolvedValue(response([canonical]));
    renderStrip(); await settle(); act(() => { selectBadge(); }); await settle();
    expect(getDifferences).toHaveBeenCalledTimes(1);
    expect(useDifferenceSelection.getState().selection?.difference).toEqual(canonical);
    expect(document.querySelector('[data-testid="live-lift-diff-popover"]')?.textContent).toContain('HG002 src:101–101');
    expect(document.querySelector('[data-testid="live-lift-diff-popover"]')?.textContent).toContain('GRCh38:  · HG002: C');
  });
  it('fetches a small unfiltered window for an unloaded ID and picks that exact item', async () => {
    vi.mocked(getDifferences).mockResolvedValue(response([{ ...canonical, id: 'neighbour', alt: 'T' }, canonical]));
    rememberDifferences({ ...response([{ ...canonical, alt: 'old' }]), lift_key: 'old-key' });
    await act(async () => { expect(selectBadge()).toBe(true); });
    expect(getDifferences).toHaveBeenCalledWith(expect.objectContaining({ start: 498, end: 503, minBp: 0, liftKey: 'key-1', liftHap: 'MAT' }));
    expect(useDifferenceSelection.getState().selection?.difference).toEqual(canonical);
  });
  it('labels an unmatched badge as a read-only event', async () => {
    vi.mocked(getDifferences).mockResolvedValue(response([]));
    renderStrip(); await settle(); await act(async () => { selectBadge(); }); await settle();
    expect(useDifferenceSelection.getState().selection?.difference.source).toBe('reads');
    expect(document.querySelector('[data-testid="live-lift-diff-popover"]')?.textContent).toContain('read-only event');
  });
  it('expands a collapsed partial carrier after fetching its canonical map ID without opening a popover', async () => {
    const carrier: CompactRead = { ...read, live_lift: { ...read.live_lift!, badge_ids: [diff.id],
      badges: [[500, 'source_insertion', 2000, 2000, 'I']], insertions: {} } };
    await act(async () => { selectReadDifference(carrier, carrier.live_lift!.badges![0], 500,
      { datasetId: 'lift', stateKey: 'mat-state', chrom: 'chr1', start: 0 }); });
    expect(useBrowserStore.getState().liveLiftExpansions.main[0]).toMatchObject({ ins_id: diff.id, length: 2353, label: 'HG002 MAT +2,353 bp', src: diff.src });
    expect(useDifferenceSelection.getState().selection).toBeNull();
  });
});

it('leaves unresolved badges as read navigation without inventing insertion evidence', () => {
  const badge: any = [500, 'outside_chains', 100, 100, 'R'];
  const read: any = { id: 'unresolved', live_lift: { hap_label: 'MAT', badges: [badge], badge_ids: [null], insertions: {} } };
  expect(selectReadDifference(read, badge, 500, { datasetId: dataset.id, stateKey: panel.stateKey!, chrom: 'chr1', start: 0 })).toBe(false);
  expect(getDifferences).not.toHaveBeenCalled();
  expect(useDifferenceSelection.getState().selection).toBeNull();
});

it('expands a replacement badge and retains its reference span through header actions', async () => {
  const replacement: Difference = { ...diff, id: 'MAT:src:100-892:replacement', kind: 'replacement',
    t_end: 504, ref_bp: 4, alt_bp: 792, src: { contig: 'src', start: 100, end: 892 } };
  vi.mocked(getDifferences).mockResolvedValue(response([replacement]));
  const read: CompactRead = { id: 'replacement', intervals: [], live_lift: { v: 1, hap_label: 'MAT',
    segments: [], badges: [[500, 'aligned_indel', 790, 792, 'I']], badge_ids: [replacement.id], insertions: {} } };
  await act(async () => { expect(selectReadDifference(read, read.live_lift!.badges![0], 500,
    { datasetId: 'lift', stateKey: 'mat-state', chrom: 'chr1', start: 0 })).toBe(true); });
  const expansion = useBrowserStore.getState().liveLiftExpansions.main[0];
  expect(expansion).toMatchObject({ kind: 'replacement', t_end: 504, ref_bp: 4, length: 792, ins_id: replacement.id });
  act(() => root.render(<ExpansionOverlay panel={panel} axis={makeAxis(0, 1000, 1000, false, [expansion])} viewKey="main" />));
  click([...host.querySelectorAll('button')].find(b => b.textContent === 'Identify')!);
  expect(useDifferenceSelection.getState().selection?.difference).toMatchObject({ kind: 'replacement',
    t_start: 500, t_end: 504, ref_bp: 4, alt_bp: 792, id: replacement.id });
});

it.each([0, 1])('opens a map marker with both spans and %i alternate bases', alt => {
  const gap = { ...diff, id: 'gap', kind: alt ? 'replacement' as const : 'deletion' as const,
    t_end: 2233, ref_bp: 1733, alt_bp: alt, src: { contig: 'src', start: 100, end: 100 + alt },
    pos: 500, method: 'assembly_projection' as const, display_only: true as const,
    sequence_status: 'unresolved' as const, read_deviations: 'unassessed' as const,
    coverage: { source: [0, alt] as [number, number], aligned_bp: alt, mol_bp: alt, left_flank: true, right_flank: true, full: true } };
  const read = { id: 'carrier', live_lift: { segments: [], gap_observations: [gap] } } as CompactRead;
  expect(selectMapGap(read, 'gap', { datasetId: 'lift', stateKey: 'mat-state', chrom: 'chr1' })).toBe(true);
  expect(useDifferenceSelection.getState().selection?.difference).toMatchObject({ id: 'gap', t_start: 500, t_end: 2233, ref_bp: 1733, alt_bp: alt });
  expect(useBrowserStore.getState().liveLiftExpansions.main ?? []).toHaveLength(0);
  expect(getDifferences).toHaveBeenCalledWith(expect.objectContaining({ start: 500, end: 501, minBp: 0 }));
});

it.each([false, true].flatMap(svEnabled => [20, 200].flatMap(refBp => [false, true].map(reversed => ({ svEnabled, refBp, reversed })))))('clicks a $refBp bp map marker with svEnabled=$svEnabled, reversed=$reversed', ({ svEnabled, refBp, reversed }) => {
  const gap = { ...diff, id: 'gap', kind: 'replacement' as const, t_start: 400, t_end: 400 + refBp, ref_bp: refBp, alt_bp: 1,
    pos: 300, method: 'assembly_projection' as const, display_only: true as const, sequence_status: 'unresolved' as const,
    read_deviations: 'unassessed' as const, coverage: { source: [0, 1] as [number, number], aligned_bp: 1, mol_bp: 1, left_flank: true, right_flank: true, full: true } };
  const event = { t: 'D' as const, ref: 400, ref_end: 400 + refBp, len: refBp, q: 0, ref_len: refBp, alt_len: 1,
    source: 'assembly' as const, display_only: true, difference_id: 'gap' };
  const read: CompactRead = { id: 'r', intervals: [], sv: [event], live_lift: { v: 1, segments: [[0, 1000, 1, '+', true]], connectors: [[300, 300 + refBp]], gap_observations: [gap] } };
  let handlers: ReturnType<typeof useReadTrackMouse>;
  function Mouse() {
    handlers = useReadTrackMouse({ displayReads: [read], width: 1000, height: 200, sidebarWidth: 0, regionWidth: 1000,
      start: 0, end: 1000, chrom: 'chr1', datasetId: 'lift', stateKey: 'mat-state', hasCluster: false,
      myClusterAssignments: {}, myClusterOrder: [], myClusterFocus: null, mySelectedClusters: null, hasClusterFocus: false,
      isPanning: false, isReversed: reversed, fillReadHeight: false, storeReadRowHeight: 20, readScrollOffset: 0,
      readSeparatorMode: 'off', readSeparatorMinHeight: 0, readSeparatorWidth: 0, showReadTooltip: false,
      showCoverageHistogram: false, svEnabled, svMinLen: 1000, linkedBoundsStart: 100 });
    return null;
  }
  act(() => root.render(<Mouse />));
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200 } as DOMRect);
  const x = reversed ? 600 - refBp / 2 : 400 + refBp / 2;
  act(() => handlers!.handleClick({ currentTarget: canvas, clientX: x, clientY: 8, shiftKey: false, ctrlKey: false, metaKey: false } as never));
  expect(useDifferenceSelection.getState().selection?.difference.id).toBe('gap');
  act(() => root.render(<SvTooltip hover={{ kind: 'event', read, event, x: 500, y: 8 }} width={1000} height={200} datasetId="lift" chrom="chr1" />));
  expect(host.textContent).toContain(`Assembly replacement · ${refBp}→1 bp`);
  expect(host.textContent).toContain('read evidence unassessed');
  expect(host.textContent).not.toContain('loading bases');
});

it('preserves loaded map sequences and fills an unloaded marker without overwriting a later selection', async () => {
  const gap: any = { ...diff, id: 'gap', kind: 'deletion', t_end: 520, ref_bp: 20, alt_bp: 0,
    pos: 500, coverage: { full: true } };
  const canonical = { ...gap, grch38: 'C'.repeat(20), alt: '' };
  const read = { id: 'r', live_lift: { gap_observations: [gap] } } as CompactRead;
  const context = { datasetId: 'lift', stateKey: 'mat-state', chrom: 'chr1' };
  rememberDifferences(response([canonical]));
  selectMapGap(read, 'gap', context);
  expect(useDifferenceSelection.getState().selection?.difference).toEqual(canonical);
  expect(getDifferences).not.toHaveBeenCalled();
  clearDifferenceCache();
  vi.mocked(getDifferences).mockResolvedValue(response([canonical]));
  await act(async () => { selectMapGap(read, 'gap', context); });
  expect(useDifferenceSelection.getState().selection?.difference.alt).toBe('');
  clearDifferenceCache();
  let finish!: (r: DifferencesResponse) => void;
  vi.mocked(getDifferences).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  selectMapGap(read, 'gap', context);
  useDifferenceSelection.getState().select(null);
  await act(async () => finish(response([canonical])));
  expect(useDifferenceSelection.getState().selection).toBeNull();
});


it('resolves both parents on expansion and sizes the shared column to the longer allele', async () => {
  const pat = { ...diff, id: 'PAT:src:100-2456:insertion', hap: 'h2', hap_label: 'PAT', alt_bp: 2356 };
  vi.mocked(getDifferences).mockResolvedValue(response([diff, pat]));
  await act(async () => {
    expandDifference({ panelId: panel.id, datasetId: dataset.id, viewKey: 'main', chrom: 'chr1', difference: diff });
  });
  const blocks = useBrowserStore.getState().liveLiftExpansions.main;
  expect(blocks).toHaveLength(1);
  expect(blocks[0].length).toBe(2356);
  expect(blocks[0].selected_length).toBe(2353);
  expect(blocks[0].alleles?.map(a => a.ins_id)).toEqual([diff.id, pat.id]);
  expect(blocks[0].label).toContain('lengths differ');
  expect(vi.mocked(getDifferences).mock.calls[0][0].liftHap).toBeUndefined();
});
