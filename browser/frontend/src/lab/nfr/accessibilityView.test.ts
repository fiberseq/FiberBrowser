import '../testSetup';
import { describe, expect, it } from 'vitest';
import { groupsToClusters, pairsToArcs, pairTooltip, prevalenceRange, strandSplit } from './accessibilityView';
import { legacyDetection, parseNfrRegions, runParameters, DEFAULT_NFR_SETTINGS } from './AccessibilityPanel';
import { nfrDetectionLine, runDetectionLine, opportunityDiagnosticLine, share } from './accessibilityView';
import { NFR_RESULT } from './accessibility/fixture';

describe('Accessibility (preview) view helpers', () => {
  it('turns significant pairs into arcs: above for together, below for apart, dotted inside, by adjusted effect', () => {
    const arcs = pairsToArcs(NFR_RESULT, 'significant', true);
    expect(arcs.map(a => `${a.pair.a}|${a.pair.b}`)).toEqual(['N1:V1|N1:V3', 'N1:V2|class_008', 'N1:V1|class_008']);
    const [split, inside, anti] = arcs;
    expect(split.side).toBe('up');
    expect(split.strength).toBeCloseTo(1.61);                 // the openness-adjusted MH, not the pooled 1.69
    expect(inside.dash).toBe('dotted');
    expect(anti.side).toBe('down');
    expect(anti.strength).toBeCloseTo(2.44);
    expect(split.start).toBeLessThan(split.end);
    expect(arcs.every(a => a.lineWidth >= 1 && a.lineWidth <= 6)).toBe(true);
  });

  it('never draws a pooled effect in place of an undefined adjusted one', () => {
    const undefinedMh = { ...NFR_RESULT.pairs[2], mh: null, mh_lo: null, mh_hi: null, log2or: 2, class: 'unresolved' as const };
    const result = { ...NFR_RESULT, pairs: [undefinedMh] };
    expect(pairsToArcs(result, 'all', true)).toEqual([]);
    const byId = new Map(NFR_RESULT.elements.map(e => [e.id, e]));
    expect(pairTooltip(undefinedMh, byId)).toContain('Adjusted log₂ OR: not defined');
  });

  it('can show every tested pair, or leave footprint classes out', () => {
    expect(pairsToArcs(NFR_RESULT, 'all', true)).toHaveLength(4);
    expect(pairsToArcs(NFR_RESULT, 'all', true).find(a => a.pair.b === 'N1:V3' && a.pair.a === 'class_008')?.dash).toBe('dashed');
    expect(pairsToArcs(NFR_RESULT, 'all', false).map(a => a.pair.a + a.pair.b)).toEqual(['N1:V1N1:V3']);
    expect(pairsToArcs(null, 'all', true)).toEqual([]);
  });

  it('says what a pair means in plain words, with both the adjusted and the pooled effect', () => {
    const byId = new Map(NFR_RESULT.elements.map(e => [e.id, e]));
    const text = pairTooltip(NFR_RESULT.pairs[0], byId);
    expect(text).toContain('open together (more often than read openness explains)');
    expect(text).toContain('Adjusted log₂ OR (openness strata pooled) +1.61');
    expect(text).toContain('Pooled log₂ OR (unadjusted) +1.69');
    expect(text).toContain('evidence against independence, not proof');
    expect(text).toContain('272 shared openings left out');
    expect(pairTooltip(NFR_RESULT.pairs[1], byId)).toContain('inside the NFR variant');
  });

  it('formats prevalence as a strict-to-EM range and the DAF strands separately', () => {
    const [v1, v2] = NFR_RESULT.nfrs[0].variants;
    expect(prevalenceRange(v1)).toBe('16–18%');
    expect(prevalenceRange({ strict: 0.29, prevalence: 0.2907 })).toBe('29%');
    expect(prevalenceRange({ strict: 0.6, prevalence: 0.54 })).toBe('54–60%');     // strict can exceed EM: lower first
    expect(strandSplit(v2)).toBe('CT 30% · GA 28%');
    expect(strandSplit({ ...v2, by_channel: { 'x::+': { n: 1, em: 0.3, strict: 0.3 } } })).toBe('');
    expect(strandSplit({ ...v2, by_channel: { 'a::+': { n: 1, em: 0.3, strict: 0.3 }, 'b::+': { n: 1, em: 0.3, strict: 0.3 } } })).toBe('');
    expect(strandSplit({ ...v2, by_channel: { 'a::CT': { n: 1, em: 0.2, strict: 0.2 }, 'b::CT': { n: 1, em: 0.8, strict: 0.8 } } }, id => id.toUpperCase()))
      .toBe('A CT 20% · B CT 80%');
  });

  it('maps read groups onto the cluster store shape (one cluster per configuration, one region per variant)', () => {
    const c = groupsToClusters({
      job_id: 'j', nfr: 'N1', variants: [{ name: 'V1', start: 10.4, end: 99.6 }, { name: 'V2', start: 50, end: 300 }],
      groups: [{ id: 0, label: 'V2', display_label: 'V2', count: 5, pattern: [0, 1] }, { id: 1, label: 'closed', display_label: 'closed', count: 3, pattern: [0, 0] }],
      by_dataset: { ds1: { r1: 0, r2: 1 } },
    });
    expect(c.order).toEqual([0, 1]);
    expect(c.patterns).toEqual({ 0: [0, 1], 1: [0, 0] });
    expect(c.regions[0]).toEqual({ start: 10, end: 100, mode: 'accessibility' });
    expect(c.byDataset.ds1).toEqual({ r1: 0, r2: 1 });
  });

  it('parses NFR regions and builds the engine parameters', () => {
    expect(parseNfrRegions('47518170-47518510, chr19:47,514,930-47,516,010')).toEqual([[47518170, 47518510], [47514930, 47516010]]);
    expect(parseNfrRegions('somewhere')).toBeNull();
    expect(parseNfrRegions('47518170-47518510 47514930–47516010')).toEqual([[47518170, 47518510], [47514930, 47516010]]);
    expect(parseNfrRegions('10-5')).toBeNull();
    expect(runParameters(DEFAULT_NFR_SETTINGS, 4)).toEqual({ stringency: 0.9, mode: 'variants', elements: 'variants', internal_footprint_labels: true });
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, stringency: 0.85, withinClusters: true, nfrRegions: '100-400' }, 4))
      .toEqual({ stringency: 0.85, mode: 'variants', elements: 'variants', internal_footprint_labels: true, nfr_regions: [[100, 400]], within_clusters: 4 });
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, withinClusters: true }, null)).not.toHaveProperty('within_clusters');
  });

  it('sends the NFR detection settings only to a FiberHMM that has them', () => {
    const base = { stringency: 0.9, mode: 'variants', elements: 'variants', internal_footprint_labels: true };
    expect(runParameters(DEFAULT_NFR_SETTINGS, null, true)).toEqual({ ...base, detect_method: 'enrichment', min_fraction: 0.10 });
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, minFraction: 0.03, minFold: 3 }, null, true)).toEqual({ ...base, detect_method: 'enrichment', min_fraction: 0.03, min_fold: 3 });
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, minFold: 9, detectQ: .1, clipGapsToRegion: true }, null, true, true, true)).toEqual({ ...base, detect_method: 'raw', min_fraction: .1, clip_gaps_to_region: true });
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, clipGapsToRegion: true }, null, true, false, false)).not.toHaveProperty('clip_gaps_to_region');
    // not known yet (or an older FiberHMM): nothing it could refuse
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, minFraction: 0.03, minFold: 3, detectMethod: 'fixed' }, null, null)).toEqual(base);
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, minFraction: 0.03, minFold: 3 }, null, false)).toEqual(base);
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, detectMethod: 'fixed', minFraction: 0.03 }, null, true))
      .toEqual({ ...base, detect_method: 'fixed', detect_threshold: 0.15 });
    // a saved detect_threshold from before the enrichment rule is not sent (it would select the fixed rule)
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, detectThreshold: 0.2 }, null, true)).toEqual({ ...base, detect_method: 'enrichment', min_fraction: 0.10 });
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, detectThreshold: 0.2 }, null, false)).toEqual({ ...base, detect_threshold: 0.2 });
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, detectThreshold: 0.2 }, null, null)).toEqual(base);     // not known: nothing
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, nfrRegions: '100-400', minFraction: 0.03 }, null, true)).toEqual({ ...base, nfr_regions: [[100, 400]] });
  });

  it('replays a run from before depth-aware detection with its fixed rule', () => {
    const legacy = { parameters: { stringency: 0.9, detect_threshold: 0.15 } };
    expect(legacyDetection({ stringency: 0.9 }, legacy)).toEqual({ stringency: 0.9, detect_threshold: 0.15 });
    expect(legacyDetection({ stringency: 0.9, nfr_regions: [[1, 2]] }, legacy)).toEqual({ stringency: 0.9, nfr_regions: [[1, 2]] });
    expect(legacyDetection({ min_fraction: 0.05 }, { parameters: {}, detection: { method: 'enrichment', note: '' } })).toEqual({ min_fraction: 0.05, detect_method: 'enrichment' });
    expect(legacyDetection({ stringency: 0.9 }, null)).toEqual({ stringency: 0.9 });
  });

  it('says how an NFR and the run were found, for new and older results', () => {
    expect(share(0.027)).toBe('2.7%'); expect(share(0.06)).toBe('6%'); expect(share(0.373)).toBe('37%'); expect(share(null)).toBe('–');
    const nfr = { source: 'detected' as const, profile_peak: 0.0612, detection: { peak: 0.0612, background: 0.0105, fold: 5.8, q: 1e-9 } };
    expect(nfrDetectionLine(nfr)).toBe('open in 6.1% of reads · background 1.1% · 5.8× background · q 1.0e-9');
    expect(nfrDetectionLine({ source: 'detected', profile_peak: 0.4 })).toBe('open in 40% of reads');     // an older result
    expect(nfrDetectionLine({ source: 'given', profile_peak: null })).toBeNull();
    expect(runDetectionLine({ parameters: { detect_threshold: 0.15 } })).toBe('NFRs: fixed rule, > 15% of reads');
    expect(runDetectionLine({ parameters: {} })).toBeNull();
    expect(runDetectionLine({ parameters: { detect_threshold: 0.15, nfr_regions: [[1, 2]] } })).toBe('NFR regions given');
    expect(share(0.0004)).toBe('<0.1%'); expect(share(0)).toBe('0%');
    expect(runDetectionLine({ parameters: {}, detection: { method: 'fixed', threshold: 0.2, note: '' } })).toBe('NFRs: fixed rule, > 20% of reads');
    expect(runDetectionLine({ parameters: {}, detection: { method: 'enrichment', note: '', background: 0.072, enrichment_test: true, min_fraction: 0.05, min_fold: 2 } }))
      .toBe('NFRs open in ≥ 5% · background 7.2% · called at ≥ 14% here');
    expect(runDetectionLine({ parameters: {}, detection: { method: 'enrichment', note: 'x', background: null, enrichment_test: false, min_fraction: 0.05 } }))
      .toBe('NFRs open in ≥ 5% · no background (see note)');
  });
});

it('keeps raw fold/q informative and explains optional background diagnostics', () => {
  expect(runDetectionLine({ parameters: {}, detection: { method: 'raw', note: '', min_fraction: .1, background: .08, enrichment_test: true, enrichment_gates: false } })).toContain('≥ 10% of reads · background 8% · fold and q are informative, not gates');
  expect(opportunityDiagnosticLine({})).toBeNull();
  expect(opportunityDiagnosticLine({ detection: { method: 'raw', note: '', opportunity_diagnostic: { available: true, background: { median_opportunities_per_100bp: 2 }, nfr: { median_opportunities_per_100bp: 9 } } } })).toContain('2 marking sites per 100 bp (inside NFRs: 9): some may be missed marks');
});
