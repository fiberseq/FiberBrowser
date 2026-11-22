/** A plot made from one panel ("Footprint size enrichment here") plots that panel even when another is selected
 *  (release audit 3.1.1). */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { usePlotTargets, type PlotTargets } from './usePlotTargets';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function resolve(invokedFrom: string | null): PlotTargets {
  let out: PlotTargets | null = null;
  const Probe = () => { out = usePlotTargets(invokedFrom); return null; };
  const box = document.createElement('div');
  const root = createRoot(box);
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return out!;
}

describe('usePlotTargets(invokedFrom)', () => {
  const setup = (clustered: Record<string, Record<string, number>>) => useBrowserStore.setState({
    datasets: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    panels: [
      { id: 'pA', contentType: 'dataset', datasetId: 'A', stateKey: 'A' },
      { id: 'pB', contentType: 'dataset', datasetId: 'B', stateKey: 'B', viewportOverride: { chrom: 'chrT', start: 5000, end: 6000 } },
    ],
    selectedDatasets: new Set(['pA']), navigationMode: 'perPanel', chrom: 'chrT', start: 100, end: 900, clusterAssignments: clustered,
  } as never);

  it('the asking panel\'s datasets at its own view, not the selected panel\'s', () => {
    setup({ A: { r1: 0 } });
    const t = resolve('pB');
    expect(t.allReads.panels.map(p => p.datasetId)).toEqual(['B']);
    expect([t.allReads.chrom, t.allReads.start, t.allReads.end]).toEqual(['chrT', 5000, 6000]);
  });
  it('without a panel: the selection, as before', () => {
    setup({});
    const t = resolve(null);
    expect(t.allReads.panels.map(p => p.datasetId)).toEqual(['A']);
  });
});
