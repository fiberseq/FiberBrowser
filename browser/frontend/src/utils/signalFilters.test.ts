import { getCoaccMatrixImageUrl, getCoaccStripUrl } from '../api/coaccessibility';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_FILTERS, keepsSignal, signalFilterParams, signalFilterUrl, type SignalEvidence } from './signalFilters';
import { useBrowserStore } from '../stores/browserStore';
import { serializeState } from '../stores/historySlice';
import { readRegionGeneration } from '../api/loadedReadRegion';
import { compactReadsQueryKey } from '../api/readOperations';
import { applyImportedState, collectFrontendState } from '../api/session';

describe('alignment signal filters', () => {
  beforeEach(() => { useBrowserStore.setState({ signalFilters: { ...DEFAULT_SIGNAL_FILTERS } }); });

  it('hides only background by default and keeps negative enums distinct', () => {
    for (const status of ['background', 'detectable', 'unclassified', 'unscored', 'unknown'] as const) {
      const evidence = { status, structure: { status: 'unscored' } } as SignalEvidence;
      expect(keepsSignal(evidence, DEFAULT_SIGNAL_FILTERS)).toBe(true);
      expect(keepsSignal(evidence, { ...DEFAULT_SIGNAL_FILTERS, hideBackground: true })).toBe(status !== 'background');
      expect(keepsSignal(evidence, { ...DEFAULT_SIGNAL_FILTERS, excludeUnscored: true })).toBe(!['unscored', 'unknown'].includes(status));
    }
    expect(keepsSignal(undefined, { ...DEFAULT_SIGNAL_FILTERS, hideBackground: true })).toBe(true);
  });

  it('carries the same predicate in panel-scoped matrix and strip image requests', () => {
    useBrowserStore.getState().setSignalFilters({ hideBackground: true });
    for (const url of [getCoaccMatrixImageUrl('chr1', 100, 200, { panelGenome: 'own' }),
      getCoaccStripUrl('chr1', 100, 200, { panelGenome: 'own' })]) {
      const params = new URL(url, 'http://localhost').searchParams;
      expect(params.get('panel_genome')).toBe('own');
      expect(JSON.parse(params.get('signal_filters')!)).toEqual({ ...DEFAULT_SIGNAL_FILTERS, hideBackground: true });
    }
  });

  it('strict filters require both supplied axes', () => {
    const filters = { ...DEFAULT_SIGNAL_FILTERS, requireDetectable: true, requireStructure: true };
    for (const status of ['background', 'detectable', 'unclassified', 'unscored', 'unknown'] as const) {
      for (const structure of ['supported', 'not_detected', 'unclassified', 'unscored'] as const) {
        expect(keepsSignal({ status, structure: { status: structure } } as SignalEvidence, filters))
          .toBe(status === 'detectable' && structure === 'supported');
      }
    }
  });

  it('invalidates the molecule cache, refreshes analyses, and saves the predicate', () => {
    const generation = readRegionGeneration(), refresh = useBrowserStore.getState().refreshGeneration;
    const params = new URLSearchParams({ dataset_id: 'one', chrom: 'chr1', start: '0', end: '500' });
    const before = compactReadsQueryKey(params);
    useBrowserStore.getState().setSignalFilters({ hideBackground: true });
    expect(readRegionGeneration()).toBeGreaterThan(generation);
    expect(useBrowserStore.getState().refreshGeneration).toBe(refresh + 1);
    const captured = signalFilterParams(params);
    expect(compactReadsQueryKey(params)).not.toBe(before);
    const saved = serializeState(useBrowserStore.getState());
    expect(saved.signalFilters).toEqual({ ...DEFAULT_SIGNAL_FILTERS, hideBackground: true });
    useBrowserStore.getState().setSignalFilters({ hideBackground: false });
    expect(compactReadsQueryKey(params)).toBe(before);
    // A pending fetch retains its own predicate after the switch changes.
    expect(signalFilterParams(captured).get('signal_filters')).toBe(captured.get('signal_filters'));
    expect(signalFilterUrl('/api/coverage?signal_filters=%7B%22hideBackground%22%3Atrue%7D')).toContain('hideBackground');
  });

  it('restores saved settings and source identity and resets old sessions', () => {
    useBrowserStore.setState({ datasets: [{ id: 'one', label: 'Input', data_type: 'bam',
      paths: ['/tmp/input.bam'], source_identity: 'original' }] as any });
    useBrowserStore.getState().setSignalFilters({ hideBackground: true, requireStructure: true });
    const saved = collectFrontendState();
    expect((saved.datasets as any[])[0].source_identity).toBe('original');
    const generation = readRegionGeneration();
    useBrowserStore.setState({ datasets: [{ ...useBrowserStore.getState().datasets[0], source_identity: 'replacement' }] });
    expect(readRegionGeneration()).toBeGreaterThan(generation);
    useBrowserStore.getState().setSignalFilters({ hideBackground: false, requireStructure: false });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: saved });
    expect(useBrowserStore.getState().signalFilters).toEqual({ ...DEFAULT_SIGNAL_FILTERS, hideBackground: true, requireStructure: true });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false });
    expect(useBrowserStore.getState().signalFilters).toEqual(DEFAULT_SIGNAL_FILTERS);
  });
});
