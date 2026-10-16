import '../testSetup';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useAccessibilityStore } from './accessibilityStore';
import { useFeatureStore } from '../../stores/featureStore';
import type { AccessibilityResult } from './api';
import { useNfrFeatureBridge } from './useNfrFeatureBridge';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function Host() { useNfrFeatureBridge(); return null; }
function render(el: React.ReactElement) {
  const root = createRoot(document.createElement('div'));
  act(() => root.render(el));
  return { unmount: () => act(() => root.unmount()) };
}

const variant = { id: 'N1:V2', nfr: 'N1', name: 'V2', start: 100, end: 200, L: 100, R: 200 } as never;
const result = { region: { chrom: 'chr2L', start: 0, end: 1000 }, nfrs: [{ id: 'N1', start: 90, end: 210, variants: [variant] }] } as unknown as AccessibilityResult;

describe('useNfrFeatureBridge', () => {
  afterEach(() => {
    useFeatureStore.getState().setHover(null);
    useAccessibilityStore.setState({ jobId: null, result: null, hoveredElement: null });
  });

  it('hovers the panel element from the channel and back', () => {
    useAccessibilityStore.setState({ jobId: 'job1', result, hoveredElement: null });
    const { unmount } = render(<Host />);
    // channel -> panel
    useFeatureStore.getState().setHover({ kind: 'nfr-variant', source: 'job1', id: 'N1:V2' });
    expect(useAccessibilityStore.getState().hoveredElement).toBe('N1:V2');
    useFeatureStore.getState().setHover(null);
    expect(useAccessibilityStore.getState().hoveredElement).toBeNull();
    // panel -> channel
    useAccessibilityStore.getState().setHoveredElement('N1');
    expect(useFeatureStore.getState().hovered).toMatchObject({ kind: 'nfr', source: 'job1', id: 'N1' });
    useAccessibilityStore.getState().setHoveredElement('N1:V2');
    expect(useFeatureStore.getState().hovered).toMatchObject({ kind: 'nfr-variant', id: 'N1:V2' });
    useAccessibilityStore.getState().setHoveredElement(null);
    expect(useFeatureStore.getState().hovered).toBeNull();
    unmount();
  });

  it('drops the hover when the run changes (it never carries over to a new run by id)', () => {
    useAccessibilityStore.setState({ jobId: 'job1', result, hoveredElement: null });
    const { unmount } = render(<Host />);
    useFeatureStore.getState().setHover({ kind: 'nfr-variant', source: 'job1', id: 'N1:V2' });
    expect(useAccessibilityStore.getState().hoveredElement).toBe('N1:V2');
    useAccessibilityStore.getState().reset();
    expect(useFeatureStore.getState().hovered).toBeNull();
    expect(useAccessibilityStore.getState().hoveredElement).toBeNull();
    useAccessibilityStore.setState({ jobId: 'job2', result });
    expect(useFeatureStore.getState().hovered).toBeNull();
    unmount();
  });

  it('leaves another run\'s and a class hover alone', () => {
    useAccessibilityStore.setState({ jobId: 'job1', result, hoveredElement: null });
    const { unmount } = render(<Host />);
    useFeatureStore.getState().setHover({ kind: 'nfr-variant', source: 'other', id: 'N1:V2' });
    expect(useAccessibilityStore.getState().hoveredElement).toBeNull();
    useFeatureStore.getState().setHover({ kind: 'fp-class', source: 'job1', id: 'c3', datasetId: 'd' });
    expect(useAccessibilityStore.getState().hoveredElement).toBeNull();
    useAccessibilityStore.getState().setFilter({ focus: 'N1' });
    expect(useFeatureStore.getState().hovered).toMatchObject({ kind: 'fp-class' });
    unmount();
  });
});
