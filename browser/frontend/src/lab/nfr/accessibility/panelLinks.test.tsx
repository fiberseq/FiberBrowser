import { scrollIntoViewWithin } from '../../../utils/scrollWithin';
import '../../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import * as cw from '../../../api/consensusWorkflow';
import { useBrowserStore } from '../../../stores/browserStore';
import { useAccessibilityStore } from '../accessibilityStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { RecallerClassTable } from '../../../components/controls/footprint-analysis/RecallerClassTable';
import { NfrClasses } from './NfrClasses';
import { NfrFeatureTrack } from '../NfrFeatureTrack';
import { useNfrRunsStore } from '../nfrRunsStore';
import { NFR_RESULT } from './fixture';
import { FOCUS_FOOTPRINT_CLASS_EVENT } from '../../../utils/panelLinks';
import { FOCUS_NFR_EVENT, savedNfrsOver } from '../nfrLinks';
import { savedFromNfr } from '../savedNfrVariants';
import { resetJobs } from '../nfrJobs';

vi.mock('../../../utils/scrollWithin', () => ({ scrollIntoViewWithin: vi.fn() }));

vi.mock('../../../api/consensusWorkflow', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/consensusWorkflow')>()), getConsensusJob: vi.fn(),
}));
vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()), getNfrClasses: vi.fn(), getNfrCooccupancy: vi.fn(),
  startNfrClassRun: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const r = (prevalence: number) => ({ prevalence, prevalence_edge: prevalence, prevalence_loose: prevalence, molecules: 100, prevalence_lower_bound: 0,
  broader: 0, other_shape: 0, accessible: 1 - prevalence, support_gain_nats: 20, supported: true, resolution_nats: 12, resolved: true, spots: '',
  L0: 0, L1: 1, R0: 2, R1: 3, unknown_accessible_fraction: .5, efficiency: null });
// a class at 47,518,180-47,518,220: inside N1 V1 (47,518,152-47,518,247) of the fixture run
const catalog = { cr_mode: 'lattice_recaller', region: { chrom: 'chr19', start: 47517000, end: 47519000 },
  datasets: { ds1: { catalog: [{ family: 'class_008', consensus_start: 47518180, consensus_end: 47518220, recaller: { CT: r(.3) } }] } } } as any;

describe('links between the NFR and Footprints panels', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [], chrom: 'chr19', savedNfrVariants: [], openAnalysisPanel: vi.fn() } as any);
    useConsensusViewStore.setState({ selections: [] } as any);
    useAccessibilityStore.setState({ jobId: 'nfrjob', result: NFR_RESULT } as any);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('a footprint class links to the NFR it sits in (and its variants), opening the NFR panel there', async () => {
    act(() => root.render(<RecallerClassTable jobId="cls1" catalog={catalog} datasetLabels={{ ds1: 'DAF' }} />));
    const link = container.querySelector('[data-testid="recaller-nfr-link"]')!;
    expect(link.textContent).toContain('N1');
    expect(link.textContent).toContain('V1');
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(FOCUS_NFR_EVENT, h);
    await click(link);
    await wait(80);
    window.removeEventListener(FOCUS_NFR_EVENT, h);
    expect(useBrowserStore.getState().openAnalysisPanel).toHaveBeenCalledWith('accessibility');
    expect(seen).toEqual([{ jobId: 'nfrjob', nfrId: 'N1', saved: false, classId: 'class_008', classJob: 'cls1' }]);   // the class and its run go along
  });

  it('the NFR track: folded NFRs, the pair arcs over it, one selection and one fold state with the panel', async () => {
    useBrowserStore.setState({ chrom: 'chr19', start: 47517650, end: 47518985, isReversed: false, selectedFeatures: [] } as any);
    useAccessibilityStore.setState({ showArcs: true, expanded: {}, focus: null, pairRequest: null, panelTab: 'nfrs', pairsMode: 'positions', qMax: 0.05, minEffect: 1, topN: 20 } as any);
    useNfrRunsStore.setState({ nfrRuns: { nfrjob: { jobId: 'nfrjob', result: NFR_RESULT, datasetIds: ['ds1'], createdAt: 1 } } } as any);
    await act(async () => root.render(<NfrFeatureTrack width={600} height={200} datasetId="ds1" panelId="p1" />));
    const track = () => container.querySelector('[data-testid="nfr-feature-track-ds1"]')!;
    // folded: one bar for N1, no variants; the arcs reach it from the footprint class
    expect(track().querySelector('[data-testid="nfr-feature-folded"][data-nfr="N1"]')).not.toBeNull();
    expect(track().querySelectorAll('[data-testid="nfr-feature-variant"]')).toHaveLength(0);
    expect([...track().querySelectorAll('[data-testid="nfr-arc-track"] [data-testid="nfr-arc"]')].map(a => (a as HTMLElement).dataset.pair))
      .toEqual(['N1:V2|class_008', 'N1:V1|class_008']);
    // unfold here: the panel's state too; the variants on lanes (V1 and V3 apart share one, V2 overlaps both)
    await act(async () => { track().querySelector('[data-testid="nfr-feature-fold"][data-nfr="N1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useAccessibilityStore.getState().expanded.nfrjob).toEqual(['N1']);
    const ys = Object.fromEntries([...track().querySelectorAll('[data-testid="nfr-feature-variant"]')].map(g => [(g as HTMLElement).dataset.variant, g.querySelector('rect')!.getAttribute('y')]));
    expect(ys['N1:V1']).toBe(ys['N1:V3']);
    expect(ys['N1:V2']).not.toBe(ys['N1:V1']);
    expect(track().querySelectorAll('[data-testid="nfr-arc-track"] [data-testid="nfr-arc"]')).toHaveLength(3);
    // on the NFRs tab a click selects the variant and shows its card (as before); shift-click is the toolbar's selection
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(FOCUS_NFR_EVENT, h);
    const v2 = () => track().querySelector('[data-testid="nfr-feature-variant"][data-variant="N1:V2"]')!;
    await act(async () => { v2().dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); });
    await wait(80);
    expect(seen).toEqual([]);
    expect(useBrowserStore.getState().selectedFeatures.map((f: any) => f.id)).toEqual(['N1:V2']);
    useBrowserStore.setState({ selectedFeatures: [] } as any);
    await act(async () => { v2().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await wait(80);
    window.removeEventListener(FOCUS_NFR_EVENT, h);
    expect(seen).toEqual([{ jobId: 'nfrjob', nfrId: 'N1', saved: false, variantId: 'N1:V2' }]);
    expect(useAccessibilityStore.getState().focus).toBe('N1:V2');
    expect(v2().getAttribute('data-focus')).toBe('true');
    // a second element: the pair goes to the panel's NFR pairs tab
    await act(async () => { track().querySelector('[data-testid="nfr-feature-variant"][data-variant="N1:V3"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useAccessibilityStore.getState().pairRequest).toMatchObject({ jobId: 'nfrjob', a: 'N1:V2', b: 'N1:V3' });
    expect(useAccessibilityStore.getState().panelTab).toBe('coaccess');
    expect(useAccessibilityStore.getState().pairsMode).toBe('elements');     // the pair shows, not Position correlation
    expect(useBrowserStore.getState().openAnalysisPanel).toHaveBeenCalledWith('accessibility');
    // a pair the panel inspects is ringed here
    useAccessibilityStore.setState({ inspected: { jobId: 'nfrjob', split: { kind: 'pair', a: 'N1:V1', b: 'N1:V3' } } } as any);
    await wait(10);
    expect(track().querySelector('[data-variant="N1:V1"]')!.getAttribute('data-in-pair')).toBe('true');
    expect(track().querySelector('[data-variant="N1:V2"]')!.getAttribute('data-in-pair')).toBeNull();
    // another run's track (not the panel's): no arcs, and a click shows it in the panel as before
    useAccessibilityStore.setState({ jobId: 'other' } as any);
    await wait(10);
    expect(track().querySelector('[data-testid="nfr-arc-track"]')).toBeNull();
    useAccessibilityStore.setState({ jobId: 'nfrjob', inspected: null } as any);
  });

  it('a saved NFR shows its footprint classes per variant and opens one in the Footprints panel (row brought into view)', async () => {
    vi.mocked(api.getNfrClasses).mockResolvedValue({ nfr: 'N1', class_job: 'cls1', joined: 'run', classes: [{
      id: 'class_008', class_id: 'class_008', label: 'class 8', start: 47518180, end: 47518220, prevalence: .3, inside: ['V1'],
      layers: { V1: { reads: 100, open: 90, labelled: 80, unlabelled_open: 10, footprinted: 30, excluded_members: { nucleosome: 3, linker: 0 },
        p_open: .9, ci_open: [.85, .95], p_fp_given_open: .375, ci_fp_given_open: [.3, .45], p_footprinted: .3375,
        stack: { closed: .1, open_unfootprinted: .5625, open_footprinted: .3375 } } } }] });
    useBrowserStore.setState({ footprintGroups: [{ id: 'g', savedClass: { id: 'S2' }, consensusJobId: 'cls1', consensusStateId: 'class_008' }] } as any);
    vi.mocked(api.getNfrCooccupancy).mockResolvedValue({ nfr: 'N1', class_job: 'cls1', definition: 'MH', pairs: [
      { variant: 'V1', a: 'class 8', b: 'class 9', a_id: 'class_008', b_id: 'class_009', distance: 60, reads: 80, table: [30, 5, 5, 40],
        both: 30, expected_both: 16.4, odds_ratio: 48, log2: 5.6, p: 1e-12, q: 2e-12, strata: 2 }] });
    const entry = { ...savedFromNfr('nfrjob', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1']), id: 'e1', savedAt: 1 };
    await act(async () => root.render(<NfrClasses entry={entry} names={['V1']} />));
    await wait(20);
    const row = container.querySelector('[data-testid="nfr-class-row"]')!;
    expect(row.textContent).toContain('Class 008');                    // one label in every panel
    expect(row.textContent).toContain('saved S2');
    expect(row.textContent).toContain('90% · 38%');                                   // open · footprinted when open
    // pairs footprinted together: one disclosure (statistics demoted)
    expect(container.querySelector('[data-testid="nfr-coocc"]')!.closest('details')!.getAttribute('data-testid')).toBe('nfr-coocc-disclosure');
    const pair = container.querySelector('[data-testid="nfr-coocc-row"]')!;
    expect(pair.textContent).toContain('Class 008 + Class 009');
    expect(pair.textContent).toContain('30 (16.4)');
    expect(pair.textContent).toContain('48.00');
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(FOCUS_FOOTPRINT_CLASS_EVENT, h);
    await click(row.querySelector('[data-testid="nfr-class-show"]'));
    await wait(80);
    window.removeEventListener(FOCUS_FOOTPRINT_CLASS_EVENT, h);
    expect(useBrowserStore.getState().openAnalysisPanel).toHaveBeenCalledWith('footprint-analysis');
    expect(useConsensusViewStore.getState().selections).toEqual([{ jobId: 'cls1', datasetId: 'ds1', family: 'class_008' }]);
    expect(seen).toEqual([{ jobId: 'cls1', classId: 'class_008' }]);
  });

  it('without classes, the Footprints section says why and runs Find classes for this window; its classes then show', async () => {
    resetJobs();                                   // the views' answers are cached by key across tests
    const klass = { id: 'class_008', class_id: 'class_008', label: 'class 8', start: 47518180, end: 47518220, prevalence: .3, inside: ['V1'], layers: {} };
    let joined = false;
    vi.mocked(api.getNfrClasses).mockReset().mockImplementation(async () => (joined
      ? { nfr: 'N1', class_job: 'cls1', joined: 'posthoc', classes: [klass], reason: null }
      : { nfr: 'N1', class_job: null, joined: null, classes: [], reason: 'No Find classes run in this session covers these molecules.' }));
    vi.mocked(api.getNfrCooccupancy).mockResolvedValue({ nfr: 'N1', class_job: 'cls1', definition: 'MH', pairs: [] });
    vi.mocked(api.startNfrClassRun).mockReset().mockImplementation(async () => { joined = true; return { job_id: 'cls1', status: 'queued', existing: false }; });
    const entry = { ...savedFromNfr('nfrjob', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1']), id: 'e1', savedAt: 1 };
    await act(async () => root.render(<NfrClasses entry={entry} names={['V1']} />));
    await wait(30);
    expect(container.querySelector('[data-testid="nfr-class-reason"]')!.getAttribute('title')).toContain('No Find classes run');
    const run = container.querySelector<HTMLButtonElement>('[data-testid="nfr-run-classes"]')!;
    expect(run.textContent).toBe('Run Find classes for this window');
    await click(run);
    await wait(30);
    expect(api.startNfrClassRun).toHaveBeenCalledWith('nfrjob');
    await wait(30);
    expect(container.querySelector('[data-testid="nfr-class-row"]')!.textContent).toContain('Class 008');
    expect(container.querySelector('[data-testid="nfr-run-classes"]')).toBeNull();
  });

  it('the wait for a started class run ends when a run joins (no class in this NFR), or when the run fails (Codex review)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      resetJobs();
      let answer: any = { nfr: 'N1', class_job: null, joined: null, classes: [], reason: 'none yet' };
      vi.mocked(api.getNfrClasses).mockReset().mockImplementation(async () => answer);
      vi.mocked(api.startNfrClassRun).mockReset().mockResolvedValue({ job_id: 'cj9', status: 'queued', existing: false });
      vi.mocked(cw.getConsensusJob).mockReset().mockResolvedValue({ job_id: 'cj9', status: 'running', message: '' } as any);
      const entry = { ...savedFromNfr('nfrjob', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1']), id: 'e1', savedAt: 1 };
      await act(async () => root.render(<NfrClasses entry={entry} names={['V1']} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      await click(container.querySelector('[data-testid="nfr-run-classes"]'));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(container.querySelector('[data-testid="nfr-run-classes"]')!.textContent).toBe('Find classes running…');
      // the run finished with classes elsewhere in the window: a class run has joined, none here; the wait ends
      answer = { nfr: 'N1', class_job: 'cj9', joined: 'posthoc', classes: [], reason: null };
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(container.querySelector('[data-testid="nfr-class-reason"]')!.textContent).toBe('No footprint class in this NFR.');
      const calls = vi.mocked(api.getNfrClasses).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(vi.mocked(api.getNfrClasses).mock.calls.length).toBe(calls);                  // no more polling
      // a failed run ends the wait with its message
      act(() => root.unmount()); root = createRoot(container); resetJobs();
      answer = { nfr: 'N1', class_job: null, joined: null, classes: [], reason: 'none yet' };
      vi.mocked(cw.getConsensusJob).mockResolvedValue({ job_id: 'cj9', status: 'error', message: 'no reads' } as any);
      await act(async () => root.render(<NfrClasses entry={entry} names={['V1']} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      await click(container.querySelector('[data-testid="nfr-run-classes"]'));
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(container.querySelector('[data-testid="nfr-class-run-error"]')!.textContent).toBe('Find classes failed: no reads');
      expect(container.querySelector('[data-testid="nfr-run-classes"]')!.textContent).toBe('Run Find classes for this window');
    } finally { vi.useRealTimers(); }
  });

  it('finds saved NFRs over a span (chr prefix ignored)', () => {
    const entry = { ...savedFromNfr('nfrjob', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1']), id: 'e1', savedAt: 1 };
    useBrowserStore.setState({ savedNfrVariants: [entry] } as any);
    expect(savedNfrsOver('19', 47518180, 47518220).map(e => e.id)).toEqual(['e1']);
    expect(savedNfrsOver('chr19', 1, 2)).toEqual([]);
  });
});

describe('opening a class from the NFR panel activates its run', () => {
  it('loads the class run, selects the class, and scrolls to it once its list mounts', async () => {
    const { showFootprintClass } = await import('../../../utils/panelLinks');
    const load = vi.fn(async () => {});
    useConsensusViewStore.setState({ selections: [], load } as any);
    useBrowserStore.setState({ openAnalysisPanel: vi.fn() } as any);
    await showFootprintClass('cls1', 'class_008', ['ds1']);
    expect(load).toHaveBeenCalledWith('cls1');
    expect(useConsensusViewStore.getState().selections).toEqual([{ jobId: 'cls1', datasetId: 'ds1', family: 'class_008' }]);
    const scrolled = vi.mocked(scrollIntoViewWithin).mockClear();
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    useAccessibilityStore.setState({ jobId: null, result: null } as any);
    act(() => root.render(<RecallerClassTable jobId="cls1" catalog={catalog} datasetLabels={{ ds1: 'DAF' }} />));
    expect(scrolled.mock.calls.map(([el]) => el?.dataset.family)).toEqual(['class_008']);
    act(() => root.unmount()); container.remove();
  });
});
