import { beforeEach, describe, expect, it, vi } from 'vitest';

const cluster = vi.hoisted(() => ({ ensureClusterRefsConnected: vi.fn() }));
vi.mock('./connectCluster', () => cluster);
const datasets = vi.hoisted(() => ({ addDataset: vi.fn() }));
vi.mock('../api/datasets', () => datasets);
vi.mock('../api/status', () => ({ getStatus: vi.fn().mockResolvedValue({}) }));

import { openLibraryEntries } from './libraryOpen';
import type { LibraryEntry } from '../api/library';

const remoteBam = {
  id: 'e1', kind: 'bam', path: 'ssh://hpc/projects/lab/a.bam', folder: 'ssh://hpc/projects/lab',
  label: 'a.bam', available: true, remote: true, connected: false,
} as LibraryEntry;

describe('opening cluster entries from the Library', () => {
  beforeEach(() => {
    cluster.ensureClusterRefsConnected.mockReset();
    datasets.addDataset.mockReset().mockResolvedValue({ success: true, dataset: { id: 'a', path: remoteBam.path } });
  });

  it('asks to connect to the host first, then opens by reference', async () => {
    cluster.ensureClusterRefsConnected.mockResolvedValue(true);
    const res = await openLibraryEntries([remoteBam], [remoteBam], []);
    expect(cluster.ensureClusterRefsConnected).toHaveBeenCalledWith(['ssh://hpc/projects/lab/a.bam'], 'The Library');
    expect(datasets.addDataset).toHaveBeenCalledWith('ssh://hpc/projects/lab/a.bam', undefined);
    expect(res.success).toBe(true);
  });

  it('opens nothing when the user does not connect', async () => {
    cluster.ensureClusterRefsConnected.mockResolvedValue(false);
    const res = await openLibraryEntries([remoteBam], [remoteBam], []);
    expect(datasets.addDataset).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toContain('Connect to cluster');
  });
});
