import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import type { HubSelected } from '../hub/hubState';
import { SegmentsView } from './SegmentsView';
import { WindowControls, WindowView, classMixCount } from './WindowView';
import { sendToNucleosomeWindow } from './handoff';
import { registerNucleosomePanel } from './register';
import { categoryLabel, highlightCategory } from './selection';
import { parseCoordinates, resolveWindow, type ResolvedWindow } from './windowSource';
import type { NucObservation, NucObservationSummary, NucWindowObservation } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const view = { chrom: 'chr3', start: 1000, end: 9000, peaks: [], hubSelected: [] as HubSelected[] };
const hit = (id: string, anchor: number, strand?: '+' | '-', frame?: HubSelected['frame']): HubSelected => ({
  setId: 's', hitId: id, typeId: 'nfr', chrom: 'chr3', start: anchor - 100, end: anchor + 100, anchor, ...(strand ? { strand } : {}),
  ...(frame ? { frame } : {}), label: `NFR ${id}` });
const ok = (r: ReturnType<typeof resolveWindow>) => { if ('error' in r) throw new Error(r.error); return r as ResolvedWindow; };

describe('window mode: window, anchor and background', () => {
  it('parses typed coordinates as 1-based inclusive', () => {
    expect(parseCoordinates('chr1:1,001-2,000')).toEqual({ chrom: 'chr1', start: 1000, end: 2000 });
    expect(parseCoordinates('chr1:2000-1000')).toBeNull();
    expect(parseCoordinates('chr1')).toBeNull();
  });

  it('defaults to the view without an anchor', () => {
    const r = ok(resolveWindow({}, view));
    expect(r.window).toEqual({ chrom: 'chr3', start: 1000, end: 9000 });
    expect(r.anchor).toBeNull();
    expect(r.background).toEqual([]);
  });

  it('widens a hub hit to its anchor ± the flank, phases at its anchor with its strand, and backgrounds the other hits', () => {
    const hits = [hit('a', 5000, '-'), hit('b', 20000, '+'), hit('c', 30000), hit('g', 40000, '+', { kind: 'source', assembly: 'x', contig: 'c' })];
    const r = ok(resolveWindow({ windowSource: 'hub', background: 'hub' }, { ...view, hubSelected: hits }));
    expect(r.window).toEqual({ chrom: 'chr3', start: 4000, end: 6000 });
    expect(r.anchor).toEqual({ pos: 5000, orientation: -1 });
    // Another assembly's hit is left out; the hits' own strands orient the backgrounds.
    expect(r.background).toEqual([{ chrom: 'chr3', pos: 20000, orientation: 1 }, { chrom: 'chr3', pos: 30000, orientation: 0 }]);
    const unoriented = ok(resolveWindow({ windowSource: 'hub', anchor: { kind: 'feature', orientation: 0 }, flank: 0 }, { ...view, hubSelected: hits }));
    expect(unoriented.window).toEqual({ chrom: 'chr3', start: 4900, end: 5100 });
    expect(unoriented.anchor).toEqual({ pos: 5000, orientation: 0 });
    expect(unoriented.background).toEqual([]);
  });

  it('asks for what is missing', () => {
    expect(resolveWindow({ windowSource: 'hub' }, view)).toEqual({ error: 'Select a hit in the Feature hub' });
    expect(resolveWindow({ windowSource: 'peak' }, view)).toHaveProperty('error');
    expect(resolveWindow({ windowSource: 'coordinates' }, view)).toHaveProperty('error');
  });

  it('phases a selected peak at its centre, and a typed position when asked', () => {
    const peaks = [{ chrom: 'chr3', start: 3000, end: 3400, index: 7 }];
    expect(ok(resolveWindow({ windowSource: 'peak' }, { ...view, peaks })).anchor).toEqual({ pos: 3200, orientation: 0 });
    const typed = ok(resolveWindow({ windowSource: 'coordinates', window: { chrom: 'chr3', start: 0, end: 4000, label: 'x' },
      anchor: { kind: 'position', pos: 2500, orientation: 1 } }, view));
    expect(typed.window).toEqual({ chrom: 'chr3', start: 0, end: 4000 });
    expect(typed.anchor).toEqual({ pos: 2500, orientation: 1 });
  });
});

describe('hand-off into window mode', () => {
  beforeEach(() => { registerNucleosomePanel(); useBrowserStore.setState({ panels: [] }); });
  it('opens a nucleosome panel on the hand-off and phases at its anchor', () => {
    const id = sendToNucleosomeWindow({ chrom: 'chr3', start: 5000, end: 5300, label: 'NFR chr3:5,001-5,300', anchor: 5150, strand: '+' });
    const panel = useBrowserStore.getState().panels.find(p => p.id === id)!;
    expect(panel.contentType).toBe('nucleosomes');
    expect(panel.nucleosomes).toMatchObject({ mode: 'window', windowSource: 'handoff', anchor: { kind: 'feature', orientation: 'feature' } });
    const r = ok(resolveWindow(panel.nucleosomes!, view));
    expect(r.window).toEqual({ chrom: 'chr3', start: 4150, end: 6150 });
    expect(r.anchor).toEqual({ pos: 5150, orientation: 1 });
    // A second hand-off reuses the panel.
    expect(sendToNucleosomeWindow({ chrom: 'chr3', start: 1, end: 2, label: 'y' })).toBe(id);
    expect(useBrowserStore.getState().panels.filter(p => p.contentType === 'nucleosomes')).toHaveLength(1);
  });
});

const obs: NucObservation = { obsId: 'o1', label: 'A', color: '#123456', datasetId: 'd1', panelId: 'p1', stateKey: 'p1', kind: 'linear', chrom: 'chr3', start: 0, end: 10 };

describe('selection', () => {
  afterEach(() => vi.restoreAllMocks());
  it('highlights the observation rows and the same molecules by QNAME', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ obsId: 'o1', readIds: ['k1'], qnames: ['q1', 'q2'], molecules: 9 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const n = await highlightCategory(obs, { kind: 'nrl', lo: 180, hi: 190 });
    expect(n).toBe(2);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.category).toEqual({ kind: 'nrl', lo: 180, hi: 190 });
    expect([...(useReadActionsStore.getState().highlight?.ids ?? [])].sort()).toEqual(['k1', 'q1', 'q2']);
    expect(categoryLabel({ kind: 'segment', state: 'low_information' })).toBe('low information segments');
  });
});

describe('views', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('segments: clicking a size class, an NRL bin, a segment state or an event selects it', async () => {
    const summary: NucObservationSummary = {
      obsId: 'o1', datasetId: 'd1', kind: 'linear', records: 10, computed: 8, lowInformation: 1,
      sizes: { coarse: { cant_tell: 2, short: 1, mono: 20, long: 1, multi2: 2, multi3: 0, edge_truncated: 1 }, tf: 1, footprints: 27, cantTellFraction: 0.11,
        z: { edges: [-4, -2, 0, 2, 4], counts: [1, 5, 9, 2], n: 17 } },
      spacing: { nrl: { edges: [170, 180, 190, 200], counts: [1, 5, 2], n: 8, quantiles: [175, 181, 184, 189, 195] }, regularity: [0, 0, 0.42, 0, 0], gapCv: null, tooShortFraction: 0.1 },
      segments: { bp: 1000, regular: 0.5, disordered: 0.1, undetermined: 0.35, low_information: 0.05, undersizedRuns: 3, missingNucleosomes: 2 },
    };
    const onSelect = vi.fn();
    await act(async () => root.render(<SegmentsView observations={[obs]} summaries={{ o1: summary }} loading={false} onHide={() => { }} onSelect={onSelect} />));
    expect(container.querySelector('[data-testid="nuc-molecules"]')!.textContent).toContain('8 / 10');
    expect(container.querySelector('[data-testid="nuc-nrl"]')!.textContent).toContain('184 [181–189]');
    act(() => (container.querySelector('[data-testid="nuc-coarse-bar-mono"]') as HTMLElement).click());
    act(() => { container.querySelectorAll('[data-testid="nuc-nrl-hist-bin"]')[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => (container.querySelector('[data-testid="nuc-seg-bar-disordered"]') as HTMLElement).click());
    act(() => (container.querySelector('[data-testid="nuc-missing"]') as HTMLElement).click());
    expect(onSelect.mock.calls.map(c => c[1])).toEqual([{ kind: 'coarse', name: 'mono' }, { kind: 'nrl', lo: 180, hi: 190 },
      { kind: 'segment', state: 'disordered' }, { kind: 'event', name: 'missing' }]);
  });

  it('window: FiberHMM\'s multi3+ class counts as multi (3+) (Codex E4)', () => {
    expect(classMixCount({ mono: 1, 'multi3+': 9 }, 'multi3')).toBe(9);
    expect(classMixCount({ mono: 1, 'multi3+': 9 }, 'mono')).toBe(1);
    expect(classMixCount(undefined, 'mono')).toBe(0);
  });

  it('window: a typed anchor position is 1-based on screen and 0-based in the settings (Codex E5)', async () => {
    const setSettings = vi.fn();
    const settings = { windowSource: 'view' as const, anchor: { kind: 'position' as const, pos: 50_999, orientation: 0 as const } };
    await act(async () => root.render(<WindowControls settings={settings} setSettings={setSettings} hubCount={0}
      resolution={{ window: { chrom: 'chr3', start: 0, end: 1 }, label: 'View', anchor: null, background: [] }} />));
    const input = container.querySelector('[data-testid="nuc-anchor-pos"]') as HTMLInputElement;
    expect(input.value).toBe('51000');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, '52000'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(setSettings).toHaveBeenLastCalledWith({ anchor: { kind: 'position', pos: 51_999, orientation: 0 } });
  });

  it('window: metrics, the anchor state, phasing and the dephasing readout', async () => {
    const bin = (lo: number, r: number, p: number) => ({ lo, hi: lo + 190, R: r + 0.05, phi: 0, n_dyads: 40, n_molecules: 12, null_mean: 0.05, null_p: p, R_minus_null: r, R_max_period: r + 0.06, P_max: 188 });
    const result: NucWindowObservation = { obsId: 'o1', datasetId: 'd1', molecules: 12, metrics: {
      n_molecules: 12, excluded_low_information: 1, class_mix: { mono: 30, short: 2, cant_tell: 3 }, insufficient: false,
      nrl_quantiles: [180, 183, 186, 190, 194], too_short_fraction: 0.08, regular_fraction: 0.6, disordered_fraction: 0.1, undetermined_fraction: 0.3,
      low_information_fraction: 0, missing_per_molecule: 0.25, undersized_fraction: 0.02, state_counts: { '1': 7, '0': 4, '.': 1 },
      phasing: { anchor: { frame: 'anchor', P: 188, side: 'both', bins: [bin(50, 0.2, 0.01), bin(240, 0.1, 0.2), bin(50, 0.15, 0.01)], dispersion_bp: 41, n_molecules: 12, n_appearances: 12 },
        molecule: { frame: 'molecule', P: 188, side: 'both', bins: [bin(50, 0.3, 0.01), bin(50, 0.3, 0.01)], dispersion_bp: 30, n_molecules: 12, n_appearances: 12 } },
      dephasing: { anchor: { R: 0.2 }, coherence: { stat: 'coherence', value: 0.2, n_matched: 9, background_median: 0.4, p_dephased: 0.1 },
        excess: { stat: 'excess', value: 0.1, n_matched: 9, background_median: 0.3, p_dephased: 0.2 }, n_background: 9 },
    } };
    await act(async () => root.render(<WindowView observations={[obs]} results={{ o1: result }} loading={false} />));
    expect(container.querySelector('[data-testid="nuc-window-molecules"]')!.textContent).toContain('12');
    expect(container.querySelectorAll('[data-testid="nuc-window-col"]').length).toBe(1);
    expect(container.querySelector('[data-testid="nuc-window-nrl"]')!.textContent).toContain('186 [183–190]');
    expect(container.querySelector('[data-testid="nuc-window-state"]')!.textContent).toBe('7 / 4 / 1');
    expect(container.querySelector('[data-testid="nuc-phasing-anchor"]')).not.toBeNull();
    expect(container.textContent).toContain('0.15*');
    expect(container.querySelector('[data-testid="nuc-dephasing"]')!.textContent).toBe('p 0.10 · 9');
  });
});
