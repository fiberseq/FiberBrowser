/** 3.1.0 audit: Undo of closing a native dataset and crash recovery bring back its molecule provenance
 *  (shared-molecule groups and the joint dedup policy), so joint analyses never count shared molecules twice. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ addDataset: vi.fn(), removeDataset: vi.fn(), getDatasets: vi.fn() }));
const lift = vi.hoisted(() => ({ updateMoleculeProvenance: vi.fn(), addLiveLiftDataset: vi.fn() }));
vi.mock('../api/datasets', async (orig) => ({ ...(await orig<typeof import('../api/datasets')>()), ...api }));
vi.mock('../features/liveLift/api', async (orig) => ({ ...(await orig<typeof import('../features/liveLift/api')>()), ...lift }));
vi.mock('../api/genomeCheck', () => ({ getGenomeCheck: vi.fn(async () => ({ datasets: [], reference: null })) }));

import { useBrowserStore } from '../stores/browserStore';
import { serializeDataset } from '../stores/historySlice';
import { reconcileClosedDatasets, restoreMoleculeProvenance } from './datasetUndo';

const GROUPS: [string, string][] = [['/data/a.bam', 'lib1']];
const NATIVE = { id: 'n', label: 'native', paths: ['/data/a.bam'], color: '#111', data_type: 'bam',
  molecule_groups: GROUPS, joint_dedup: 'by_molecule' };

describe('molecule provenance of a reopened native dataset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBrowserStore.setState({ datasets: [], panels: [], error: null } as never);
    api.addDataset.mockResolvedValue({ success: true, dataset: { id: 'n', label: 'native', paths: ['/data/a.bam'], data_type: 'bam' } });
    lift.updateMoleculeProvenance.mockImplementation(async (id: string, molecule_groups: unknown, joint_dedup: unknown) => (
      { success: true, dataset: { id, label: 'native', paths: ['/data/a.bam'], data_type: 'bam', molecule_groups, joint_dedup } }));
  });

  it('snapshots keep the joint dedup policy with the groups', () => {
    const s = serializeDataset(NATIVE);
    expect(s.molecule_groups).toEqual(GROUPS);
    expect(s.joint_dedup).toBe('by_molecule');
    expect(serializeDataset({ ...NATIVE, joint_dedup: 'off', molecule_groups: undefined }).joint_dedup).toBeUndefined();
  });

  it('Undo reopens it with its groups and policy declared on the server', async () => {
    await reconcileClosedDatasets({ reopen: [serializeDataset(NATIVE)], close: [] });
    expect(lift.updateMoleculeProvenance).toHaveBeenCalledWith('n', GROUPS, 'by_molecule');
    const ds = useBrowserStore.getState().datasets.find(d => d.id === 'n') as { molecule_groups?: unknown; joint_dedup?: string };
    expect(ds.molecule_groups).toEqual(GROUPS);
    expect(ds.joint_dedup).toBe('by_molecule');
    expect(useBrowserStore.getState().error).toBeNull();
  });

  it('a dataset without provenance, or a live-lift one, declares nothing', async () => {
    const plain = serializeDataset({ ...NATIVE, molecule_groups: undefined, joint_dedup: 'off' });
    expect(await restoreMoleculeProvenance(plain, { id: 'n' })).toEqual({ id: 'n' });
    const lifted = { ...serializeDataset(NATIVE), live_lift: { manifest: '/m.json', haplotypes: [], settings: {} } };
    expect(await restoreMoleculeProvenance(lifted as never, { id: 'n' })).toEqual({ id: 'n' });
    expect(lift.updateMoleculeProvenance).not.toHaveBeenCalled();
  });

  it('a saved empty/off provenance clears the groups and dedup an already-open dataset carries', async () => {
    const plain = serializeDataset({ ...NATIVE, molecule_groups: undefined, joint_dedup: 'off' });
    const open = { id: 'n', molecule_groups: GROUPS, joint_dedup: 'by_molecule' };
    const out = await restoreMoleculeProvenance(plain, open) as typeof open;
    expect(lift.updateMoleculeProvenance).toHaveBeenCalledWith('n', [], 'off');
    expect(out.molecule_groups).toEqual([]);
    expect(out.joint_dedup).toBe('off');
    // the same provenance already declared: nothing sent
    lift.updateMoleculeProvenance.mockClear();
    expect(await restoreMoleculeProvenance(serializeDataset(NATIVE), open)).toBe(open);
    expect(lift.updateMoleculeProvenance).not.toHaveBeenCalled();
  });
});
