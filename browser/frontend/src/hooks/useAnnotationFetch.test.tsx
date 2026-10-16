import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';

const pending = vi.hoisted(() => ({ resolve: null as null | ((value: unknown) => void) }));

vi.mock('../api/annotations', () => ({
  // A response that arrives even after the request was aborted.
  getAnnotationsForRegion: vi.fn(() => new Promise(resolve => { pending.resolve = resolve; })),
}));

import { otherPanelViewportsKey, useAnnotationFetch } from './useAnnotationFetch';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const file = { id: 'f1', path: '/a.bb', label: 'a', active: true, datasetIds: [], annotationTypes: [] };

describe('useAnnotationFetch', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('keeps overlays cleared when the file is deactivated while its request is pending', async () => {
    vi.useFakeTimers();
    useBrowserStore.setState({
      chrom: 'chr1', start: 0, end: 1_000,
      datasets: [{ id: 'ds1' }],
      annotationFiles: [file],
      enabledAnnotationTypes: { tss: true },
      annotationOverlays: {},
    } as any);
    function Host() { useAnnotationFetch(); return null; }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host />));
    act(() => { vi.advanceTimersByTime(500); });
    expect(pending.resolve).not.toBeNull();

    act(() => { useBrowserStore.setState({ annotationFiles: [{ ...file, active: false }], annotationOverlays: {} } as any); });
    await act(async () => {
      pending.resolve!({ annotations: { r1: [{ start: 1, end: 2, type: 'tss', confidence: 1 }] }, types: [] });
      await Promise.resolve();
    });

    expect(useBrowserStore.getState().annotationOverlays).toEqual({});
    act(() => root.unmount());
  });
});

describe('otherPanelViewportsKey', () => {
  it('lists dataset panels at their own locus, not the main view', () => {
    const panel = (id: string, viewportOverride?: { chrom: string; start: number; end: number }) =>
      ({ id, contentType: 'dataset', datasetId: 'ds1', ...(viewportOverride ? { viewportOverride } : {}) }) as any;
    const key = otherPanelViewportsKey([
      panel('main'),
      panel('same', { chrom: 'chr1', start: 1000, end: 2000 }),
      panel('copy', { chrom: 'chr1', start: 1100, end: 2100 }),
      panel('copy2', { chrom: 'chr1', start: 1100, end: 2100 }),
    ], 'chr1', 1000, 2000);
    expect(JSON.parse(key)).toEqual([JSON.stringify(['chr1', 1100, 2100])]);
  });
});
