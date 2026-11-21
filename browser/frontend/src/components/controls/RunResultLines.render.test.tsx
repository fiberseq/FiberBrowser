import { useUndoToastStore } from '../../stores/undoToastStore';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { beginRun, runResultPanelsClosed, setRunResult, useRunResultStore } from '../../stores/runResultStore';
import { RunResultLines } from './RunResultLines';
import { clusterRunReporter } from '../../utils/clusterRunReporter';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const panel = (id: string) => ({ id, contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 });

describe('run result lines tied to their panels (round 2, N5)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    useUndoToastStore.getState().dismiss();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useRunResultStore.setState({ results: {}, runs: {}, showSummaries: true });
    useBrowserStore.setState({ panels: [panel('src'), panel('car'), panel('ref')] } as any);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('off by default, a run that went through shows no line; a refusal still does, floating (owner, 6 Oct)', () => {
    useRunResultStore.setState({ showSummaries: false });
    const run = beginRun('cluster');
    setRunResult('cluster', { tone: 'done', text: 'Clustered 1,802 reads in Carriers at 3 selected peaks.' }, run);
    setRunResult('cluster', { tone: 'note', text: 'The clusters largely separate the regions (NMI 0.75).' }, run);
    act(() => root.render(<RunResultLines />));
    expect(container.querySelector('[data-testid="run-result-cluster"]')).toBeNull();
    expect(useRunResultStore.getState().results.cluster?.text).toContain('NMI 0.75');
    act(() => setRunResult('sort', { tone: 'error', text: 'Nothing to sort.' }, beginRun('sort')));
    act(() => root.render(<RunResultLines />));
    expect(container.querySelector('[data-testid="run-result-sort"]')).not.toBeNull();
    // A toast at the foot of the window: the reads do not move, and panel headers stay clickable.
    expect(container.querySelector('[data-testid="run-results-anchor"]')!.className).toContain('fixed');
    act(() => useRunResultStore.getState().setShowSummaries(true));
    expect(container.querySelector('[data-testid="run-result-cluster"]')).not.toBeNull();
  });

  it('shows a no-op explanation with summaries off', () => {
    useRunResultStore.setState({ showSummaries: false });
    setRunResult('sort', { tone: 'note', alwaysShow: true, text: 'Reads are already in this order.' }, beginRun('sort'));
    act(() => root.render(<RunResultLines />));
    expect(container.querySelector('[data-testid="run-result-sort"]')?.textContent).toContain('already in this order');
  });

  it('uses the neutral result style for successful shared-feature clustering', () => {
    setRunResult('cluster', { tone: 'done', text: 'Clustered 1,025 reads on 2 shared flank features, balanced at 284 reads per panel. Insertion interior excluded.' }, beginRun('cluster'));
    act(() => root.render(<RunResultLines />));
    const line = container.querySelector<HTMLElement>('[data-testid="run-result-cluster"]')!;
    expect(line.dataset.tone).toBe('done');
    expect(line.className).toContain('text-slate-600');
    expect(line.className).not.toContain('amber');
  });

  it('stacks removal undo with run results and keeps it available without a run result', () => {
    let undone = false;
    setRunResult('cluster', { tone: 'note', text: 'Clustered selected regions.' }, beginRun('cluster'));
    useUndoToastStore.getState().show('browser', 'Removed F1 · Group', () => { undone = true; });
    act(() => root.render(<RunResultLines />));
    const stack = container.querySelector('[data-testid="run-results"]')!;
    expect(stack.querySelector('[data-testid="run-result-cluster"]')).not.toBeNull();
    expect(stack.querySelector('[data-testid="undo-toast"]')).not.toBeNull();
    act(() => useRunResultStore.getState().clearRunResult('cluster'));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="undo-toast-undo"]')!.click());
    expect(undone).toBe(true);
    expect(container.querySelector('[data-testid="run-results-anchor"]')).toBeNull();
  });

  it('keeps the panels of a run, joined across its notes', () => {
    const run = beginRun('cluster');
    setRunResult('cluster', { tone: 'done', text: 'Clustered 2,033 reads in Carriers.', panelIds: ['car'] }, run);
    setRunResult('cluster', { tone: 'note', text: 'Not clustered: Reference.' }, run);
    const r = useRunResultStore.getState().results.cluster!;
    expect(r.panelIds).toEqual(['car']);
    expect(r.tone).toBe('note');
    expect(runResultPanelsClosed(r, new Set(['car']))).toBe(false);
    expect(runResultPanelsClosed(r, new Set(['ref']))).toBe(true);
    // Not tied to panels (a refusal): never "closed".
    expect(runResultPanelsClosed({}, new Set())).toBe(false);
  });

  it('says "(panel closed)" once every panel it clustered has closed', () => {
    const run = beginRun('cluster');
    setRunResult('cluster', { tone: 'done', text: 'Clustered 2,033 reads in Carriers.', panelIds: ['car'] }, run);
    act(() => root.render(<RunResultLines />));
    const line = () => container.querySelector<HTMLElement>('[data-testid="run-result-cluster"]')!;
    expect(line().dataset.panelsClosed).toBeUndefined();
    expect(line().textContent).not.toContain('closed');
    act(() => useBrowserStore.setState({ panels: [panel('src')] } as any));
    expect(line().dataset.panelsClosed).toBe('true');
    expect(container.querySelector('[data-testid="run-result-cluster-text"]')!.textContent).toBe('Clustered 2,033 reads in Carriers. (panel closed)');
  });

  it.each(['done', 'note'] as const)('keeps plan advice out of pending results, then publishes it with the %s outcome and panels', async tone => {
    act(() => root.render(<RunResultLines />));
    let run!: number;
    act(() => { run = beginRun('cluster'); });
    const advice = {
      text: 'Plain peaks in each panel are paired from left to right and cropped to the narrowest width. These positions are not verified matches.',
      action: { label: 'Synchronise regions', panel: 'sync-regions' },
    };
    const report = clusterRunReporter(run, advice);
    let finish!: () => void;
    const response = new Promise<void>(resolve => { finish = resolve; });
    const pending = response.then(() => report(tone, 'Clustered 9 reads in Carriers.', ['car']));

    // cluster-targets waits for this run's done/note marker before closing the split.
    // Planning advice alone used to satisfy that wait and let Close cancel the request.
    expect(useRunResultStore.getState().results.cluster).toBeUndefined();
    expect(container.querySelector('[data-testid="run-result-cluster-marker"]')).toBeNull();
    const published: Array<string[] | undefined> = [];
    const unsubscribe = useRunResultStore.subscribe(s => published.push(s.results.cluster?.panelIds));
    await act(async () => { finish(); await pending; });
    unsubscribe();
    expect(published).toEqual([['car']]); // no intermediate advice-only outcome
    const line = container.querySelector<HTMLElement>('[data-testid="run-result-cluster"]')!;
    expect(line.dataset.tone).toBe('note');
    expect(line.textContent).toContain(`${advice.text} Clustered 9 reads in Carriers.`);
    expect(container.querySelector('[data-testid="run-result-cluster-action"]')!.textContent).toBe('Synchronise regions');
    expect(container.querySelector<HTMLElement>('[data-testid="run-result-cluster-marker"]')!.dataset.run).toBe(String(run));
    act(() => report('note', 'Not clustered: Reference.'));
    expect(line.textContent!.split(advice.text)).toHaveLength(2); // advice appears once
    act(() => useBrowserStore.setState({ panels: [panel('src')] } as any));
    expect(container.querySelector('[data-testid="run-result-cluster-closed"]')!.textContent).toBe('(panel closed)');
  });

  it('does not attach plan advice to a refusal or publish a superseded outcome', () => {
    const report = clusterRunReporter(beginRun('cluster'), { text: 'Planning advice.' });
    report('error', 'Request failed.');
    expect(useRunResultStore.getState().results.cluster!.text).toBe('Request failed.');
    beginRun('cluster');
    report('done', 'Old response.', ['car']);
    expect(useRunResultStore.getState().results.cluster).toBeUndefined();
  });

  it('a rerun with the same text replaces the line visibly: its run number and time (round 3, B5)', () => {
    act(() => root.render(<RunResultLines />));
    const marker = () => container.querySelector<HTMLElement>('[data-testid="run-result-cluster-marker"]');
    let run = 0;
    act(() => { run = beginRun('cluster'); setRunResult('cluster', { tone: 'done', text: 'Clustered 1,977 reads in Carriers at 1 selected peak.' }, run); });
    expect(marker()!.dataset.run).toBe('1');
    expect(marker()!.textContent).toMatch(/^run 1 · \d/);
    act(() => { run = beginRun('cluster'); setRunResult('cluster', { tone: 'done', text: 'Clustered 1,977 reads in Carriers at 1 selected peak.' }, run); });
    expect(marker()!.dataset.run).toBe('2');
    expect(marker()!.textContent).toMatch(/^run 2 · /);
    // A note of the same run keeps the run's time.
    const at = useRunResultStore.getState().results.cluster!.at;
    act(() => setRunResult('cluster', { tone: 'note', text: 'Not clustered: Reference.' }, run));
    expect(useRunResultStore.getState().results.cluster!.at).toBe(at);
  });
});
