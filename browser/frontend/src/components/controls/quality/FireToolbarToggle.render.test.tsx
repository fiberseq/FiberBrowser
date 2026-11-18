import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { resetSharedRequests } from '../../../api/sharedRequest';
import { ToolbarSummaryShown } from '../ToolbarGroups';
import { FIRE_SLIDER_COMMIT_MS, QualityQuickControls, QualitySummary } from './QualityQuickControls';
import { fireAqForFdr, fireFdrLabel } from './qualityControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FIRE = { layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true };
const NUC = { layer: 'nuc', qualityName: 'nq', minValue: 128, enabled: true };

const filters = () => useBrowserStore.getState().activeColormap.qualityFilters;
const setFilters = (qualityFilters: any[]) => useBrowserStore.setState({
  activeColormap: { ...useBrowserStore.getState().activeColormap, qualityFilters },
} as any);

function setRange(input: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Owner (18 Nov): the toolbar Quality group controls the FIRE filter itself.
describe('toolbar FIRE filter toggle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetSharedRequests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, filters: [], available: {} }), { status: 200 })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 500, maxRegionForReads: 1_000_000,
      datasets: [{ id: 'ds1', available_layers: { fire: true } }],
    } as any);
    setFilters([{ ...FIRE }]);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const q = <T extends Element = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);

  it('maps FDR presets to aq (aq = 255 x precision)', () => {
    expect([0.05, 0.1, 0.2].map(fireAqForFdr)).toEqual([242, 230, 204]);
    expect(fireFdrLabel(230)).toBe('10%');
  });

  it('the toggle flips enabled and keeps the row and its threshold', async () => {
    setFilters([{ ...FIRE, minValue: 242 }]);
    await act(async () => { root.render(<QualityQuickControls />); });
    const toggle = q<HTMLInputElement>('fire-filter-toggle')!;
    expect(toggle.checked).toBe(true);
    await act(async () => { toggle.click(); });
    expect(filters()).toEqual([{ layer: 'fire', qualityName: 'aq', minValue: 242, enabled: false }]);
    expect(q<HTMLInputElement>('fire-filter-slider')!.disabled).toBe(true);
    await act(async () => { q<HTMLInputElement>('fire-filter-toggle')!.click(); });
    expect(filters()).toEqual([{ layer: 'fire', qualityName: 'aq', minValue: 242, enabled: true }]);
  });

  it('the slider updates minValue (after it settles) and shows the FDR', async () => {
    vi.useFakeTimers();
    await act(async () => { root.render(<QualityQuickControls />); });
    const slider = q<HTMLInputElement>('fire-filter-slider')!;
    await act(async () => { setRange(slider, 204); });
    expect(q('fire-filter-value')!.textContent).toContain('FDR 20%');
    expect(filters()[0].minValue).toBe(230); // not yet: each change reloads reads
    await act(async () => { vi.advanceTimersByTime(FIRE_SLIDER_COMMIT_MS + 10); });
    expect(filters()[0]).toMatchObject({ layer: 'fire', qualityName: 'aq', minValue: 204, enabled: true });
  });

  it('an FDR preset sets the threshold at once', async () => {
    await act(async () => { root.render(<QualityQuickControls />); });
    await act(async () => { q<HTMLButtonElement>('fire-fdr-preset-5')!.click(); });
    expect(filters()[0].minValue).toBe(242);
    expect(q('fire-fdr-preset-5')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('re-adds the default FIRE row when it was removed', async () => {
    setFilters([{ ...NUC }]);
    await act(async () => { root.render(<QualityQuickControls />); });
    const toggle = q<HTMLInputElement>('fire-filter-toggle')!;
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    expect(filters()).toEqual([{ ...NUC }, { ...FIRE }]);
  });

  it('other filters get an enable box; an unticked one stays listed', async () => {
    setFilters([{ ...FIRE }, { ...NUC }]);
    await act(async () => { root.render(<QualityQuickControls />); });
    const boxes = () => container.querySelectorAll<HTMLInputElement>('[data-testid="quality-filter-enable"]');
    expect(boxes()).toHaveLength(1);
    await act(async () => { boxes()[0].click(); });
    expect(filters()[1]).toEqual({ ...NUC, enabled: false });
    expect(filters()[0]).toEqual({ ...FIRE });
    expect(boxes()).toHaveLength(1);
    await act(async () => { boxes()[0].click(); });
    expect(filters()[1]).toEqual({ ...NUC });
  });

  it('says so when no loaded dataset has FIRE scores, and still shows the toggle', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'ds1', available_layers: { msp: true } }] } as any);
    await act(async () => { root.render(<QualityQuickControls />); });
    expect(q('fire-filter-toggle')).not.toBeNull();
    expect(q('fire-filter-nodata')!.textContent).toBe('no FIRE scores in loaded data');
  });

  it('the header reflects on (default and other thresholds) and off', async () => {
    await act(async () => { root.render(<ToolbarSummaryShown value={false}><QualitySummary /></ToolbarSummaryShown>); });
    expect(q('quality-summary-fire')!.textContent).toBe('FIRE default · aq ≥ 230 · FDR 10%');
    await act(async () => { setFilters([{ ...FIRE, minValue: 204 }]); });
    expect(q('quality-summary-fire')!.textContent).toBe('FIRE · aq ≥ 204 · FDR 20%');
    await act(async () => { setFilters([{ ...FIRE, minValue: 204, enabled: false }, { ...NUC }]); });
    expect(q('quality-summary-fire')!.textContent).toBe('FIRE off');
    expect(q('quality-summary')!.textContent).toContain('+1 filter');
    await act(async () => { setFilters([]); });
    expect(q('quality-summary-fire')!.textContent).toBe('FIRE off');
  });

  // Audit RC2 (MED 1): Labeling can add several FIRE rows; the toolbar treats them as one.
  it('duplicate FIRE rows: off disables all, the header and toggle read them as one, an edit collapses them', async () => {
    setFilters([{ ...FIRE }, { ...NUC }, { ...FIRE, minValue: 242 }]);
    await act(async () => { root.render(<QualityQuickControls />); });
    // The strictest cutoff in effect is shown (both rows apply).
    expect(q('fire-filter-value')!.textContent).toContain('242');
    expect(container.querySelectorAll('[data-testid="quality-filter-enable"]')).toHaveLength(1); // only nuc
    await act(async () => { q<HTMLInputElement>('fire-filter-toggle')!.click(); });
    expect(filters().filter(f => f.layer === 'fire' && f.enabled)).toHaveLength(0);
    expect(filters()).toEqual([{ ...FIRE, minValue: 242, enabled: false }, { ...NUC }]);
    await act(async () => { q<HTMLInputElement>('fire-filter-toggle')!.click(); });
    expect(filters()).toEqual([{ ...FIRE, minValue: 242 }, { ...NUC }]);
    setFilters([{ ...FIRE }, { ...FIRE, minValue: 242 }]);
    await act(async () => { q<HTMLButtonElement>('fire-fdr-preset-20')!.click(); });
    expect(filters()).toEqual([{ ...FIRE, minValue: 204 }]);
  });

  it('duplicate FIRE rows: the header says off only when every FIRE row is off', async () => {
    setFilters([{ ...FIRE, enabled: false }, { ...FIRE, minValue: 242 }]);
    await act(async () => { root.render(<ToolbarSummaryShown value={false}><QualitySummary /></ToolbarSummaryShown>); });
    expect(q('quality-summary-fire')!.textContent).toBe('FIRE · aq ≥ 242 · FDR 5%');
    expect(q('quality-summary')!.textContent).not.toContain('filter');
  });

  // Audit RC2 (MED 2): a pending slider move never overrides filters changed elsewhere.
  for (const [name, change] of [
    ['a session turns FIRE off', () => setFilters([{ ...FIRE, enabled: false }])],
    ['the FIRE row is removed', () => setFilters([{ ...NUC }])],
    ['Labeling edits the threshold', () => setFilters([{ ...FIRE, minValue: 250 }])],
  ] as const) {
    it(`a pending slider move is dropped when ${name}`, async () => {
      vi.useFakeTimers();
      await act(async () => { root.render(<QualityQuickControls />); });
      await act(async () => { setRange(q<HTMLInputElement>('fire-filter-slider')!, 204); });
      await act(async () => { change(); });
      const after = JSON.stringify(filters());
      await act(async () => { vi.advanceTimersByTime(FIRE_SLIDER_COMMIT_MS * 3); });
      expect(JSON.stringify(filters())).toBe(after);
      expect(q('fire-filter-value')!.textContent).not.toContain('204');
    });
  }

  // Audit RC2 (MED 3): what is shown is what filters.
  it('off/on before a slider move applies discards it: display and filter agree', async () => {
    vi.useFakeTimers();
    await act(async () => { root.render(<QualityQuickControls />); });
    await act(async () => { setRange(q<HTMLInputElement>('fire-filter-slider')!, 204); });
    expect(q('fire-filter-value')!.textContent).toContain('204');
    await act(async () => { q<HTMLInputElement>('fire-filter-toggle')!.click(); });
    await act(async () => { q<HTMLInputElement>('fire-filter-toggle')!.click(); });
    await act(async () => { vi.advanceTimersByTime(FIRE_SLIDER_COMMIT_MS * 3); });
    expect(filters()).toEqual([{ ...FIRE }]);
    expect(q('fire-filter-value')!.textContent).toContain('230 (FDR 10%)');
  });

  it('releasing the slider applies the move at once', async () => {
    vi.useFakeTimers();
    await act(async () => { root.render(<QualityQuickControls />); });
    const slider = q<HTMLInputElement>('fire-filter-slider')!;
    await act(async () => { setRange(slider, 204); });
    await act(async () => { slider.dispatchEvent(new Event('pointerup', { bubbles: true })); });
    expect(filters()).toEqual([{ ...FIRE, minValue: 204 }]);
    expect(q('fire-filter-value')!.textContent).toContain('204 (FDR 20%)');
  });

  // RC2 e2e (ui-chrome-small): a two-line Quality group folded other open groups for the reads' height budget.
  it('below 1440 px the group drops the presets and long words (one line), keeping the full text for wide windows', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'ds1', available_layers: { msp: true } }] } as any);
    await act(async () => { root.render(<QualityQuickControls />); });
    const presets = container.querySelector('[aria-label="FIRE FDR presets"]')!;
    expect(presets.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'min-[1440px]:flex']));
    const note = q('fire-filter-nodata')!;
    expect(note.textContent).toBe('no FIRE scores in loaded data');
    expect(note.querySelector('.hidden')!.textContent).toBe(' in loaded data');
  });
});

