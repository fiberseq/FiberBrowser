import { beforeEach, describe, expect, it } from 'vitest';
import { useDafcStore } from './dafcStore';
import { applyDafcSettings, serializeDafcSettings } from './dafcPersistence';

describe('DAF-C session persistence', () => {
  beforeEach(() => {
    useDafcStore.setState({
      dafcChrom: 'chr1', dafcStart: 0, dafcEnd: 1000,
      dafcXStart: 0, dafcXEnd: 1000, dafcYStart: 0, dafcYEnd: 1000,
      dafcResolution: 1000, dafcResolutions: [1000, 5000], microcResolution: null,
      matrixNormalization: 'balanced', linkedSplitMode: 'horizontal',
      linkedSessions: [], currentLinkedSessionId: null,
      xSegmentNames: new Set(), ySegmentNames: new Set(), linkedReads: [],
    });
  });

  it('round-trips viewport, normalization, and portable split-view settings', () => {
    useDafcStore.setState({
      dafcChrom: 'chr2L', dafcXStart: 100, dafcXEnd: 200,
      dafcYStart: 300, dafcYEnd: 400, matrixNormalization: 'oe_global',
      linkedSplitMode: 'vertical',
    });
    const saved = serializeDafcSettings();
    useDafcStore.setState({
      dafcChrom: 'changed', matrixNormalization: 'none',
      linkedSplitMode: 'horizontal',
    });
    applyDafcSettings(saved);
    const restored = useDafcStore.getState();
    expect(restored.dafcChrom).toBe('chr2L');
    expect(restored.dafcXStart).toBe(100);
    expect(restored.dafcYStart).toBe(300);
    expect(restored.matrixNormalization).toBe('oe_global');
    expect(restored.linkedSplitMode).toBe('vertical');
  });

  it('excludes live linked-session resources from portable JSON', () => {
    useDafcStore.setState({
      linkedSessions: [{ id: 'live' } as any],
      currentLinkedSessionId: 'live',
      xSegmentNames: new Set(['x1']),
      ySegmentNames: new Set(['y1']),
      linkedReads: [{ base_id: 'r1', x_segments: ['x1'], y_segments: ['y1'] }],
    });

    const saved = serializeDafcSettings() as Record<string, unknown>;
    expect(saved.linkedSessions).toBeUndefined();
    expect(saved.currentLinkedSessionId).toBeUndefined();
    expect(saved.linkedReads).toBeUndefined();
    expect(saved.xSegmentNames).toBeUndefined();
  });

  it('does not restore a resolution absent from the reloaded source', () => {
    applyDafcSettings(
      { dafcResolution: 25000, microcResolution: 25000, matrixNormalization: 'oe' },
      { availableResolutions: [1000, 5000] },
    );
    const restored = useDafcStore.getState();
    expect(restored.dafcResolution).toBe(1000);
    expect(restored.microcResolution).toBeNull();
    expect(restored.matrixNormalization).toBe('oe');
  });
});
