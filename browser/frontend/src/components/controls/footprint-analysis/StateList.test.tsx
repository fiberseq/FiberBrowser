import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { StateList, stateFilterKey } from './StateList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const catalog = {
  datasets: {
    ds: {
      catalog: [
        { family: 'F2', consensus_start: 200, consensus_end: 230.6, classification_counts: { CT: { primary_calls: 7 } } },
        { family: 'F1', consensus_start: 100, consensus_end: 110, classification_counts: { CT: { primary_calls: 3 }, GA: { primary_calls: 2 } } },
      ],
    },
  },
} as any;

describe('StateList', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useConsensusViewStore.setState({ jobId: 'job', catalog, selections: [] } as any);
    useBrowserStore.setState({ footprintGroups: [] } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (props: Partial<React.ComponentProps<typeof StateList>> = {}) => act(() => root.render(
    <StateList jobId="job" datasetLabels={{ ds: 'Sample' }} activeFilterKey={null} onFilter={vi.fn()} {...props} />,
  ));

  it('lists states in genomic order with rounded widths and call counts', () => {
    render();
    const rows = [...container.querySelectorAll('[data-testid="state-row"]')].map(row => row.textContent);
    expect(rows[0]).toContain('Class 1 · 10 bp · 5 calls');
    expect(rows[1]).toContain('Class 2 · 31 bp · 7 calls');
  });

  it('Save saves a state and unticking removes it', () => {
    render();
    const box = container.querySelector('input[aria-label="Save Class 1"]') as HTMLInputElement;
    act(() => box.click());
    const saved = useBrowserStore.getState().footprintGroups;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ consensusJobId: 'job', sourceDatasetId: 'ds', consensusStateId: 'F1', enabled: true });
    act(() => (container.querySelector('input[aria-label="Save Class 1"]') as HTMLInputElement).click());
    expect(useBrowserStore.getState().footprintGroups).toHaveLength(0);
  });

  it('saves a class on the run\'s chromosome after the view has moved on', () => {
    useConsensusViewStore.setState({ catalog: { ...catalog, region: { chrom: 'chr1', start: 0, end: 1000 } } } as any);
    useBrowserStore.setState({ chrom: 'chr2' } as any);
    render();
    act(() => (container.querySelector('input[aria-label="Save Class 1"]') as HTMLInputElement).click());
    expect(useBrowserStore.getState().footprintGroups[0]).toMatchObject({ referenceChrom: 'chr1' });
  });

  it('Save all saves every state once', () => {
    render();
    const compareAll = [...container.querySelectorAll('button')].find(b => b.textContent === 'Save all')!;
    act(() => compareAll.click());
    act(() => compareAll.click());
    expect(useBrowserStore.getState().footprintGroups.map(g => g.consensusStateId).sort()).toEqual(['F1', 'F2']);
  });

  it('Filter reads reports the state and shows the active filter', () => {
    const onFilter = vi.fn();
    render({ onFilter, activeFilterKey: stateFilterKey('ds', 'F2') });
    const buttons = [...container.querySelectorAll('button[aria-pressed]')] as HTMLButtonElement[];
    expect(buttons.map(b => b.textContent)).toEqual(['Filter reads', 'Filtering']);
    act(() => buttons[0].click());
    expect(onFilter).toHaveBeenCalledWith('ds', 'F1', 'Class 1');
  });

  it('Save all skips ignored states', () => {
    useConsensusViewStore.setState({ curation: { ignored_families: { ds: ['F2'] } } } as any);
    render();
    expect(container.textContent).toContain('ignored');
    const compareAll = [...container.querySelectorAll('button')].find(b => b.textContent === 'Save all')!;
    act(() => compareAll.click());
    expect(useBrowserStore.getState().footprintGroups.map(g => g.consensusStateId)).toEqual(['F1']);
    useConsensusViewStore.setState({ curation: null } as any);
  });
});
