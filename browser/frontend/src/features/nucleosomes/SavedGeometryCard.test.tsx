/** Saved geometries: an unmatched entry can still be renamed (double-click), and a zero grouping tolerance is kept. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { SavedGeometries, geometryTolerance } from './SavedGeometryCard';
import type { SavedGeometry } from './savedGeometries';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const entry: SavedGeometry = { id: 's1', label: 'G1', name: 'G1', kind: 'high', chrom: 'chrX', start: 1000, end: 5000,
  openLeft: false, openRight: false, color: '#e11d48', shares: {}, tolBp: 0, savedAt: 0 };

describe('saved geometries', () => {
  let box: HTMLDivElement; let root: Root;
  beforeEach(() => {
    box = document.createElement('div'); document.body.appendChild(box); root = createRoot(box);
    useBrowserStore.setState({ savedNucGeometries: [entry], selectedFeatures: [], chrom: 'chr2L' } as never);
  });
  afterEach(() => { act(() => root.unmount()); box.remove(); useBrowserStore.setState({ savedNucGeometries: [] } as never); });

  it('an entry not in this analysis is renamed by double-click', async () => {
    await act(async () => root.render(<SavedGeometries res={null} run={null} pos={String} />));
    const btn = box.querySelector('[data-testid="nuc-geo-saved-name"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const input = box.querySelector('[data-testid="nuc-geo-saved-name-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
  });

  it('a tolerance of 0 is a value, not missing', () => {
    expect(geometryTolerance({ params: { geometry: { tol_bp: 0 } } } as never)).toBe(0);
    expect(geometryTolerance({ params: { geometry: {} } } as never)).toBe(500);
    expect(geometryTolerance({ params: { geometry: { tol_bp: 'x' } } } as never)).toBe(500);
    expect(geometryTolerance(null)).toBe(500);
    expect(geometryTolerance({ params: { geometry: { tol_bp: 250 } } } as never)).toBe(250);
  });
});
