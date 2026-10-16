import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { BLAST_DB_KEY, syncPrimerConfigFromStorage } from './primerConfigSync';

const apiMocks = vi.hoisted(() => ({
  getPrimerConfig: vi.fn(),
  setPrimerConfig: vi.fn(),
}));

vi.mock('../api/primers', () => ({
  getPrimerConfig: apiMocks.getPrimerConfig,
  setPrimerConfig: apiMocks.setPrimerConfig,
}));

function resetPrimerState() {
  useBrowserStore.setState({
    primer: {
      targetStart: null,
      targetEnd: null,
      pair: null,
      configFasta: null,
      configBlastDb: null,
      designing: false,
      error: null,
      designResults: [],
      savedPrimers: [],
      mode: 'standard',
      dafcQuads: [],
      cartTrackDisplay: 'off',
    },
  } as any);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  resetPrimerState();
});

describe('primer config storage sync', () => {
  it('restores a saved BLAST DB when the server has no active DB', async () => {
    localStorage.setItem(BLAST_DB_KEY, '/db/dm6');
    apiMocks.setPrimerConfig.mockResolvedValue({
      success: true,
      fasta: '/ref/dm6.fa',
      blast_db: '/db/dm6',
      configured: true,
    });

    const result = await syncPrimerConfigFromStorage({
      fasta: '/ref/dm6.fa',
      blast_db: null,
      configured: true,
    });

    expect(apiMocks.setPrimerConfig).toHaveBeenCalledWith(undefined, '/db/dm6');
    expect(result.warning).toBeNull();
    expect(localStorage.getItem(BLAST_DB_KEY)).toBe('/db/dm6');
    expect(useBrowserStore.getState().primer.configBlastDb).toBe('/db/dm6');
  });

  it('persists backend auto-switched DBs back to localStorage', async () => {
    const result = await syncPrimerConfigFromStorage({
      fasta: '/ref/dm6.fa',
      blast_db: '/db/dm6',
      configured: true,
      current_genome: 'dm6',
      blast_db_warning: null,
    });

    expect(apiMocks.setPrimerConfig).not.toHaveBeenCalled();
    expect(result.config.blast_db).toBe('/db/dm6');
    expect(localStorage.getItem(BLAST_DB_KEY)).toBe('/db/dm6');
    expect(useBrowserStore.getState().primer.configBlastDb).toBe('/db/dm6');
  });

  it('clears stale saved DBs when restore fails', async () => {
    localStorage.setItem(BLAST_DB_KEY, '/db/hg38');
    apiMocks.setPrimerConfig.mockResolvedValue({
      success: false,
      message: 'BLAST database not found: /db/hg38',
    });

    const result = await syncPrimerConfigFromStorage({
      fasta: '/ref/dm6.fa',
      blast_db: null,
      configured: true,
    });

    expect(result.warning).toBe('BLAST database not found: /db/hg38');
    expect(localStorage.getItem(BLAST_DB_KEY)).toBeNull();
    expect(useBrowserStore.getState().primer.configBlastDb).toBeNull();
    expect(useBrowserStore.getState().primer.error).toBe('BLAST database not found: /db/hg38');
  });
});
