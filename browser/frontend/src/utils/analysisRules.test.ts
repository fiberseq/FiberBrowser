import { describe, expect, it } from 'vitest';
import type { ClusterFeatureRule, FirePeak, Gene, PeakMode } from '../types';
import {
  buildAnalysisFilterRuleAutoName,
  buildClusterFeatureRuleAutoName,
  normalizeAnalysisRuleScope,
  resolveClusterRuleRegions,
} from './analysisRules';

describe('analysis rule helpers', () => {
  it('builds compact names from source terms and non-default scopes', () => {
    const rule: ClusterFeatureRule = {
      id: 'r1',
      name: '',
      enabled: true,
      scope: { kind: 'allPeaks', peakLevelMin: 0, peakLevelMax: 2 },
      terms: [{ id: 't1', source: 'layer', layer: 'tf', sizeMin: 20, sizeMax: 80 }],
    };

    expect(buildClusterFeatureRuleAutoName(rule)).toBe('TF 20-80bp @ all peaks L0-2');
  });

  it('names Pol II state terms using transcription-panel labels', () => {
    expect(buildClusterFeatureRuleAutoName({
      id: 'r1',
      name: '',
      enabled: true,
      scope: { kind: 'gene' },
      terms: [{ id: 't1', source: 'transcription_state', transcriptionState: 'pause' }],
    })).toBe('Pol II Pause @ selected gene');
  });

  it('builds filter rule names with metric thresholds', () => {
    expect(buildAnalysisFilterRuleAutoName({
      scope: { kind: 'currentWindow' },
      terms: [{ id: 't1', source: 'layer', layer: 'fire', sizeMin: 100, sizeMax: null }],
      metric: 'count',
      operator: 'gte',
      threshold: 1,
    })).toBe('Accessibility 100+bp count >= 1 @ current window');
  });

  it('normalizes legacy rules to selected-peak scope', () => {
    expect(normalizeAnalysisRuleScope(undefined)).toMatchObject({
      kind: 'selectedPeaks',
      peakLevelMin: null,
      peakLevelMax: null,
    });
  });

  it('resolves selected peak scopes with per-peak modes', () => {
    const peaks: FirePeak[] = [
      { index: 1, start: 1_010, end: 1_020, layer: 0 },
      { index: 2, start: 1_030, end: 1_050, layer: 3 },
    ];
    const regions = resolveClusterRuleRegions(
      { scope: { kind: 'selectedPeaks', peakLevelMax: 1 } },
      baseContext({
        allPeaks: peaks,
        selectedPeaks: [1, 2],
        peakModes: { 1: 'tf' as PeakMode },
        mode: 'cluster_rule:r1' as PeakMode,
      }),
    );

    expect(regions).toEqual([{ start: 1_010, end: 1_020, mode: 'tf' }]);
  });

  it('keeps FirePeak coordinates absolute at non-zero viewport starts', () => {
    const regions = resolveClusterRuleRegions(
      { scope: { kind: 'allPeaks' } },
      baseContext({
        allPeaks: [{ index: 1, start: 1_010, end: 1_020, layer: 0 }],
      }),
    );

    expect(regions).toEqual([{ start: 1_010, end: 1_020, mode: 'accessibility' }]);
  });

	  it('resolves current-window and gene scopes without selected peaks', () => {
    const gene: Gene = {
      id: 'g1',
      name: 'GeneA',
      chrom: 'chr1',
      start: 1_100,
      end: 1_800,
      strand: '+',
      biotype: 'protein_coding',
      exons: [
        { start: 1_100, end: 1_250 },
        { start: 1_500, end: 1_800 },
      ],
    };

    expect(resolveClusterRuleRegions(
      { scope: { kind: 'currentWindow' } },
      baseContext({ mode: 'cluster_rule:r1' as PeakMode }),
    )).toEqual([{ start: 1_000, end: 2_000, mode: 'cluster_rule:r1' }]);

    expect(resolveClusterRuleRegions(
      { scope: { kind: 'gene', geneId: 'g1', genePart: 'intron' } },
      baseContext({ selectedGenes: [gene], mode: 'cluster_rule:r1' as PeakMode }),
    )).toEqual([{ start: 1_250, end: 1_500, mode: 'cluster_rule:r1' }]);
	  });

  it('a rule naming a gene that is no longer selected matches nothing', () => {
    const geneB: Gene = {
      id: 'g2', name: 'GeneB', chrom: 'chr1', start: 1_100, end: 1_800, strand: '+',
      biotype: 'protein_coding', exons: [],
    };
    expect(resolveClusterRuleRegions(
      { scope: { kind: 'gene', geneId: 'g1', genePart: 'full' } },
      baseContext({ selectedGenes: [geneB] }),
    )).toEqual([]);
    expect(resolveClusterRuleRegions(
      { scope: { kind: 'gene', geneName: 'GeneA', genePart: 'full' } },
      baseContext({ selectedGenes: [geneB] }),
    )).toEqual([]);
    // Naming none: the first selected gene, as before.
    expect(resolveClusterRuleRegions(
      { scope: { kind: 'gene', genePart: 'full' } },
      baseContext({ selectedGenes: [geneB] }),
    ).length).toBe(1);
  });

  it('gives a single-exon gene no intron regions', () => {
    const gene: Gene = {
      id: 'g1',
      name: 'GeneA',
      chrom: 'chr1',
      start: 1_100,
      end: 1_800,
      strand: '+',
      biotype: 'protein_coding',
      exons: [{ start: 1_100, end: 1_800 }],
    };

    expect(resolveClusterRuleRegions(
      { scope: { kind: 'gene', geneId: 'g1', genePart: 'intron' } },
      baseContext({ selectedGenes: [gene] }),
    )).toEqual([]);
  });

  it('resolves selected genes from legacy payloads without chrom fields', () => {
    const gene = {
      id: 'g1',
      name: 'GeneA',
      start: 1_100,
      end: 1_800,
      strand: '+',
      biotype: 'protein_coding',
      exons: [],
    } as Gene;

    expect(resolveClusterRuleRegions(
      { scope: { kind: 'gene', genePart: 'full' } },
      baseContext({ selectedGenes: [gene] }),
    )).toEqual([{ start: 1_100, end: 1_800, mode: 'accessibility' }]);
  });

  it('matches selected genes across chr-prefixed chromosome aliases', () => {
    const gene: Gene = {
      id: 'g1',
      name: 'GeneA',
      chrom: '2L',
      start: 1_100,
      end: 1_800,
      strand: '+',
      biotype: 'protein_coding',
      exons: [],
    };

    expect(resolveClusterRuleRegions(
      { scope: { kind: 'gene', genePart: 'full' } },
      baseContext({ chrom: 'chr2L', selectedGenes: [gene] }),
    )).toEqual([{ start: 1_100, end: 1_800, mode: 'accessibility' }]);
  });

  it('resolves custom regions as absolute clipped windows', () => {
    expect(resolveClusterRuleRegions(
      { scope: { kind: 'customRegion', region: { chrom: 'chr1', start: 900, end: 1_050 } } },
      baseContext(),
    )).toEqual([{ start: 1_000, end: 1_050, mode: 'accessibility' }]);
  });

  it('matches a custom region across chromosome aliases, and not on another chromosome', () => {
    const region = (chrom: string) => ({ scope: { kind: 'customRegion' as const, region: { chrom, start: 900, end: 1_050 } } });
    expect(resolveClusterRuleRegions(region('1'), baseContext())).toEqual([{ start: 1_000, end: 1_050, mode: 'accessibility' }]);
    expect(resolveClusterRuleRegions(region('chr2'), baseContext())).toEqual([]);
  });

  it('returns no selected-peak regions when the level scope filters them all out', () => {
    const regions = resolveClusterRuleRegions(
      { scope: { kind: 'selectedPeaks', peakLevelMax: 0 } },
      baseContext({
        allPeaks: [{ index: 1, start: 1_010, end: 1_020, layer: 2 }],
        selectedPeaks: [1],
      }),
    );

    expect(regions).toEqual([]);
  });
});

function baseContext(overrides: Partial<Parameters<typeof resolveClusterRuleRegions>[1]> = {}): Parameters<typeof resolveClusterRuleRegions>[1] {
  return {
    allPeaks: [],
    selectedPeaks: [],
    peakModes: {},
    mode: 'accessibility',
    chrom: 'chr1',
    viewportStart: 1_000,
    viewportEnd: 2_000,
    selectedGenes: [],
    ...overrides,
  };
}
