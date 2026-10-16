import { describe, expect, it } from 'vitest';
import { showDrawerPanel, useDrawerTabsStore } from './drawerTabsStore';
import { useBrowserStore } from './browserStore';
import '../plugins/builtinPanels';

describe('side-panel drawer tabs', () => {
  it('brings a panel hidden behind another tab forward; others are left alone', () => {
    useDrawerTabsStore.setState({ active: { 0: 'p-a' }, hidden: { 'p-b': 0 } });
    expect(showDrawerPanel('p-c')).toBe(false);
    expect(showDrawerPanel('p-b')).toBe(true);
    expect(useDrawerTabsStore.getState().active[0]).toBe('p-b');
  });

  it('opening an already open panel shows it in the drawer instead of doing nothing', () => {
    useBrowserStore.setState({ panels: [], dismissedPanelTypes: new Set() } as never);
    useBrowserStore.getState().openAnalysisPanel('read-stats');
    const id = useBrowserStore.getState().panels.find(p => p.contentType === 'read-stats')!.id;
    useDrawerTabsStore.setState({ active: { 0: 'other' }, hidden: { [id]: 0 } });
    useBrowserStore.getState().openAnalysisPanel('read-stats');
    expect(useDrawerTabsStore.getState().active[0]).toBe(id);
    expect(useBrowserStore.getState().panels.filter(p => p.contentType === 'read-stats')).toHaveLength(1);
  });

  // Codex integration review (fb24, M1): Quality → Edit filters… with Labeling already the
  // drawer's active tab, the drawer tucked away: nothing told the drawer to slide back out.
  it('asking again for the panel the drawer already shows tells the drawer (to slide back out)', () => {
    useBrowserStore.setState({ panels: [], dismissedPanelTypes: new Set() } as never);
    useBrowserStore.getState().openAnalysisPanel('colormap');
    const id = useBrowserStore.getState().panels.find(p => p.contentType === 'colormap')!.id;
    useDrawerTabsStore.setState({ active: { 0: id }, hidden: {}, inDrawer: [id] });
    let notified = 0;
    const stop = useDrawerTabsStore.subscribe(() => { notified += 1; });
    useBrowserStore.getState().openAnalysisPanel('colormap');
    stop();
    expect(notified).toBeGreaterThan(0);
    expect(useDrawerTabsStore.getState().active[0]).toBe(id);
  });

  it('a panel beside the reads (not in the drawer) asks nothing of the drawer', () => {
    useBrowserStore.setState({ panels: [], dismissedPanelTypes: new Set() } as never);
    useBrowserStore.getState().openAnalysisPanel('colormap');
    const id = useBrowserStore.getState().panels.find(p => p.contentType === 'colormap')!.id;
    // Its row remembers it as the drawer's tab (for when the drawer comes back), but no drawer holds it now.
    useDrawerTabsStore.setState({ active: { 0: id }, hidden: {}, inDrawer: ['panel-other'] });
    let notified = 0;
    const stop = useDrawerTabsStore.subscribe(() => { notified += 1; });
    useBrowserStore.getState().openAnalysisPanel('colormap');
    stop();
    expect(notified).toBe(0);
  });
});
