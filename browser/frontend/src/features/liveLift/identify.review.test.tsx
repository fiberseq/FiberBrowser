import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import { DifferencePopover } from './DifferencePopover';
import { getDifferenceReads } from './api';
import { useDifferenceSelection } from './inspectionStore';
import { useBrowserStore } from '../../stores/browserStore';
import { identifyLens } from '../insertion/IdentifyTab';

vi.mock('./api', async original => ({ ...await original<any>(), getDifferenceReads: vi.fn() }));
vi.mock('../insertion/IdentifyTab', () => ({ IdentifyTab: () => <div>Identification result</div>, identifyLens: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('fetches one full noisy carrier on Identify while inspection keeps 60 bp previews', async () => {
  const d: any = { id: 'MAT:src:100-200:insertion', hap: 'h1', hap_label: 'MAT', kind: 'insertion', source: 'assembly', reason: 'source_insertion', t_start: 500, t_end: 500, ref_bp: 0, alt_bp: 100, strand: '+', src: { contig: 'src', start: 100, end: 200 }, grch38: '', alt: null };
  const dataset: any = { id: 'lift', label: 'Lift', path: 'source.bam', data_type: 'bam_livelift', live_lift: { key: 'key' } };
  const panel: any = { id: 'mat', datasetId: 'lift', liftHap: 'MAT', subTracks: [], linkGroup: null, contentType: 'dataset', collapsed: false };
  useBrowserStore.setState({ datasets: [dataset], panels: [panel] });
  useDifferenceSelection.getState().select({ panelId: panel.id, datasetId: dataset.id, viewKey: 'main', chrom: 'chr1', difference: d });
  const response: any = { dataset_id: 'lift', lift_key: 'key', chrom: 'chr1', pos: 500, end: 500,
    rows: [{ id: 'carrier', record: 'rec', molecule: 'carrier', hap_label: 'MAT', strand: null, supplementary: false, source_pos: d.src, read_bases: 'A'.repeat(60), read_bases_length: 101, hg002: null, grch38: '', allele: 'hg002', ins_id: d.id, carries_insertion: true, mol_bp: 101, chromatin: { state: 'none', layer: null, nearest_m6a_bp: null, orientation: '+' } }], summary: { MAT: { hg002: 1 } }, capped: false, max_records: 500 };
  vi.mocked(getDifferenceReads).mockResolvedValueOnce(response).mockResolvedValueOnce({ ...response,
    sequence: { sequence: 'A'.repeat(101), read_id: 'carrier', record: 'rec', ins_id: d.id, orientation: '+', source: 'reads' } });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<DifferencePopover panel={panel} dataset={dataset} anchor={{ current: host }} />); });
    const identify = [...document.querySelectorAll('button')].find(b => b.textContent === 'Identify')!;
    expect(identify.disabled).toBe(false);
    expect(getDifferenceReads).toHaveBeenCalledTimes(1);
    await act(async () => { identify.click(); });
    expect(getDifferenceReads).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: d.id, includeSequence: true }), expect.any(AbortSignal));
    expect(identifyLens).toHaveBeenCalledWith(expect.objectContaining({ consensus: expect.objectContaining({ seq: 'A'.repeat(101), n_reads: 1 }) }), 'lift', expect.anything());
    expect(document.body.textContent).toContain('Identification result');
  } finally { act(() => root.unmount()); host.remove(); useDifferenceSelection.getState().select(null); }
});
