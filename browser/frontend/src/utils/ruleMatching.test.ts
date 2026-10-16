import { describe, expect, it } from 'vitest';
import { DEFAULT_COLORMAP, type ColorRule, type Gene } from '../types';
import { buildRuleMatchContext, footprintMatchesRule, getMatchingRuleColor, peaksForPanelChrom, qualityGatesPayload, readMatchesRule, ruleTargetsLayer } from './ruleMatching';

const genes: Gene[] = [
  {
    id: 'FBgn0000606-RB',
    name: 'eve',
    chrom: 'chr2R',
    start: 100,
    end: 300,
    strand: '+',
    biotype: 'protein_coding',
    exons: [],
  },
  {
    id: 'FBgn0003448-RA',
    name: 'sna',
    chrom: 'chr2R',
    start: 260,
    end: 500,
    strand: '-',
    biotype: 'protein_coding',
    exons: [],
  },
  {
    id: 'FBgn-nc-1',
    name: 'roX1',
    chrom: 'chr2R',
    start: 520,
    end: 590,
    strand: '+',
    biotype: 'lncRNA',
    exons: [],
  },
];

function rule(overrides: Partial<ColorRule>): ColorRule {
  return {
    id: 'rule',
    name: 'Rule',
    color: '#ff00ff',
    sizeMin: 1,
    sizeMax: null,
    targetLayers: [],
    conditions: [],
    enabled: true,
    ...overrides,
  };
}

describe('ruleMatching', () => {
  it('supports reproducible gene-specific NOT exclusions', () => {
    const pol2NotEve = rule({
      sizeMin: 35,
      sizeMax: 65,
      conditions: [{ target: 'gene', geneId: 'FBgn0000606-RB', geneName: 'eve', negate: true }],
    });
    const ctx = buildRuleMatchContext(genes, [], [], 0, 600, [pol2NotEve]);

    expect(footprintMatchesRule(140, 190, 50, pol2NotEve, ctx)).toBe(false);
    expect(footprintMatchesRule(360, 410, 50, pol2NotEve, ctx)).toBe(true);
  });

  it('uses gene names as a stable fallback for exported rules', () => {
    const inEveByName = rule({
      conditions: [{ target: 'gene', geneName: 'eve' }],
    });
    const ctx = buildRuleMatchContext(genes, [], [], 0, 600, [inEveByName]);

    expect(footprintMatchesRule(125, 175, 45, inEveByName, ctx)).toBe(true);
    expect(footprintMatchesRule(390, 440, 45, inEveByName, ctx)).toBe(false);
  });

  it('matches generic gene rules against noncoding viewport annotations', () => {
    const anyGene = rule({
      conditions: [{ target: 'gene' }],
    });
    const ctx = buildRuleMatchContext(genes, [], [], 0, 700, [anyGene]);

    expect(footprintMatchesRule(535, 555, 20, anyGene, ctx)).toBe(true);
    expect(footprintMatchesRule(610, 630, 20, anyGene, ctx)).toBe(false);
  });

  it('matches positions inside the wider of two overlapping gene regions', () => {
    // A nested/overlapping pair where an earlier-starting gene is also the
    // widest. Region-overlap matching must merge intervals first, otherwise a
    // midpoint that falls only inside the wide gene is wrongly missed.
    const overlappingGenes: Gene[] = [
      { id: 'wide', name: 'wide', chrom: 'chr2R', start: 100, end: 500, strand: '+', biotype: 'protein_coding', exons: [] },
      { id: 'inner', name: 'inner', chrom: 'chr2R', start: 200, end: 300, strand: '+', biotype: 'protein_coding', exons: [] },
    ];
    const anyGene = rule({ conditions: [{ target: 'gene' }] });
    const ctx = buildRuleMatchContext(overlappingGenes, [], [], 0, 600, [anyGene]);

    // midpoint 450 is inside the wide gene only — must still match.
    expect(footprintMatchesRule(440, 460, 20, anyGene, ctx)).toBe(true);
    // midpoint 250 is inside both — matches.
    expect(footprintMatchesRule(240, 260, 20, anyGene, ctx)).toBe(true);
    // midpoint 550 is outside both — no match.
    expect(footprintMatchesRule(540, 560, 20, anyGene, ctx)).toBe(false);
  });

  it('matches gene-specific rules against noncoding viewport annotations', () => {
    const inRox1 = rule({
      conditions: [{ target: 'gene', geneId: 'FBgn-nc-1', geneName: 'roX1' }],
    });
    const ctx = buildRuleMatchContext(genes, [], [], 0, 700, [inRox1]);

    expect(footprintMatchesRule(535, 555, 20, inRox1, ctx)).toBe(true);
    expect(footprintMatchesRule(125, 175, 20, inRox1, ctx)).toBe(false);
  });

  it('aliases user-facing FIRE rules to legacy internal MSP layers', () => {
    const fireRule = rule({
      targetLayers: ['fire'],
      qualityGates: [{ qualityName: 'aq', minValue: 230 }],
    });
    const ctx = buildRuleMatchContext([], [], [], 0, 100, [fireRule]);

    expect(ruleTargetsLayer(fireRule, 'msp')).toBe(true);
    expect(footprintMatchesRule(10, 20, 10, fireRule, ctx, 'msp', { aq: 229 })).toBe(false);
    expect(footprintMatchesRule(10, 20, 10, fireRule, ctx, 'msp', { aq: 230 })).toBe(true);
  });

  it('matches fixed genomic region conditions created by Copilot commands', () => {
    const fixedRegion = rule({
      targetLayers: ['tf'],
      conditions: [{
        target: 'region',
        regionChrom: 'chr2R',
        regionStart: 250,
        regionEnd: 330,
        regionLabel: 'eve TSS -100',
      }],
    });
    const ctx = buildRuleMatchContext([], [], [], 200, 420, [fixedRegion], 'chr2R');
    const wrongChromCtx = buildRuleMatchContext([], [], [], 200, 420, [fixedRegion], 'chr3L');

    expect(footprintMatchesRule(65, 95, 30, fixedRegion, ctx, 'tf')).toBe(true);
    expect(footprintMatchesRule(120, 150, 30, fixedRegion, ctx, 'tf')).toBe(false);
    expect(footprintMatchesRule(65, 95, 30, fixedRegion, wrongChromCtx, 'tf')).toBe(false);
  });

  it('can restrict a layer rule to intervals with explicit annotation names', () => {
    const namedOnly = rule({
      targetLayers: ['tf_sr'],
      requireAnnotationName: true,
    });
    const ctx = buildRuleMatchContext([], [], [], 0, 100, [namedOnly]);

    expect(footprintMatchesRule(10, 20, 10, namedOnly, ctx, 'tf_sr', { q0: 255 }, '')).toBe(false);
    expect(footprintMatchesRule(10, 20, 10, namedOnly, ctx, 'tf_sr', { q0: 200 }, 'rescue_R')).toBe(true);
  });

  it('keeps the default subnucleosome fallback below Pol II and TF rules', () => {
    const ids = DEFAULT_COLORMAP.rules.map(defaultRule => defaultRule.id);
    const subnuc = DEFAULT_COLORMAP.rules.find(defaultRule => defaultRule.id === 'subnuc');
    const ctx = buildRuleMatchContext([], [], [], 0, 100, DEFAULT_COLORMAP.rules);

    expect(ids.indexOf('subnuc')).toBeGreaterThan(ids.indexOf('pol2'));
    expect(ids.indexOf('subnuc')).toBeGreaterThan(ids.indexOf('tf'));
    expect(subnuc).toMatchObject({
      name: 'Subnucleosome',
      color: '#9ca3af',
      sizeMin: 1,
      sizeMax: 89,
      targetLayers: ['tf'],
      conditions: [],
      enabled: true,
    });
    expect(subnuc && footprintMatchesRule(10, 30, 20, subnuc, ctx, 'tf')).toBe(true);
    expect(subnuc && footprintMatchesRule(10, 30, 20, subnuc, ctx, 'nuc')).toBe(false);
  });

  it('returns size-gradient colors for the first matching rule', () => {
    const gradientRule = rule({
      colorMode: 'size_gradient',
      color: '#000000',
      sizeMin: 10,
      sizeMax: 20,
      gradient: { startColor: '#000000', endColor: '#ffffff', scale: 'linear' },
    });
    const ctx = buildRuleMatchContext([], [], [], 0, 100, [gradientRule]);

    expect(getMatchingRuleColor(10, 25, 15, [gradientRule], ctx)).toBe('#808080');
  });
});

describe('readMatchesRule (cluster enrichment)', () => {
  it('finds TF footprints in the TF layer of layered reads, not only top-level intervals', async () => {
    const { readMatchesRule } = await import('./ruleMatching');
    const tfRule = rule({ sizeMin: 10, sizeMax: 80 });
    const ctx = buildRuleMatchContext([], [], [], 0, 1000, [tfRule]);
    const read = {
      id: 'r1',
      intervals: [[0, 1000, 0]] as [number, number, number][],        // read span only
      layers: { tf: { intervals: [[100, 140, 40]] as [number, number, number][] } },
    };
    expect(readMatchesRule(read, tfRule, ctx)).toBe(true);
    expect(readMatchesRule({ ...read, layers: {} }, tfRule, ctx)).toBe(false);
  });
});

describe('ruleMatching named genes and track percentiles', () => {
  it('a rule naming a gene that is not in view matches nothing', () => {
    const inAbsent = rule({ conditions: [{ target: 'gene', geneId: 'FBgn-absent', geneName: 'absent' }] });
    const notAbsent = rule({ id: 'n', conditions: [{ target: 'gene', geneId: 'FBgn-absent', geneName: 'absent', negate: true }] });
    const ctx = buildRuleMatchContext(genes, [], [], 0, 600, [inAbsent, notAbsent]);
    // 140-190 lies in eve, which is not the named gene.
    expect(footprintMatchesRule(140, 190, 50, inAbsent, ctx)).toBe(false);
    expect(footprintMatchesRule(140, 190, 50, notAbsent, ctx)).toBe(true);
  });

  it('rules on one track keep their own percentile thresholds', () => {
    const track = { index: 0, label: 'sig', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], renderMode: 'signal' as const };
    const low = rule({ id: 'low', conditions: [{ target: 'track', trackId: '0', trackThreshold: 20 }] });
    const high = rule({ id: 'high', conditions: [{ target: 'track', trackId: '0', trackThreshold: 80 }] });
    const ctx = buildRuleMatchContext([], [], [track], 0, 100, [low, high]);
    // Midpoint 45 falls in the bin holding 5: above the 20th percentile, below the 80th.
    expect(footprintMatchesRule(40, 50, 10, low, ctx)).toBe(true);
    expect(footprintMatchesRule(40, 50, 10, high, ctx)).toBe(false);
  });

  it('a signal track with no positive values in view overlaps nothing', () => {
    const track = { index: 0, label: 'sig', values: [0, 0, 0, 0], renderMode: 'signal' as const };
    const inTrack = rule({ id: 'in', conditions: [{ target: 'track', trackId: '0', trackThreshold: 50 }] });
    const notInTrack = rule({ id: 'not', conditions: [{ target: 'track', trackId: '0', trackThreshold: 50, negate: true }] });
    const ctx = buildRuleMatchContext([], [], [track], 0, 100, [inTrack, notInTrack]);
    expect(footprintMatchesRule(40, 50, 10, inTrack, ctx)).toBe(false);
    expect(footprintMatchesRule(40, 50, 10, notInTrack, ctx)).toBe(true);
  });

  it('genes and tagged peaks on another chromosome never match', () => {
    const inGene = rule({ id: 'g', conditions: [{ target: 'gene' }] });
    const inPeak = rule({ id: 'p', conditions: [{ target: 'peak' }] });
    const peaks = [{ index: 0, start: 100, end: 200, chrom: 'chr1' }] as never[];
    // eve spans 100-300 on chr2R; the peak is on chr1.
    const onChr3L = buildRuleMatchContext(genes, peaks, [], 0, 600, [inGene, inPeak], 'chr3L');
    expect(footprintMatchesRule(140, 160, 20, inGene, onChr3L)).toBe(false);
    expect(footprintMatchesRule(140, 160, 20, inPeak, onChr3L)).toBe(false);
    const onChr2R = buildRuleMatchContext(genes, peaks, [], 0, 600, [inGene, inPeak], 'chr2R');
    expect(footprintMatchesRule(140, 160, 20, inGene, onChr2R)).toBe(true);
    expect(footprintMatchesRule(140, 160, 20, inPeak, onChr2R)).toBe(false);
  });

  it('untagged peaks belong to the main view, not a panel on another chromosome', () => {
    const peaks = [{ start: 1 }, { start: 2, chrom: 'chr2' }, { start: 3, chrom: 'chr1' }];
    expect(peaksForPanelChrom(peaks, 'chr1', 'chr1')).toBe(peaks);
    expect(peaksForPanelChrom(peaks, 'chr2', 'chr1')).toEqual([{ start: 2, chrom: 'chr2' }]);
  });

  it('enrichment skips primary footprints for a rule targeting another layer', () => {
    const tfOnly = rule({ id: 'tf', sizeMin: 100, sizeMax: 200, targetLayers: ['tf'] });
    const ctx = buildRuleMatchContext([], [], [], 0, 600, [tfOnly]);
    const nucOnly = { id: 'r', intervals: [[100, 250, 150]] as [number, number, number][] };
    expect(readMatchesRule(nucOnly, tfOnly, ctx)).toBe(false);
    const withTf = { ...nucOnly, layers: { tf: { intervals: [[300, 450, 150]] as [number, number, number][] } } };
    expect(readMatchesRule(withTf, tfOnly, ctx)).toBe(true);
  });
});

describe('qualityGatesPayload', () => {
  it('sends a rule\'s quality gates to the sort/filter API', () => {
    expect(qualityGatesPayload([{ qualityName: 'tq', minValue: 200 }, { qualityName: 'aq', minValue: 230, maxValue: 250 }]))
      .toEqual([{ quality_name: 'tq', min_value: 200, max_value: null }, { quality_name: 'aq', min_value: 230, max_value: 250 }]);
    expect(qualityGatesPayload(undefined)).toEqual([]);
  });
});
