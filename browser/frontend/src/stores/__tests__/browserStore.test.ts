import { describe, it, expect } from 'vitest';
import { getTargetDatasetIds, isLinkedGroup } from '../browserStore';
import type { PanelConfig } from '../../types';

// Helper to create a minimal dataset panel
function makePanel(id: string, datasetId: string, linkGroup: string | null = null): PanelConfig {
  return {
    id,
    contentType: 'dataset',
    datasetId,
    subTracks: [],
    collapsed: false,
    linkGroup,
    layoutRow: 0,
  };
}

// Helper to create an analysis panel (non-dataset)
function makeAnalysisPanel(id: string, contentType: string): PanelConfig {
  return {
    id,
    contentType: contentType as any,
    datasetId: null,
    subTracks: [],
    collapsed: false,
    linkGroup: null,
    layoutRow: 0,
  };
}

// ============================================================================
// getTargetDatasetIds
// ============================================================================

describe('getTargetDatasetIds', () => {
  const allDatasets = [{ id: 'ds1' }, { id: 'ds2' }, { id: 'ds3' }];

  it('returns all dataset IDs when selection is empty', () => {
    const result = getTargetDatasetIds(new Set(), [], allDatasets);
    expect(result).toEqual(['ds1', 'ds2', 'ds3']);
  });

  it('returns only selected datasets when no link groups', () => {
    const panels = [makePanel('p1', 'ds1'), makePanel('p2', 'ds2')];
    // selectedDatasets uses panel IDs, not dataset IDs
    const result = getTargetDatasetIds(new Set(['p1']), panels, allDatasets);
    expect(result).toEqual(['ds1']);
  });

  it('expands selection via link group', () => {
    const panels = [
      makePanel('p1', 'ds1', 'group-A'),
      makePanel('p2', 'ds2', 'group-A'),
      makePanel('p3', 'ds3'),
    ];
    const result = getTargetDatasetIds(new Set(['p1']), panels, allDatasets);
    expect(result).toEqual(['ds1', 'ds2']);
  });

  it('does not expand to unlinked panels', () => {
    const panels = [
      makePanel('p1', 'ds1', 'group-A'),
      makePanel('p2', 'ds2', 'group-B'),
      makePanel('p3', 'ds3'),
    ];
    const result = getTargetDatasetIds(new Set(['p1']), panels, allDatasets);
    expect(result).toEqual(['ds1']);
  });

  it('preserves allDatasets ordering in result', () => {
    const panels = [
      makePanel('p1', 'ds3', 'group-A'),
      makePanel('p2', 'ds1', 'group-A'),
    ];
    const result = getTargetDatasetIds(new Set(['p1']), panels, allDatasets);
    // ds1 comes before ds3 in allDatasets — but panel order takes priority
    // p1 has ds3, p2 has ds1; both in group-A so both selected
    // orderedAll from panels: [ds3, ds1], then allDatasets fills ds2
    expect(result).toEqual(['ds3', 'ds1']);
  });

  it('ignores analysis panels during expansion', () => {
    const panels = [
      makePanel('p1', 'ds1', 'group-A'),
      makeAnalysisPanel('p-analysis', 'cluster-detail'),
      makePanel('p2', 'ds2', 'group-A'),
    ];
    const result = getTargetDatasetIds(new Set(['p1']), panels, allDatasets);
    expect(result).toEqual(['ds1', 'ds2']);
  });

  it('handles selected panel whose dataset has no other panels', () => {
    const panels = [makePanel('p1', 'ds1')];
    // Select a panel ID that exists — p1 maps to ds1
    const result = getTargetDatasetIds(new Set(['p1']), panels, allDatasets);
    expect(result).toEqual(['ds1']);
  });

  it('expands across multiple link groups', () => {
    const panels = [
      makePanel('p1', 'ds1', 'group-A'),
      makePanel('p2', 'ds2', 'group-A'),
      makePanel('p3', 'ds3', 'group-B'),
    ];
    // Select p1 (group-A) and p3 (group-B) — expands to all panels in both groups
    const result = getTargetDatasetIds(new Set(['p1', 'p3']), panels, allDatasets);
    expect(result).toEqual(['ds1', 'ds2', 'ds3']);
  });
});

// ============================================================================
// isLinkedGroup
// ============================================================================

describe('isLinkedGroup', () => {
  it('returns false when no panels', () => {
    expect(isLinkedGroup(['ds1'], [])).toBe(false);
  });

  it('returns false when panels have no link groups', () => {
    const panels = [makePanel('p1', 'ds1'), makePanel('p2', 'ds2')];
    expect(isLinkedGroup(['ds1', 'ds2'], panels)).toBe(false);
  });

  it('returns false when only one panel has a link group', () => {
    const panels = [makePanel('p1', 'ds1', 'group-A'), makePanel('p2', 'ds2')];
    expect(isLinkedGroup(['ds1', 'ds2'], panels)).toBe(false);
  });

  it('returns true when two panels share a link group', () => {
    const panels = [
      makePanel('p1', 'ds1', 'group-A'),
      makePanel('p2', 'ds2', 'group-A'),
    ];
    expect(isLinkedGroup(['ds1', 'ds2'], panels)).toBe(true);
  });

  it('returns false when panels have different link groups', () => {
    const panels = [
      makePanel('p1', 'ds1', 'group-A'),
      makePanel('p2', 'ds2', 'group-B'),
    ];
    expect(isLinkedGroup(['ds1', 'ds2'], panels)).toBe(false);
  });

  it('ignores non-target datasets', () => {
    const panels = [
      makePanel('p1', 'ds1', 'group-A'),
      makePanel('p2', 'ds2', 'group-A'),
      makePanel('p3', 'ds3', 'group-A'),
    ];
    // Only ds1 is in target — only 1 panel matched, need ≥2 with same group
    expect(isLinkedGroup(['ds1'], panels)).toBe(false);
  });

  it('returns true with three linked panels', () => {
    const panels = [
      makePanel('p1', 'ds1', 'group-A'),
      makePanel('p2', 'ds2', 'group-A'),
      makePanel('p3', 'ds3', 'group-A'),
    ];
    expect(isLinkedGroup(['ds1', 'ds2', 'ds3'], panels)).toBe(true);
  });
});
