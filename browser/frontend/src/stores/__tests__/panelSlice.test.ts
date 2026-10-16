import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, ensureBuiltinPanelsRegistered } from './helpers';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  store = createTestStore();
});

// ============================================================================
// Panel CRUD
// ============================================================================

describe('addPanel', () => {
  it('creates a dataset panel with default sub-tracks', () => {
    const id = store.getState().addPanel('ds1');
    expect(id).toBeTruthy();
    const panels = store.getState().panels;
    expect(panels).toHaveLength(1);
    expect(panels[0].contentType).toBe('dataset');
    expect(panels[0].datasetId).toBe('ds1');
    expect(panels[0].collapsed).toBe(false);
  });

  it('returns unique IDs for multiple panels', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    expect(id1).not.toBe(id2);
    expect(store.getState().panels).toHaveLength(2);
  });
});

describe('removePanel', () => {
  it('removes panel by ID', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().removePanel(id);
    expect(store.getState().panels).toHaveLength(0);
  });

  it('clears fullViewPanelId when that panel is removed', () => {
    const id = store.getState().addPanel('ds1');
    store.setState({ fullViewPanelId: id });
    store.getState().removePanel(id);
    expect(store.getState().fullViewPanelId).toBeNull();
  });
});

describe('duplicatePanel', () => {
  it('creates a copy of a dataset panel', () => {
    const id = store.getState().addPanel('ds1');
    const cloneId = store.getState().duplicatePanel(id);
    expect(cloneId).toBeTruthy();
    expect(store.getState().panels).toHaveLength(2);
    const clone = store.getState().panels.find(p => p.id === cloneId)!;
    expect(clone.datasetId).toBe('ds1');
    expect(clone.contentType).toBe('dataset');
  });

  it('inserts clone after original', () => {
    store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    store.getState().addPanel('ds3');
    store.getState().duplicatePanel(id2);
    const panels = store.getState().panels;
    expect(panels).toHaveLength(4);
    // Clone of ds2 should be at index 2
    expect(panels[2].datasetId).toBe('ds2');
  });

  it('clone starts unlinked (linkGroup: null)', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().togglePanelLink(id);
    const cloneId = store.getState().duplicatePanel(id);
    const clone = store.getState().panels.find(p => p.id === cloneId)!;
    // Duplicates start unlinked so they have independent state
    expect(clone.linkGroup).toBeNull();
  });

  it('returns empty string for non-dataset panels', () => {
    store.getState().openAnalysisPanel('cluster-detail');
    const analysisPanel = store.getState().panels[0];
    const result = store.getState().duplicatePanel(analysisPanel.id);
    expect(result).toBe('');
  });
});

// ============================================================================
// openAnalysisPanel — singleton enforcement
// ============================================================================

describe('openAnalysisPanel', () => {
  it('opens analysis panel', () => {
    store.getState().openAnalysisPanel('cluster-detail');
    const panels = store.getState().panels;
    expect(panels).toHaveLength(1);
    expect(panels[0].contentType).toBe('cluster-detail');
  });

  it('enforces singleton — cannot open duplicate', () => {
    store.getState().openAnalysisPanel('cluster-detail');
    store.getState().openAnalysisPanel('cluster-detail');
    expect(store.getState().panels).toHaveLength(1);
  });

  it('allows multiple different analysis panels', () => {
    store.getState().openAnalysisPanel('cluster-detail');
    store.getState().openAnalysisPanel('transcription-state');
    expect(store.getState().panels).toHaveLength(2);
  });

  it('ignores unknown plugin types', () => {
    store.getState().openAnalysisPanel('nonexistent-panel');
    expect(store.getState().panels).toHaveLength(0);
  });
});

describe('closeAnalysisPanel', () => {
  it('removes panel by ID', () => {
    store.getState().openAnalysisPanel('cluster-detail');
    const id = store.getState().panels[0].id;
    store.getState().closeAnalysisPanel(id);
    expect(store.getState().panels).toHaveLength(0);
  });

  it('clears fullViewPanelId when the closed analysis panel was maximized', () => {
    store.getState().openAnalysisPanel('cluster-detail');
    const id = store.getState().panels[0].id;
    store.setState({ fullViewPanelId: id });

    store.getState().closeAnalysisPanel(id);

    expect(store.getState().fullViewPanelId).toBeNull();
  });
});

// ============================================================================
// Link groups — toggleSubTrack propagation
// ============================================================================

describe('link group propagation', () => {
  it('toggleSubTrack propagates to linked panels', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    // Link both panels
    store.getState().linkPanels([id1, id2]);

    const panel1 = store.getState().panels.find(p => p.id === id1)!;
    const readsTrack = panel1.subTracks.find(t => t.type === 'reads');
    expect(readsTrack?.visible).toBe(true);

    // Toggle reads on panel1 — should propagate to panel2
    store.getState().toggleSubTrack(id1, 'reads');

    const p1After = store.getState().panels.find(p => p.id === id1)!;
    const p2After = store.getState().panels.find(p => p.id === id2)!;
    expect(p1After.subTracks.find(t => t.type === 'reads')?.visible).toBe(false);
    expect(p2After.subTracks.find(t => t.type === 'reads')?.visible).toBe(false);
  });

  it('panel-only toggle does not propagate to unlinked panels', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    // Explicit local visibility, regardless of link groups.
    store.getState().toggleSubTrack(id1, 'reads', true);

    const p1 = store.getState().panels.find(p => p.id === id1)!;
    const p2 = store.getState().panels.find(p => p.id === id2)!;
    expect(p1.subTracks.find(t => t.type === 'reads')?.visible).toBe(false);
    expect(p2.subTracks.find(t => t.type === 'reads')?.visible).toBe(true);
  });
});

describe('projected sub-tracks', () => {
  it('hides composite rows instead of deleting them so sync does not revive expensive tracks', () => {
    const panelId = store.getState().addPanel('ds1');
    const compositeId = store.getState().addComposite({
      id: 'motifs',
      label: 'Motifs',
      kind: 'annotation',
      sources: [],
    });
    const trackType = `composite-${compositeId}` as const;

    expect(store.getState().panels.find(p => p.id === panelId)?.subTracks.find(t => t.type === trackType)?.visible).toBe(true);

    store.getState().removeSubTrack(panelId, trackType);

    expect(store.getState().panels.find(p => p.id === panelId)?.subTracks.find(t => t.type === trackType)?.visible).toBe(false);

    store.getState().setCompositeTracks(store.getState().compositeTracks);

    expect(store.getState().panels.find(p => p.id === panelId)?.subTracks.find(t => t.type === trackType)?.visible).toBe(false);

    expect(store.getState().canUndo()).toBe(true);
    store.getState().undo();
    expect(store.getState().panels.find(p => p.id === panelId)?.subTracks.find(t => t.type === trackType)?.visible).toBe(true);

    expect(store.getState().canRedo()).toBe(true);
    store.getState().redo();
    expect(store.getState().panels.find(p => p.id === panelId)?.subTracks.find(t => t.type === trackType)?.visible).toBe(false);
  });
});

// ============================================================================
// Link group management
// ============================================================================

describe('link group management', () => {
  it('togglePanelLink assigns a link group', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().togglePanelLink(id);
    const panel = store.getState().panels[0];
    expect(panel.linkGroup).toBeTruthy();
  });

  it('togglePanelLink removes link group when already linked', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().togglePanelLink(id);
    store.getState().togglePanelLink(id);
    expect(store.getState().panels[0].linkGroup).toBeNull();
  });

  it('linkPanels assigns same group to multiple panels', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    store.getState().linkPanels([id1, id2]);
    const p1 = store.getState().panels.find(p => p.id === id1)!;
    const p2 = store.getState().panels.find(p => p.id === id2)!;
    expect(p1.linkGroup).toBe(p2.linkGroup);
    expect(p1.linkGroup).toBeTruthy();
  });

  it('unlinkPanel removes link from single panel', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    store.getState().linkPanels([id1, id2]);
    store.getState().unlinkPanel(id1);
    expect(store.getState().panels.find(p => p.id === id1)!.linkGroup).toBeNull();
    expect(store.getState().panels.find(p => p.id === id2)!.linkGroup).toBeTruthy();
  });
});

// ============================================================================
// Panel config
// ============================================================================

describe('panel config', () => {
  it('setPanelCollapsed toggles collapsed state', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().setPanelCollapsed(id, true);
    expect(store.getState().panels[0].collapsed).toBe(true);
    store.getState().setPanelCollapsed(id, false);
    expect(store.getState().panels[0].collapsed).toBe(false);
  });

  it('exits full view when the maximized panel is minimized', () => {
    const id = store.getState().addPanel('ds1');
    store.setState({ fullViewPanelId: id });

    store.getState().setPanelCollapsed(id, true);

    expect(store.getState().fullViewPanelId).toBeNull();
  });

  it('setPanelDataset changes dataset', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().setPanelDataset(id, 'ds2');
    expect(store.getState().panels[0].datasetId).toBe('ds2');
  });

  it('setPanelLayout changes layout row', () => {
    const id = store.getState().addPanel('ds1');
    expect(store.getState().panels[0].layoutRow).toBe(0);
    store.getState().setPanelLayout(id, 'column');
    expect(store.getState().panels[0].layoutRow).toBe(1);
    store.getState().setPanelLayout(id, 'row');
    expect(store.getState().panels[0].layoutRow).toBe(0);
  });

  it('setFullViewPanel sets the full-view panel ID', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().setFullViewPanel(id);
    expect(store.getState().fullViewPanelId).toBe(id);
  });
});

// ============================================================================
// reorderPanels
// ============================================================================

describe('reorderPanels', () => {
  it('moves panel from one position to another', () => {
    store.getState().addPanel('ds1');
    store.getState().addPanel('ds2');
    store.getState().addPanel('ds3');
    const before = store.getState().panels.map(p => p.datasetId);
    expect(before).toEqual(['ds1', 'ds2', 'ds3']);

    store.getState().reorderPanels(0, 2);
    const after = store.getState().panels.map(p => p.datasetId);
    expect(after).toEqual(['ds2', 'ds3', 'ds1']);
  });
});

// ============================================================================
// Contact regions (split view)
// ============================================================================

describe('openContactRegions', () => {
  it('creates Locus X and Locus Y panels and collapses originals', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().openContactRegions({
      chrom: 'chr1',
      x_start: 1000,
      x_end: 2000,
      y_start: 5000,
      y_end: 6000,
    });

    const panels = store.getState().panels;
    // Original collapsed + 2 new panels
    const xPanels = panels.filter(p => p.regionLabel === 'Locus X');
    const yPanels = panels.filter(p => p.regionLabel === 'Locus Y');
    expect(xPanels).toHaveLength(1);
    expect(yPanels).toHaveLength(1);
    expect(xPanels[0].viewportOverride?.start).toBe(1000);
    expect(yPanels[0].viewportOverride?.start).toBe(5000);

    // Original should be collapsed
    const original = panels.find(p => p.id === id);
    expect(original?.collapsed).toBe(true);
  });

  it('publishes contact loci into the genome navigator channel', () => {
    store.getState().addPanel('ds1');
    store.getState().openContactRegions({
      chrom: 'chr1',
      x_start: 1000,
      x_end: 2000,
      y_chrom: 'chr2',
      y_start: 5000,
      y_end: 6000,
    });

    expect(store.getState().navigatorRegions).toEqual([
      expect.objectContaining({ label: 'Locus X', source: 'contact', chrom: 'chr1', start: 1000, end: 2000 }),
      expect.objectContaining({ label: 'Locus Y', source: 'contact', chrom: 'chr2', start: 5000, end: 6000 }),
    ]);
  });

  it('lays out multiple datasets as stacked X/Y columns with independent state keys', () => {
    store.getState().addPanel('ds1');
    store.getState().addPanel('ds2');
    store.getState().openContactRegions({
      chrom: 'chr1',
      x_start: 1000,
      x_end: 2000,
      y_start: 5000,
      y_end: 6000,
    });

    const regionPanels = store.getState().panels.filter(p => p.contactRegionGroupId);
    expect(regionPanels).toHaveLength(4);
    expect(regionPanels.filter(p => p.contactRegionRole === 'x').map(p => p.layoutColumn)).toEqual([0, 0]);
    expect(regionPanels.filter(p => p.contactRegionRole === 'y').map(p => p.layoutColumn)).toEqual([1, 1]);
    expect(new Set(regionPanels.map(p => p.stateKey))).toHaveLength(4);
  });

  it('replaces the previous contact-region group instead of accumulating stale panels', () => {
    store.getState().addPanel('ds1');
    store.getState().openContactRegions({
      chrom: 'chr1',
      x_start: 1000, x_end: 2000,
      y_start: 5000, y_end: 6000,
    });
    store.getState().openContactRegions({
      chrom: 'chr1',
      x_start: 3000, x_end: 4000,
      y_start: 7000, y_end: 8000,
    });

    const regionPanels = store.getState().panels.filter(p => p.contactRegionGroupId);
    expect(regionPanels).toHaveLength(2);
    expect(regionPanels.find(p => p.contactRegionRole === 'x')?.viewportOverride?.start).toBe(3000);
    expect(regionPanels.find(p => p.contactRegionRole === 'y')?.viewportOverride?.start).toBe(7000);
    expect(store.getState().navigatorRegions.filter(r => r.source === 'contact')).toHaveLength(2);
    expect(store.getState().navigatorRegions.find(r => r.label === 'Locus X')?.start).toBe(3000);
  });
});

describe('Genome Navigator regions', () => {
  it('stores navigator regions without opening panels by default', () => {
    store.getState().addNavigatorRegion({
      chrom: 'chr3',
      start: 100,
      end: 200,
      label: 'manual',
      source: 'manual',
      datasetIds: ['ds1'],
    });

    expect(store.getState().navigatorRegions).toHaveLength(1);
    expect(store.getState().panels).toHaveLength(0);
  });

  it('opens explicit navigator regions as dataset panels', () => {
    store.setState({ datasets: [{ id: 'ds1', label: 'one' }, { id: 'ds2', label: 'two' }] as any });
    store.getState().openGenomeRegionViews([
      { chrom: 'chr1', start: 1000, end: 2000, label: 'A', datasetIds: ['ds2'] },
      { chrom: 'chr2', start: 3000, end: 4000, label: 'B', datasetIds: ['ds1', 'ds2'] },
    ]);

    const panels = store.getState().panels.filter(p => p.genomeRegionGroupId);
    expect(panels).toHaveLength(3);
    expect(panels.map(p => p.datasetId)).toEqual(['ds2', 'ds1', 'ds2']);
    expect(panels[0].viewportOverride).toEqual({ chrom: 'chr1', start: 1000, end: 2000 });
    expect(panels[1].regionLabel).toBe('B');
  });
});

describe('closeContactRegions', () => {
  it('removes viewport-override panels and uncollapse originals', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().openContactRegions({
      chrom: 'chr1',
      x_start: 1000, x_end: 2000,
      y_start: 5000, y_end: 6000,
    });
    store.getState().closeContactRegions();

    const panels = store.getState().panels;
    expect(panels.filter(p => p.viewportOverride)).toHaveLength(0);
    expect(panels.find(p => p.id === id)?.collapsed).toBe(false);
    expect(store.getState().navigatorRegions.filter(r => r.source === 'contact')).toHaveLength(0);
  });

  it('does not remove unrelated viewport-override panels', () => {
    store.getState().openHaplotypeComparison({
      chrom1: 'chr2L',
      chrom2: 'chr2R',
      start: 1000,
      end: 2000,
    });
    store.getState().openContactRegions({
      chrom: 'chr1',
      x_start: 1000, x_end: 2000,
      y_start: 5000, y_end: 6000,
    });
    store.getState().closeContactRegions();

    const panels = store.getState().panels;
    expect(panels.filter(p => p.haplotypeGroup)).toHaveLength(2);
    expect(panels.filter(p => p.contactRegionGroupId)).toHaveLength(0);
  });
});

describe('haplotype comparison lifecycle', () => {
  it('closes only haplotype panels and restores their source panels', () => {
    const sourceId = store.getState().addPanel('ds1');
    store.getState().openHaplotypeComparison({
      chrom1: 'chr1_mat',
      chrom2: 'chr1_pat',
      start: 1000,
      end: 2000,
    });

    expect(store.getState().panels.filter(p => p.haplotypeGroup)).toHaveLength(2);
    expect(store.getState().panels.find(p => p.id === sourceId)?.collapsed).toBe(true);

    store.getState().closeHaplotypeComparison();

    expect(store.getState().panels.filter(p => p.haplotypeGroup)).toHaveLength(0);
    expect(store.getState().panels.find(p => p.id === sourceId)?.collapsed).toBe(false);
    expect(store.getState().navigatorRegions.filter(r => r.source === 'haplotype')).toHaveLength(0);
  });

  it('replaces a previous haplotype comparison without touching contact panels', () => {
    store.getState().addPanel('ds1');
    store.getState().openContactRegions({
      chrom: 'chr1', x_start: 1000, x_end: 2000, y_start: 3000, y_end: 4000,
    });
    store.getState().openHaplotypeComparison({
      chrom1: 'chr1_mat', chrom2: 'chr1_pat', start: 5000, end: 6000,
    });
    store.getState().openHaplotypeComparison({
      chrom1: 'chr2_mat', chrom2: 'chr2_pat', start: 7000, end: 8000,
    });

    expect(store.getState().panels.filter(p => p.contactRegionGroupId)).toHaveLength(2);
    const hapPanels = store.getState().panels.filter(p => p.haplotypeGroup);
    expect(hapPanels).toHaveLength(2);
    expect(hapPanels.map(p => p.viewportOverride?.chrom)).toEqual(['chr2_mat', 'chr2_pat']);
  });
});

describe('haplotype comparison with datasets chosen per view', () => {
  it('shows each view its own datasets, stacked, and restores the sources on close', () => {
    store.setState({ datasets: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] as any });
    const sourceA = store.getState().addPanel('a');
    store.getState().addPanel('b');
    store.getState().addPanel('c');

    store.getState().openHaplotypeComparison({
      chrom1: 'chr1_mat', chrom2: 'chr1_pat', start: 1000, end: 2000,
      datasets1: ['a', 'b'], datasets2: ['c'],
    });

    const hap = store.getState().panels.filter(p => p.haplotypeGroup);
    expect(hap.map(p => [p.datasetId, p.haplotypeSide, p.layoutColumn, p.viewportOverride?.chrom])).toEqual([
      ['a', 1, 0, 'chr1_mat'],
      ['b', 1, 0, 'chr1_mat'],
      ['c', 2, 1, 'chr1_pat'],
    ]);
    // Own state keys (clusters, filters) per comparison panel; the source panel's tracks.
    expect(new Set(hap.map(p => p.stateKey)).size).toBe(3);
    expect(hap[0].subTracks).toEqual(store.getState().panels.find(p => p.id === sourceA)!.subTracks);
    expect(hap.every(p => p.siteLocked)).toBe(true);
    const regions = store.getState().navigatorRegions.filter(r => r.source === 'haplotype');
    expect(regions.map(r => [r.chrom, r.datasetIds])).toEqual([['chr1_mat', ['a', 'b']], ['chr1_pat', ['c']]]);

    store.getState().closeHaplotypeComparison();
    expect(store.getState().panels.filter(p => p.haplotypeGroup)).toHaveLength(0);
    expect(store.getState().panels.every(p => !p.collapsed)).toBe(true);
  });

  it('gives a dataset without an open panel default tracks', () => {
    store.getState().addPanel('a');
    store.getState().openHaplotypeComparison({
      chrom1: 'h1', chrom2: 'h2', start: 0, end: 500, datasets1: ['a'], datasets2: ['z'],
    });
    const right = store.getState().panels.find(p => p.haplotypeSide === 2)!;
    expect(right.datasetId).toBe('z');
    expect(right.subTracks.length).toBeGreaterThan(0);
  });

  it('marks the default layout panels with their view too', () => {
    store.getState().addPanel('a');
    store.getState().openHaplotypeComparison({ chrom1: 'h1', chrom2: 'h2', start: 0, end: 500 });
    const hap = store.getState().panels.filter(p => p.haplotypeGroup);
    expect(hap.map(p => [p.haplotypeSide, p.viewportOverride?.chrom])).toEqual([[1, 'h1'], [2, 'h2']]);
  });
});

// ============================================================================
// Panel selection (edit mode)
// ============================================================================

describe('panel selection', () => {
  it('togglePanelSelection only works in edit mode', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().togglePanelSelection(id, false);
    expect(store.getState().selectedPanelIds.size).toBe(0);
  });

  it('togglePanelSelection works in edit mode', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().setEditMode(true);
    store.getState().togglePanelSelection(id, false);
    expect(store.getState().selectedPanelIds.has(id)).toBe(true);
  });

  it('shift-click adds to selection', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    store.getState().setEditMode(true);
    store.getState().togglePanelSelection(id1, false);
    store.getState().togglePanelSelection(id2, true); // shift-click
    expect(store.getState().selectedPanelIds.size).toBe(2);
  });

  it('setEditMode(false) clears selection', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().setEditMode(true);
    store.getState().togglePanelSelection(id, false);
    store.getState().setEditMode(false);
    expect(store.getState().selectedPanelIds.size).toBe(0);
  });
});

// ============================================================================
// Row layout
// ============================================================================

describe('row layout', () => {
  it('panels default to layoutRow 0', () => {
    const id = store.getState().addPanel('ds1');
    expect(store.getState().panels[0].layoutRow).toBe(0);
  });

  it('setPanelRow moves panel to a different row', () => {
    const id = store.getState().addPanel('ds1');
    store.getState().setPanelRow(id, 2);
    expect(store.getState().panels[0].layoutRow).toBe(2);
  });

  it('movePanelToRow moves panel to target row', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    store.getState().movePanelToRow(id1, 1);
    const p1 = store.getState().panels.find(p => p.id === id1)!;
    expect(p1.layoutRow).toBe(1);
    // ds2 stays at row 0
    const p2 = store.getState().panels.find(p => p.id === id2)!;
    expect(p2.layoutRow).toBe(0);
  });

  it('toggleRowCollapsed toggles row collapse state', () => {
    expect(store.getState().collapsedRows.has(0)).toBe(false);
    store.getState().toggleRowCollapsed(0);
    expect(store.getState().collapsedRows.has(0)).toBe(true);
    store.getState().toggleRowCollapsed(0);
    expect(store.getState().collapsedRows.has(0)).toBe(false);
  });

  it('setAnalysisStripCollapsed sets strip collapsed', () => {
    expect(store.getState().analysisStripCollapsed).toBe(false);
    store.getState().setAnalysisStripCollapsed(true);
    expect(store.getState().analysisStripCollapsed).toBe(true);
  });

  it('setHiddenStripPanels replaces and persists strip visibility settings', () => {
    store.getState().setHiddenStripPanels(['read-stats', 'history']);
    expect(store.getState().hiddenStripPanels).toEqual(new Set(['read-stats', 'history']));
    expect(localStorage.getItem('fiberhmm_hidden_strip_panels')).toBe('["read-stats","history"]');
  });

  it('setHiddenStripPanels drops stale panel ids from saved and notebook settings', () => {
    store.getState().setHiddenStripPanels(['read-stats', 'dataset', 'motif-tracks', 'read-stats', 'history']);
    expect(store.getState().hiddenStripPanels).toEqual(new Set(['read-stats', 'history']));
    expect(localStorage.getItem('fiberhmm_hidden_strip_panels')).toBe('["read-stats","history"]');
  });

  it('toggleStripPanel persists hidden strip panel changes', () => {
    store.getState().toggleStripPanel('read-stats');
    expect(store.getState().hiddenStripPanels).toEqual(new Set(['read-stats']));
    expect(localStorage.getItem('fiberhmm_hidden_strip_panels')).toBe('["read-stats"]');
    store.getState().toggleStripPanel('read-stats');
    expect(store.getState().hiddenStripPanels.size).toBe(0);
    expect(localStorage.getItem('fiberhmm_hidden_strip_panels')).toBe('[]');
  });

  it('toggleStripPanel ignores non-analysis panel ids', () => {
    store.getState().toggleStripPanel('dataset');
    store.getState().toggleStripPanel('not-real');
    expect(store.getState().hiddenStripPanels.size).toBe(0);
    expect(localStorage.getItem('fiberhmm_hidden_strip_panels')).toBeNull();
  });

  it('tolerates corrupted hidden strip localStorage', () => {
    localStorage.setItem('fiberhmm_hidden_strip_panels', 'not-json');
    store = createTestStore();
    expect(store.getState().hiddenStripPanels.size).toBe(0);
  });

  it('removeEmptyRows renumbers rows to be contiguous', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    store.getState().setPanelRow(id2, 5);
    store.getState().removeEmptyRows();
    const panels = store.getState().panels;
    const rows = new Set(panels.map(p => p.layoutRow));
    expect(rows).toEqual(new Set([0, 1]));
  });

  it('resetPanelLayout moves all panels to row 0 and clears collapsedRows', () => {
    const id1 = store.getState().addPanel('ds1');
    const id2 = store.getState().addPanel('ds2');
    store.getState().setPanelRow(id2, 1);
    store.getState().toggleRowCollapsed(1);
    store.getState().resetPanelLayout();
    expect(store.getState().panels.every(p => p.layoutRow === 0)).toBe(true);
    expect(store.getState().collapsedRows.size).toBe(0);
  });
});

describe('independent window navigation',()=>{
  it('changes one chromosome without moving its sibling or global viewport',()=>{
    const first=store.getState().addPanel('ds1'),second=store.getState().addPanel('ds1');
    const original=store.getState().chrom;
    store.getState().setPanelIndependent(first,true);
    store.getState().navigatePanel(first,'paternal',100,200);
    expect(store.getState().panels.find(panel=>panel.id===first)?.viewportOverride).toEqual({chrom:'paternal',start:100,end:200});
    expect(store.getState().panels.find(panel=>panel.id===second)?.viewportOverride).toBeUndefined();
    expect(store.getState().chrom).toBe(original);
    store.getState().setPanelIndependent(first,false);
    expect(store.getState().panels.find(panel=>panel.id===first)?.viewportOverride).toBeUndefined();
  });
});

describe('copies at other sites', () => {
  const view = (id: string) => store.getState().panels.find(p => p.id === id)?.viewportOverride;

  it('opens a copy right after the source with its own view and state, and focuses its location box', () => {
    store.getState().setViewport('chr1', 1000, 2000);
    const a = store.getState().addPanel('ds1');
    const b = store.getState().addPanel('ds2');
    const copy = store.getState().openPanelAtSite(a);
    const panels = store.getState().panels;
    expect(panels.map(p => p.id)).toEqual([a, copy, b]);
    expect(view(copy)).toEqual({ chrom: 'chr1', start: 1000, end: 2000 });
    expect(panels[1].stateKey).toBe(copy);
    expect(panels[0].stateKey).toBeUndefined();  // the source keeps its dataset-keyed state
    expect(panels[1].layoutColumn).toBeUndefined();
    expect(store.getState().pendingPanelLocationFocus).toBe(copy);
  });

  it('keeps a copy\'s clusters when the main view moves, and drops them when the copy jumps away', () => {
    store.getState().setViewport('chr1', 1000, 2000);
    const a = store.getState().addPanel('ds1');
    const copy = store.getState().openPanelAtSite(a);
    store.setState({ clusterAssignments: { [copy]: { r1: 0 }, ds1: { r2: 1 } } });
    store.getState().setViewport('chr2', 5000, 6000);  // main jumps: its own clusters go
    expect(store.getState().clusterAssignments).toEqual({ [copy]: { r1: 0 } });
    store.getState().navigatePanel(copy, 'chr1', 1100, 2100);  // a pan: kept
    expect(store.getState().clusterAssignments[copy]).toEqual({ r1: 0 });
    store.getState().navigatePanel(copy, 'chr5', 1, 1000);  // a jump: dropped
    expect(store.getState().clusterAssignments[copy]).toBeUndefined();
  });

  it('locked sites pan and zoom together with each other and the main view, each around its own centre', () => {
    store.getState().setViewport('chr1', 10_000, 20_000);
    const a = store.getState().addPanel('ds1');
    const hap2 = store.getState().openPanelAtSite(a);
    const other = store.getState().openPanelAtSite(a);
    store.getState().navigatePanel(hap2, 'chr1_hap2', 50_000, 60_000);
    store.getState().navigatePanel(other, 'chr7', 0, 4_000);
    store.getState().setPanelSiteLocked(hap2, true);

    // Pan the locked copy by +1 kb: the main view follows; the unlocked one doesn't.
    store.getState().setPanelViewport(hap2, 51_000, 61_000);
    expect(store.getState().start).toBe(11_000);
    expect(store.getState().end).toBe(21_000);
    expect(view(other)).toEqual({ chrom: 'chr7', start: 0, end: 4_000 });

    // Zoom the main view in 2x: the locked copy zooms around its own centre.
    store.getState().setViewport('chr1', 13_500, 18_500);
    expect(view(hap2)).toEqual({ chrom: 'chr1_hap2', start: 53_500, end: 58_500 });

    // A main-view jump to another gene doesn't drag locked sites along.
    store.getState().setViewport('chr1', 900_000, 905_000);
    expect(view(hap2)).toEqual({ chrom: 'chr1_hap2', start: 53_500, end: 58_500 });
  });

  it('following the main view again clears the lock', () => {
    const a = store.getState().addPanel('ds1');
    const copy = store.getState().openPanelAtSite(a);
    store.getState().setPanelSiteLocked(copy, true);
    store.getState().setPanelIndependent(copy, false);
    const panel = store.getState().panels.find(p => p.id === copy)!;
    expect(panel.viewportOverride).toBeUndefined();
    expect(panel.siteLocked).toBeUndefined();
  });
});

describe('copies at other sites: review fixes', () => {
  const panel = (id: string) => store.getState().panels.find(p => p.id === id)!;

  it('rejoining the main view from another site drops that site\'s filters and clusters', () => {
    store.getState().setViewport('chr1', 1000, 2000);
    const a = store.getState().addPanel('ds1');
    const copy = store.getState().openPanelAtSite(a);
    store.getState().navigatePanel(copy, 'chr2', 5000, 6000);
    store.setState({ filteredReadIds: { [copy]: new Set(['r1']) } });
    store.getState().setPanelIndependent(copy, false);
    expect(store.getState().filteredReadIds[copy]).toBeUndefined();
  });

  it('navigating a haplotype panel keeps it in its comparison, and windows are at least 3 bp', () => {
    store.getState().addPanel('ds1');
    store.getState().openHaplotypeComparison({ chrom1: 'chr1_hap1', chrom2: 'chr1_hap2', start: 100, end: 200 });
    const hap = store.getState().panels.find(p => p.haplotypeGroup)!;
    store.getState().navigatePanel(hap.id, 'chr1_hap1', 500, 500);
    expect(panel(hap.id).haplotypeGroup).toBe(hap.haplotypeGroup);
    expect(panel(hap.id).viewportOverride).toEqual({ chrom: 'chr1_hap1', start: 500, end: 503 });
    store.getState().closeHaplotypeComparison();
    expect(store.getState().panels.some(p => p.id === hap.id)).toBe(false);
  });

  it('a restore that moves the main view leaves locked panels where they were saved', async () => {
    const { withSiteLockSuppressed, migrateSitePanels } = await import('../siteLock');
    store.getState().setViewport('chr1', 10_000, 20_000);
    const a = store.getState().addPanel('ds1');
    const copy = store.getState().openPanelAtSite(a);
    store.getState().navigatePanel(copy, 'chr1_hap2', 50_000, 60_000);
    store.getState().setPanelSiteLocked(copy, true);
    withSiteLockSuppressed(() => store.getState().setViewport('chr1', 12_000, 22_000));
    expect(panel(copy).viewportOverride).toEqual({ chrom: 'chr1_hap2', start: 50_000, end: 60_000 });
    expect(migrateSitePanels([{ haplotypeGroup: 'g' }, { haplotypeGroup: 'g', siteLocked: false }, {}]))
      .toEqual([{ haplotypeGroup: 'g', siteLocked: true }, { haplotypeGroup: 'g', siteLocked: false }, {}]);
  });

  it('copying and locking are undo points', () => {
    const a = store.getState().addPanel('ds1');
    const copy = store.getState().openPanelAtSite(a);
    store.getState().setPanelSiteLocked(copy, true);
    const labels = store.getState()._historyStack.map(s => s.label);
    expect(labels).toContain('Copy panel to another locus');
    expect(labels[labels.length - 1]).toBe('Link panel');
  });

  it('a linked copy (the header +) follows the main view, jumps included; one at another locus stays put', () => {
    store.getState().setViewport('chr1', 10_000, 20_000);
    const a = store.getState().addPanel('ds1');
    const copy = store.getState().openPanelAtSite(a, { linked: true });
    const elsewhere = store.getState().openPanelAtSite(a);
    store.getState().navigatePanel(elsewhere, 'chr1_hap2', 50_000, 60_000);
    store.getState().setPanelSiteLocked(elsewhere, true);
    expect(panel(copy).siteLocked).toBe(true);
    expect(store.getState().pendingPanelLocationFocus).toBe(elsewhere);
    store.getState().setViewport('chr1', 12_000, 22_000);
    expect(panel(copy).viewportOverride).toEqual({ chrom: 'chr1', start: 12_000, end: 22_000 });
    store.getState().setViewport('chr3', 500, 1_500);
    expect(panel(copy).viewportOverride).toEqual({ chrom: 'chr3', start: 500, end: 1_500 });
    expect(panel(elsewhere).viewportOverride).toEqual({ chrom: 'chr1_hap2', start: 52_000, end: 62_000 });
  });

  it('a linked copy following a jump leaves its filters behind; one at another locus keeps them', () => {
    store.getState().setViewport('chr1', 10_000, 20_000);
    const a = store.getState().addPanel('ds1');
    const copy = store.getState().openPanelAtSite(a, { linked: true });
    const elsewhere = store.getState().openPanelAtSite(a);
    store.getState().navigatePanel(elsewhere, 'chr1_hap2', 50_000, 60_000);
    store.setState({ filteredReadIds: { [copy]: new Set(['r1']), [elsewhere]: new Set(['r2']) } });
    store.getState().setViewport('chr3', 500, 1_500);
    expect(store.getState().filteredReadIds[copy]).toBeUndefined();
    expect(store.getState().filteredReadIds[elsewhere]).toEqual(new Set(['r2']));
  });
});

describe('DAF-seq strand panels', () => {
  it('splits a panel into CT and GA side by side, each with its own state, and back to both', () => {
    store.getState().setViewport('chr1', 1000, 2000);
    const a = store.getState().addPanel('ds1');
    store.setState({ clusterAssignments: { ds1: { r1: 0 } } });
    const ga = store.getState().splitPanelByStrand(a);
    const panels = store.getState().panels;
    expect(panels.map(p => [p.id, p.strand])).toEqual([[a, 'CT'], [ga, 'GA']]);
    expect(panels[1].stateKey).toBe(ga);
    expect(panels[1].viewportOverride).toBeUndefined();  // both follow the main view
    expect(store.getState().clusterAssignments.ds1).toBeUndefined();  // CT reads now: old clusters dropped
    store.getState().setPanelStrand(a, null);
    expect(store.getState().panels[0].strand).toBeUndefined();
    const labels = store.getState()._historyStack.map(s => s.label);
    expect(labels).toContain('Split panel by strand');
  });

  it('a panel sharing its state with another takes its own key instead of clearing the other', () => {
    const a = store.getState().addPanel('ds1');
    const b = store.getState().addPanel('ds1');
    store.setState({ clusterAssignments: { ds1: { r1: 0 } }, dynamicClustering: true });
    store.getState().setPanelStrand(a, 'CT');
    const pa = store.getState().panels.find(p => p.id === a)!;
    expect(pa.stateKey).toBe(a);
    expect(store.getState().panels.find(p => p.id === b)!.stateKey).toBeUndefined();
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0 });  // the other panel's clusters stay
    expect(store.getState().dynamicClustering).toBe(false);
  });
});

describe('merge similar clusters settings', () => {
  it('are shared, kept in range, and default to 5% / 0.95', () => {
    expect([store.getState().mergeMinFraction, store.getState().mergeMaxSimilarity]).toEqual([0.05, 0.95]);
    store.getState().setMergeSettings({ maxSimilarity: 0.97 });
    expect([store.getState().mergeMinFraction, store.getState().mergeMaxSimilarity]).toEqual([0.05, 0.97]);
    store.getState().setMergeSettings({ minFraction: 2, maxSimilarity: 0.1 });
    expect([store.getState().mergeMinFraction, store.getState().mergeMaxSimilarity]).toEqual([0.5, 0.5]);
    store.getState().setMergeSettings({ minFraction: Number.NaN });
    expect(store.getState().mergeMinFraction).toBe(0.5);
  });
});

describe('panel pans and zooms are undo steps (fb-r2-integ 3)', () => {
  const view = (id: string) => store.getState().panels.find(p => p.id === id)!.viewportOverride;

  it('a pan of a panel navigating on its own can be undone and redone', () => {
    store.getState().setViewport('chr1', 1_000, 2_000);
    const a = store.getState().addPanel('ds1');
    store.getState().setNavigationMode('perPanel');
    expect(view(a)).toEqual({ chrom: 'chr1', start: 1_000, end: 2_000 });
    const before = store.getState()._historyPointer;

    store.getState().setPanelViewport(a, 1_500, 2_500);
    expect(store.getState()._historyPointer).toBeGreaterThan(before);
    expect(store.getState()._historyStack[store.getState()._historyPointer].kind).toBe('navigation');

    store.getState().undo();
    expect(view(a)).toEqual({ chrom: 'chr1', start: 1_000, end: 2_000 });
    // Undo stepped back over the pan only, not the switch to per-panel navigation.
    expect(store.getState().panels.find(p => p.id === a)!.navOwn).toBe(true);
    store.getState().redo();
    expect(view(a)).toEqual({ chrom: 'chr1', start: 1_500, end: 2_500 });
  });

  it('quick successive pans of one panel are one step; a later one is another', () => {
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    try {
      store.getState().setViewport('chr1', 1_000, 2_000);
      const a = store.getState().addPanel('ds1');
      store.getState().setNavigationMode('perPanel');
      const before = store.getState()._historyStack.length;
      store.getState().setPanelViewport(a, 1_100, 2_100);
      t += 200;
      store.getState().setPanelViewport(a, 1_200, 2_200);
      t += 200;
      store.getState().setPanelViewport(a, 1_300, 2_300);
      const afterBurst = store.getState()._historyStack.length;
      expect(afterBurst - before).toBeLessThanOrEqual(2); // a baseline at most, and one pan step
      t += 5_000;
      store.getState().setPanelViewport(a, 5_000, 6_000);
      expect(store.getState()._historyStack.length).toBe(afterBurst + 1);
      store.getState().undo();
      expect(view(a)).toEqual({ chrom: 'chr1', start: 1_300, end: 2_300 });
      store.getState().undo();
      expect(view(a)).toEqual({ chrom: 'chr1', start: 1_000, end: 2_000 });
    } finally {
      now.mockRestore();
    }
  });

  it('a pan right after Undo is recorded (Redo is dropped) and does not replace the step undone to (review)', () => {
    const now = vi.spyOn(Date, 'now');
    let t = 2_000_000;
    now.mockImplementation(() => t);
    try {
      store.getState().setViewport('chr1', 1_000, 2_000);
      const a = store.getState().addPanel('ds1');
      store.getState().setNavigationMode('perPanel');
      store.getState().setPanelViewport(a, 1_100, 2_100);
      t += 2_000;
      store.getState().setPanelViewport(a, 1_200, 2_200);
      t += 100;
      store.getState().undo();
      expect(view(a)).toEqual({ chrom: 'chr1', start: 1_100, end: 2_100 });
      t += 100;
      store.getState().setPanelViewport(a, 9_000, 10_000);
      expect(store.getState().canRedo()).toBe(false);
      store.getState().undo();
      expect(view(a)).toEqual({ chrom: 'chr1', start: 1_100, end: 2_100 });
    } finally {
      now.mockRestore();
    }
  });
});
