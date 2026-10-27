// Adapted from the post-merge review's agy probes (group D); each case failed before its fix.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DifferencePopover } from '../liveLift/DifferencePopover';
import { getDifferenceReads } from '../liveLift/api';
import { useDifferenceSelection } from '../liveLift/inspectionStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import { identifyLens } from '../insertion/IdentifyTab';
import { AssemblyComparisonPanel, mapOptionsFor, useMapChoice } from './AssemblyComparisonPanel';
import { compareWithAssembly, useComparisonStore } from './comparison';
import { useGraphStatusStore } from '../graphPanel/statusStore';
import { getGraphStatus } from '../graphPanel/api';
import { applyImportedState } from '../../api/session';
import { storeExtensions } from '../../stores/storeExtensions';
import './persistence';

vi.mock('../liveLift/api', async original => ({
  ...(await original<any>()),
  getDifferenceReads: vi.fn(),
}));
vi.mock('./comparison', async original => ({
  ...(await original<any>()),
  compareWithAssembly: vi.fn(),
}));
vi.mock('../graphPanel/api', async original => ({
  ...(await original<any>()),
  getGraphStatus: vi.fn(),
}));
vi.mock('../insertion/IdentifyTab', () => ({
  IdentifyTab: () => <div data-testid="identify-tab">Identification result</div>,
  identifyLens: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('post-merge review, agy group D: Reads-lane Identify, sample matching picks, graph status after a public session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMapChoice.setState({ byDataset: {} });
    useComparisonStore.setState({ byKey: {} });
    useDifferenceSelection.getState().select(null);
    useGraphStatusStore.setState({ status: null, loading: false, error: null, refused: false });
    useBrowserStore.setState({ publicMode: false, datasets: [], panels: [] } as any);
  });

  it('a Reads-lane insertion on a pooled panel can be identified (no haplotype preference)', async () => {
    const d: any = {
      id: 'geom:ins:1200:120',
      hap: '',
      hap_label: 'Reads',
      kind: 'insertion',
      source: 'reads',
      reason: 'composed_geometry',
      t_start: 1200,
      t_end: 1200,
      ref_bp: 0,
      alt_bp: 120,
      strand: null,
      chain: null,
      src: { contig: null, start: null, end: null },
      grch38: null,
      alt: null,
    };
    const dataset: any = {
      id: 'lift_ds',
      label: 'Lift',
      path: '/fake/source.bam',
      data_type: 'bam_livelift',
      live_lift: { key: 'k1', haplotypes: ['h1', 'h2'], haplotype_labels: { h1: 'MAT', h2: 'PAT' } },
    };
    // Pooled panel: liftHap is undefined
    const panel: any = { id: 'p_pooled', datasetId: 'lift_ds', subTracks: [], linkGroup: null, contentType: 'dataset', collapsed: false };
    useBrowserStore.setState({ datasets: [dataset], panels: [panel] } as any);
    useDifferenceSelection.getState().select({
      panelId: panel.id,
      datasetId: dataset.id,
      viewKey: 'main',
      chrom: 'chr1',
      action: 'identify',
      difference: d,
    });

    const serverResponse: any = {
      dataset_id: 'lift_ds',
      lift_key: 'k1',
      chrom: 'chr1',
      pos: 1200,
      end: 1200,
      preferred_hap: null, // exact value returned by difference_reads(..., lift_hap="Reads") after 91dc09eb4
      rows: [{
        id: 'carrier_mol',
        record: 'rec0',
        molecule: 'lift_ds|carrier_mol',
        hap_label: 'MAT',
        strand: '+',
        supplementary: false,
        source_pos: { contig: 'mat_ctg', start: 200, end: 200 },
        read_bases: 'A'.repeat(60),
        read_bases_length: 120,
        hg002: '',
        grch38: '',
        allele: 'other',
        ins_id: 'h1:0:1200-1200:inspection',
        carries_insertion: true,
        mol_bp: 120,
        chromatin: { state: 'none', layer: null, nearest_m6a_bp: null, orientation: '+' },
      }],
      summary: { MAT: { other: 1 } },
      capped: false,
      max_records: 500,
      sequence: {
        sequence: 'A'.repeat(120),
        read_id: 'carrier_mol',
        record: 'rec0',
        ins_id: 'h1:0:1200-1200:inspection',
        orientation: '+',
        source: 'reads',
      },
    };
    vi.mocked(getDifferenceReads).mockResolvedValue(serverResponse);
    vi.mocked(compareWithAssembly).mockResolvedValue({
      dataset_id: 'lift_ds', chrom: 'chr1', start: 0, end: 3000, search_complete: false,
      reasons: [], assembly: {}, reads: {}, lineage_events: [], ledger: {}, policy: {},
    } as any);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<DifferencePopover panel={panel} dataset={dataset} anchor={{ current: host }} />);
      });
      await act(async () => { await Promise.resolve(); });
      expect(getDifferenceReads).toHaveBeenCalledWith(
        expect.objectContaining({ liftHap: 'Reads', includeSequence: true }),
        expect.any(AbortSignal),
      );
      const identifyBtn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Identify')!;
      expect(identifyBtn.disabled).toBe(false);
      expect(document.body.textContent).not.toContain('Identify unavailable');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('a pick of another sample yields to the dataset of the same sample once open; picks stay among the options; a session import forgets them', async () => {
    const mk = (id: string, data_type: string, sample_keys: string[]) =>
      ({ id, label: id, path: `/${id}.bam`, color: '#000', data_type, sample_keys }) as any;
    const nativeA = mk('nativeA', 'bam', ['key_sample_1']);
    const liftB = mk('liftB', 'bam_livelift', ['key_sample_2']);
    const liftA = mk('liftA', 'bam_livelift', ['key_sample_1']);
    const liftA2 = mk('liftA2', 'bam_livelift', ['key_sample_1']);

    // 2a: User chooses liftB when only liftB is open, then opens liftA (nativeA's own sample)
    useMapChoice.getState().choose('nativeA', 'liftB');
    useBrowserStore.setState({ datasets: [liftB, liftA, nativeA] } as any);
    vi.mocked(compareWithAssembly).mockResolvedValue({
      dataset_id: 'liftB', chrom: 'chr1', start: 0, end: 3000, search_complete: false,
      reasons: [], assembly: {}, reads: {}, lineage_events: [], ledger: {}, policy: {},
    } as any);

    const selection: any = {
      panelId: 'p1', datasetId: 'nativeA', viewKey: 'main', chrom: 'chr1',
      difference: { id: 'ins1', kind: 'insertion', source: 'reads', hap: '', hap_label: '', reason: 'r', t_start: 500, t_end: 500, ref_bp: 0, alt_bp: 80, src: { contig: null, start: null, end: null }, chain: null, strand: null, grch38: null, alt: null },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<AssemblyComparisonPanel selection={selection} dataset={nativeA} />);
      });
      expect(compareWithAssembly).toHaveBeenCalledWith(expect.objectContaining({ dataset_id: 'liftA' }), expect.any(AbortSignal));
      expect(host.querySelector('[data-testid="assembly-map-picker"]')).toBeNull();

      // 2b: When two same-sample lifts + another sample's lift are open, picking liftA injects liftB into options under 'several_of_sample'
      const afterPick = mapOptionsFor(nativeA, [liftA, liftA2, liftB, nativeA], 'liftA');
      expect(afterPick.reason).toBe('several_of_sample');
      expect(afterPick.options.map(d => d.id)).toEqual(['liftA', 'liftA2']);
      expect(afterPick.map?.id).toBe('liftA');

      // 2c: Session import does not clear useMapChoice
      for (const ext of storeExtensions()) ext.onSessionImport?.();
      await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); });
      expect(useMapChoice.getState().byDataset).toEqual({});
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('a session saved on a public server skips graph status only while it is open; a local session asks again', async () => {
    vi.mocked(getGraphStatus).mockResolvedValue({
      helper: { available: true, path: '/bin/helper', producer: 'test', version: '1', protocol_version: 1, error: null },
      registrations: [],
      registration_errors: [],
      limits: {},
    } as any);

    // Import a session exported from a public server (publicMode: true)
    applyImportedState({
      datasets: [{ id: 'ds1', label: 'A', path: 'a.bam', data_type: 'bam' }],
      overlays: [],
      has_fasta: false,
      frontend: { publicMode: true, panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [] }] },
    });
    expect(useBrowserStore.getState().publicMode).toBe(true);

    // Graph status load triggered while publicMode is true (e.g. by watchGraphBindings)
    await useGraphStatusStore.getState().load();
    expect(useGraphStatusStore.getState().refused).toBe(false);
    expect(getGraphStatus).not.toHaveBeenCalled();

    // User imports a normal local session (publicMode: false)
    applyImportedState({
      datasets: [{ id: 'ds1', label: 'A', path: '/local/a.bam', data_type: 'bam' }],
      overlays: [],
      has_fasta: false,
      frontend: { publicMode: false, panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [] }] },
    });
    expect(useBrowserStore.getState().publicMode).toBe(false);

    // LoadLocalFileSettings / GraphModeSettings / GraphPanel / watchGraphBindings call load()
    await useGraphStatusStore.getState().load();
    expect(getGraphStatus).toHaveBeenCalledTimes(1);
    expect(useGraphStatusStore.getState().status).not.toBeNull();
  });
});

// agy post-merge review D round 2, HIGH 1: on a pooled panel both haplotypes can carry a read-supported insertion and
// the server (no haplotype preference) may pick the second haplotype's carrier; Identify uses that carrier's sequence.
describe('Reads-lane Identify on a diploid pooled panel', () => {
  const dataset: any = {
    id: 'lift_ds',
    label: 'Lift',
    path: '/fake/source.bam',
    data_type: 'bam_livelift',
    live_lift: { key: 'k1', haplotypes: ['H#1', 'H#2'], haplotype_labels: { 'H#1': 'MAT', 'H#2': 'PAT' } },
  };
  const panel: any = { id: 'p_pooled', datasetId: 'lift_ds', subTracks: [], linkGroup: null, contentType: 'dataset', collapsed: false };
  const insertion: any = {
    id: 'geom:ins:1200:120', hap: '', hap_label: 'Reads', kind: 'insertion', source: 'reads', reason: 'composed_geometry',
    t_start: 1200, t_end: 1200, ref_bp: 0, alt_bp: 120, strand: null, chain: null,
    src: { contig: null, start: null, end: null }, grch38: null, alt: null,
  };
  const row = (hap: 'MAT' | 'PAT', length: number) => ({
    id: `mol_${hap}`, record: `rec_${hap}:0`, molecule: `lift_ds|mol_${hap}`, hap_label: hap, strand: '+', supplementary: false,
    source_pos: { contig: `ctg_${hap}`, start: 200, end: 201 }, read_bases: 'A'.repeat(60), read_bases_length: length,
    hg002: 'C', grch38: null, allele: 'other', ins_id: `${hap}:ctg_${hap}:200-201:inspection`, carries_insertion: true,
    mol_bp: length, chromatin: { state: 'none', layer: null, nearest_m6a_bp: null, orientation: '+' },
  });
  // Rows in haplotype order (MAT first); the server's best carrier is PAT's (120 bp matches the insertion exactly).
  const response = (withSequence: boolean): any => ({
    dataset_id: 'lift_ds', lift_key: 'k1', chrom: 'chrT', pos: 1200, end: 1200, preferred_hap: null,
    rows: [row('MAT', 121), row('PAT', 120)], summary: { MAT: { other: 1 }, PAT: { other: 1 } }, capped: false, max_records: 500,
    sequence: withSequence ? { sequence: 'A'.repeat(120), read_id: 'mol_PAT', record: 'rec_PAT:0',
      ins_id: 'PAT:ctg_PAT:200-201:inspection', orientation: '+', source: 'reads' } : null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useComparisonStore.setState({ byKey: {} });
    useDifferenceSelection.getState().select(null);
    useTrackFeedStore.setState({ byStateKey: {} } as any);
    useBrowserStore.setState({ publicMode: false, datasets: [dataset], panels: [panel] } as any);
    vi.mocked(compareWithAssembly).mockResolvedValue({
      dataset_id: 'lift_ds', chrom: 'chrT', start: 0, end: 3000, search_complete: false,
      reasons: [], assembly: {}, reads: {}, lineage_events: [], ledger: {}, policy: {},
    } as any);
  });

  async function open(action?: 'identify') {
    useDifferenceSelection.getState().select({ panelId: panel.id, datasetId: dataset.id, viewKey: 'main', chrom: 'chrT',
      ...(action ? { action } : {}), difference: insertion });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<DifferencePopover panel={panel} dataset={dataset} anchor={{ current: host }} />); });
    await act(async () => { await Promise.resolve(); });
    return () => { act(() => root.unmount()); host.remove(); };
  }

  function expectIdentified() {
    expect(document.body.textContent).not.toContain('Identify unavailable');
    expect(document.querySelector('[data-testid="identify-tab"]')).not.toBeNull();
    expect(identifyLens).toHaveBeenCalledWith(
      expect.objectContaining({ consensus: expect.objectContaining({ seq: 'A'.repeat(120), n_reads: 1 }) }), 'lift_ds', expect.anything());
  }

  it('clicking Identify identifies the carrier the server picked from the second haplotype', async () => {
    useTrackFeedStore.setState({ byStateKey: { lift_ds: { reads: [{ id: 'mol_MAT' }, { id: 'mol_PAT' }], zoomedOut: false } } } as any);
    vi.mocked(getDifferenceReads).mockImplementation(async (params: any) => response(Boolean(params.includeSequence)));
    const close = await open();
    try {
      const identifyBtn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Identify')!;
      expect(identifyBtn.disabled).toBe(false);
      await act(async () => { identifyBtn.click(); });
      await act(async () => { await Promise.resolve(); });
      expect(getDifferenceReads).toHaveBeenLastCalledWith(expect.objectContaining({ liftHap: 'Reads', includeSequence: true }), expect.any(AbortSignal));
      expectIdentified();
    } finally { close(); }
  });

  it('the context menu\'s Identify identifies the carrier the server picked from the second haplotype', async () => {
    vi.mocked(getDifferenceReads).mockResolvedValue(response(true));
    const close = await open('identify');
    try {
      expect(getDifferenceReads).toHaveBeenCalledWith(expect.objectContaining({ liftHap: 'Reads', includeSequence: true }), expect.any(AbortSignal));
      expectIdentified();
    } finally { close(); }
  });
});
