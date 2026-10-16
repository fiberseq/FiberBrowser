/**
 * Usability round 2: the class rows at the Footprints column's widths (N1), the tier words and their units (N20), the
 * Saved card's channel rows as checkboxes with a warning when an unsupported channel changes the estimate (N19), and
 * Inspect opening under the list rather than inside its scroll box (FP-3).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { NARROW_LIST_PX, RecallerClassTable, tierCumulativeLine, tierLine, tierText } from './RecallerClassTable';
import { SavedClassCard, savedEstimate, unsupportedEffect } from './SavedClassCard';
import { savedClassEntries } from '../../../utils/savedClasses';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const r = (prevalence: number, extra = {}) => ({ prevalence, prevalence_edge: prevalence + .28, prevalence_loose: prevalence + .49, molecules: 1039,
  prevalence_lower_bound: 0, broader: 0, other_shape: 0, accessible: 1 - prevalence, support_gain_nats: 20, supported: true,
  resolution_nats: 12, resolved: true, spots: '', L0: 0, L1: 1, R0: 2, R1: 3, unknown_accessible_fraction: .5, efficiency: null, ...extra });
const catalog = () => ({
  cr_mode: 'lattice_recaller', region: { chrom: 'chr1', start: 0, end: 1000 },
  datasets: {
    ind: { catalog: [{ family: 'class_025', consensus_start: 100, consensus_end: 137,
      recaller: { CT: r(.026, { supported: false, molecules: 1413, prevalence_edge: .03, prevalence_loose: .04 }), GA: r(.052) } }] },
  },
}) as any;
const labels = { ind: 'amp_DddB.full' };

/** A ResizeObserver that reports one width for every element it observes. */
function fixWidth(width: number) {
  (globalThis as any).ResizeObserver = class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(el: Element) { this.cb([{ target: el, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {} disconnect() {}
  };
}

describe('class rows at the Footprints column widths (N1)', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [], chrom: 'chr1', hasFasta: false } as any);
    useConsensusViewStore.setState({ selections: [] } as any);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); delete (globalThis as any).ResizeObserver; });

  const layoutAt = (width: number) => {
    fixWidth(width);
    act(() => root.render(<RecallerClassTable jobId="7c90ea8f" catalog={catalog()} datasetLabels={labels} runLabel="run 1" />));
    const list = container.querySelector<HTMLElement>('[data-testid="recaller-class-list"]')!;
    const row = container.querySelector<HTMLElement>('[data-testid="recaller-row"]')!;
    const parts = [...row.children].map(el => el.getAttribute('data-testid'));
    return { layout: list.dataset.layout, parts, row };
  };

  it.each([420, 520])('at %i px the numbers go on their own line, after "Add to Saved" (no overlap)', width => {
    const { layout, parts, row } = layoutAt(width);
    expect(layout).toBe('narrow');
    expect(parts.indexOf('recaller-row-stats')).toBeGreaterThan(parts.indexOf('recaller-save'));
    expect(row.className).toContain('flex-wrap');
    expect(row.querySelector('[data-testid="recaller-row-stats"]')!.className).toContain('w-full');
    // the action keeps its words (not "Save", which is the toolbar's)
    expect(row.querySelector('[data-testid="recaller-save"]')!.textContent).toBe('Add to Saved');
  });

  it('at 700 px one line: the numbers between the class and the action, in a column of their own', () => {
    expect(700).toBeGreaterThanOrEqual(NARROW_LIST_PX);
    const { layout, parts, row } = layoutAt(700);
    expect(layout).toBe('wide');
    expect(parts.indexOf('recaller-row-stats')).toBeLessThan(parts.indexOf('recaller-save'));
    const words = row.querySelector<HTMLElement>('[data-testid="recaller-tier-text"]')!;
    expect(words.className).toContain('shrink-0');                              // the bar gives way, not the numbers
    // the numbers never shrink under the links or Add to Saved: below their width the row wraps instead (Codex)
    expect(row.querySelector('[data-testid="recaller-row-stats"]')!.className).toContain('min-w-[12.5rem]');
    expect(row.className).toContain('flex-wrap');
    expect(words.textContent).toBe('2.6%');                                    // unsupported CT: its exact % only
    expect(row.querySelectorAll('[data-testid="recaller-tier-text"]')[1].textContent).toBe('5.2% · +28 · +21 pp');
  });

  it('Inspect opens under the list, outside its scroll box (FP-3)', async () => {
    layoutAt(420);
    act(() => (container.querySelector('[data-testid="recaller-inspect"]') as HTMLButtonElement).click());
    const panel = container.querySelector<HTMLElement>('[data-testid="recaller-inspect-panel"]')!;
    expect(panel).not.toBeNull();
    expect(panel.closest('[data-testid="recaller-class-list"]')).toBeNull();
    expect(panel.dataset.family).toBe('class_025');
    // keyboard handoff (Codex): the arrow controls the panel, focus moves into it, and closing returns focus to the arrow
    const arrow = container.querySelector<HTMLElement>('[data-testid="recaller-inspect"]')!;
    expect(arrow.getAttribute('aria-controls')).toBe(panel.id);
    expect(document.activeElement).toBe(panel);
    act(() => (container.querySelector('[data-testid="recaller-inspect-close"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="recaller-inspect-panel"]')).toBeNull();
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement).toBe(container.querySelector('[data-testid="recaller-inspect"]'));
  });

  it('a mouse click opens Inspect without taking focus away from the list (Codex)', () => {
    layoutAt(420);
    const arrow = container.querySelector<HTMLElement>('[data-testid="recaller-inspect"]')!;
    arrow.focus();
    act(() => { arrow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
    expect(container.querySelector('[data-testid="recaller-inspect-panel"]')).not.toBeNull();
    expect(document.activeElement).toBe(arrow);
  });
});

describe('tier words with units, one formatter (N20)', () => {
  it('increments in percentage points; cumulative labelled as such', () => {
    const s = r(.052) as any;
    expect(tierText(s)).toEqual({ exact: '5.2%', edge: '+28 pp', other: '+21 pp' });
    expect(tierLine(s)).toBe('exact 5.2% · edge +28 pp · other +21 pp');
    expect(tierCumulativeLine(s)).toBe('exact 5.2% · ≤ edge 33.2% · ≤ other 54.2%');
    // an unsupported channel has no upper tiers
    expect(tierLine({ ...s, supported: false })).toBe('exact 5.2%');
  });
});

describe('Compare strands uses the same tier words (N20)', () => {
  it('a compare cell says "exact 5.2% · edge +28 pp · other +21 pp", as its tooltip does', () => {
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    useConsensusViewStore.setState({ selections: [] } as any);
    try {
      act(() => root.render(<RecallerClassTable variant="compare" jobId="7c90ea8f" catalog={catalog()} datasetLabels={labels} />));
      const tiers = container.querySelector<HTMLElement>('[data-testid="recaller-tiers"]')!;
      expect(tiers.textContent).toBe('exact 5.2% · edge +28 pp · other +21 pp');
      expect(tiers.closest('button')!.title).toContain('tiers: exact 5.2% · edge +28 pp · other +21 pp');
    } finally { act(() => root.unmount()); container.remove(); }
  });
});

describe('Saved channel rows (N19)', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [], chrom: 'chr1', hasFasta: false } as any);
    useConsensusViewStore.setState({ selections: [] } as any);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const renderCard = () => {
    const [e] = savedClassEntries(useBrowserStore.getState().footprintGroups);
    act(() => root.render(<SavedClassCard info={e.info} groups={e.groups} filtering={false} onFilter={() => {}} targetDatasetIds={[]} chartWidth={300} />));
    return e;
  };

  it('each channel is a checkbox row; "not supported" is words; including it warns with both estimates', () => {
    act(() => root.render(<RecallerClassTable jobId="7c90ea8f" catalog={catalog()} datasetLabels={labels} runLabel="run 1" />));
    act(() => (container.querySelector('[data-testid="recaller-save"]') as HTMLButtonElement).click());
    renderCard();
    const inputs = () => [...container.querySelectorAll<HTMLInputElement>('[data-testid="saved-class-channel-input"]')];
    expect(inputs().map(i => i.checked)).toEqual([false, true]);                 // CT unsupported: not counted
    expect(inputs()[1].disabled).toBe(true);                                     // the last counted channel stays
    expect(container.querySelector('[data-testid="saved-class-unsupported"]')!.textContent).toBe(' · Not supported on CT (exact matches only)');
    expect(container.querySelector('[data-testid="saved-class-unsupported-warning"]')).toBeNull();
    // the channel tooltips say plainly what a tick does, and "not supported" in the same words as the class list (R12)
    const channelRows = [...container.querySelectorAll<HTMLElement>('[data-testid="saved-class-channel"]')];
    expect(channelRows[0].title.split('\n')[0]).toBe('Not counted: tick to include amp_DddB.full CT');
    expect(channelRows[0].title).toContain('Not supported on CT (exact matches only)');
    expect(channelRows[1].title.split('\n')[0]).toBe('Counted: amp_DddB.full GA is the last counted channel');
    act(() => inputs()[0].click());                                               // include CT
    const e = renderCard();
    expect(inputs().map(i => i.checked)).toEqual([true, true]);
    const warning = container.querySelector('[data-testid="saved-class-unsupported-warning"]')!.textContent!;
    expect(warning).toContain('CT');
    expect(warning).toContain('of 2,452 molecules');
    expect(warning).toContain('without: 5.2% of 1,039');
    const effect = unsupportedEffect(e.info, ['core'])!;
    expect(effect.unsupported).toEqual(['ind::CT']);
    expect(effect.with.molecules).toBe(2452);
    // counting + edge: the unsupported channel still counts exact matches only, as its row says (Codex)
    const edge = unsupportedEffect(e.info, ['core', 'edge'])!;
    const rows = (1413 * .026 + 1039 * (.052 + .28)) / 2452;
    expect(edge.with.value).toBeCloseTo(rows, 6);
    expect(edge.without!.value).toBeCloseTo(.332, 6);
    expect(savedEstimate(e.info, e.info.picked, ['core', 'edge']).value).toBeCloseTo(rows, 6);   // the card's estimate agrees
    // exact unticked: the unsupported channel counts nothing (its wider tiers don't count), as downstream (Codex)
    expect(savedEstimate(e.info, ['ind::CT'], ['edge']).value).toBe(0);
    expect(savedEstimate(e.info, ['ind::GA'], ['edge']).value).toBeCloseTo(.28, 6);
  });
});

describe('one short run name (Top 4)', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(async () => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [], chrom: 'chr1', hasFasta: false } as any);
    useConsensusViewStore.setState({ selections: [] } as any);
    const { resetRunNames, useRunNamesStore } = await import('../../../utils/runNames');
    resetRunNames();
    const at = (h: number, m: number) => new Date(2026, 9, 6, h, m).getTime() / 1000;
    useRunNamesStore.getState().note('footprint', [{ job_id: '7c90ea8f749f4f85', created_at: at(14, 2) }, { job_id: '11aa22bb', created_at: at(13, 40) }]);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('the class list, the Saved card and its prose say "Footprint run 2 · 6 Oct 14:02"; the id is in the tooltip', () => {
    act(() => root.render(<RecallerClassTable jobId="7c90ea8f749f4f85" catalog={catalog()} datasetLabels={labels} runLabel="run 2" />));
    const label = container.querySelector<HTMLElement>('[data-testid="recaller-run-label"]')!;
    expect(label.textContent).toBe('Footprint run 2 · 6 Oct 14:02');
    expect(label.title).toContain('7c90ea8f749f4f85');
    act(() => root.render(<RecallerClassTable jobId="7c90ea8f749f4f85" catalog={catalog()} datasetLabels={labels} runLabel="run 2 · stringency 0.90" />));
    expect(container.querySelector('[data-testid="recaller-run-label"]')!.textContent).toBe('Footprint run 2 · 6 Oct 14:02 · stringency 0.90');
    act(() => (container.querySelector('[data-testid="recaller-save"]') as HTMLButtonElement).click());
    const [e] = savedClassEntries(useBrowserStore.getState().footprintGroups);
    act(() => root.render(<SavedClassCard info={e.info} groups={e.groups} filtering={false} onFilter={() => {}} targetDatasetIds={[]} chartWidth={300} />));
    const run = container.querySelector<HTMLElement>('[data-testid="saved-class-run"]')!;
    expect(run.textContent).toBe('37 bp · Footprint run 2 · 6 Oct 14:02');
    expect(run.textContent).not.toMatch(/7c90/);
    act(() => (container.querySelector('[aria-expanded]') as HTMLButtonElement).click());
    const prose = container.querySelector<HTMLElement>('[data-testid="saved-class-provenance"]')!;
    expect(prose.textContent).toContain('Class 025 of Footprint run 2 · 6 Oct 14:02 (stringency 0.90)');
    expect(prose.textContent).not.toMatch(/7c90ea8f|class_025/);                 // the ids are behind Copy ids
    expect(container.querySelector('[data-testid="saved-class-copy-run"]')).not.toBeNull();
  });
});

describe('run names are looked for again while unknown (Codex)', () => {
  it('a run the first list did not have gets its name on a later look', async () => {
    const { vi } = await import('vitest');
    const { registerRunLister, resetRunNames, useRunName, RUN_NAME_RETRY_MS } = await import('../../../utils/runNames');
    resetRunNames();
    vi.useFakeTimers();
    const lists = [[], [{ job_id: 'late1', created_at: new Date(2026, 9, 6, 9, 5).getTime() / 1000 }]];
    let calls = 0;
    registerRunLister('footprint', async () => lists[Math.min(calls++, 1)]);
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    function Name() { return <span data-testid="n">{useRunName('footprint', 'late1').name}</span>; }
    try {
      await act(async () => { root.render(<Name />); });
      expect(container.textContent).toBe('Footprint run late…');
      await act(async () => { vi.advanceTimersByTime(RUN_NAME_RETRY_MS + 10); });
      await act(async () => { await Promise.resolve(); });
      expect(container.textContent).toBe('Footprint run 1 · 6 Oct 09:05');
      expect(calls).toBe(2);
    } finally {
      act(() => root.unmount()); container.remove(); vi.useRealTimers();
      const { getConsensusJobs } = await import('../../../api/consensusWorkflow');
      registerRunLister('footprint', () => getConsensusJobs().then(r => r.jobs));
      resetRunNames();
    }
  });
});
