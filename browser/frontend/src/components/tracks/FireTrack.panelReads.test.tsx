/**
 * M16 (UI audit): one dataset's scanned peaks were drawn on every panel,
 * including panels of other datasets with no reads at that locus.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { DEFAULT_PEAK_RULES } from '../../types/peak';
import { FireTrack } from './FireTrack';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('scanned peaks are drawn only on panels with reads', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr2R', start: 9974319, end: 9984319, maxRegionForReads: 1_000_000,
      peakRules: DEFAULT_PEAK_RULES,
      peaksByRule: {
        'default-accessibility': [{ start: 9979115, end: 9979391, index: 0, layer: 0 }],
        'default-custom': [{ start: 9980000, end: 9980200, index: 1, isCustom: true }],
      },
      activeReadIds: { daf: ['r1', 'r2'], flyamp: [] },
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const count = () => Number(container.querySelector('[data-copilot-track="peaks"]')!.getAttribute('data-peak-count'));

  it('the panel whose reads were scanned shows the peaks', () => {
    act(() => root.render(<FireTrack width={800} height={40} readsKey="daf" />));
    expect(count()).toBe(2);
  });

  it('zoomed out past read level (no reads fetched anywhere) the peaks still show', () => {
    useBrowserStore.setState({ start: 9_000_000, end: 11_000_000, maxRegionForReads: 1_000_000 } as never);
    act(() => root.render(<FireTrack width={800} height={40} readsKey="flyamp" />));
    expect(count()).toBe(2);
  });

  it('a panel without reads here keeps only peaks the user drew', () => {
    act(() => root.render(<FireTrack width={800} height={40} readsKey="flyamp" />));
    expect(count()).toBe(1);
  });
});
