import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';

const anchors = vi.hoisted(() => ({
  highlightForAction: vi.fn(async (_action: Record<string, unknown>, _opts?: unknown): Promise<string | undefined> => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));
vi.mock('../utils/copilotAnchors', () => anchors);

beforeEach(() => {
  useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  anchors.highlightForAction.mockReset();
  anchors.highlightForAction.mockResolvedValue(undefined);
});

describe('tutorial gating', () => {
  it('skip_if drops a step whose goal already holds, without showing it', async () => {
    useBrowserStore.setState({ selectedPeaks: new Set([2]) } as never);
    const message = await executeBrowserAction({ type: 'explain', text: 'Click a peak.', skip_if: 'has_selected_peak' } as never);
    expect(message).toMatch(/^⏭ Already done \(a peak is selected\)/);
    expect(anchors.highlightForAction).not.toHaveBeenCalled();
  });

  it('requires first points at the missing prerequisite, then shows the step', async () => {
    anchors.highlightForAction.mockResolvedValueOnce('done');
    await executeBrowserAction({ type: 'explain', text: 'Cluster now.', requires: 'has_selected_peak' } as never);
    const [first, second] = anchors.highlightForAction.mock.calls.map(call => call[0]);
    expect(first).toMatchObject({ type: 'try_it', anchor: 'peaks-track', wait_condition: 'has_selected_peak' });
    expect(String(first.text)).toMatch(/Select a peak first/);
    expect(second).toMatchObject({ type: 'explain', text: 'Cluster now.' });
  });

  it('reports whether the user did a try_it step', async () => {
    anchors.highlightForAction.mockResolvedValueOnce('done');
    expect(await executeBrowserAction({ type: 'try_it', text: 'Click Cluster.', wait_for: 'clustered' } as never))
      .toBe('✅ Done: Click Cluster.');
    anchors.highlightForAction.mockResolvedValueOnce('timeout');
    expect(await executeBrowserAction({ type: 'try_it', text: 'Click Cluster.', wait_for: 'clustered' } as never))
      .toBe('⏭ Skipped (timed out): Click Cluster.');
    anchors.highlightForAction.mockResolvedValueOnce('skip');
    expect(await executeBrowserAction({ type: 'try_it', text: 'Click Cluster.', wait_for: 'clustered' } as never))
      .toBe('⏭ Skipped: Click Cluster.');
  });
});

describe('view actions', () => {
  it('zooms, pans and closes panels without touching analysis state', async () => {
    const before = useBrowserStore.getState();
    await executeBrowserAction({ type: 'zoom_view', direction: 'out', steps: 2 } as never);
    const zoomed = useBrowserStore.getState();
    expect(zoomed.end - zoomed.start).toBeGreaterThan(before.end - before.start);
    await executeBrowserAction({ type: 'pan_view', direction: 'right' } as never);
    expect(useBrowserStore.getState().start).toBeGreaterThan(zoomed.start);
    // (openAnalysisPanel needs the plugin registry, which unit tests don't load.)
    useBrowserStore.setState({
      panels: [...useBrowserStore.getState().panels, { id: 'cd1', contentType: 'cluster-detail', subTracks: [] } as never],
    });
    await executeBrowserAction({ type: 'close_panel', panel_type: 'cluster-detail' } as never);
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'cluster-detail')).toBe(false);
    expect(useBrowserStore.getState().clusterAssignments).toEqual(before.clusterAssignments);
  });

  it('opens a sidebar section through the app event', async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('fiberbrowser:open-sidebar-section', listener);
    await executeBrowserAction({ type: 'open_sidebar', section: 'genome', subsection: 'genome.reference' } as never);
    window.removeEventListener('fiberbrowser:open-sidebar-section', listener);
    expect(seen).toEqual([{ sectionId: 'genome', subsectionId: 'genome.reference' }]);
    expect(useBrowserStore.getState().sidebarOpen).toBe(true);
  });
});
