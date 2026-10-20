import { describe, expect, it } from 'vitest';
import { stackHeights, usePanelContentHeightStore } from './panelContentHeightStore';
import { useBrowserStore } from './browserStore';
import { usePreviewStore } from '../utils/previewFeatures';
import { registerGraphPanel } from '../features/graphPanel/register';
import type { PanelConfig } from '../types';

describe('size-to-content panels in a stacked column', () => {
  it('a reported natural height (plus its header) replaces an equal share; the others share the rest', () => {
    expect(stackHeights(800, [null, 170], 24)).toEqual([606, 194]);
    expect(stackHeights(800, [170, null, null], 24)).toEqual([194, 303, 303]);
    // Never more than half the column; never below its header and a little.
    expect(stackHeights(800, [null, 2000], 24)).toEqual([400, 400]);
    expect(stackHeights(800, [null, 0], 24)).toEqual([736, 64]);
    // No room: the flexible panel keeps its minimum, the sized ones shrink.
    expect(stackHeights(300, [null, 200], 24, 0.9, 160)).toEqual([160, 140]);
    // Nothing reported yet: equal shares.
    expect(stackHeights(800, [null, null], 24)).toEqual([400, 400]);
    expect(stackHeights(500, [null], 24)).toEqual([500]);
  });

  it('reports are kept per panel and cleared', () => {
    const s = usePanelContentHeightStore.getState();
    s.report('g1', 170.4);
    expect(usePanelContentHeightStore.getState().heights.g1).toBe(170);
    s.report('g1', null);
    expect('g1' in usePanelContentHeightStore.getState().heights).toBe(false);
  });

  it('a graph view opens stacked under the top row\'s reads panel, a second one under the first', () => {
    registerGraphPanel();
    usePreviewStore.setState({ enabled: true } as never);
    const reads = { id: 'reads-1', contentType: 'dataset', datasetId: 'd1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 } as unknown as PanelConfig;
    useBrowserStore.setState({ panels: [reads], dismissedPanelTypes: new Set() } as never);
    useBrowserStore.getState().openAnalysisPanel('graph-view' as never);
    useBrowserStore.getState().openAnalysisPanel('graph-view' as never);
    const panels = useBrowserStore.getState().panels;
    expect(panels.map(p => p.contentType)).toEqual(['dataset', 'graph-view', 'graph-view']);
    const col = panels[0].layoutColumn;
    expect(col).not.toBeUndefined();
    expect(panels.every(p => p.layoutColumn === col && (p.layoutRow ?? 0) === 0)).toBe(true);
  });
});
