/**
 * The Co-accessibility panel moved into Plots: opening the old panel type (⌘K, links, scripts, the track menu, the
 * Footprints button) opens Plots on a co-accessibility plot of the view with the co-accessibility settings; ⌘K has its
 * own entry; a session saved with the panel open restores the plot as the builder's working plot, the panel dropped.
 */
import '../testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useCoaccStore } from '../../stores/coaccStore';
import { migratePanelAliases } from '../../plugins/registry';
import { APP_COMMAND_INFO, runAppCommand } from '../../utils/appCommands';
import { registerCoaccEntry } from './coaccEntry';
import { emptyPlotsWorkspace } from './plotsState';
import { newPlot } from './plotModel';
import { useWorkspaceStore } from './workspace';

registerCoaccEntry();

beforeEach(() => {
  useWorkspaceStore.setState({ view: 'browser' });
  useBrowserStore.setState({ plotsWorkspace: emptyPlotsWorkspace(), datasets: [{ id: 'd1', label: 'D1', path: '/x.bam' }, { id: 'd2', label: 'D2', path: '/y.bam' }] } as never);
  const c = useCoaccStore.getState();
  c.setCoaccNormalization('raw' as never);
  c.setCoaccScaling('log' as never);
  c.setCoaccBinSize(200);
  c.setCoaccMinCoverage(12);
  c.setCoaccLayer('nuc');
});

describe('co-accessibility entry points', () => {
  it('opening the old panel opens Plots on a co-accessibility plot of the view, with the settings; no panel', () => {
    const before = useBrowserStore.getState().panels.length;
    useBrowserStore.getState().openAnalysisPanel('co-accessibility' as never);
    expect(useBrowserStore.getState().panels.length).toBe(before);
    expect(useWorkspaceStore.getState().view).toBe('plots');
    const p = useBrowserStore.getState().plotsWorkspace.current;
    expect(p).toMatchObject({ type: 'co-accessibility', where: 'view', groupBy: 'dataset' });
    expect(p.coacc).toMatchObject({ normalization: 'raw', scaling: 'log', binBp: 200, minCoverage: 12, layer: 'nuc' });
  });

  it('⌘K: a Co-accessibility entry opens the same', () => {
    expect(APP_COMMAND_INFO['open-coaccessibility']?.label).toBe('Co-accessibility');
    expect(runAppCommand('open-coaccessibility')).toBe(true);
    expect(useBrowserStore.getState().plotsWorkspace.current.type).toBe('co-accessibility');
  });

  it('an old session with the panel open: the panel goes, the builder holds the co-accessibility plot', () => {
    vi.useFakeTimers();
    useBrowserStore.getState().setPlotsWorkspace(ws => ({ ...ws, current: newPlot({ type: 'metaprofile' }) }));
    const panels = migratePanelAliases([{ id: 'p1', contentType: 'dataset' }, { id: 'coacc-1', contentType: 'co-accessibility' }]);
    expect(panels.map(p => p.contentType)).toEqual(['dataset']);
    vi.runAllTimers();
    const p = useBrowserStore.getState().plotsWorkspace.current;
    expect(p.type).toBe('co-accessibility');
    expect(p.coacc).toMatchObject({ normalization: 'raw', layer: 'nuc' });
    // The browser stays in the browser (a session never opens in a workspace).
    expect(useWorkspaceStore.getState().view).toBe('browser');
    vi.useRealTimers();
  });
});
