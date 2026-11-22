/** Plots and Quantify leave live-lifted datasets out, and say so (never a silent drop; graph-aware quantification
 *  comes later). */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { liftedLeftOutNotice, LIFTED_LEFT_OUT_NOTE, usePlotTargets, type PlotTargets } from './usePlotTargets';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function resolve(): PlotTargets {
  let out: PlotTargets | null = null;
  const Probe = () => { out = usePlotTargets(null); return null; };
  const box = document.createElement('div');
  const root = createRoot(box);
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return out!;
}

describe('live-lifted datasets in Plots and Quantify', () => {
  it('are left out of the targets and named', () => {
    useBrowserStore.setState({
      datasets: [{ id: 'R', label: 'Reference reads' }, { id: 'L', label: 'HG002 lifted', data_type: 'bam_livelift' }],
      panels: [{ id: 'pR', contentType: 'dataset', datasetId: 'R', stateKey: 'R' },
               { id: 'pL', contentType: 'dataset', datasetId: 'L', stateKey: 'L' }],
      selectedDatasets: new Set<string>(), navigationMode: 'locked', chrom: 'chrT', start: 100, end: 900, clusterAssignments: {},
    } as never);
    const t = resolve();
    expect(t.allReads.panels.map(p => p.datasetId)).toEqual(['R']);
    expect(t.liftedLeftOut).toEqual(['HG002 lifted']);
    expect(liftedLeftOutNotice(t.liftedLeftOut)).toBe(`${LIFTED_LEFT_OUT_NOTE}: left out HG002 lifted.`);
  });
  it('use the words the headless numbers use (services/meta_locus_numbers.py)', () => {
    expect(LIFTED_LEFT_OUT_NOTE).toBe("Live-lifted datasets aren't plotted or quantified yet");
  });
  it('say nothing when none is in scope', () => {
    useBrowserStore.setState({
      datasets: [{ id: 'R', label: 'Reference reads' }],
      panels: [{ id: 'pR', contentType: 'dataset', datasetId: 'R', stateKey: 'R' }],
      selectedDatasets: new Set<string>(), navigationMode: 'locked', chrom: 'chrT', start: 100, end: 900, clusterAssignments: {},
    } as never);
    const t = resolve();
    expect(t.liftedLeftOut).toEqual([]);
    expect(liftedLeftOutNotice(t.liftedLeftOut)).toBe('');
  });
});
