import { describe, expect, it } from 'vitest';
import { createTestStore } from '../stores/__tests__/helpers';
import { buildSessionManifest, formatSessionManifest } from './sessionManifest';

describe('session manifest', () => {
  it('summarizes reproducibility-critical state', () => {
    const store = createTestStore();
    store.setState({
      sessionName: 'DAF test',
      chrom: 'chr2R',
      start: 100,
      end: 500,
      currentGenome: 'dm6',
      fastaPath: '/ref/dm6.fa',
      hasFasta: true,
      analysisSampleSeed: 'stable-seed',
      analysisSampleCount: 5000,
      downsampleCount: 1000,
      readDisplayMode: 'all',
      allReadsDisplayCap: 15000,
      peaksLocked: true,
      selectedPeaks: new Set([1, 2]),
      clusterMethod: 'kmeans',
      clusterK: 8,
      clusterFeatureRules: [{
        id: 'short_tf',
        name: 'Short TF',
        enabled: true,
        terms: [{ id: 't1', source: 'layer', layer: 'tf', sizeMin: 1, sizeMax: 40 }],
      }],
      spanningOnly: true,
      legacyLayerInference: false,
      legacyNucMinSize: 120,
      footprintGroups: [{
        id: 'fg-tf',
        name: 'Pinned TF',
        color: '#f00',
        layer: 'tf',
        sizeMin: 8,
        sizeMax: 40,
        referenceAbsStart: 150,
        referenceAbsEnd: 175,
        overlapFraction: 0.5,
        conditions: [{ target: 'gene', geneName: 'eve', negate: true }],
        enabled: true,
        sourceIndex: -1,
      }, {
        id: 'fg-fire',
        name: 'FIRE class',
        color: '#0f0',
        layer: 'fire',
        sizeMin: 50,
        sizeMax: null,
        overlapFraction: 0.5,
        enabled: false,
        sourceIndex: -1,
      }, {
        id: 'fg-base',
        name: 'Legacy base class',
        color: '#00f',
        layer: null,
        sizeMin: 70,
        sizeMax: 140,
        overlapFraction: 0.5,
        enabled: false,
        sourceIndex: -1,
      }],
      datasets: [{
        id: 'ds1',
        label: 'stage_d',
        path: '/data/stage_d.bam',
        paths: ['/data/stage_d.bam'],
        color: '#000',
        data_type: 'bam',
        available_layers: { nuc: true, tf: true, deam: false },
      } as any],
      cachedLayerTypes: { fire: false },
      catalog: [{ id: 'cat1', source: 'local', kind: 'bigbed', label: 'motifs', loaded: false, unavailable: true } as any],
      compositeTracks: [{ id: 'comp1' } as any],
      savedTracks: [{ id: 'saved1' } as any],
    });

    const manifest = buildSessionManifest(store.getState(), { generatedAt: '2026-04-30T00:00:00.000Z' });

    expect(manifest.sessionName).toBe('DAF test');
    expect(manifest.viewport).toEqual({ chrom: 'chr2R', start: 100, end: 500, reversed: false });
    expect(manifest.datasets[0]).toMatchObject({
      id: 'ds1',
      label: 'stage_d',
      paths: ['/data/stage_d.bam'],
      dataType: 'bam',
      layers: ['nuc', 'tf'],
    });
    expect(manifest.reproducibility).toMatchObject({
      seed: 'stable-seed',
      analysisCap: 5000,
      displayCap: 1000,
      displayMode: 'all',
      allReadsDisplayCap: 15000,
      peaksLocked: true,
      selectedPeaks: 2,
      clusterMethod: 'kmeans',
      clusterK: 8,
      clusterFeatureRules: {
        total: 1,
        enabled: 1,
        terms: 1,
        names: ['Short TF'],
      },
      legacyLayerInference: {
        enabled: false,
        nucMinSize: 120,
      },
      footprintRules: {
        total: 3,
        enabled: 1,
        pinned: 1,
        layers: ['Accessibility', 'Base intervals', 'TF'],
      },
    });
    expect(manifest.reproducibility.footprintRules.rules[0]).toMatchObject({
      id: 'fg-tf',
      name: 'Pinned TF',
      layer: 'tf',
      layerLabel: 'TF',
      enabled: true,
      sizeMin: 8,
      sizeMax: 40,
      pinned: true,
      referenceAbsStart: 150,
      referenceAbsEnd: 175,
      conditions: 1,
    });
    expect(manifest.warnings).toEqual(expect.arrayContaining([
      'Analysis cap is active (5,000 reads).',
      '1 catalog track unavailable after restore.',
      'Layer cache disabled for: fire.',
    ]));
  });

  it('formats a copyable text summary', () => {
    const store = createTestStore();
    store.setState({
      sessionName: 'Summary',
      datasets: [],
      selectedPeaks: new Set([1]),
      peaksLocked: false,
    });

    const text = formatSessionManifest(
      buildSessionManifest(store.getState(), { generatedAt: '2026-04-30T00:00:00.000Z' }),
    );

    expect(text).toContain('FiberBrowser session: Summary');
    expect(text).toContain('Datasets: 0');
    expect(text).toContain('Legacy layer inference: on (nuc >= 90bp)');
    expect(text).toContain('Cluster feature rules: 0 total, 0 enabled, terms=0');
    expect(text).toContain('Footprint rules: 0 total, 0 enabled, 0 pinned');
    expect(text).toContain('Warnings:');
    expect(text).toContain('No datasets are loaded.');
    expect(text).toContain('Selected peaks are not locked');
  });
});
