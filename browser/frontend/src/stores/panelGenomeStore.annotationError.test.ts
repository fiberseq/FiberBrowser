/** A reference attached without genes (a declined or failed annotation download) says so (Codex R23). */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/panelGenomes', () => ({
  attachPanelGenome: vi.fn(async () => ({ success: true, genome: { key: 'pg', label: 'pg' }, needs_confirmation: true,
    annotation_error: 'connection reset' })),
  detachPanelGenome: vi.fn(),
  getPanelGenomes: vi.fn(async () => ({ main: { genome_id: null, fasta_path: null }, genomes: [], datasets: {} })),
}));

import { attachPanelGenome } from '../api/panelGenomes';
import { usePanelGenomeStore } from './panelGenomeStore';
import { useReferenceNoticeStore } from './referenceNoticeStore';

describe('panel genome attach', () => {
  it('names a reference attached without genes and why', async () => {
    useReferenceNoticeStore.getState().setNotice(null);
    await usePanelGenomeStore.getState().attach({ dataset_ids: ['ds'], genome_id: 'pg' });
    expect(useReferenceNoticeStore.getState().notice).toBe('pg is attached without genes: connection reset');
  });
  it('clears that notice once a later attach loads the annotation, and leaves other notices alone', async () => {
    useReferenceNoticeStore.getState().setNotice(null);
    await usePanelGenomeStore.getState().attach({ dataset_ids: ['ds'], genome_id: 'pg' });
    vi.mocked(attachPanelGenome).mockResolvedValueOnce({ success: true, genome: { key: 'pg', label: 'pg', has_gtf: true } } as never);
    await usePanelGenomeStore.getState().attach({ dataset_ids: ['ds'], genome_id: 'pg', confirm_large: true });
    expect(useReferenceNoticeStore.getState().notice).toBeNull();
    await usePanelGenomeStore.getState().attach({ dataset_ids: ['ds'], genome_id: 'pg' });
    useReferenceNoticeStore.getState().setNotice('another notice');
    vi.mocked(attachPanelGenome).mockResolvedValueOnce({ success: true, genome: { key: 'pg', label: 'pg', has_gtf: true } } as never);
    await usePanelGenomeStore.getState().attach({ dataset_ids: ['ds'], genome_id: 'pg', confirm_large: true });
    expect(useReferenceNoticeStore.getState().notice).toBe('another notice');
  });
});
