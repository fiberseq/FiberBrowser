import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SavedClassCard } from './SavedClassCard';
import * as workflow from '../../../api/consensusWorkflow';

const info = { id: 'S1', family: 'class_001', className: 'Class 1', runLabel: 'run 1', start: 100, end: 130,
  channels: [{ key: 'd::CT', datasetId: 'd', strand: 'CT', label: 'D CT', daf: true }], stats: {}, picked: ['d::CT'] };
const group = { id: 'g1', name: 'S1 · Class 1 · D CT', color: '#7c3aed', sizeMin: 0, sizeMax: null, enabled: true, sourceIndex: -1,
  consensusJobId: 'run1', consensusStateId: 'class_001', sourceDatasetId: 'd', consensusStrand: 'CT', consensusTier: 'core', savedClass: info } as any;

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const render = async () => {
  await act(async () => root.render(<SavedClassCard info={info} groups={[group]} filtering={false} onFilter={() => {}} targetDatasetIds={['d']} chartWidth={300} />));
  await act(async () => { await Promise.resolve(); });
};

describe('saved class whose run is gone (audit: saved classes outlive their runs)', () => {
  it('is marked "run unavailable" and cannot filter', async () => {
    vi.spyOn(workflow, 'getConsensusJob').mockRejectedValue(new Error('404'));
    await render();
    expect(container.querySelector('[data-testid="saved-class-stale"]')?.textContent).toBe('run unavailable');
    const filter = [...container.querySelectorAll('button')].find(b => b.textContent === 'Filter reads')!;
    expect(filter.disabled).toBe(true);
  });
  it('is not marked while its run is in the session', async () => {
    vi.spyOn(workflow, 'getConsensusJob').mockResolvedValue({ job_id: 'run1', status: 'complete' } as any);
    await render();
    expect(container.querySelector('[data-testid="saved-class-stale"]')).toBeNull();
  });
});
