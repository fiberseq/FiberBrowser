import { describe, expect, it } from 'vitest';
import { applyImportedState, collectFrontendState } from './session';
import { useBrowserStore } from '../stores/browserStore';

const session = { datasets: [], overlays: [], has_fasta: false, viewport: { chrom: 'chr1', start: 0, end: 500 } };

describe('QC-fail read visibility in sessions', () => {
  it('saves and restores opt-in visibility', () => {
    useBrowserStore.getState().setShowQcFailReads(true);
    const saved = collectFrontendState();
    expect(saved.showQcFailReads).toBe(true);
    useBrowserStore.getState().setShowQcFailReads(false);
    applyImportedState({ ...session, frontend: saved });
    expect(useBrowserStore.getState().showQcFailReads).toBe(true);
  });

  it('loads old sessions with QC-fail visibility off', () => {
    useBrowserStore.getState().setShowQcFailReads(true);
    applyImportedState({ ...session, frontend: {} });
    expect(useBrowserStore.getState().showQcFailReads).toBe(false);
    useBrowserStore.getState().setShowQcFailReads(true);
    applyImportedState(session);
    expect(useBrowserStore.getState().showQcFailReads).toBe(false);
  });
});
