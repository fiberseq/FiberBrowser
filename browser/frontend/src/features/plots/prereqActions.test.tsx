/**
 * The step buttons of Plots' empty states each run the right command: Scan peaks, Scan and select the peaks in view,
 * Find classes in this view, the Nucleosomes panel (geometries), Cluster reads, each behind Plots (the workspace stays);
 * read groups need a choice and open Footprints › Classes (the browser shows). A step that does not start says why.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const cmd = vi.hoisted(() => ({ run: vi.fn((_n: string) => true as boolean), find: vi.fn(async () => true), tab: vi.fn() }));
vi.mock('../../utils/appCommands', async importOriginal => ({ ...(await importOriginal<typeof import('../../utils/appCommands')>()), runAppCommand: cmd.run }));
vi.mock('../../utils/analysisCommands', async importOriginal => ({ ...(await importOriginal<typeof import('../../utils/analysisCommands')>()), findFootprintClassesInView: cmd.find, openPanelOnTab: cmd.tab }));

import { useBrowserStore } from '../../stores/browserStore';
import { PrereqButton, PrereqProgress, type PrereqKind } from './prereqActions';
import { useLiveJobs } from '../../stores/liveJobsStore';
import { useNucJob } from '../nucleosomes/nucJob';

/** Rendered into the page (the stores' current state, not their initial one). */
function html(node: React.ReactElement): string {
  const c = document.createElement('div');
  document.body.appendChild(c);
  const r = createRoot(c);
  act(() => { r.render(node); });
  const out = c.innerHTML;
  act(() => r.unmount());
  c.remove();
  return out;
}
import { registerPlots } from './register';
import { useWorkspaceStore, workspaceHeld } from './workspace';

registerPlots();

async function click(kind: PrereqKind) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<PrereqButton kind={kind} />); });
  await act(async () => { (container.querySelector(`[data-testid="plots-prereq-run-${kind}"]`) as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
  const state = container.querySelector(`[data-testid="plots-prereq-${kind}"]`)!.getAttribute('data-state');
  const text = container.textContent ?? '';
  act(() => root.unmount());
  container.remove();
  return { state, text };
}

beforeEach(() => {
  cmd.run.mockClear(); cmd.find.mockClear(); cmd.tab.mockClear();
  cmd.run.mockImplementation(() => true);
  useWorkspaceStore.setState({ view: 'plots' });
});

describe('Plots step buttons', () => {
  it('Scan peaks runs the toolbar scan', async () => {
    const r = await click('peaks');
    expect(cmd.run).toHaveBeenCalledWith('scan-peaks');
    expect(r.state).toBe('running');
  });
  it('Find classes runs Find classes in this view, behind Plots', async () => {
    let heldDuring = false;
    cmd.find.mockImplementation(async () => { heldDuring = workspaceHeld(); return true; });
    await click('classes');
    expect(cmd.find).toHaveBeenCalledTimes(1);
    expect(heldDuring).toBe(true);
    expect(useWorkspaceStore.getState().view).toBe('plots');
  });
  it('Find geometries opens the Nucleosomes panel on this view without leaving Plots', async () => {
    const open = vi.spyOn(useBrowserStore.getState(), 'openAnalysisPanel');
    await click('geometries');
    expect(open).toHaveBeenCalledWith('nucleosomes');
    expect(useWorkspaceStore.getState().view).toBe('plots');
    open.mockRestore();
  });
  it('Cluster reads runs the toolbar Cluster', async () => {
    await click('cluster');
    expect(cmd.run).toHaveBeenCalledWith('cluster-reads');
  });
  it('read groups need a choice: opens Footprints › Classes (the browser shows) and says so', async () => {
    const r = await click('groups');
    expect(cmd.tab).toHaveBeenCalledWith('footprint-analysis', 'states');
    expect(useWorkspaceStore.getState().view).toBe('browser');
    expect(r.text).toContain('opens the panel');
  });
  it('Scan and select peaks: scans when there are none, then selects the peaks in view', async () => {
    const peaks = [{ index: 0, chrom: 'chrT', start: 100, end: 200 }, { index: 1, chrom: 'chrT', start: 9000, end: 9100 }, { index: 2, chrom: 'chrT', start: 400, end: 500 }];
    let scanned = false;
    cmd.run.mockImplementation((n: string) => { if (n === 'scan-peaks') scanned = true; return true; });
    const select = vi.fn();
    useBrowserStore.setState({ chrom: 'chrT', start: 0, end: 1000, getAllPeaks: () => (scanned ? peaks : []), replacePeakSelection: select } as never);
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => { root.render(<PrereqButton kind="select-peaks" />); });
    await act(async () => { (container.querySelector('[data-testid="plots-prereq-run-select-peaks"]') as HTMLButtonElement).click(); await vi.advanceTimersByTimeAsync(600); });
    expect(cmd.run).toHaveBeenCalledWith('scan-peaks');
    expect(select).toHaveBeenCalledWith([0, 2]);
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  it('a step that does not start says why', async () => {
    cmd.run.mockImplementation(() => false);
    const r = await click('peaks');
    expect(r.state).toBe('error');
    expect(r.text).toContain('not available');
  });
});

describe('step progress: the panels\' own progress components and job state', () => {
  it('Find classes: the consensus run\'s stage, bar and Cancel; geometries: the nucleosome line with Cancel; peaks: the scan', () => {
    useLiveJobs.setState({ consensus: { job_id: 'j1', status: 'running', stage: 'recaller_discovery', created_at: 1, started_at: 1, request: { parameters: {}, dataset_ids: [] }, progress: { stage: 'recaller_discovery', completed: 4, total: 20, fraction: 0.2, unit: 'tiles' } } as never, scanning: true });
    const classes = html(<PrereqProgress kind="classes" />);
    expect(classes).toContain('consensus-progress');
    expect(classes).toContain('Finding classes');
    expect(classes).toContain('Cancel');
    useNucJob.setState({ job: { job_id: 'n1', status: 'running', created_at: 1, datasets: [{ datasetId: 'd', label: 'D', kind: 'native' }, { datasetId: 'e', label: 'E', kind: 'native' }], view: { chrom: 'c', start: 0, end: 1 }, results: {} } } as never);
    const geo = html(<PrereqProgress kind="geometries" />);
    expect(geo).toContain('Analysing… 1 of 2 samples');
    expect(geo).toContain('plots-prereq-progress-geometries-cancel');
    expect(html(<PrereqProgress kind="peaks" />)).toContain('Scanning peaks');
    useLiveJobs.setState({ consensus: null, scanning: false });
    useNucJob.setState({ job: null } as never);
    expect(html(<PrereqProgress kind="classes" />)).toBe('');
  });
});
