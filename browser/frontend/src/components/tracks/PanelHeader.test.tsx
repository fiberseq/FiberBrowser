import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadStatusStore } from '../../stores/readStatusStore';
import { HEADER_NAME_MIN, PanelHeader, fitHeaderPills, headerLayout } from './PanelHeader';
import { useTrackMenuStore } from '../../stores/trackMenuStore';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const panel = { id: 'p1', datasetId: 'ds1', contentType: 'dataset', subTracks: [], collapsed: false } as unknown as PanelConfig;

describe('dataset header: colour, name, read count, strand and one menu', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6' }],
      panels: [panel], selectedDatasets: new Set(), exportInProgress: false, fullViewPanelId: null,
    } as never);
    useReadStatusStore.getState().setStatus('ds1', { text: '586 of 3,170 rows drawn', title: 'reads' });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useReadStatusStore.getState().setStatus('ds1', null);
  });

  it('a split panel leads with its group (never cut); the SV and the dataset follow; Split × reads Close split on hover', () => {
    const split = { ...panel, id: 'p2', stateKey: 'ds1:split-1:1', readSubset: {
      groupId: 'split-1', label: 'INS 9.2 kb @ chr2L:9,467,039 · Reference', colour: '#00f', count: 333, sourcePanelId: 'p1',
      locus: { chrom: 'chr2L', start: 1, end: 2, label: 'INS 9.2 kb @ chr2L:9,467,039' },
      rule: { kind: 'frozen', datasetId: 'ds1', groupKeys: ['1'] } } } as unknown as PanelConfig;
    act(() => root.render(<PanelHeader panel={split} panelIndex={0} width={300} />));
    const title = container.querySelector<HTMLElement>('[data-testid="panel-header-title"]')!;
    expect(title.textContent).toBe('Reference');
    expect(title.className).toContain('flex-shrink-0');
    expect(container.querySelector('[data-testid="panel-header-context"]')!.textContent).toBe('\u00a0·\u00a0INS 9.2 kb @ chr2L:9,467,039 · napa_ddda');
    expect(container.querySelector<HTMLElement>('[data-testid="panel-header-name"]')!.title).toContain('Reference · INS 9.2 kb');
    const pill = container.querySelector<HTMLElement>('[data-testid="split-panel-close-all"]')!;
    expect(pill.getAttribute('aria-label')).toBe('Close split (all its panels)');
    expect(pill.textContent).toContain('Close split');
    expect(pill.title).toContain('the panel it came from shows again');
    const sibling = { ...split, id: 'p3', readSubset: { ...split.readSubset!, groupId: 'split-2' } };
    act(() => useBrowserStore.setState({ panels: [panel, split, sibling] }));
    expect(pill.title).toContain('stays folded while another split from it is open');
    act(() => useBrowserStore.setState({ panels: [panel, split] }));
    expect(pill.title).toContain('the panel it came from shows again');
  });

  it('shows the name, a quiet read count and, with room, every action as a button (⋯ keeps only Close)', () => {
    act(() => root.render(<PanelHeader panel={panel} panelIndex={0} width={800} />));
    const header = container.querySelector('[data-testid="dataset-header-ds1"]')!;
    expect(header.textContent).toContain('napa_ddda');
    const count = container.querySelector('[data-testid="panel-read-status"]')!;
    expect(count.textContent).toBe('586 of 3,170 rows drawn');
    expect(count.className).not.toContain('pill');
    // fb-n11-tracks: Tracks and the panel tools, then minimize, expand and close at the end.
    const buttons = [...header.querySelectorAll('button[aria-label]')];
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual([
      'Tracks in this panel…', 'Clean view', 'Add a copy', 'Compare haplotypes…', 'Panel actions', 'Minimize', 'Expand to full view', 'Close dataset',
    ]);
    // "…" is there at every width, with Close in it (usability audit bug 6: Close left the menu as panels widened).
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="panel-actions-p1"]')!.click());
    expect([...container.querySelectorAll('[role="menu"] [role="menuitem"]')].map(b => b.textContent)).toEqual(['Close dataset']);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="panel-actions-p1"]')!.click());
    expect(container.querySelector('[data-testid="panel-tracks-p1"]')!.textContent).toBe('Tracks');
    act(() => container.querySelector<HTMLButtonElement>('[data-tour="panel-minimize"]')!.click());
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p1')?.collapsed).toBe(true);
  });

  it('the name targets the panel from the keyboard and says so (aria-pressed, a Target chip)', () => {
    act(() => root.render(<PanelHeader panel={panel} panelIndex={0} width={800} />));
    const name = container.querySelector<HTMLButtonElement>('button[data-testid="panel-header-name"]')!;
    expect(name.getAttribute('aria-pressed')).toBe('false');
    act(() => name.click());
    expect(useBrowserStore.getState().selectedDatasets.has('p1')).toBe(true);
    act(() => root.render(<PanelHeader panel={panel} panelIndex={0} width={800} />));
    expect(container.querySelector('button[data-testid="panel-header-name"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="panel-target-chip"]')?.textContent?.trim()).toBe('Target');
    act(() => container.querySelector<HTMLButtonElement>('button[data-testid="panel-header-name"]')!.click());
    expect(useBrowserStore.getState().selectedDatasets.has('p1')).toBe(false);
  });

  it('the Tracks button opens "Tracks in this panel"; a track menu can open it too', () => {
    act(() => root.render(<PanelHeader panel={panel} panelIndex={0} width={800} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="panel-tracks-p1"]')!.click());
    expect(document.querySelector('[data-testid="panel-tracks-menu-p1"]')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="panel-tracks-p1"]')!.click());
    expect(document.querySelector('[data-testid="panel-tracks-menu-p1"]')).toBeNull();
    act(() => useTrackMenuStore.getState().openPanelTracksMenu('p1'));
    expect(document.querySelector('[data-testid="panel-tracks-menu-p1"]')).not.toBeNull();
    expect(useTrackMenuStore.getState().tracksMenuFor).toBeNull();
  });

  it('Clean view: on by default (labels on hover only); the toggle keeps them shown, undoably', () => {
    act(() => root.render(<PanelHeader panel={panel} panelIndex={0} width={800} />));
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="panel-clean-view-p1"]')!;
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    act(() => toggle().click());
    const p1 = () => useBrowserStore.getState().panels.find(p => p.id === 'p1')!;
    expect(p1().showTrackLabels).toBe(true);
    act(() => root.render(<PanelHeader panel={p1()} panelIndex={0} width={800} />));
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    act(() => useBrowserStore.getState().undo());
    expect(p1().showTrackLabels).toBeUndefined();
  });

  // M17: stacking was only reachable by dropping a panel on another's bottom edge.
  it('the menu stacks a side-by-side panel below its neighbour, and puts a stacked one side by side', async () => {
    const a = { ...panel, layoutRow: 0 } as PanelConfig;
    const b = { ...panel, id: 'p2', datasetId: 'ds2', layoutRow: 0 } as PanelConfig;
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6' }, { id: 'ds2', label: 'FlyAmp', color: '#ef4444' }],
      panels: [a, b],
    } as never);
    act(() => root.render(<PanelHeader panel={b} panelIndex={1} width={800} />));
    const stack = container.querySelector<HTMLButtonElement>('[data-tour="panel-stack"]')!;
    expect(stack.getAttribute('aria-label')).toContain('Stack below napa_ddda');
    expect(container.querySelector('[data-tour="panel-side-by-side"]')).toBeNull();
    act(() => stack.click());
    const panels = useBrowserStore.getState().panels;
    expect(panels.map(p => [p.id, p.layoutColumn])).toEqual([['p1', 0], ['p2', 0]]);

    const stacked = panels.find(p => p.id === 'p2')!;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });  // the menu closes
    act(() => root.render(<PanelHeader panel={stacked} panelIndex={1} width={800} />));
    expect(container.querySelector('[data-tour="panel-stack"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-tour="panel-side-by-side"]')!.click());
    const after = useBrowserStore.getState().panels;
    expect(after.find(p => p.id === 'p2')!.layoutColumn).toBeUndefined();
  });

  it('exported figures keep only the name (no menu)', () => {
    useBrowserStore.setState({ exportInProgress: true } as never);
    act(() => root.render(<PanelHeader panel={panel} panelIndex={0} width={800} />));
    expect(container.querySelector('[data-testid="panel-actions-p1"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel-clean-view-p1"]')).toBeNull();
  });
});

// Audit M14: with four panels the headers kept "312/3,173 visible" and lost the dataset name.
describe('a narrow dataset header keeps the name first', () => {
  const c = { label: 'flyamp_DddB.called', status: '312/3,173 visible', stranded: true, strand: null, grip: true, actions: true } as const;

  it('wide: everything in full', () => {
    expect(headerLayout(800, c)).toMatchObject({ status: 'full', strandNarrow: false });
    expect(headerLayout(undefined, c)).toMatchObject({ status: 'full', strandNarrow: false });
  });

  it('narrower: the count shortens, then the strand chip, then the count goes', () => {
    expect(headerLayout(380, c)).toMatchObject({ status: 'short', strandNarrow: false });
    expect(headerLayout(345, c)).toMatchObject({ status: 'short', strandNarrow: true });
    expect(headerLayout(230, c)).toMatchObject({ status: 'none', strandNarrow: true });
    // Measured action buttons that must stay (fb-n11-tracks) take their room first.
    expect(headerLayout(380, { ...c, actionsWidth: 120 })).toMatchObject({ status: 'none', strandNarrow: true });
  });

  it('a short name leaves room for the count', () => {
    // (A short name still keeps its 56 px minimum: Codex review.)
    expect(headerLayout(360, { ...c, label: 'napa' })).toMatchObject({ status: 'full', strandNarrow: false });
    expect(headerLayout(340, { ...c, label: 'napa' }).status).not.toBe('full');
  });

  it('rendered narrow: the name is there with a minimum width; the count is short or gone', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'flyamp_DddB.called', color: '#8b5cf6' }],
      panels: [panel], selectedDatasets: new Set(), exportInProgress: false, fullViewPanelId: null,
    } as never);
    useReadStatusStore.getState().setStatus('ds1', { text: '312/3,173 visible', title: 'reads' });
    act(() => root.render(<PanelHeader panel={panel} panelIndex={0} width={300} />));
    const name = container.querySelector<HTMLElement>('[data-testid="panel-header-name"]')!;
    expect(name.textContent).toBe('flyamp_DddB.called');
    expect(name.style.minWidth).toBe(`${HEADER_NAME_MIN}px`);
    expect(container.querySelector('[data-testid="panel-read-status"]')!.textContent).toBe('312/3,173');
    act(() => root.render(<PanelHeader panel={panel} panelIndex={0} width={230} />));
    expect(container.querySelector('[data-testid="panel-read-status"]')).toBeNull();
    expect(name.title).toContain('312/3,173 visible');
    act(() => root.unmount());
    container.remove();
    useReadStatusStore.getState().setStatus('ds1', null);
  });
});

describe('action pills (a split panel\'s "Expand INS …", round 2 N3)', () => {
  it('shows whole pills, in order, while the essential actions keep their room; the rest go to "…"', () => {
    // 2 pills of 100 px (+6 gap each), essentials 110 px.
    expect(fitHeaderPills(400, [100, 100], 110)).toEqual({ count: 2, width: 212 });
    expect(fitHeaderPills(250, [100, 100], 110)).toEqual({ count: 1, width: 106 });
    expect(fitHeaderPills(200, [100, 100], 110)).toEqual({ count: 0, width: 0 });
    // A second pill that doesn't fit is not shown even if a later, narrower one would: order is kept.
    expect(fitHeaderPills(250, [100, 100, 10], 110)).toEqual({ count: 1, width: 106 });
    // No layout (tests): all of them.
    expect(fitHeaderPills(undefined, [100, 100], 110).count).toBe(2);
  });
});
